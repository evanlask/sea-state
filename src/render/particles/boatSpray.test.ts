import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import { DEG } from '../../sim/core/conventions';
import type { BoatKind, BoatSnapshot } from '../../sim/world/protocol';
import {
  BoatSpray,
  hullSidePoint,
  planRate,
  slamSides,
  sprayPlan,
  sprayScale,
  wipersWanted,
} from './boatSpray';
import { FX_BUDGETS } from './budgets';
import type { SpawnRequest } from './emissionQueue';
import { emitSlamSpray, roosterShape, washLump, washRate } from './emitters';
import { hullVolume, insideHull } from './hullVolumes';
import type { ParticleSystem } from './ParticleSystem';
import { powerLawRadius } from './sprayMath';

const boat = (kind: BoatKind, speed: number, telemetry: Record<string, number> = {}): BoatSnapshot => ({
  id: kind,
  kind,
  position: { x: 0, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 0, y: 0, z: -speed },
  angularVelocity: { x: 0, y: 0, z: 0 },
  telemetry: { speedThroughWater: speed, ...telemetry },
});
const calm = { hs: 0, waveFrom: 0 };

describe('boat spray plan', () => {
  it('gives the jet ski a rooster tail that follows the throttle and dies when the intake runs dry', () => {
    const full = sprayPlan(boat('pwc', 20, { throttle: 1, bucket: 0 }), 0, calm);
    const half = sprayPlan(boat('pwc', 10, { throttle: 0.5, bucket: 0 }), 0, calm);
    expect(full.rooster!.thrust).toBe(1);
    expect(half.rooster!.thrust).toBe(0.5);
    expect(full.rooster!.local.z).toBeGreaterThan(1); // at the nozzle, aft
    expect(sprayPlan(boat('pwc', 20, { throttle: 1, ventilated: 1 }), 0, calm).rooster!.thrust).toBe(0);
    expect(sprayPlan(boat('pwc', 20, { throttle: 1, airborne: 1 }), 0, calm).rooster!.thrust).toBe(0);
    expect(sprayPlan(boat('powerboat', 20), 0, calm).rooster).toBeNull();
  });

  it('washes behind every propeller, pod and outboard, by its own throttle', () => {
    expect(
      sprayPlan(boat('powerboat', 5, { eng0Throttle: 1, eng1Throttle: 0.5 }), 0, calm).wash.map(
        (w) => w.throttle,
      ),
    ).toEqual([1, 0.5]);
    expect(
      sprayPlan(boat('cruise', 5, { pod0Thrust: -0.8, pod1Thrust: 0.4 }), 0, calm).wash.map(
        (w) => w.throttle,
      ),
    ).toEqual([0.8, 0.4]);
    const ship = sprayPlan(boat('cargo', 5, { telegraphResponse: 0.6 }), 0, calm).wash;
    expect(ship).toHaveLength(1);
    expect(ship[0]!.local.z).toBeGreaterThan(100); // at the stern
    expect(sprayPlan(boat('sail', 3), 0, calm).wash).toEqual([]);
  });

  it('throws more bow spray with speed and sea state, most into a head sea', () => {
    const intensity = (speed: number, hs: number, waveFrom = 0) =>
      sprayPlan(boat('powerboat', speed), 0, { hs, waveFrom }).bow.intensity;
    expect(intensity(0, 2)).toBe(0);
    expect(intensity(10, 0)).toBeGreaterThan(0);
    expect(intensity(20, 0)).toBeGreaterThan(intensity(10, 0));
    expect(intensity(10, 1.5)).toBeGreaterThan(intensity(10, 0));
    expect(intensity(10, 1.5, 0)).toBeGreaterThan(intensity(10, 1.5, 180 * DEG)); // heading north into it
  });

  it('keeps a whole fleet at full spray within its share of every quality budget', () => {
    const fleet = [
      sprayPlan(boat('pwc', 25, { throttle: 1, bucket: 0 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('powerboat', 25, { eng0Throttle: 1, eng1Throttle: 1 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('cargo', 12, { telegraphResponse: 1 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('cruise', 11, { pod0Thrust: 1, pod1Thrust: 1 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('crab', 6, { telegraphResponse: 1 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('sail', 4), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('pwc', 25, { throttle: 1, bucket: 0 }), 0, { hs: 4, waveFrom: 0 }),
      sprayPlan(boat('hydro', 89, { throttle: 1, thrust: 16_000 }), 0, { hs: 4, waveFrom: 0 }),
    ];
    const requested = fleet.reduce((sum, plan) => sum + planRate(plan, 25), 0);
    for (const budget of Object.values(FX_BUDGETS)) {
      const scale = sprayScale(requested, budget, 1);
      const alive = requested * scale * 1.6; // particles/s × mean life
      expect(alive).toBeLessThanOrEqual(0.3 * budget.particles + 1);
      expect((requested * scale) / 60).toBeLessThanOrEqual(0.3 * budget.emitPerFrame + 1);
    }
    expect(sprayScale(100, FX_BUDGETS.ultra, 0.5)).toBe(0.5); // a light load keeps the quality scale
  });
});

describe('spray leaves the hull from outside it', () => {
  const kinds: BoatKind[] = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc', 'hydro'];

  it.each(kinds)('%s: bow spray and slam sheets start beside the hull, wash astern of it', (kind) => {
    const volume = hullVolume(kind);
    const out = new Vector3();
    for (const speed of [2, 8, 20]) {
      const plan = sprayPlan(boat(kind, speed), 0, { hs: 2, waveFrom: 0 });
      for (const side of [-1, 1]) {
        const at = hullSidePoint(kind, plan.bow.z, side, out);
        expect(insideHull(volume, at)).toBe(false);
        expect(Math.abs(at.x)).toBeGreaterThan(0.04);
      }
      for (const w of plan.wash) expect(insideHull(volume, { ...w.local, y: 0.05 })).toBe(false);
    }
    // A slam under the forefoot throws its sheets from the waterline beside it.
    const b = boat(kind, 5);
    const sides = slamSides(b, { x: 0, y: -0.3, z: volume.zBow * 0.6 });
    for (const point of [sides.port, sides.starboard]) expect(insideHull(volume, point)).toBe(false);
    expect(sides.port.x).toBeLessThan(0);
    expect(sides.starboard.x).toBeGreaterThan(0);
  });

  it("boils a ship's wash up astern of the counter, not under it", () => {
    const wash = sprayPlan(boat('cargo', 5, { telegraphResponse: 0.6 }), 0, calm).wash[0]!;
    expect(wash.local.z).toBeGreaterThan(hullVolume('cargo').zStern);
  });

  it("keeps an outboard's wash a narrow fizz next to a ship's boil", () => {
    expect(washRate(0.7, 1, 15)).toBeLessThan(washRate(7.9, 1, 15) / 3);
    expect(washLump(0.7)).toBeLessThan(1);
    expect(washLump(7.9)).toBeGreaterThan(2.5);
    expect(washRate(2, 0, 10)).toBe(0);
  });

  it('scales the spray with the hull', () => {
    expect(sprayPlan(boat('pwc', 10), 0, calm).spray).toBeLessThan(
      sprayPlan(boat('powerboat', 10), 0, calm).spray,
    );
    expect(sprayPlan(boat('cargo', 10), 0, calm).spray).toBeGreaterThan(3);
    // A planing hull's spray root runs aft as it speeds up; a ship's stays at the stem.
    expect(sprayPlan(boat('powerboat', 20), 0, calm).bow.z).toBeGreaterThan(
      sprayPlan(boat('powerboat', 3), 0, calm).bow.z,
    );
    expect(sprayPlan(boat('cargo', 12), 0, calm).bow.z).toBe(sprayPlan(boat('cargo', 3), 0, calm).bow.z);
  });
});

// CPU mirror of the emit kernel and a short flight (gravity and quadratic drag in still air), with
// the boat sailing on north: the share of a request's particles that a hull test would kill.
function killedShare(
  kind: BoatKind,
  requests: SpawnRequest[],
  boatVelocity: Vector3,
  seconds: number,
): number {
  const volume = hullVolume(kind);
  let seed = 12345;
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const range = (a: number, b: number): number => a + (b - a) * rand();
  const ball = (): Vector3 => {
    const v = new Vector3();
    do v.set(range(-1, 1), range(-1, 1), range(-1, 1));
    while (v.lengthSq() > 1);
    return v;
  };
  let total = 0;
  let killed = 0;
  for (const r of requests) {
    if (r.kind === 'smoke') continue;
    for (let i = 0; i < Math.min(400, Math.floor(r.count)); i++) {
      total++;
      const line = r.positionLine ?? { x: 0, y: 0, z: 0 };
      const f = range(-1, 1);
      const p = new Vector3(
        r.position.x + line.x * f,
        r.position.y + line.y * f,
        r.position.z + line.z * f,
      ).add(ball().multiplyScalar(r.positionRadius ?? 0));
      const v = new Vector3(r.velocity.x, r.velocity.y, r.velocity.z);
      if (r.fanAxis) {
        v.applyAxisAngle(
          new Vector3(r.fanAxis.x, r.fanAxis.y, r.fanAxis.z),
          range(-1, 1) * (r.fanAngle ?? 0),
        );
      }
      v.multiplyScalar(1 - (r.speedVariation ?? 0) * rand()).add(
        ball().multiplyScalar(r.velocitySpread ?? 0),
      );
      if (r.carrier) v.add(new Vector3(r.carrier.x, r.carrier.y, r.carrier.z));
      const drag = r.drag ?? (r.kind === 'mist' ? 25 : 0.5);
      const size = powerLawRadius(r.size[0], r.size[1], 0, rand());
      const dt = 1 / 120;
      for (let t = 0; t < seconds; t += dt) {
        const speed = v.length();
        v.multiplyScalar(Math.exp(-drag * speed * dt));
        if (r.kind !== 'mist') v.y -= 9.81 * dt;
        p.addScaledVector(v, dt);
        const local = p.clone().addScaledVector(boatVelocity, -(t + dt)); // the boat moved on
        if (insideHull(volume, local)) {
          killed++;
          break;
        }
        if (p.y < -0.2 || size < 0) break; // back in the sea
      }
    }
  }
  return total ? killed / total : 0;
}

describe('spray clears the hull it comes off', () => {
  const capture = (): { particles: ParticleSystem; requests: SpawnRequest[] } => {
    const requests: SpawnRequest[] = [];
    const particles = {
      spawn: (r: SpawnRequest) => {
        requests.push(r);
        return r.count;
      },
    } as unknown as ParticleSystem;
    return { particles, requests };
  };

  it.each([
    ['powerboat', 20],
    ['powerboat', 8],
    ['pwc', 18],
    ['crab', 6],
    ['cargo', 11],
  ] as const)('%s bow spray at %d m/s', (kind, speed) => {
    const { particles, requests } = capture();
    const b = boat(kind, speed, { eng0Throttle: 1, eng1Throttle: 1, throttle: 1 });
    new BoatSpray().update(particles, [b], [0], { hs: 2, waveFrom: 0 }, 1, FX_BUDGETS.ultra, 1);
    const bow = requests.filter((r) => r.kind === 'droplet' || r.kind === 'mist');
    expect(bow.reduce((sum, r) => sum + r.count, 0)).toBeGreaterThan(20); // in one 0.1 s step
    expect(killedShare(kind, bow, new Vector3(0, 0, -speed), 1)).toBeLessThan(0.1);
  });

  it.each(['powerboat', 'crab', 'cargo'] as const)('%s slam sheets', (kind) => {
    const { particles, requests } = capture();
    const b = boat(kind, 10);
    const at = { x: 0, y: -0.3, z: hullVolume(kind).zBow * 0.55 };
    emitSlamSpray(particles, { ...at, strength: 4 }, b.velocity, {
      heading: { x: 0, y: 0, z: -1 },
      sides: slamSides(b, at),
    });
    expect(killedShare(kind, requests, new Vector3(0, 0, -10), 1)).toBeLessThan(0.05);
  });
});

describe("the hydroplane's rooster tail", () => {
  const capture = (): { particles: ParticleSystem; requests: SpawnRequest[] } => {
    const requests: SpawnRequest[] = [];
    const particles = {
      spawn: (r: SpawnRequest) => {
        requests.push({ ...r, position: { ...r.position }, carrier: r.carrier && { ...r.carrier } });
        return r.count;
      },
    } as unknown as ParticleSystem;
    return { particles, requests };
  };
  // One 0.1 s step of the hydroplane's spray at full throttle, heading north.
  const step = (speed: number, thrust: number) => {
    const { particles, requests } = capture();
    const b = boat('hydro', speed, { throttle: 1, thrust });
    new BoatSpray().update(particles, [b], [0], calm, 0.1, FX_BUDGETS.ultra, 1);
    // From the propeller (not the sponsons), and not its wash.
    return requests.filter((r) => r.position.z > 4.9 && r.kind !== 'foam');
  };
  // Heights reached and where it comes down, by the emit kernel and a flight in still air.
  const flight = (requests: SpawnRequest[]) => {
    const apexes: number[] = [];
    let drift = 0;
    let n = 0;
    for (const r of requests) {
      const up = r.velocity.y;
      for (const f of [0.45, 0.7, 1]) {
        const v = new Vector3(r.carrier!.x, up * f, r.carrier!.z);
        const p = new Vector3(r.position.x, r.position.y, r.position.z);
        const start = p.clone();
        let apex = p.y;
        for (let t = 0; t < 6 && p.y > -0.1; t += 1 / 120) {
          v.multiplyScalar(Math.exp((-(r.drag ?? 0.1) * v.length()) / 120));
          v.y -= 9.81 / 120;
          p.addScaledVector(v, 1 / 120);
          apex = Math.max(apex, p.y);
        }
        if (r.kind === 'droplet') apexes.push(apex);
        drift += Math.hypot(p.x - start.x, p.z - start.z);
        n++;
      }
    }
    return { apex: Math.max(...apexes), drift: drift / n };
  };

  it('stands 15–20 m tall at 200 mph and grows with speed and thrust', () => {
    const top = roosterShape(1, 1);
    expect(top.height).toBeGreaterThan(15);
    expect(top.height).toBeLessThan(20);
    expect(roosterShape(0.5, 1).height).toBeLessThan(0.5 * top.height);
    expect(roosterShape(0.2, 1).height).toBeLessThan(2.5);
    expect(roosterShape(1, 0.25).height).toBeLessThan(top.height);
    expect(roosterShape(1, 0).rate).toBe(0);
    const plan = sprayPlan(boat('hydro', 89, { thrust: 16_000 }), 0, calm);
    expect(plan.rooster).toMatchObject({ prop: true, thrust: 1 });
    expect(plan.rooster!.speedShare).toBeGreaterThan(0.99);
    expect(sprayPlan(boat('hydro', 89, { thrust: 16_000, capsized: 1 }), 0, calm).rooster!.thrust).toBe(0);
  });

  it('flies up from the propeller and hangs over the track while the boat races on', () => {
    const fast = step(89, 16_000);
    expect(fast.reduce((sum, r) => sum + r.count, 0)).toBeGreaterThan(300); // in 0.1 s
    // Spread along the 9 m the propeller covered in the step, not in one bead.
    expect(Math.max(...fast.map((r) => Math.hypot(r.positionLine!.x, r.positionLine!.z)))).toBeGreaterThan(4);
    const high = flight(fast);
    expect(high.apex).toBeGreaterThan(14);
    // Over the ground it barely moves: it lands within a few tens of metres of where it was thrown,
    // a few hundred metres behind the boat by then.
    expect(high.drift).toBeLessThan(30);
    expect(flight(step(30, 16_000)).apex).toBeLessThan(0.5 * high.apex);
    expect(killedShare('hydro', fast, new Vector3(0, 0, -89), 1)).toBeLessThan(0.01);
  });

  it('throws none at rest or off the plane: the idling propeller only churns', () => {
    expect(roosterShape(0, 1).rate).toBe(0);
    expect(roosterShape(0.08, 1).height).toBe(0);
    for (const speed of [0, 3, 8]) {
      expect(step(speed, 2_500).filter((r) => r.kind === 'mist' || r.velocity.y > 2)).toEqual([]);
    }
    expect(roosterShape(0.4, 1).height).toBeGreaterThan(3);
  });

  it('throws sheets off the sponsons, beside the pads', () => {
    const { particles, requests } = capture();
    new BoatSpray().update(
      particles,
      [boat('hydro', 70, { thrust: 9_000 })],
      [0],
      calm,
      0.1,
      FX_BUDGETS.ultra,
      1,
    );
    const sheets = requests.filter((r) => r.position.z < 0);
    expect(sheets.reduce((sum, r) => sum + r.count, 0)).toBeGreaterThan(20);
    for (const r of sheets) {
      expect(Math.abs(r.position.x)).toBeGreaterThan(BOAT_SPECS.hydro.dimensions.beam / 2);
      expect(r.position.z).toBeGreaterThan(-2); // the pads' wetted aft ends, ahead of the step
    }
  });
});

describe('wipers', () => {
  it('start in rain or heavy spray and keep going until it has clearly eased', () => {
    expect(wipersWanted(false, 0, 0)).toBe(false);
    expect(wipersWanted(false, 0.3, 0)).toBe(true);
    expect(wipersWanted(false, 0, 0.5)).toBe(true);
    expect(wipersWanted(false, 0, 0.3)).toBe(false);
    expect(wipersWanted(true, 0, 0.3)).toBe(true); // hysteresis
    expect(wipersWanted(true, 0, 0.1)).toBe(false);
  });
});
