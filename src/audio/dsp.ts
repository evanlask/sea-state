// Offline DSP for the procedural sound kit: seamless noise loops and one-shot renderers (slams,
// splashes, creaks, winch ratchets, thunder cracks, breaking crests, laps, sail snaps, rain-drop
// loops). Everything renders into plain Float32Arrays from a seeded RNG, so it runs and is tested
// in node; the engine copies the results into AudioBuffers once at start-up.

import { Rng } from '../sim/core/rng';

// RBJ biquad, transposed direct form II. Bandpass has a 0 dB peak.
export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  static lowpass(freq: number, q: number, sampleRate: number): Biquad {
    return new Biquad().set('lowpass', freq, q, sampleRate);
  }

  static highpass(freq: number, q: number, sampleRate: number): Biquad {
    return new Biquad().set('highpass', freq, q, sampleRate);
  }

  static bandpass(freq: number, q: number, sampleRate: number): Biquad {
    return new Biquad().set('bandpass', freq, q, sampleRate);
  }

  set(type: 'lowpass' | 'highpass' | 'bandpass', freq: number, q: number, sampleRate: number): this {
    const w = (2 * Math.PI * Math.min(freq, sampleRate * 0.49)) / sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 1e-3));
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 'lowpass') {
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = b0;
    } else if (type === 'highpass') {
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = b0;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

export type NoiseColor = 'white' | 'pink' | 'brown';

// Generates `length` samples of coloured noise that loop without a seam: `fade` extra samples are
// rendered and cross-faded (equal power, the halves being uncorrelated) into the start.
export function noiseLoop(color: NoiseColor, length: number, rng: Rng, fade = 2048): Float32Array {
  const total = length + fade;
  const raw = new Float32Array(total);
  // Paul Kellet's pink filter state.
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  let p3 = 0;
  let p4 = 0;
  let p5 = 0;
  let p6 = 0;
  let brown = 0;
  for (let i = 0; i < total; i++) {
    const white = rng.next() * 2 - 1;
    if (color === 'white') {
      raw[i] = white;
    } else if (color === 'pink') {
      p0 = 0.99886 * p0 + white * 0.0555179;
      p1 = 0.99332 * p1 + white * 0.0750759;
      p2 = 0.969 * p2 + white * 0.153852;
      p3 = 0.8665 * p3 + white * 0.3104856;
      p4 = 0.55 * p4 + white * 0.5329522;
      p5 = -0.7616 * p5 - white * 0.016898;
      raw[i] = (p0 + p1 + p2 + p3 + p4 + p5 + p6 + white * 0.5362) * 0.11;
      p6 = white * 0.115926;
    } else {
      // Leaky integrator: brown below ~150 Hz without DC drift.
      brown = (brown + 0.02 * white) / 1.02;
      raw[i] = brown * 3.5;
    }
  }
  const out = raw.subarray(0, length);
  const n = Math.min(fade, length);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = (raw[i] ?? 0) * Math.sqrt(t) + (raw[length + i] ?? 0) * Math.sqrt(1 - t);
  }
  return normalizePeak(new Float32Array(out), 0.9);
}

function normalizePeak(data: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i] ?? 0));
  if (max > 0) {
    const k = peak / max;
    for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) * k;
  }
  return data;
}

export function peakOf(data: Float32Array): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i] ?? 0));
  return max;
}

export function rmsOf(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, data.length));
}

// Adds a damped sine (a struck resonance) at `start` seconds; `glide` sweeps its pitch by that
// factor per second (bubbles rise in pitch as they shrink). Writes wrap when `wrap` is set, which
// keeps drop textures loopable.
function addPing(
  out: Float32Array,
  sampleRate: number,
  start: number,
  freq: number,
  decay: number,
  amp: number,
  glide = 0,
  wrap = false,
): void {
  const begin = Math.round(start * sampleRate);
  const n = Math.round(decay * 6 * sampleRate);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    let j = begin + i;
    if (wrap) j %= out.length;
    else if (j >= out.length) break;
    const t = i / sampleRate;
    phase += (2 * Math.PI * freq * (1 + glide * t)) / sampleRate;
    out[j] = (out[j] ?? 0) + amp * Math.exp(-t / decay) * Math.sin(phase);
  }
}

const envAttackDecay = (t: number, attack: number, decay: number): number =>
  t < attack ? t / attack : Math.exp(-(t - attack) / decay);

// Hull slam: a falling low "thump", the impact's crunch and a spray tail.
export function renderSlam(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.round(1.4 * sampleRate);
  const out = new Float32Array(n);
  const lowpass = Biquad.lowpass(900 + rng.next() * 400, 0.8, sampleRate);
  const spray = Biquad.bandpass(2200 + rng.next() * 1200, 0.7, sampleRate);
  const f1 = 95 + rng.next() * 30;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = 38 + (f1 - 38) * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * f) / sampleRate;
    const thump = Math.sin(phase) * envAttackDecay(t, 0.003, 0.12);
    const white = rng.next() * 2 - 1;
    const crunch = lowpass.process(white) * envAttackDecay(t, 0.002, 0.06);
    const tail = t < 0.02 ? 0 : spray.process(white) * envAttackDecay(t - 0.02, 0.03, 0.35);
    out[i] = 0.9 * thump + 0.7 * crunch + 0.5 * tail;
  }
  for (let k = 0; k < 14; k++) {
    addPing(out, sampleRate, 0.05 + rng.next() * 0.7, 1500 + rng.next() * 2500, 0.004, 0.08, 0.5);
  }
  return normalizePeak(out, 0.9);
}

// Bow splash: a soft-attack noise burst with droplets falling back.
export function renderSplash(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.round(0.9 * sampleRate);
  const out = new Float32Array(n);
  const band = Biquad.bandpass(900 + rng.next() * 800, 0.6, sampleRate);
  const high = Biquad.highpass(300, 0.7, sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = high.process(band.process(rng.next() * 2 - 1)) * envAttackDecay(t, 0.04, 0.22);
  }
  for (let k = 0; k < 16; k++) {
    addPing(out, sampleRate, 0.08 + rng.next() * 0.6, 1400 + rng.next() * 2600, 0.005, 0.1, 0.8);
  }
  return normalizePeak(out, 0.8);
}

// Creak: stick-slip pulses (a groan whose rate glides) exciting two structural resonances.
export function renderCreak(sampleRate: number, rng: Rng): Float32Array {
  const duration = 0.5 + rng.next() * 0.7;
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  const r1 = Biquad.bandpass(320 + rng.next() * 380, 9, sampleRate);
  const r2 = Biquad.bandpass(1100 + rng.next() * 700, 7, sampleRate);
  const startRate = 35 + rng.next() * 40;
  const endRate = startRate * (0.6 + rng.next() * 1.4);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let x = 0;
    if (t >= next) {
      x = 1;
      const rate = startRate + (endRate - startRate) * (t / duration);
      next = t + (1 / rate) * (0.7 + 0.6 * rng.next()); // irregular slip intervals
    }
    const swell = Math.sin((Math.PI * t) / duration) ** 1.5;
    out[i] = (r1.process(x) * 1.2 + r2.process(x) * 0.6) * swell;
  }
  return normalizePeak(out, 0.7);
}

// Winch ratchet: a run of metallic pawl clicks.
export function renderWinch(sampleRate: number, rng: Rng, clicks = 8, rate = 16): Float32Array {
  const n = Math.round((clicks / rate + 0.15) * sampleRate);
  const out = new Float32Array(n);
  const body = 850 + rng.next() * 200;
  for (let k = 0; k < clicks; k++) {
    const t = k / rate + (rng.next() - 0.5) * 0.006;
    const amp = 0.6 + 0.4 * rng.next();
    addPing(out, sampleRate, Math.max(0, t), 3100 + rng.next() * 500, 0.0025, amp);
    addPing(out, sampleRate, Math.max(0, t), body, 0.006, amp * 0.5);
    addPing(out, sampleRate, Math.max(0, t), 6200 + rng.next() * 800, 0.0012, amp * 0.4);
  }
  return normalizePeak(out, 0.7);
}

// Thunder crack: a ripping burst of impulses with a bright noise flash and a short low boom.
export function renderCrack(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.round(1.8 * sampleRate);
  const out = new Float32Array(n);
  const hp = Biquad.highpass(700, 0.7, sampleRate);
  const lp = Biquad.lowpass(160, 0.9, sampleRate);
  const rip = 0.25 + rng.next() * 0.2;
  let next = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    let impulse = 0;
    if (t < rip && t >= next) {
      impulse = (rng.next() * 2 - 1) * (1 - t / rip);
      next = t + 1 / (200 + rng.next() * 500);
    }
    const white = rng.next() * 2 - 1;
    const flash = hp.process(white) * envAttackDecay(t, 0.002, 0.18);
    const boom = lp.process(white) * envAttackDecay(t, 0.02, 0.6);
    out[i] = 1.2 * impulse + 0.6 * flash + 2.5 * boom;
  }
  return normalizePeak(out, 0.95);
}

// Breaking crest: a rising roar of white water collapsing into fizz.
export function renderCrest(sampleRate: number, rng: Rng): Float32Array {
  const duration = 2 + rng.next() * 1.2;
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  const lp = Biquad.lowpass(1800 + rng.next() * 1200, 0.7, sampleRate);
  const hp = Biquad.highpass(150, 0.7, sampleRate);
  const fizz = Biquad.highpass(3000, 0.7, sampleRate);
  const attack = 0.25 + rng.next() * 0.25;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const rise = t < attack ? (t / attack) ** 2 : Math.exp(-(t - attack) / 0.7);
    const white = rng.next() * 2 - 1;
    const tail = Math.exp(-Math.max(0, t - attack) / 1.2) * Math.min(1, t / attack);
    const fade = Math.min(1, (duration - t) / 0.2);
    out[i] = (hp.process(lp.process(white)) * rise + 0.3 * fizz.process(white) * tail) * fade;
  }
  return normalizePeak(out, 0.8);
}

// Lap: a small wave slapping the hull, with a couple of bubbles.
export function renderLap(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.round(0.6 * sampleRate);
  const out = new Float32Array(n);
  const band = Biquad.bandpass(380 + rng.next() * 250, 1.3, sampleRate);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = band.process(rng.next() * 2 - 1) * envAttackDecay(t, 0.05, 0.13);
  }
  const bubbles = 2 + Math.floor(rng.next() * 3);
  for (let k = 0; k < bubbles; k++) {
    addPing(out, sampleRate, 0.05 + rng.next() * 0.3, 550 + rng.next() * 700, 0.012, 0.25, 6);
  }
  return normalizePeak(out, 0.7);
}

// Sail snap: the crack of a flogging leech, with a short flutter after.
export function renderFlogSnap(sampleRate: number, rng: Rng): Float32Array {
  const n = Math.round(0.35 * sampleRate);
  const out = new Float32Array(n);
  const band = Biquad.bandpass(700 + rng.next() * 600, 0.8, sampleRate);
  const flutter = 18 + rng.next() * 10;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const am = t < 0.02 ? 1 : 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * flutter * t));
    out[i] = band.process(rng.next() * 2 - 1) * envAttackDecay(t, 0.002, 0.07) * am;
  }
  return normalizePeak(out, 0.8);
}

// Loopable rain-drop texture. 'deck' drops tick on hard surfaces; 'water' drops make the rising
// "plink" of an entrained bubble, with the odd low plop.
export function renderDrops(
  sampleRate: number,
  rng: Rng,
  seconds: number,
  dropsPerSecond: number,
  flavour: 'deck' | 'water',
): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  const count = Math.round(seconds * dropsPerSecond);
  for (let k = 0; k < count; k++) {
    const t = rng.next() * seconds;
    const amp = 0.15 + 0.85 * rng.next() ** 2;
    if (flavour === 'deck') {
      addPing(out, sampleRate, t, 2200 + rng.next() * 4500, 0.0008 + rng.next() * 0.0012, amp, 0, true);
      addPing(out, sampleRate, t, 700 + rng.next() * 900, 0.002, amp * 0.3, 0, true);
    } else {
      addPing(out, sampleRate, t, 900 + rng.next() * 2600, 0.003 + rng.next() * 0.006, amp * 0.6, 4, true);
      if (rng.next() < 0.08) addPing(out, sampleRate, t, 180 + rng.next() * 150, 0.01, amp * 0.5, 1, true);
    }
  }
  return normalizePeak(out, 0.8);
}

// Single-cycle harmonic tables for PeriodicWave, from amplitudes of harmonics 1..n. A seeded phase
// jitter keeps the wave from being a perfectly symmetric (buzzy) sawtooth.
export function harmonicTables(
  amplitudes: readonly number[],
  seed: number,
): { real: Float32Array; imag: Float32Array } {
  const rng = new Rng(seed);
  const n = amplitudes.length + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let h = 1; h < n; h++) {
    const a = amplitudes[h - 1] ?? 0;
    const phase = rng.next() * Math.PI * 2;
    real[h] = a * Math.cos(phase);
    imag[h] = a * Math.sin(phase);
  }
  return { real, imag };
}
