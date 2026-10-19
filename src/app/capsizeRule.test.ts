import { describe, expect, it } from 'vite-plus/test';

import { createBoatDynamics } from '../sim/boats/drivetrains';
import { attitudeFromQuat } from '../sim/core/attitude';
import { DEG, signedAngle } from '../sim/core/conventions';
import { physicsTuning } from '../sim/physics/tuning';
import { AiryWave } from '../sim/physics/water';
import { getWeatherPreset } from '../sim/weather/presets';
import {
  type BoatKind,
  type BoatSpawn,
  neutralControls,
  type PhysicsMode,
  type SimCommand,
} from '../sim/world/protocol';
import { SimWorld } from '../sim/world/SimWorld';
import { sailSetupFor } from './spawnPlan';

// The capsize rule, on the real FFT ocean and wind of the weather presets: no small craft capsizes in
// Fair, Breezy or Squalls however carelessly driven (full throttle, hard over, zig-zagging); from a
// Storm up it is how they are handled, not the storm, that decides: careful handling (running off
// slower than the seas, the seas fine on the bow) survives, lying beam-on to breaking seas does not.
// Big ships never capsize. A few short runs each; the measurements behind them (three minutes per run,
// 4 seeds, every preset, careful and careless) come from scripts/capsize-sweep.ts.

// `speed`: a helm holding the heading with as much helm as it takes, the throttle on that speed (never
// below the power the drive needs to steer), eased while the bow climbs a steep face (the careful and
// the slow cases of scripts/capsize-sweep.ts, without its look-out for breaking crests).
type Drive = 'ahead' | 'hardover' | 'zigzag' | 'drift' | { twa: number } | { speed: number };

interface Case {
  id: string;
  rel: number; // heading off the wind (and sea), rad: 0 head to it, π/2 beam-on
  drive: Drive;
  x?: number; // m east (default: 10 km apart in order)
}

// One world per call, the cases 10 km apart. Returns per case whether it capsized and its worst heel
// (deg) until then.
function voyage(
  kind: BoatKind,
  weather: string,
  mode: PhysicsMode,
  seed: number,
  cases: Case[],
  seconds: number,
): Record<string, { capsized: boolean; maxHeel: number }> {
  const p = getWeatherPreset(weather);
  const wind = { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor };
  const boats: BoatSpawn[] = cases.map((c, i) => {
    const heading = wind.from + c.rel;
    const spawn: BoatSpawn = { id: c.id, kind, x: c.x ?? i * 10_000, z: 0, heading };
    // The sailboat reefed and its genoa furled as the HUD advises, sheets set for the course.
    if (kind === 'sail') spawn.sail = sailSetupFor(wind.speed, signedAngle(wind.from - heading));
    return spawn;
  });
  const world = new SimWorld({
    seed,
    physicsMode: mode,
    boats,
    wind,
    seaState: p.seaState,
    oceanQuality: 'low',
    wakes: false,
  });
  const commands: SimCommand[] = [];
  world.boats.forEach((b, i) => {
    const d = cases[i]!.drive;
    b.setAutopilot(typeof d === 'object' && 'twa' in d ? { mode: 'windAngle', twa: d.twa } : null);
  });
  const throttle = cases.map(() => 0.3);
  const out: Record<string, { capsized: boolean; maxHeel: number }> = {};
  for (const c of cases) out[c.id] = { capsized: false, maxHeel: 0 };
  const att = { heading: 0, pitch: 0, roll: 0 };
  const dt = 0.1;
  for (let step = 1; step * dt <= seconds + 1e-9; step++) {
    const t = step * dt;
    const controls: Record<string, ReturnType<typeof neutralControls>> = {};
    for (const [i, c] of cases.entries()) {
      if (c.drive === 'drift' || (typeof c.drive === 'object' && 'twa' in c.drive)) continue;
      const ctl = neutralControls();
      ctl.throttle = kind === 'sail' ? 0 : 1;
      if (typeof c.drive === 'object') {
        const b = world.boats[i]!;
        attitudeFromQuat(b.dyn.body.orientation, att);
        const u = b.telemetry['surge'] ?? 0;
        throttle[i] = Math.max(0.2, Math.min(1, throttle[i]! + dt * 0.15 * (c.drive.speed - u)));
        ctl.throttle = att.pitch > 12 * DEG ? Math.min(throttle[i]!, 0.25) : throttle[i]!;
        const yaw = b.telemetry['yawRate'] ?? 0;
        const err = signedAngle(wind.from + c.rel - att.heading - 1.5 * yaw);
        ctl.steer = Math.max(-1, Math.min(1, 2 * err));
        if (Math.abs(err) > 15 * DEG) ctl.throttle = Math.max(ctl.throttle, 0.6);
      }
      if (c.drive === 'hardover') ctl.steer = t > 3 ? 1 : 0;
      if (c.drive === 'zigzag') ctl.steer = t > 3 ? (Math.floor((t - 3) / 6) % 2 ? -1 : 1) : 0;
      controls[c.id] = ctl;
    }
    const s = world.advance({
      type: 'advance',
      targetTime: t,
      controls,
      commands: step === 1 ? commands : [],
      probes: new Float64Array(),
    });
    for (const e of s.events) if (e.type === 'capsized') out[e.boatId]!.capsized = true;
    for (const b of s.boats) {
      const o = out[b.id]!;
      if (o.capsized) continue;
      attitudeFromQuat(b.orientation, att);
      o.maxHeel = Math.max(o.maxHeel, Math.abs(att.roll) / DEG);
    }
  }
  return out;
}

// Arcade: hard over and zig-zagging at full lock; Realistic: flat out into the sea and zig-zagging.
const DRIVEN: Record<PhysicsMode, Case[]> = {
  arcade: [
    { id: 'hardover', rel: 0, drive: 'hardover' },
    { id: 'zigzag', rel: 0, drive: 'zigzag' },
  ],
  realistic: [
    { id: 'ahead', rel: 0, drive: 'ahead' },
    { id: 'zigzag', rel: 0, drive: 'zigzag' },
  ],
};

describe('capsize rule: the jet ski', () => {
  it('Squalls, flat out into the sea, hard over or zig-zagging at full lock: stays upright', () => {
    for (const [mode, seed] of [
      ['arcade', 1],
      ['realistic', 2],
    ] as const) {
      const r = voyage('pwc', 'squalls', mode, seed, DRIVEN[mode], 20);
      for (const [id, o] of Object.entries(r)) expect(o.capsized, `${mode} ${id}`).toBe(false);
    }
  }, 60_000);

  it('Hurricane Category 3, lying beam-on: rolls over', () => {
    const r = voyage(
      'pwc',
      'hurricane-3',
      'realistic',
      1,
      [{ id: 'drift', rel: 90 * DEG, drive: 'drift' }],
      15,
    );
    expect(r['drift']!.capsized).toBe(true);
  }, 30_000);
});

describe('capsize rule: the center console', () => {
  it('Gale, full ahead into the sea, hard over or zig-zagging: stays upright, heel under 45°', () => {
    for (const [mode, seed] of [
      ['arcade', 1],
      ['realistic', 2],
    ] as const) {
      const r = voyage('powerboat', 'gale', mode, seed, DRIVEN[mode], 20);
      for (const [id, o] of Object.entries(r)) {
        expect(o.capsized, `${mode} ${id}`).toBe(false);
        expect(o.maxHeel, `${mode} ${id}`).toBeLessThan(45);
      }
    }
  }, 60_000);

  // A train of 60 m waves, 5.2 m high (a·k 0.27, past the breaking limit) or the same length unbroken
  // (a·k 0.2, 3.8 m), running east onto the boat stopped in it: worst heel (deg), and whether it was
  // capsized: past 100° (its AVS is 99°) for 2.5 s or rolled upside down (the world's rule).
  const breakingTrain = (ak: number, heading: number): { capsized: boolean; maxHeel: number } => {
    const k = (2 * Math.PI) / 60;
    const wave = new AiryWave({
      amplitude: ak / k,
      wavelength: 60,
      directionX: 1,
      directionZ: 0,
      phase: Math.PI,
    });
    const d = createBoatDynamics('powerboat', physicsTuning('powerboat', 'realistic'));
    d.placeAtRest(0, 0, heading);
    const att = { heading: 0, pitch: 0, roll: 0 };
    let maxHeel = 0;
    let over = 0;
    for (let t = 0; t < 20; t += 1 / 120) {
      d.step(1 / 120, wave, null, t);
      attitudeFromQuat(d.body.orientation, att);
      maxHeel = Math.max(maxHeel, Math.abs(att.roll) / DEG);
      over = Math.cos(att.roll) * Math.cos(att.pitch) < Math.cos(100 * DEG) ? over + 1 / 120 : 0;
      if (over > 2.5) return { capsized: true, maxHeel };
    }
    return { capsized: maxHeel > 150, maxHeel };
  };

  it('a breaking sea rolls her over lying beam-on; bow-on, or unbroken, she rides it', () => {
    expect(breakingTrain(0.27, 0).capsized, 'beam-on, breaking').toBe(true);
    const bow = breakingTrain(0.27, 270 * DEG);
    expect(bow.capsized, 'bow-on, breaking').toBe(false);
    expect(bow.maxHeel).toBeLessThan(45);
    const unbroken = breakingTrain(0.2, 0);
    expect(unbroken.capsized, 'beam-on, unbroken').toBe(false);
    expect(unbroken.maxHeel).toBeLessThan(45);
  }, 60_000);

  it('Storm, running off slower than the seas with them on the quarter (careful): stays upright', () => {
    for (const [mode, seed] of [
      ['arcade', 1],
      ['realistic', 2],
    ] as const) {
      const r = voyage(
        'powerboat',
        'storm',
        mode,
        seed,
        [{ id: 'run', rel: 150 * DEG, drive: { speed: 8 } }],
        40,
      );
      expect(r['run']!.capsized, mode).toBe(false);
      expect(r['run']!.maxHeel, mode).toBeLessThan(35);
    }
  }, 60_000);

  it('Hurricane Category 1, lying beam-on at steerage way (careless): a breaking sea rolls her over', () => {
    // At least one of four one-minute runs: about a third of three-minute runs in a Storm or a
    // Category 1 are rolled over (scripts/capsize-sweep.ts). Of seeds 5-8, seeds 7 and 8 are rolled in
    // the first minute: so they run first, and the test stops at the first roll.
    let rolled = 0;
    for (const seed of [7, 8, 5, 6]) {
      if (rolled) break;
      const r = voyage(
        'powerboat',
        'hurricane-1',
        'arcade',
        seed,
        [{ id: 'beam', rel: 90 * DEG, drive: { speed: 3 } }],
        60,
      );
      if (r['beam']!.capsized) rolled++;
    }
    expect(rolled).toBeGreaterThan(0);
  }, 90_000);
});

describe('capsize rule: the sailboat', () => {
  it('Squalls, reefed as advised: close-hauled, reaching and rounding up hard over stays upright', () => {
    const cases: Record<PhysicsMode, Case[]> = {
      arcade: [
        { id: 'reach', rel: -90 * DEG, drive: { twa: 90 * DEG } },
        { id: 'hardover', rel: -90 * DEG, drive: 'hardover' },
      ],
      realistic: [
        { id: 'beat', rel: -45 * DEG, drive: { twa: 45 * DEG } },
        { id: 'hardover', rel: -90 * DEG, drive: 'hardover' },
      ],
    };
    for (const [mode, seed] of [
      ['arcade', 1],
      ['realistic', 2],
    ] as const) {
      const r = voyage('sail', 'squalls', mode, seed, cases[mode], 20);
      for (const [id, o] of Object.entries(r)) {
        expect(o.capsized, `${mode} ${id}`).toBe(false);
        expect(o.maxHeel, `${mode} ${id}`).toBeLessThan(60);
      }
    }
  }, 60_000);

  it('Hurricane Category 3, Realistic, close-hauled under storm canvas: a breaking sea rolls her over', () => {
    const r = voyage(
      'sail',
      'hurricane-3',
      'realistic',
      3,
      [{ id: 'beat', rel: -45 * DEG, drive: { twa: 45 * DEG }, x: 20_000 }],
      30,
    );
    expect(r['beat']!.capsized).toBe(true);
  }, 30_000);
});
