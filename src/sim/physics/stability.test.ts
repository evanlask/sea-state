import { describe, expect, it } from 'vite-plus/test';

import { CALIBRATION, stabilityCurve } from '../boats/calibration/index';
import { createBoatDynamics } from '../boats/drivetrains';
import { BOAT_SPECS } from '../boats/specs/index';
import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { type BoatKind, neutralControls, type SimEvent } from '../world/protocol';
import { WorldBoat } from '../world/WorldBoat';
import { BreakingWaves, DeckWater, Flooding } from './flooding';
import { HullWater } from './hullWater';
import { IrregularSea } from './seas';
import { physicsTuning } from './tuning';
import { AiryWave, flatWater, waterSample } from './water';
import { UniformWind } from './windage';

const MASTER = 1 / 120;
const att = { heading: 0, pitch: 0, roll: 0 };
const KINDS: readonly BoatKind[] = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc'];

describe('exported stability curves', () => {
  it('have AVS and downflooding angles plausible for each type', () => {
    expect(CALIBRATION.sail.stability.avs / DEG).toBeGreaterThan(115);
    expect(CALIBRATION.sail.stability.avs / DEG).toBeLessThan(125);
    // Crab boat with an empty deck (ballasted to carry pots; the pot load's AVS is in loading.test).
    expect(CALIBRATION.crab.stability.avs / DEG).toBeGreaterThan(120);
    expect(CALIBRATION.cargo.stability.maxGz).toBeGreaterThan(1);
    for (const kind of KINDS) {
      const s = stabilityCurve(kind);
      expect(s.curve.length).toBeGreaterThan(20);
      expect(s.downflooding).toBeGreaterThan(20 * DEG);
    }
  });

  it('the cruise ship’s superstructure carries its righting arm on past the deck edge', () => {
    // Enclosed passenger decks nearly as wide as the hull: no collapse of GZ between the deck edge
    // going under (~17°) and the superstructure taking over.
    const { heel, gz } = CALIBRATION.cruise.stability;
    for (let i = 0; i < heel.length; i++) {
      if (heel[i]! >= 25 * DEG && heel[i]! <= 70 * DEG)
        expect(gz[i]!, `${heel[i]! / DEG}°`).toBeGreaterThan(1.2);
    }
  });
});

describe('capsizing with the full drive train', () => {
  it('a sailboat knocked down to 100° (below its AVS) rights itself; a jet ski at 80° (beyond) stays over', () => {
    for (const [kind, heel, rights] of [
      ['sail', 100, true],
      ['pwc', 80, false],
    ] as const) {
      const d = createBoatDynamics(kind, physicsTuning(kind, 'arcade'));
      d.placeAtRest(0, 0, 0, heel * DEG);
      for (let i = 0; i < 120 * 12; i++) d.step(MASTER, flatWater, null, i * MASTER);
      const roll = Math.abs(attitudeFromQuat(d.body.orientation, att).roll);
      if (rights) expect(roll).toBeLessThan(15 * DEG);
      else expect(roll).toBeGreaterThan(120 * DEG);
    }
  });

  it('fires a capsized event, and recover puts the boat upright at rest', () => {
    const sea = new IrregularSea({ hs: 0.01, tp: 5, towards: 0 });
    const boat = new WorldBoat('a', 'pwc', sea, 'arcade');
    boat.dyn.placeAtRest(0, 0, 0, 170 * DEG);
    const wind = new UniformWind(0, 0);
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 * 5; i++) boat.step(MASTER, i * MASTER, wind, events);
    expect(events.some((e) => e.type === 'capsized')).toBe(true);
    boat.recover(5, events);
    expect(events.at(-1)?.type).toBe('recovered');
    expect(Math.abs(attitudeFromQuat(boat.dyn.body.orientation, att).roll)).toBeLessThan(1 * DEG);
    expect(Math.hypot(boat.dyn.body.velocity.x, boat.dyn.body.velocity.y)).toBe(0);
  });
});

describe('green water and downflooding', () => {
  it('the crab boat sheds a shipped sea through its freeing ports in the Torricelli time', () => {
    const d = createBoatDynamics('crab');
    const deck = d.modules.find((m) => m instanceof DeckWater) as DeckWater;
    const well = deck.wells[0]!;
    const tank = well.tank;
    const v0 = 0.25 * tank.capacity;
    tank.volume = v0;
    let t = 0;
    while (tank.volume > 0.1 * v0 && t < 120) {
      d.step(MASTER * 4, flatWater, null, t);
      t += MASTER * 4;
    }
    // dV/dt = −Cd·A·√(2g·h), h = V/A_well → down to 10% in 2·V0/Q0·(1 − √0.1).
    const area = 4 * tank.ax * tank.az;
    const q0 = 0.6 * well.drainArea * Math.sqrt(2 * 9.81 * (v0 / area));
    const expected = ((2 * v0) / q0) * (1 - Math.sqrt(0.1));
    expect(Math.abs(t / expected - 1)).toBeLessThan(0.3);
  });

  it('water in the crab boat’s deck well weighs only what stands above the sea outside', () => {
    // The hull's pressure model already loads an immersed deck with the sea over it; the well's
    // water up to that level is the same water and must not be weighed twice.
    const d = createBoatDynamics('crab');
    const deck = d.modules.find((m) => m instanceof DeckWater) as DeckWater;
    const tank = deck.wells[0]!.tank;
    const area = 4 * tank.ax * tank.az;
    const ctx = {
      body: d.body,
      water: flatWater,
      wind: new UniformWind(0, 0),
      time: 0,
      dt: 1e-6,
      controls: neutralControls(),
      physicsMode: 'arcade' as const,
    };
    const load = (originY: number, depth: number): number => {
      d.placeAtRest(0, 0, 0, 0, originY);
      deck.reset();
      tank.volume = area * depth;
      d.body.clearForces();
      deck.apply(ctx);
      return -d.body.force.y / (9.81 * 1025 * area * depth);
    };
    const freeboard = deck.wells[0]!.floorY;
    // Deck 0.3 m under a calm sea, the well flooded to the sea's level: no extra weight.
    expect(Math.abs(load(-freeboard - 0.3, 0.3))).toBeLessThan(0.1);
    // Deck 0.2 m under, 0.5 m of trapped water: only the 0.3 m above the sea is extra weight.
    expect(load(-freeboard - 0.2, 0.5)).toBeCloseTo(0.6, 1);
    // Deck clear of the sea: all of it is weight.
    expect(load(0, 0.3)).toBeCloseTo(1, 2);
  });

  it('water on deck and flood water reduce the righting moment (free surface)', () => {
    // Same steady heeling moment; the heel grows with slack water aboard.
    const heelWith = (fill: (d: ReturnType<typeof createBoatDynamics>) => void): number => {
      const d = createBoatDynamics('crab');
      fill(d);
      const wind = new UniformWind(30, Math.PI / 2); // beam wind from the east
      for (let i = 0; i < 120 * 40; i++) d.step(MASTER, flatWater, wind, i * MASTER);
      return Math.abs(attitudeFromQuat(d.body.orientation, att).roll);
    };
    const dry = heelWith(() => {});
    // Water through the house doors: slack and on the main deck level.
    const flooded = heelWith((d) => {
      const f = d.modules.find((m) => m instanceof Flooding) as Flooding;
      f.pumps.fill(0);
      const t = f.tanks[0]!;
      t.volume = 0.4 * t.capacity;
    });
    // The slack water's free-surface loss (i/∇ ≈ 0.2 m) against a GM of 1.2 m.
    expect(flooded).toBeGreaterThan(dry * 1.15);
  });
});

// RMS vertical acceleration felt at the helm (what the HUD's ride meter shows).
function rmsMotion(kind: BoatKind, sea: IrregularSea, seconds: number): number {
  const boat = new WorldBoat(kind, kind, sea, 'arcade');
  boat.place(0, 0, Math.PI / 4, 0);
  const wind = new UniformWind(0, 0);
  const events: SimEvent[] = [];
  const eye = BOAT_SPECS[kind].helmEye;
  const p = vec3();
  const v = vec3();
  let prev = NaN;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < seconds * 120; i++) {
    boat.step(MASTER, i * MASTER, wind, events);
    const b = boat.dyn.body;
    b.bodyToWorldPoint(p, eye);
    b.pointVelocity(v, p);
    if (i > 120 * 8 && i % 4 === 0) {
      if (Number.isFinite(prev)) {
        const a = (v.y - prev) / (4 * MASTER);
        sum += a * a;
        n++;
      }
    }
    if (i % 4 === 0) prev = v.y;
  }
  return Math.sqrt(sum / n);
}

describe('seakeeping comparison', () => {
  it('in the same sea, motion orders cargo < cruise < crab < console < jet ski', () => {
    const sea = new IrregularSea({ hs: 2.5, tp: 7.5, towards: 0, seed: 3, components: 24 });
    const rms = (['cargo', 'cruise', 'crab', 'powerboat', 'pwc'] as const).map((k) => rmsMotion(k, sea, 22));
    for (let i = 1; i < rms.length; i++) expect(rms[i]!).toBeGreaterThan(rms[i - 1]!);
  }, 20_000);
});

// The crab boat with pots on deck, at full ahead in a long-crested sea from the north (waves
// running south) and a matching wind: steer(t) per run. Returns the worst heel (rad) and whether
// she capsized.
function crabInSea(
  sea: IrregularSea,
  windSpeed: number,
  pots: number,
  heading: number,
  steer: ((t: number) => number) | null,
  seconds: number,
): { maxHeel: number; capsized: boolean } {
  const boat = new WorldBoat('crab', 'crab', sea, 'arcade', false, { crabPots: pots });
  boat.place(0, 0, heading, 0);
  if (!steer) boat.setAutopilot({ mode: 'drift' });
  const wind = new UniformWind(windSpeed, 0);
  const events: SimEvent[] = [];
  let maxHeel = 0;
  for (let i = 0; i < seconds * 120; i++) {
    const t = i * MASTER;
    if (steer) boat.controls = { ...neutralControls(), throttle: 1, steer: steer(t) };
    boat.step(MASTER, t, wind, events);
    if (i % 12 === 0)
      maxHeel = Math.max(maxHeel, Math.abs(attitudeFromQuat(boat.dyn.body.orientation, att).roll));
  }
  return { maxHeel, capsized: events.some((e) => e.type === 'capsized') };
}

describe('the crab boat with its deck load of pots', () => {
  // A gale's sea (the Gale preset resolves to Hs 6.3 m, Tp 12.4 s in 38 kn).
  it('Gale, Arcade, 120 pots: full ahead, hard over or zig-zagging, she stays upright', () => {
    for (const seed of [1, 2]) {
      const sea = new IrregularSea({ hs: 6.3, tp: 12.4, towards: Math.PI, seed, components: 24 });
      const runs = [
        crabInSea(sea, 19.5, 120, 0, () => 0, 40), // head sea
        crabInSea(sea, 19.5, 120, 0, (t) => (t > 3 ? 1 : 0), 40), // hard over
        crabInSea(sea, 19.5, 120, 0, (t) => (Math.floor(t / 12) % 2 ? -1 : 1), 40), // zig-zag
      ];
      for (const r of runs) {
        expect(r.capsized).toBe(false);
        expect(r.maxHeel).toBeLessThan(35 * DEG);
      }
    }
  }, 30_000);

  it('Hurricane, Realistic, an overload of 200 pots lying beam-on: she rolls over', () => {
    // Hurricane Category 1's sea (Hs 9.2 m, Tp 13 s) and 70 kn of wind, drifting beam-on.
    const sea = new IrregularSea({ hs: 9.2, tp: 13, towards: Math.PI, seed: 1, components: 24 });
    const boat = new WorldBoat('crab', 'crab', sea, 'realistic', false, { crabPots: 200 });
    boat.place(0, 0, Math.PI / 2, 0);
    boat.setAutopilot({ mode: 'drift' });
    const wind = new UniformWind(36, 0);
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 * 45 && !events.some((e) => e.type === 'capsized'); i++) {
      boat.step(MASTER, i * MASTER, wind, events);
    }
    expect(events.some((e) => e.type === 'capsized')).toBe(true);
  }, 30_000);
});

describe('wind', () => {
  it('a beam wind from starboard heels a ship to port and pushes it to leeward', () => {
    const d = createBoatDynamics('cargo', physicsTuning('cargo', 'realistic'));
    const wind = new UniformWind(25, Math.PI / 2); // from the east, onto the starboard side (bow north)
    for (let i = 0; i < 60 * 60; i++) d.step(1 / 60, flatWater, wind, i / 60, neutralControls());
    const roll = attitudeFromQuat(d.body.orientation, att).roll;
    expect(roll).toBeLessThan(-0.5 * DEG); // port down
    expect(roll).toBeGreaterThan(-15 * DEG);
    expect(d.body.velocity.x).toBeLessThan(-0.05); // drifting west
  });
});

describe('water grid', () => {
  it('the water grid matches direct sampling of the sea at the hull', () => {
    const sea = new IrregularSea({ hs: 3, tp: 8, towards: 0.3, seed: 2 });
    const d = createBoatDynamics('crab');
    const grid = new HullWater(sea, {
      halfLength: 22,
      halfWidth: 10,
      nx: 13,
      nz: 5,
      referenceDepth: 3.6,
      mask: 15,
    });
    grid.update(d.body, 3);
    const a = waterSample();
    const b = waterSample();
    grid.sample(5, -2, 3, 3, a);
    sea.sample(5, -2, 3, 3, b);
    expect(Math.abs(a.height - b.height)).toBeLessThan(0.25);
    expect(Math.abs(a.pressureHead - b.pressureHead)).toBeLessThan(0.3);
  });

  it('below its reference depth the grid keeps the pressure of the long waves (a jet ski’s 0.26 m)', () => {
    // A Squalls sea. The long waves' pressure barely decays over a metre or two, so the
    // grid must not fade every wave's share as 1/depth past its reference depth.
    const sea = new IrregularSea({ hs: 3.4, tp: 9.3, towards: 0.3, seed: 2 });
    const d = createBoatDynamics('pwc');
    const grid = new HullWater(sea, {
      halfLength: 1.8,
      halfWidth: 0.7,
      nx: 9,
      nz: 5,
      referenceDepth: 0.256,
      mask: 15,
    });
    const a = waterSample();
    const b = waterSample();
    let worst = 0;
    for (let t = 1; t < 40; t += 0.9) {
      d.body.position.x = 23 * t;
      grid.update(d.body, t);
      const x = d.body.position.x;
      grid.sample(x, 0, 0, t, a);
      const eta = a.height;
      for (const depth of [0.5, 1, 2]) {
        grid.sample(x, eta - depth, 0, t, a);
        sea.sample(x, eta - depth, 0, t, b);
        worst = Math.max(worst, Math.abs(a.pressureHead - b.pressureHead));
      }
    }
    expect(worst).toBeLessThan(0.15);
  });
});

describe('breaking waves', () => {
  // A 60 m wave of steepness a·k running toward +x, its crest on a center console lying beam-on
  // (bow north, port side to the sea) with its waterline at the crest.
  const impact = (ak: number): { force: number; fx: number; expected: number } => {
    const k = (2 * Math.PI) / 60;
    const a = ak / k;
    const wave = new AiryWave({ amplitude: a, wavelength: 60, directionX: 1, directionZ: 0 });
    const d = createBoatDynamics('powerboat');
    d.placeAtRest(0, 0, 0, 0, a);
    const breaking = d.modules.find((m) => m instanceof BreakingWaves) as BreakingWaves;
    d.body.clearForces();
    breaking.apply({
      body: d.body,
      water: wave,
      wind: new UniformWind(0, 0),
      time: 0,
      dt: 1e-3,
      controls: neutralControls(),
      physicsMode: 'realistic',
    });
    // The crest's water at the wave's speed against the side, from the waterline up to the top of its
    // breaking half: ½·ρ·C·c²·h on each of the five port stations.
    const c = Math.sqrt(9.81 / k);
    const h = breaking.spec.stations.map((st) => Math.min(0.5 * a, 1.5 * st.freeboard));
    const expected = h.reduce((sum, hi) => sum + 1025 * c * c * hi * breaking.segment, 0);
    return { force: breaking.force, fx: d.body.force.x, expected };
  };

  it('a crest steeper than the breaking limit hits the hull side with its own speed and height', () => {
    const r = impact(0.3);
    expect(r.fx).toBeGreaterThan(0);
    expect(r.force / r.expected).toBeGreaterThan(0.7);
    expect(r.force / r.expected).toBeLessThan(1.1);
  });

  it('a crest below the limit does not break', () => {
    expect(impact(0.18).force).toBe(0);
  });
});
