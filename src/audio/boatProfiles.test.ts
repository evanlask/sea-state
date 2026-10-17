import { describe, expect, it } from 'vite-plus/test';

import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';
import {
  BOAT_AUDIO,
  boostTarget,
  engineEffort,
  engineFundamental,
  engineParams,
  type EngineProfile,
  firingInterval,
  lagToward,
  MAX_WHINES,
} from './boatProfiles';

const engine = (kind: BoatKind): EngineProfile => {
  const profile = BOAT_AUDIO[kind].engine;
  if (!profile) throw new Error(`${kind} has no engine`);
  return profile;
};

const POWERED = ['cargo', 'cruise', 'crab', 'powerboat', 'pwc'] as const;

describe('engine fundamentals', () => {
  it('container ship: slow-speed two-stroke fires once per cylinder per revolution', () => {
    // 6 cylinders at 90 rpm → 1.5 rev/s × 6 = 9 Hz; 10.4 Hz at the 104 rpm design point.
    expect(engineFundamental(engine('cargo'), 90)).toBeCloseTo(9);
    expect(engineFundamental(engine('cargo'), 104)).toBeCloseTo(10.4);
    expect(engine('cargo').stroke).toBe(2);
    expect(firingInterval(engine('cargo'))).toBe(60);
  });

  it('cruise ship: generators run at constant speed whatever the pod rpm', () => {
    const cruise = engine('cruise');
    expect(engineFundamental(cruise, 0)).toBeCloseTo((514 / 60) * 8);
    expect(engineFundamental(cruise, 140)).toBe(engineFundamental(cruise, 0));
  });

  it('crab boat: V12 four-stroke at 1800 rpm fires at 180 Hz', () => {
    expect(engineFundamental(engine('crab'), 1800)).toBeCloseTo(180);
  });

  it('center console: twin V8 four-strokes at 6000 rpm fire at 400 Hz', () => {
    expect(engineFundamental(engine('powerboat'), 6000)).toBeCloseTo(400);
    expect(engine('powerboat').units).toBe(2);
  });

  it('jet ski: triple at 8000 rpm fires at 200 Hz, every 240°', () => {
    expect(engineFundamental(engine('pwc'), 8000)).toBeCloseTo(200);
    expect(firingInterval(engine('pwc'))).toBe(240);
  });

  it('every firing order and layer list fits the synth', () => {
    for (const kind of POWERED) {
      const p = engine(kind);
      expect(p.whines.length, kind).toBeLessThanOrEqual(MAX_WHINES);
      if (p.banks) expect(p.banks, kind).toHaveLength(p.cylinders);
      expect(p.cycles, kind).toBeGreaterThan(0);
    }
    // Cross-plane V8: L R R L R L L R, four firings per bank.
    expect(engine('powerboat').banks).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
  });

  it('the sailboat has no engine', () => {
    expect(BOAT_AUDIO.sail.engine).toBeNull();
  });
});

describe('engine parameters', () => {
  it('is silent when stopped and running at idle', () => {
    for (const kind of ['cargo', 'crab', 'powerboat', 'pwc'] as const) {
      const p = engine(kind);
      expect(engineParams(p, 0, 0, 0).gain, kind).toBe(0);
      expect(engineParams(p, p.idleRpm, 0, 0).gain, kind).toBeGreaterThan(0);
    }
  });

  it('gets louder and brighter with rpm and load, within the profile clamps', () => {
    for (const kind of POWERED) {
      const p = engine(kind);
      const idle = { ...engineParams(p, p.idleRpm, 0.1, 0) };
      const full = { ...engineParams(p, p.maxRpm, 1, 0) };
      expect(full.gain, kind).toBeGreaterThan(idle.gain);
      expect(full.cutoff, kind).toBeGreaterThanOrEqual(idle.cutoff);
      expect(full.cutoff, kind).toBeLessThanOrEqual(p.cutoffRange[1]);
      expect(idle.cutoff, kind).toBeGreaterThanOrEqual(p.cutoffRange[0]);
      expect(full.gain, kind).toBeLessThanOrEqual(1);
    }
  });

  it('rises in pitch monotonically with rpm', () => {
    for (const kind of ['cargo', 'crab', 'powerboat', 'pwc'] as const) {
      const p = engine(kind);
      let last = -1;
      for (let rpm = 0; rpm <= p.maxRpm; rpm += p.maxRpm / 20) {
        const f0 = engineParams(p, rpm, 0.5, 0).f0;
        expect(f0, kind).toBeGreaterThan(last);
        last = f0;
      }
    }
  });

  it('unloads an airborne jet drive: burble on, pump roar and hiss down, still bright', () => {
    const p = engine('pwc');
    const wet = { ...engineParams(p, 7000, 0.9, 0) };
    const air = { ...engineParams(p, 7000, 0.9, 1) };
    expect(air.burble).toBe(1);
    expect(wet.burble).toBe(0);
    expect(air.hissGain).toBeLessThan(wet.hissGain);
    expect(air.pumpGain).toBeLessThan(wet.pumpGain);
    expect(air.effort).toBeLessThan(wet.effort);
    expect(air.cutoff).toBeGreaterThan(0.5 * wet.cutoff);
  });

  it('turns the firing loop from closed-throttle to working pulses with effort', () => {
    for (const kind of POWERED) {
      const p = engine(kind);
      const rpm = p.fixedRpm === undefined ? p.maxRpm * 0.7 : p.maxRpm * 0.5;
      let last = -1;
      for (let load = 0; load <= 1; load += 0.1) {
        const on = engineParams(p, rpm, load, 0).onLoad;
        expect(on, kind).toBeGreaterThanOrEqual(last);
        last = on;
      }
      expect(engineParams(p, rpm, 0, 0).onLoad, kind).toBe(0);
      expect(engineParams(p, rpm, 1, 0).onLoad, kind).toBe(1);
    }
  });

  it('overrun at speed is darker and quieter than the same rpm under load', () => {
    for (const kind of ['cargo', 'crab', 'powerboat', 'pwc'] as const) {
      const p = engine(kind);
      const rpm = p.maxRpm * 0.8;
      const pulling = { ...engineParams(p, rpm, 0.8, 0) };
      const coasting = { ...engineParams(p, rpm, 0, 0) };
      expect(coasting.cutoff, kind).toBeLessThan(pulling.cutoff);
      expect(coasting.gain, kind).toBeLessThan(pulling.gain);
      expect(coasting.combustionGain, kind).toBeLessThan(pulling.combustionGain);
      expect(coasting.f0, kind).toBe(pulling.f0);
    }
  });

  it('diesel clatter is loudest at idle; petrol intake noise grows with load', () => {
    const crab = engine('crab');
    const idle = engineParams(crab, crab.idleRpm, 0.01, 0).combustionGain;
    const lightCruise = engineParams(crab, 0.6 * crab.maxRpm, 0.1, 0).combustionGain;
    expect(idle).toBeGreaterThan(lightCruise);
    const outboard = engine('powerboat');
    const loaded = engineParams(outboard, 4000, 0.6, 0).combustionGain;
    const light = engineParams(outboard, 4000, 0.05, 0).combustionGain;
    expect(loaded).toBeGreaterThan(light);
  });

  it('a turbo whine follows boost: silent and low at idle, high and loud spooled up', () => {
    const crab = engine('crab');
    const turbo = crab.whines.findIndex((w) => w.kind === 'turbo');
    const idle = { ...engineParams(crab, crab.idleRpm, 0.02, 0, undefined, 0) };
    const spooled = { ...engineParams(crab, crab.maxRpm, 1, 0, undefined, 1) };
    expect(spooled.whineFreq[turbo]).toBeCloseTo(crab.whines[turbo]?.hz ?? 0);
    expect(idle.whineFreq[turbo]).toBeLessThan(0.3 * (spooled.whineFreq[turbo] ?? 0));
    expect(idle.whineGain[turbo]).toBe(0);
    expect(spooled.whineGain[turbo]).toBeGreaterThan(0);
    // Same rpm and load, boost still lagging: lower and quieter.
    const lagging = { ...engineParams(crab, crab.maxRpm, 1, 0, undefined, 0.4) };
    expect(lagging.whineFreq[turbo]).toBeLessThan(spooled.whineFreq[turbo] ?? 0);
    expect(lagging.whineGain[turbo]).toBeLessThan(spooled.whineGain[turbo] ?? 0);
    expect(boostTarget(crab, crab.maxRpm, 1)).toBe(1);
    expect(boostTarget(crab, crab.idleRpm, 0)).toBeLessThan(0.25);
  });

  it('crank-driven whines are locked to rpm', () => {
    const outboard = engine('powerboat');
    const gear = outboard.whines[0];
    expect(gear?.kind).toBe('gear');
    expect(engineParams(outboard, 6000, 1, 0).whineFreq[0]).toBeCloseTo(gear?.hz ?? 0);
    expect(engineParams(outboard, 3000, 1, 0).whineFreq[0]).toBeCloseTo((gear?.hz ?? 0) / 2);
    // Gear whine is a high-rpm sound.
    expect(engineParams(outboard, 1000, 0.1, 0).whineGain[0]).toBeLessThan(
      0.05 * (engineParams(outboard, 6000, 1, 0).whineGain[0] ?? 0),
    );
  });

  it("sends the outboards' exhaust under water through the hub as they speed up", () => {
    const p = engine('powerboat');
    const idle = { ...engineParams(p, p.idleRpm, 0.02, 0) };
    const fast = { ...engineParams(p, p.maxRpm, 1, 0) };
    expect(idle.toneGain).toBe(1);
    expect(fast.toneGain).toBeCloseTo(p.hub?.level ?? 0);
    expect(fast.cutoff).toBeLessThan(p.cutoffRange[1] * (p.hub?.cutoff ?? 1) + 1e-9);
  });

  it('generator sets hold their speed and thicken with load', () => {
    const p = engine('cruise');
    const light = { ...engineParams(p, 20, 0.1, 0) };
    const heavy = { ...engineParams(p, 140, 0.9, 0) };
    expect(heavy.shaftRpm).toBe(p.fixedRpm);
    expect(light.shaftRpm).toBe(p.fixedRpm);
    expect(heavy.gain).toBeGreaterThan(light.gain);
    expect(heavy.onLoad).toBeGreaterThan(light.onLoad);
    expect(heavy.motorFreq).toBeGreaterThan(light.motorFreq);
  });

  it('ignores bad telemetry', () => {
    for (const kind of POWERED) {
      const p = engineParams(engine(kind), Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
      for (const [key, value] of Object.entries(p)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) expect(Number.isFinite(v), `${kind}.${key}`).toBe(true);
      }
    }
  });

  it('defines a horn in a plausible COLREG band for every boat', () => {
    expect(BOAT_AUDIO.cargo.horn.fundamental).toBeGreaterThanOrEqual(70);
    expect(BOAT_AUDIO.cargo.horn.fundamental).toBeLessThanOrEqual(150);
    expect(BOAT_AUDIO.cruise.horn.fundamental).toBeLessThanOrEqual(150);
    expect(BOAT_AUDIO.crab.horn.fundamental).toBeGreaterThanOrEqual(180);
    expect(BOAT_AUDIO.crab.horn.fundamental).toBeLessThanOrEqual(250);
    expect(BOAT_AUDIO.powerboat.horn.fundamental).toBeCloseTo(400);
    for (const kind of BOAT_KINDS) {
      const h = BOAT_AUDIO[kind].horn;
      expect(h.gain, kind).toBeGreaterThan(0);
      expect(h.gain, kind).toBeLessThanOrEqual(0.6);
      expect(h.attack, kind).toBeGreaterThan(0);
    }
  });
});

describe('engine effort', () => {
  it('reads torque from power: the propeller curve, a throttle step and overrun', () => {
    const p = engine('powerboat');
    // On the propeller curve power ∝ rpm³, so torque ∝ rpm².
    expect(engineEffort(p, p.maxRpm, 1)).toBeCloseTo(1);
    expect(engineEffort(p, p.maxRpm * 0.5, 0.125)).toBeCloseTo(0.25);
    // Throttle opened at half speed: the cylinders work flat out before the shaft catches up.
    expect(engineEffort(p, p.maxRpm * 0.5, 0.5)).toBeCloseTo(1);
    // Throttle closed at speed.
    expect(engineEffort(p, p.maxRpm * 0.8, 0)).toBe(0);
    // Near idle the division is bounded.
    expect(engineEffort(p, 10, 0.05)).toBeCloseTo(0.2);
  });

  it("is the plant's load for generator sets", () => {
    const p = engine('cruise');
    expect(engineEffort(p, 5, 0.6)).toBeCloseTo(0.6);
    expect(engineEffort(p, 140, 0.6)).toBeCloseTo(0.6);
  });
});

describe('lagToward', () => {
  it('is a one-pole lag that does not depend on the frame rate', () => {
    const one = lagToward(0, 1, 0.1, 0.5);
    let two = lagToward(0, 1, 0.05, 0.5);
    two = lagToward(two, 1, 0.05, 0.5);
    expect(two).toBeCloseTo(one, 12);
    expect(one).toBeCloseTo(1 - Math.exp(-0.2), 12);
    let v = 0;
    for (let i = 0; i < 600; i++) v = lagToward(v, 1, 1 / 60, 0.5);
    expect(v).toBeCloseTo(1, 6);
  });

  it('jumps with no lag and ignores bad input', () => {
    expect(lagToward(0.2, 0.9, 0.016, 0)).toBe(0.9);
    expect(lagToward(0.2, Number.NaN, 0.016, 1)).toBe(0.2);
    expect(lagToward(Number.NaN, 0.5, 0.016, 1)).toBe(0.5);
    expect(lagToward(0.2, 0.9, -1, 1)).toBeCloseTo(0.2, 12);
  });
});
