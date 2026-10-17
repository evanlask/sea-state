// Initial spectral amplitudes h0(k) for each cascade, plus spectral moments and the choppiness cap.
//
// Texel layout (Float32Array, N×N texels × 4 floats, row-major, rows = z):
//   texel(m, n) = modeIndex(n)·N + modeIndex(m), modeIndex(m) = (m + N) mod N, kx = 2πm/L, kz = 2πn/L
//   [4·texel + 0, 1] = h0(k).re, h0(k).im
//   [4·texel + 2, 3] = conj(h0(−k)).re, conj(h0(−k)).im
// Modes outside the cascade's annulus [kMin, kMax) are zero, as is DC.
//
// Each mode's complex Gaussian comes from a hash of (seed, cascade index, m, n), never a sequential
// stream, so it does not depend on N, on evaluation order, or on the spectrum. Changing the weather
// therefore only rescales amplitudes; the phases are fixed for the life of the seed.

import type { CascadeConfig } from './cascades';
import { modeIndex, modeWaveNumber, signedMode } from './cascades';
import { hash4, hashToUnit } from './hash';
import { type ResolvedSpectrum, waveNumberSpectrum } from './spectrum';

const SECOND_UNIFORM_SALT = 0x9e3779b9;

// Box-Muller pair for one mode, as a unit complex Gaussian ξ with E|ξ|² = 1.
function modeGaussian(
  seed: number,
  cascadeIndex: number,
  m: number,
  n: number,
  out: { re: number; im: number },
): { re: number; im: number } {
  const u1 = hashToUnit(hash4(seed, cascadeIndex, m, n));
  const u2 = hashToUnit(hash4(seed ^ SECOND_UNIFORM_SALT, cascadeIndex, m, n));
  const r = Math.sqrt(-Math.log(u1)); // √(−2 ln u) / √2
  out.re = r * Math.cos(2 * Math.PI * u2);
  out.im = r * Math.sin(2 * Math.PI * u2);
  return out;
}

export interface CascadeSpectrum {
  cascade: CascadeConfig;
  h0: Float32Array;
  choppiness: number; // λ for this cascade's horizontal displacement, after assignChoppiness
  kRepresentative: number; // energy-weighted mean |k|, for depth attenuation e^{−k·depth}
  m0: number; // expected variance of this cascade's elevation, Σ S Δk², m²
  slopeVariance: number; // Σ k² S Δk², the mean-square slope it contributes
}

export class H0Generator {
  readonly cascade: CascadeConfig;
  readonly seed: number;
  private readonly active: Uint32Array; // texel index of every mode in the annulus
  private readonly partner: Uint32Array; // texel index of −k for each active mode
  private readonly noise: Float64Array; // ξ (re, im) per active mode
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;

  constructor(cascade: CascadeConfig, seed: number) {
    this.cascade = cascade;
    this.seed = seed >>> 0;
    const n = cascade.resolution;
    const dk = (2 * Math.PI) / cascade.size;
    const active: number[] = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const m = signedMode(col, n);
        const nz = signedMode(row, n);
        const k = modeWaveNumber(cascade, m, nz);
        if (k >= cascade.kMin && k < cascade.kMax) active.push(row * n + col);
      }
    }
    this.active = Uint32Array.from(active);
    this.partner = new Uint32Array(active.length);
    this.noise = new Float64Array(active.length * 2);
    this.kx = new Float64Array(active.length);
    this.kz = new Float64Array(active.length);
    const xi = { re: 0, im: 0 };
    for (let i = 0; i < active.length; i++) {
      const texel = this.active[i] as number;
      const m = signedMode(texel % n, n);
      const nz = signedMode(Math.floor(texel / n), n);
      this.partner[i] = modeIndex(-nz, n) * n + modeIndex(-m, n);
      this.kx[i] = m * dk;
      this.kz[i] = nz * dk;
      modeGaussian(this.seed, cascade.index, m, nz, xi);
      this.noise[2 * i] = xi.re;
      this.noise[2 * i + 1] = xi.im;
    }
  }

  get modeCount(): number {
    return this.active.length;
  }

  // Generates (or regenerates, with identical phases) the cascade's h0 for a spectrum.
  build(spectrum: ResolvedSpectrum, out?: CascadeSpectrum): CascadeSpectrum {
    const n = this.cascade.resolution;
    const dk = (2 * Math.PI) / this.cascade.size;
    const dk2 = dk * dk;
    const h0 = out?.h0 ?? new Float32Array(n * n * 4);
    h0.fill(0);
    let m0 = 0;
    let m1 = 0;
    let m2 = 0;
    for (let i = 0; i < this.active.length; i++) {
      const kx = this.kx[i] as number;
      const kz = this.kz[i] as number;
      const energy = waveNumberSpectrum(spectrum, kx, kz) * dk2;
      // E|h0|² = ½ S Δk², so h0(k) and conj(h0(−k)) together carry S(k) Δk² of variance.
      const a = Math.sqrt(energy / 2);
      const texel = this.active[i] as number;
      h0[4 * texel] = a * (this.noise[2 * i] as number);
      h0[4 * texel + 1] = a * (this.noise[2 * i + 1] as number);
      const k = Math.hypot(kx, kz);
      m0 += energy;
      m1 += energy * k;
      m2 += energy * k * k;
    }
    for (let i = 0; i < this.active.length; i++) {
      const texel = this.active[i] as number;
      const partner = this.partner[i] as number;
      h0[4 * texel + 2] = h0[4 * partner] as number;
      h0[4 * texel + 3] = -(h0[4 * partner + 1] as number);
    }
    const geometricMid = Math.sqrt(this.cascade.kMin * this.cascade.kMax);
    const result = out ?? {
      cascade: this.cascade,
      h0,
      choppiness: 0,
      kRepresentative: 0,
      m0: 0,
      slopeVariance: 0,
    };
    result.h0 = h0;
    result.m0 = m0;
    result.slopeVariance = m2;
    result.kRepresentative = m0 > 0 ? m1 / m0 : geometricMid;
    result.choppiness = spectrum.choppiness;
    return result;
  }
}

// Choppiness cap. With D = iλk̂h, the Jacobian is J ≈ 1 + div D, and div D = −λ Σ |k| h e^{ik·x} has
// standard deviation λ·√(mean-square slope). Keeping JACOBIAN_PEAK_SIGMAS standard deviations of
// headroom above jMin means folds (J < jMin) are rare enough that Newton inversion stays well-posed.
const JACOBIAN_PEAK_SIGMAS = 3.5;
const JACOBIAN_MIN_PHYSICS = 0.1; // physics cascades alone
const JACOBIAN_MIN_TOTAL = 0; // physics + visual on the GPU

function choppinessCap(slopeVariance: number, jacobianMin: number): number {
  if (slopeVariance <= 0) return Infinity;
  return (1 - jacobianMin) / (JACOBIAN_PEAK_SIGMAS * Math.sqrt(slopeVariance));
}

// Physics cascades get the cap computed from physics alone, so physics never depends on graphics
// quality. Visual cascades get whatever budget is left for the full GPU sum to keep J above 0.
function assignChoppiness(
  physics: readonly CascadeSpectrum[],
  visual: readonly CascadeSpectrum[],
  requested: number,
): { physics: number; visual: number } {
  let physicsSlope = 0;
  for (const c of physics) physicsSlope += c.slopeVariance;
  let visualSlope = 0;
  for (const c of visual) visualSlope += c.slopeVariance;
  const lambdaPhysics = Math.min(requested, choppinessCap(physicsSlope, JACOBIAN_MIN_PHYSICS));
  const budget = (1 - JACOBIAN_MIN_TOTAL) / JACOBIAN_PEAK_SIGMAS;
  const remaining = Math.max(0, budget * budget - lambdaPhysics * lambdaPhysics * physicsSlope);
  const lambdaVisual = visualSlope > 0 ? Math.min(requested, Math.sqrt(remaining / visualSlope)) : requested;
  for (const c of physics) c.choppiness = lambdaPhysics;
  for (const c of visual) c.choppiness = lambdaVisual;
  return { physics: lambdaPhysics, visual: lambdaVisual };
}

export interface OceanSpectra {
  spectrum: ResolvedSpectrum;
  physics: CascadeSpectrum[];
  visual: CascadeSpectrum[];
  choppinessPhysics: number;
  choppinessVisual: number;
}

// Builds and rebuilds every cascade for a fixed seed; the generators cache the per-mode noise, so a
// weather change costs one spectrum evaluation per mode. Visual cascades are optional (GPU only).
export class OceanSpectrumBuilder {
  readonly seed: number;
  private readonly physics: H0Generator[];
  private readonly visual: H0Generator[];

  constructor(physics: readonly CascadeConfig[], visual: readonly CascadeConfig[], seed: number) {
    this.seed = seed;
    this.physics = physics.map((cascade) => new H0Generator(cascade, seed));
    this.visual = visual.map((cascade) => new H0Generator(cascade, seed));
  }

  build(spectrum: ResolvedSpectrum): OceanSpectra {
    const physics = this.physics.map((generator) => generator.build(spectrum));
    const visual = this.visual.map((generator) => generator.build(spectrum));
    const lambda = assignChoppiness(physics, visual, spectrum.choppiness);
    return { spectrum, physics, visual, choppinessPhysics: lambda.physics, choppinessVisual: lambda.visual };
  }
}

// Weather transitions blend h0 linearly from the old to the new spectrum with this weight. CPU and GPU
// both evaluate it from the shared simTime, so they agree to the frame. Smoothstep avoids a kink in the
// wave energy at either end.
export function transitionBlend(startTime: number, duration: number, t: number): number {
  if (!(duration > 0)) return t >= startTime ? 1 : 0; // (a NaN duration is a step, not NaN weights)
  const x = (t - startTime) / duration;
  if (!(x > 0)) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

// out = a + (b − a)·w, element-wise; out may alias a or b.
export function blendH0(out: Float32Array, a: Float32Array, b: Float32Array, w: number): Float32Array {
  for (let i = 0; i < out.length; i++) {
    const x = a[i] as number;
    out[i] = x + ((b[i] as number) - x) * w;
  }
  return out;
}
