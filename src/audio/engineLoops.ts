// Offline engine-cycle loops for EngineSynth. Each loop holds `cycles` complete engine cycles at the
// engine's top speed (its root rpm), so playback only ever slows it down, or speeds it up a little
// with Doppler: playbackRate = rpm / root. Rendered in the crank-angle domain, everything in it
// scales with rpm as it does in a real engine (pulse widths are crank angles, turbulence frequencies
// follow the gas speed). Four channels:
//   0  exhaust pulses under load: per firing, the time derivative of a blowdown flow pulse (what a
//      pipe radiates) plus the turbulent noise riding it
//   1  the same firings at closed throttle or idle: weaker, more ragged, the odd miss and pop
//   2  combustion envelope 0..1: gates EngineSynth's block/intake noise per firing
//   3  valve-train tick envelope 0..1 (engines with a `tick` only)
// Per-cylinder level spread, bank asymmetry (the cross-plane V8's burble) and cycle-to-cycle timing
// and level jitter are drawn per firing from a seeded RNG, so no two cycles are alike, and twin
// units started at different points in the loop never coincide. Pulses wrap around the loop end
// and the band-limiting filters run over the loop twice, so the loop is seamless.

import { Rng } from '../sim/core/rng';
import { cycleDegrees, type EngineProfile, firingInterval } from './boatProfiles';
import { Biquad } from './dsp';

// Loops are rendered at 24 kHz whatever the context's rate: the firing note is low-passed far below
// that live, and reading a 24 kHz buffer at playbackRate r steps r·24/44.1 buffer frames per output
// frame, under one (so no aliasing at all) up to r ≈ 1.8: more than overspeed and Doppler ever ask.
export const LOOP_SAMPLE_RATE = 24000;
export const LOOP_MAX_RATE = 1.8;
// Content above this (Hz at the root) is filtered out, so linear-interpolation images stay faint.
export const LOOP_BANDWIDTH = 9000;
const LOOP_RMS = 0.25; // channel 0's level; channel 1 keeps its level relative to it

export interface EngineLoop {
  channels: Float32Array[]; // 3 or 4, see above
  sampleRate: number;
  rootRpm: number; // exact: a whole number of samples per cycle
  cycles: number;
  samplesPerCycle: number;
}

export interface Firing {
  angle: number; // crank ° within the cycle
  bank: number;
  cylinder: number;
}

// The firing order: evenly spaced, each on its bank.
export function firingSchedule(profile: EngineProfile): Firing[] {
  const interval = firingInterval(profile);
  return Array.from({ length: profile.cylinders }, (_, i) => ({
    angle: i * interval,
    bank: profile.banks?.[i] ?? 0,
    cylinder: i,
  }));
}

// The rpm the loop is rendered at.
export const loopRoot = (profile: EngineProfile): number => profile.fixedRpm ?? profile.maxRpm;

// Normal deviate clamped to ±2.5σ, so one wild draw can't make a firing land on its neighbour.
const deviate = (rng: Rng): number => Math.max(-2.5, Math.min(2.5, rng.gaussian()));

// Blowdown flow pulse q(x) = x^k·e^{k(1−x)} (peak 1 at x = 1, x in pulse widths): the extent beyond
// which it's negligible, and 1 / the peak of |dq/dx| to normalize the radiated pulse. Memoized by k.
const pulseShapes = new Map<number, { extent: number; norm: number }>();
function pulseShape(k: number): { extent: number; norm: number } {
  let shape = pulseShapes.get(k);
  if (!shape) {
    let extent = 1;
    while (k * (extent - 1 - Math.log(extent)) < 7) extent += 0.05;
    let peak = 0;
    for (let x = 0.001; x < extent; x += 0.001) {
      peak = Math.max(peak, Math.abs(Math.pow(x, k) * Math.exp(k * (1 - x)) * k * (1 / x - 1)));
    }
    shape = { extent, norm: 1 / peak };
    pulseShapes.set(k, shape);
  }
  return shape;
}

class Writer {
  readonly n: number;
  readonly degPerSample: number;
  private readonly rng: Rng;

  constructor(n: number, degPerSample: number, rng: Rng) {
    this.n = n;
    this.degPerSample = degPerSample;
    this.rng = rng;
  }

  // Adds the radiated pressure of one flow pulse starting at crank angle `at` (loop-wrapped).
  pulse(out: Float32Array, at: number, level: number, width: number, k: number, noise: number): void {
    const { extent, norm } = pulseShape(k);
    const start = at / this.degPerSample;
    const end = start + (extent * width) / this.degPerSample;
    const dx = this.degPerSample / width;
    for (let j = Math.ceil(start); j < end; j++) {
      const x = (j - start) * dx;
      if (x <= 0) continue;
      const q = Math.exp(k * (Math.log(x) + 1 - x));
      const slope = q * k * (1 / x - 1) * norm;
      const i = ((j % this.n) + this.n) % this.n;
      out[i] = (out[i] ?? 0) + level * (slope + noise * q * (this.rng.next() * 2 - 1));
    }
  }

  // Adds an attack/decay envelope (crank degrees) starting at `at`.
  envelope(out: Float32Array, at: number, level: number, attack: number, decay: number): void {
    const start = at / this.degPerSample;
    const peak = start + attack / this.degPerSample;
    const end = start + (attack + 7 * decay) / this.degPerSample;
    const fall = Math.exp(-this.degPerSample / decay);
    let e = 0;
    for (let j = Math.ceil(start); j < end; j++) {
      if (j < peak) e = ((j - start) * this.degPerSample) / attack;
      else e = e > 0 && j - 1 >= peak ? e * fall : Math.exp(-((j - peak) * this.degPerSample) / decay);
      const i = ((j % this.n) + this.n) % this.n;
      out[i] = (out[i] ?? 0) + level * e;
    }
  }
}

// 4th-order Butterworth low-pass run twice round the loop: the first pass settles the filter state
// on the loop's own tail, so the output wraps without a seam.
function bandLimit(data: Float32Array, cutoff: number, sampleRate: number): void {
  const stages = [Biquad.lowpass(cutoff, 0.5412, sampleRate), Biquad.lowpass(cutoff, 1.3066, sampleRate)];
  const run = (write: boolean): void => {
    for (let i = 0; i < data.length; i++) {
      let x = data[i] ?? 0;
      for (const s of stages) x = s.process(x);
      if (write) data[i] = x;
    }
  };
  run(false);
  run(true);
}

function rms(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, data.length));
}

export function renderEngineLoop(
  profile: EngineProfile,
  seed: number,
  sampleRate = LOOP_SAMPLE_RATE,
): EngineLoop {
  const rng = new Rng(seed);
  const cycleDeg = cycleDegrees(profile);
  const revsPerCycle = cycleDeg / 360;
  const samplesPerCycle = Math.max(16, Math.round(((revsPerCycle * 60) / loopRoot(profile)) * sampleRate));
  const rootRpm = (revsPerCycle * 60 * sampleRate) / samplesPerCycle;
  const cycles = Math.max(1, Math.round(profile.cycles));
  const n = samplesPerCycle * cycles;
  const w = new Writer(n, cycleDeg / samplesPerCycle, rng);
  const on = new Float32Array(n);
  const light = new Float32Array(n);
  const combustion = new Float32Array(n);
  const tick = profile.tick ? new Float32Array(n) : null;

  const interval = firingInterval(profile);
  const { width, sharpness, noise } = profile.pulse;
  const cylLevel = Array.from({ length: profile.cylinders }, () => 1 + profile.spread * (rng.next() * 2 - 1));
  // Manifold runners differ in length: each cylinder's pulse arrives a little early or late.
  const cylOffset = Array.from({ length: profile.cylinders }, () => 0.5 * profile.jitter.deg * deviate(rng));
  // Each cylinder's two valves seat at their own points in its interval.
  const valveAt = Array.from({ length: profile.cylinders }, () => [
    rng.range(0.15, 0.4),
    rng.range(0.55, 0.85),
  ]);
  const schedule = firingSchedule(profile);
  const { deg: jitterDeg, level: jitterLevel } = profile.jitter;

  for (let c = 0; c < cycles; c++) {
    for (const f of schedule) {
      const bankGain = profile.bankGain?.[f.bank] ?? 1;
      const offset = (profile.bankLag?.[f.bank] ?? 0) + (cylOffset[f.cylinder] ?? 0);
      const at = c * cycleDeg + f.angle + offset + jitterDeg * deviate(rng);
      const level = Math.max(0.2, (cylLevel[f.cylinder] ?? 1) * bankGain * (1 + jitterLevel * deviate(rng)));
      w.pulse(on, at, level, width, sharpness, noise);
      w.envelope(combustion, at, level, 0.04 * interval, 0.22 * interval);

      // Closed throttle: thin charges burn unevenly, now and then not at all, now and then late
      // in the pipe (a pop).
      if (rng.next() >= profile.light.misfire) {
        const thin = Math.max(0.1, 1 + 2 * jitterLevel * deviate(rng));
        const late = jitterDeg * deviate(rng);
        w.pulse(light, at + late, level * profile.light.level * thin, width * 1.15, sharpness, noise * 1.3);
      }
      if (rng.next() < profile.light.pop) {
        w.pulse(light, at + 0.4 * width, level * 1.3, width * 0.35, sharpness * 1.5, noise * 2);
      }

      if (tick) {
        for (const v of valveAt[f.cylinder] ?? []) {
          w.envelope(tick, at + v * cycleDeg * 0.5, rng.range(0.5, 1), 0.5, 6);
        }
      }
    }
    // A direct-drive propeller's blades sweep past the hull plating, crank-locked: soft pressure
    // pulses whatever the throttle.
    if (profile.blades) {
      const { count, level } = profile.blades;
      for (let rev = 0; rev < revsPerCycle; rev++) {
        for (let b = 0; b < count; b++) {
          const at = c * cycleDeg + rev * 360 + (b * 360) / count + 0.3 * jitterDeg * deviate(rng);
          const bladeWidth = (0.2 * 360) / count;
          w.pulse(on, at, level, bladeWidth, 2, 0.1);
          w.pulse(light, at, level, bladeWidth, 2, 0.1);
        }
      }
    }
  }

  const cutoff = Math.min(LOOP_BANDWIDTH, 0.4 * sampleRate);
  bandLimit(on, cutoff, sampleRate);
  bandLimit(light, cutoff, sampleRate);
  const scale = LOOP_RMS / Math.max(rms(on), 1e-9);
  for (let i = 0; i < n; i++) {
    on[i] = (on[i] ?? 0) * scale;
    light[i] = (light[i] ?? 0) * scale;
  }
  const channels = [on, light, normalizeEnvelope(combustion)];
  if (tick) channels.push(normalizeEnvelope(tick));
  return { channels, sampleRate, rootRpm, cycles, samplesPerCycle };
}

function normalizeEnvelope(data: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, data[i] ?? 0);
  if (peak > 0) for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) / peak;
  return data;
}
