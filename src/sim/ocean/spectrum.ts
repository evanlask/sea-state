// Directional wave spectra: JONSWAP / Pierson-Moskowitz frequency spectra with Donelan-Banner spreading
// for the wind sea, an independent narrow swell (Horvath 2015), short-wave damping, the conversion to a
// wavenumber spectrum S(kx, kz), and the quantized deep-water dispersion shared with the GPU.
//
// Spectral density units: S(ω) in m²·s, S(ω, θ) in m²·s/rad, S(kx, kz) in m⁴ (so Σ S Δk² is m²).

import { GRAVITY } from '../core/units';
import {
  autoSeaBulk,
  DEFAULT_FETCH,
  JONSWAP_GAMMA,
  type ResolvedSeaState,
  type SwellSettings,
  type WaveBulk,
} from '../weather/seaState';

// Every mode's frequency is a whole multiple of ω0, so the whole ocean repeats exactly after T_REPEAT.
export const T_REPEAT = 1000; // s
export const OMEGA_0 = (2 * Math.PI) / T_REPEAT;

// Gaussian roll-off of the finest ripples, e^{-(k/k_d)²}, so the last cascade's cut-off is not a cliff.
// Fixed (not quality-dependent) so it is the same everywhere and never touches the physics band.
const DAMPING_WAVELENGTH = 0.01; // m
const DAMPING_K = (2 * Math.PI) / DAMPING_WAVELENGTH;

const DEFAULT_SWELL_GAMMA = 5; // narrow-banded, well-travelled swell
const DEFAULT_SWELL_SPREAD = 40; // s in cos^{2s}(θ/2); Goda gives 25–75 for long swell

// ω(k) = floor(√(g|k|)/ω0)·ω0. The GPU must use the same formula (in f32 the floor is safe: the
// largest ω/ω0 is ~3e5, well inside f32's exact-integer range).
export function quantizedDispersion(k: number): number {
  return Math.floor(Math.sqrt(GRAVITY * k) / OMEGA_0) * OMEGA_0;
}

// JONSWAP spectral width: σ = 0.07 below the peak, 0.09 above.
export function jonswap(omega: number, alpha: number, omegaP: number, gamma: number): number {
  if (omega <= 0 || alpha <= 0) return 0;
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const x = omegaP / omega;
  const x2 = x * x;
  const d = (omega - omegaP) / (sigma * omegaP);
  const r = Math.exp(-0.5 * d * d);
  const w2 = omega * omega;
  return ((alpha * GRAVITY * GRAVITY) / (w2 * w2 * omega)) * Math.exp(-1.25 * x2 * x2) * Math.pow(gamma, r);
}

// Pierson-Moskowitz is JONSWAP with γ = 1, α = 8.1e-3 and ωp = 0.877 g / U19.5.
export const PM_ALPHA = 8.1e-3;

export function piersonMoskowitzSpectrum(omega: number, u10: number): number {
  if (u10 <= 0) return 0;
  return jonswap(omega, PM_ALPHA, (0.877 * GRAVITY) / (1.026 * u10), 1);
}

const shapeIntegrals = new Map<number, number>();

// ∫ x⁻⁵ e^{-1.25 x⁻⁴} γ^r(x) dx over x = ω/ωp, so m0 = α g² ωp⁻⁴ · I(γ). I(1) = 1/5 exactly.
export function jonswapShapeIntegral(gamma: number): number {
  const cached = shapeIntegrals.get(gamma);
  if (cached !== undefined) return cached;
  const a = 0.25;
  const b = 25;
  const steps = 8000; // Simpson; even
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = a + i * h;
    const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
    sum += weight * jonswap(x, 1 / (GRAVITY * GRAVITY), 1, gamma);
  }
  // Beyond b the tail is a pure x⁻⁵; below a the exponential makes it negligible.
  const value = (sum * h) / 3 + 1 / (4 * b ** 4);
  shapeIntegrals.set(gamma, value);
  return value;
}

// Phillips constant that gives a JONSWAP spectrum of significant height hs.
export function alphaForHs(hs: number, omegaP: number, gamma: number): number {
  const m0 = (hs * hs) / 16;
  const w2 = omegaP * omegaP;
  return (m0 * w2 * w2) / (GRAVITY * GRAVITY * jonswapShapeIntegral(gamma));
}

// Donelan, Hamilton & Hui (1985) with Banner's (1990) extension above 1.6 ωp.
export function donelanBannerBeta(omegaRatio: number): number {
  if (omegaRatio < 0.95) return 2.61 * Math.pow(Math.max(omegaRatio, 0.56), 1.3);
  if (omegaRatio < 1.6) return 2.28 * Math.pow(omegaRatio, -1.3);
  const e = -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(omegaRatio * omegaRatio));
  return Math.pow(10, e);
}

// Normalized over θ ∈ (-π, π]: ∫ β sech²(βθ) / (2 tanh βπ) dθ = 1.
export function donelanBanner(theta: number, beta: number): number {
  const c = Math.cosh(beta * theta);
  return beta / (2 * Math.tanh(beta * Math.PI) * c * c);
}

// Normalization of cos^{2s}(θ/2) over (-π, π], by quadrature (s is not always an integer).
export function swellSpreadNorm(s: number): number {
  const steps = 4096;
  const h = (2 * Math.PI) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const theta = -Math.PI + (i + 0.5) * h;
    sum += Math.pow(Math.abs(Math.cos(theta / 2)), 2 * s);
  }
  return 1 / (sum * h);
}

interface SwellParams extends SwellSettings {
  gamma?: number;
  spread?: number; // s in cos^{2s}(θ/2); larger is narrower
}

export interface SpectrumParams {
  windSpeed: number; // U10, m/s
  windFrom: number; // radians, meteorological
  fetch: number; // m
  // Target wind-sea Hs and Tp. When omitted they follow the wind (smaller of fetch-limited and fully
  // developed, soft-capped); when given, amplitudes scale so the spectrum's m0 matches hs exactly.
  hs?: number;
  tp?: number;
  fullyDeveloped?: boolean;
  gamma?: number;
  directionOffset?: number; // wind-sea direction relative to the wind's "from", radians
  spreading?: number; // Donelan-Banner β multiplier: >1 long-crested, <1 short-crested
  swell?: SwellParams | null;
  choppiness?: number; // requested horizontal displacement scale (capped per cascade set later)
}

// Precomputed constants for fast evaluation. Plain numbers so it is cheap to clone and post.
export interface ResolvedSpectrum {
  seaHs: number;
  seaTp: number;
  seaAlpha: number;
  seaOmegaP: number;
  seaGamma: number;
  seaDirX: number; // unit propagation direction (downwind)
  seaDirZ: number;
  spreading: number;
  swellHs: number;
  swellTp: number;
  swellAlpha: number;
  swellOmegaP: number;
  swellGamma: number;
  swellDirX: number;
  swellDirZ: number;
  swellSpread: number;
  swellNorm: number;
  dampingK: number;
  choppiness: number;
}

const bulk: WaveBulk = { hs: 0, tp: 0 };

export function resolveSpectrum(params: SpectrumParams): ResolvedSpectrum {
  autoSeaBulk(params.windSpeed, params.fetch, params.fullyDeveloped ?? false, bulk);
  const seaHs = Math.max(0, params.hs ?? bulk.hs);
  const seaTp = params.tp ?? bulk.tp;
  const seaGamma = params.gamma ?? JONSWAP_GAMMA;
  const seaOmegaP = seaTp > 0 ? (2 * Math.PI) / seaTp : 0;
  const seaFrom = params.windFrom + (params.directionOffset ?? 0);

  const swell = params.swell;
  const swellHs = swell && swell.height > 0 && swell.period > 0 ? swell.height : 0;
  const swellTp = swellHs > 0 && swell ? swell.period : 0;
  const swellGamma = swell?.gamma ?? DEFAULT_SWELL_GAMMA;
  const swellOmegaP = swellTp > 0 ? (2 * Math.PI) / swellTp : 0;
  const swellSpread = swell?.spread ?? DEFAULT_SWELL_SPREAD;
  const swellFrom = swell?.from ?? 0;

  return {
    seaHs,
    seaTp,
    seaAlpha: seaHs > 0 && seaOmegaP > 0 ? alphaForHs(seaHs, seaOmegaP, seaGamma) : 0,
    seaOmegaP,
    seaGamma,
    seaDirX: -Math.sin(seaFrom),
    seaDirZ: Math.cos(seaFrom),
    spreading: params.spreading ?? 1,
    swellHs,
    swellTp,
    swellAlpha: swellHs > 0 ? alphaForHs(swellHs, swellOmegaP, swellGamma) : 0,
    swellOmegaP,
    swellGamma,
    swellDirX: -Math.sin(swellFrom),
    swellDirZ: Math.cos(swellFrom),
    swellSpread,
    swellNorm: swellHs > 0 ? swellSpreadNorm(swellSpread) : 0,
    dampingK: DAMPING_K,
    choppiness: Math.max(0, params.choppiness ?? 1),
  };
}

export function spectrumParamsFromSeaState(
  sea: ResolvedSeaState,
  windSpeed: number,
  windFrom: number,
  fetch: number = DEFAULT_FETCH,
): SpectrumParams {
  return {
    windSpeed,
    windFrom,
    fetch,
    hs: sea.hs,
    tp: sea.tp,
    gamma: sea.gamma,
    directionOffset: sea.windSeaFrom - windFrom,
    spreading: sea.spreading,
    swell: sea.swell,
    choppiness: sea.choppiness,
  };
}

// Angle between a unit wave direction and a unit mean direction, in [0, π].
function angleBetween(ux: number, uz: number, dx: number, dz: number): number {
  return Math.abs(Math.atan2(ux * dz - uz * dx, ux * dx + uz * dz));
}

// Directional frequency spectrum S(ω, θ) for a unit propagation direction (ux, uz).
export function directionalSpectrum(r: ResolvedSpectrum, omega: number, ux: number, uz: number): number {
  let s = 0;
  if (r.seaAlpha > 0) {
    const beta = donelanBannerBeta(omega / r.seaOmegaP) * r.spreading;
    s +=
      jonswap(omega, r.seaAlpha, r.seaOmegaP, r.seaGamma) *
      donelanBanner(angleBetween(ux, uz, r.seaDirX, r.seaDirZ), beta);
  }
  if (r.swellAlpha > 0) {
    const theta = angleBetween(ux, uz, r.swellDirX, r.swellDirZ);
    s +=
      jonswap(omega, r.swellAlpha, r.swellOmegaP, r.swellGamma) *
      r.swellNorm *
      Math.pow(Math.cos(theta / 2), 2 * r.swellSpread);
  }
  return s;
}

// S(kx, kz) = S(ω, θ) · (dω/dk) / k with deep-water ω = √(gk), dω/dk = g / 2ω. The amplitude uses the
// exact dispersion; only the time evolution uses the quantized ω.
export function waveNumberSpectrum(r: ResolvedSpectrum, kx: number, kz: number): number {
  const k = Math.hypot(kx, kz);
  if (k <= 0) return 0;
  const omega = Math.sqrt(GRAVITY * k);
  const jacobian = GRAVITY / (2 * omega * k);
  const damping = Math.exp(-(k * k) / (r.dampingK * r.dampingK));
  return directionalSpectrum(r, omega, kx / k, kz / k) * jacobian * damping;
}
