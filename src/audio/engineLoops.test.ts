import { describe, expect, it } from 'vite-plus/test';

import { BOAT_AUDIO, type BoatAudioProfile, cycleDegrees, type EngineProfile } from './boatProfiles';
import { Biquad } from './dsp';
import {
  type EngineLoop,
  firingSchedule,
  LOOP_BANDWIDTH,
  LOOP_MAX_RATE,
  LOOP_SAMPLE_RATE,
  loopRoot,
  renderEngineLoop,
} from './engineLoops';

const POWERED = ['cargo', 'cruise', 'crab', 'powerboat', 'pwc'] as const;

const engine = (profile: BoatAudioProfile): EngineProfile => {
  if (!profile.engine) throw new Error('no engine');
  return profile.engine;
};

const loops = new Map<string, EngineLoop>();
const loopOf = (kind: (typeof POWERED)[number]): EngineLoop => {
  let loop = loops.get(kind);
  if (!loop) {
    loop = renderEngineLoop(engine(BOAT_AUDIO[kind]), 42);
    loops.set(kind, loop);
  }
  return loop;
};

const sumSquares = (data: ArrayLike<number>): number => {
  let s = 0;
  for (let i = 0; i < data.length; i++) s += (data[i] ?? 0) ** 2;
  return s;
};

// Cycle-synchronous average: the share of the channel's energy that repeats every engine cycle,
// and the power of that average at each order (harmonic of the cycle) up to maxOrder.
function cycleAnalysis(
  loop: EngineLoop,
  channel: number,
  maxOrder: number,
): { periodic: number; orders: number[] } {
  const x = loop.channels[channel] ?? new Float32Array(0);
  const period = loop.samplesPerCycle;
  const average = new Float64Array(period);
  for (let c = 0; c < loop.cycles; c++) {
    for (let i = 0; i < period; i++) average[i] = (average[i] ?? 0) + (x[c * period + i] ?? 0) / loop.cycles;
  }
  const orders: number[] = [0];
  for (let k = 1; k <= Math.min(maxOrder, period / 2); k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < period; i++) {
      const a = (2 * Math.PI * k * i) / period;
      re += (average[i] ?? 0) * Math.cos(a);
      im -= (average[i] ?? 0) * Math.sin(a);
    }
    orders.push(re * re + im * im);
  }
  return { periodic: (sumSquares(average) * loop.cycles) / sumSquares(x), orders };
}

// Share of the order spectrum at multiples of `every` (the firing harmonics when every = cylinders).
const shareAt = (orders: readonly number[], every: number): number => {
  let all = 0;
  let at = 0;
  orders.forEach((p, k) => {
    if (k === 0) return;
    all += p;
    if (k % every === 0) at += p;
  });
  return at / all;
};

describe('firing schedule', () => {
  it('fires every cylinder once per cycle, evenly', () => {
    for (const kind of POWERED) {
      const p = engine(BOAT_AUDIO[kind]);
      const schedule = firingSchedule(p);
      expect(schedule, kind).toHaveLength(p.cylinders);
      schedule.forEach((f, i) => expect(f.angle, kind).toBeCloseTo((i * cycleDegrees(p)) / p.cylinders));
    }
  });

  it('puts the cross-plane V8 firings on their banks', () => {
    const banks = firingSchedule(engine(BOAT_AUDIO.powerboat)).map((f) => f.bank);
    expect(banks).toEqual([0, 1, 1, 0, 1, 0, 0, 1]);
  });
});

describe('engine loops', () => {
  it('holds whole engine cycles at the root rpm, in 3 or 4 finite channels', () => {
    for (const kind of POWERED) {
      const p = engine(BOAT_AUDIO[kind]);
      const loop = loopOf(kind);
      expect(loop.sampleRate, kind).toBe(LOOP_SAMPLE_RATE);
      expect(loop.channels.length, kind).toBe(p.tick ? 4 : 3);
      for (const ch of loop.channels) {
        expect(ch.length, kind).toBe(loop.samplesPerCycle * loop.cycles);
        expect(ch.every(Number.isFinite), kind).toBe(true);
      }
      // A whole number of samples per cycle, so the rpm is nudged by at most half a sample.
      const cycleSeconds = cycleDegrees(p) / 360 / (loop.rootRpm / 60);
      expect(cycleSeconds * loop.sampleRate, kind).toBeCloseTo(loop.samplesPerCycle, 6);
      expect(Math.abs(loop.rootRpm / loopRoot(p) - 1), kind).toBeLessThan(0.5 / loop.samplesPerCycle + 1e-9);
    }
  });

  it('loops without a seam', () => {
    for (const kind of POWERED) {
      const loop = loopOf(kind);
      for (const [c, ch] of loop.channels.entries()) {
        let mean = 0;
        let max = 0;
        for (let i = 1; i < ch.length; i++) {
          const step = Math.abs((ch[i] ?? 0) - (ch[i - 1] ?? 0));
          mean += step / (ch.length - 1);
          max = Math.max(max, step);
        }
        const wrap = Math.abs((ch[0] ?? 0) - (ch[ch.length - 1] ?? 0));
        // The wrap is an ordinary step: no bigger than the loop's own largest, and for the pulse
        // channels no bigger than a typical one (the envelopes' attacks are steep by design).
        expect(wrap, `${kind} ch${c}`).toBeLessThanOrEqual(max);
        if (c < 2) expect(wrap, `${kind} ch${c}`).toBeLessThan(12 * mean);
      }
    }
  });

  it('is band-limited, and played no faster than LOOP_MAX_RATE it cannot alias', () => {
    // Reading a 24 kHz buffer at up to LOOP_MAX_RATE steps at most one frame per output frame at
    // 44.1 kHz, so nothing folds back...
    expect((LOOP_MAX_RATE * LOOP_SAMPLE_RATE) / 44100).toBeLessThanOrEqual(1);
    expect(LOOP_BANDWIDTH).toBeLessThanOrEqual(0.4 * LOOP_SAMPLE_RATE);
    for (const kind of POWERED) {
      const p = engine(BOAT_AUDIO[kind]);
      // ...and the synth never asks for more: rev-limiter overshoot with a fast Doppler shift.
      expect(((p.maxRpm * 1.05) / loopRoot(p)) * 1.15, kind).toBeLessThan(LOOP_MAX_RATE);
      // Content near the buffer's Nyquist (where interpolation images would be loud) is 50 dB down.
      const loop = loopOf(kind);
      for (const ch of loop.channels.slice(0, 2)) {
        const a = Biquad.highpass(1.25 * LOOP_BANDWIDTH, 0.54, loop.sampleRate);
        const b = Biquad.highpass(1.25 * LOOP_BANDWIDTH, 1.31, loop.sampleRate);
        let high = 0;
        for (let pass = 0; pass < 2; pass++) {
          for (let i = 0; i < ch.length; i++) {
            const y = b.process(a.process(ch[i] ?? 0));
            if (pass === 1) high += y * y;
          }
        }
        expect(10 * Math.log10(high / sumSquares(ch)), kind).toBeLessThan(-50);
      }
    }
  });

  it('sounds at the firing frequency and its harmonics, with cycle-to-cycle variation', () => {
    for (const kind of ['cruise', 'crab', 'pwc'] as const) {
      const p = engine(BOAT_AUDIO[kind]);
      const { periodic, orders } = cycleAnalysis(loopOf(kind), 0, 120);
      // Mostly the repeating cycle, but never a perfect repeat (that's the buzzer sound).
      expect(periodic, kind).toBeGreaterThan(0.6);
      expect(periodic, kind).toBeLessThan(0.98);
      // Evenly firing engines: the cycle's energy sits on the firing harmonics.
      expect(shareAt(orders, p.cylinders), kind).toBeGreaterThan(0.9);
    }
  });

  it('gives the cross-plane V8 its burble: lines between the firing harmonics', () => {
    const v8 = engine(BOAT_AUDIO.powerboat);
    const steady = { ...v8, spread: 0, jitter: { deg: 0, level: 0 } };
    const even = { ...steady, bankGain: [1, 1], bankLag: [0, 0] };
    const firing = (p: EngineProfile): number =>
      shareAt(cycleAnalysis(renderEngineLoop(p, 1), 0, 4 * p.cylinders).orders, p.cylinders);
    expect(firing(even)).toBeGreaterThan(0.999);
    const crossPlane = firing(steady);
    expect(crossPlane).toBeLessThan(0.9);
    expect(crossPlane).toBeGreaterThan(0.5); // still a V8, not a lumpy four
  });

  it("fires the cargo ship's cylinders louder than its propeller blades", () => {
    const { orders } = cycleAnalysis(loopOf('cargo'), 0, 60);
    expect(shareAt(orders, 6)).toBeGreaterThan(shareAt(orders, 5));
  });

  it('closed-throttle firings are weaker and more ragged than working ones', () => {
    for (const kind of POWERED) {
      const loop = loopOf(kind);
      const on = cycleAnalysis(loop, 0, 60);
      const light = cycleAnalysis(loop, 1, 60);
      const level = Math.sqrt(sumSquares(loop.channels[1] ?? []) / sumSquares(loop.channels[0] ?? []));
      expect(level, kind).toBeLessThan(0.85);
      if (kind !== 'cargo') expect(light.periodic, kind).toBeLessThan(on.periodic); // cargo: blades dominate
    }
  });

  it('normalizes the envelopes to 0..1', () => {
    for (const kind of POWERED) {
      for (const ch of loopOf(kind).channels.slice(2)) {
        let min = Infinity;
        let max = -Infinity;
        for (const v of ch) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
        expect(min, kind).toBeGreaterThanOrEqual(0);
        expect(max, kind).toBeCloseTo(1, 6);
      }
    }
  });

  it('is reproducible from its seed', () => {
    const p = engine(BOAT_AUDIO.pwc);
    const a = renderEngineLoop(p, 7).channels[0];
    const b = renderEngineLoop(p, 7).channels[0];
    const c = renderEngineLoop(p, 8).channels[0];
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
