// Calm-water resistance targets for the towing-tank calibration:
//  - Holtrop & Mennen (1982/84) for the displacement ships and the crab boat;
//  - ITTC-1957 friction plus a DSYHS-style residuary curve for the sailboat's
//    bare canoe body (the keel and rudder are foils with their own drag);
//  - Savitsky (1964) planing prismatic for the planing hulls above the hump,
//    joined to a Mercier–Savitsky-style tabulated pre-planing hump below it.
// All return newtons for speed V (m/s) through calm water.

import { GRAVITY, NU_SEAWATER, RHO_SEAWATER } from '../core/units';
import { ittc57 } from './kerner';

const RHO = RHO_SEAWATER;
const G = GRAVITY;

export interface HoltropHull {
  L: number; // waterline length, m
  B: number;
  T: number; // mean draft
  TF: number; // draft at the forward perpendicular
  volume: number; // m³
  lcb: number; // LCB forward of 0.5 L, % of L
  CM: number;
  CWP: number;
  ABT: number; // transverse bulb area at the FP, m²
  hB: number; // centre of ABT above the keel, m
  AT: number; // immersed transom area, m²
  Sapp: number; // appendage wetted area, m²
  k2app: number; // appendage form factor (1 + k2)
  Cstern: number; // −25 pram/gondola, −10 V, 0 normal, +10 U (Hogner)
}

export interface HoltropBreakdown {
  total: number;
  friction: number; // R_F (1 + k1)
  appendage: number;
  wave: number;
  bulb: number;
  transom: number;
  correlation: number;
  wettedArea: number; // Holtrop's S estimate
  formFactor: number; // 1 + k1
}

function holtropWettedArea(h: HoltropHull): number {
  const CB = h.volume / (h.L * h.B * h.T);
  return (
    h.L *
      (2 * h.T + h.B) *
      Math.sqrt(h.CM) *
      (0.453 + 0.4425 * CB - 0.2862 * h.CM - 0.003467 * (h.B / h.T) + 0.3696 * h.CWP) +
    (2.38 * h.ABT) / CB
  );
}

export function holtropMennen(h: HoltropHull, V: number): HoltropBreakdown {
  const { L, B, T, TF, volume, lcb, CM, CWP, ABT, hB, AT } = h;
  const CB = volume / (L * B * T);
  const CP = CB / CM;
  const S = holtropWettedArea(h);
  const q = 0.5 * RHO * V * V;
  const Fn = V / Math.sqrt(G * L);
  const LR = L * (1 - CP + (0.06 * CP * lcb) / (4 * CP - 1));
  const c14 = 1 + 0.011 * h.Cstern;
  const k1 =
    0.93 +
    0.487118 *
      c14 *
      (B / L) ** 1.06806 *
      (T / L) ** 0.46106 *
      (L / LR) ** 0.121563 *
      (L ** 3 / volume) ** 0.36486 *
      (1 - CP) ** -0.604247;
  const cf = ittc57((V * L) / NU_SEAWATER);
  const friction = q * S * cf * k1;
  const appendage = q * h.Sapp * h.k2app * cf;

  const c7 = B / L < 0.11 ? 0.229577 * (B / L) ** 0.33333 : B / L < 0.25 ? B / L : 0.5 - 0.0625 * (L / B);
  const iE =
    1 +
    89 *
      Math.exp(
        -((L / B) ** 0.80856) *
          (1 - CWP) ** 0.30484 *
          Math.max(1e-6, 1 - CP - 0.0225 * lcb) ** 0.6367 *
          (LR / B) ** 0.34574 *
          ((100 * volume) / L ** 3) ** 0.16302,
      );
  const c1 = 2223105 * c7 ** 3.78613 * (T / B) ** 1.07961 * (90 - iE) ** -1.37565;
  const c3 = ABT > 0 ? (0.56 * ABT ** 1.5) / (B * T * (0.31 * Math.sqrt(ABT) + TF - hB)) : 0;
  const c2 = Math.exp(-1.89 * Math.sqrt(c3));
  const c5 = 1 - (0.8 * AT) / (B * T * CM);
  const lambda = L / B < 12 ? 1.446 * CP - 0.03 * (L / B) : 1.446 * CP - 0.36;
  const c16 = CP < 0.8 ? 8.07981 * CP - 13.8673 * CP ** 2 + 6.984388 * CP ** 3 : 1.73014 - 0.7067 * CP;
  const m1 = 0.0140407 * (L / T) - (1.75254 * volume ** (1 / 3)) / L - 4.79323 * (B / L) - c16;
  const lv = L ** 3 / volume;
  const c15 = lv < 512 ? -1.69385 : lv < 1726.91 ? -1.69385 + (L / volume ** (1 / 3) - 8) / 2.36 : 0;
  const c17 = 6919.3 * CM ** -1.3346 * (volume / L ** 3) ** 2.00977 * (L / B - 2) ** 1.40692;
  const m3 = -7.2035 * (B / L) ** 0.326869 * (T / B) ** 0.605375;
  const waveAt = (fn: number, high: boolean): number => {
    if (fn <= 0) return 0;
    const m4 = c15 * 0.4 * Math.exp(-0.034 * fn ** -3.29);
    const base = high ? c17 : c1;
    const m = high ? m3 : m1;
    return base * c2 * c5 * volume * RHO * G * Math.exp(m * fn ** -0.9 + m4 * Math.cos(lambda * fn ** -2));
  };
  let wave: number;
  if (Fn <= 0.4) wave = waveAt(Fn, false);
  else if (Fn >= 0.55) wave = waveAt(Fn, true);
  else {
    const a = waveAt(0.4, false);
    wave = a + ((10 * Fn - 4) * (waveAt(0.55, true) - a)) / 1.5;
  }

  let bulb = 0;
  if (ABT > 0) {
    const PB = (0.56 * Math.sqrt(ABT)) / (TF - 1.5 * hB);
    const Fni = V / Math.sqrt(G * (TF - hB - 0.25 * Math.sqrt(ABT)) + 0.15 * V * V);
    bulb = (0.11 * Math.exp(-3 * PB ** -2) * Fni ** 3 * ABT ** 1.5 * RHO * G) / (1 + Fni * Fni);
  }
  let transom = 0;
  if (AT > 0) {
    const FnT = V / Math.sqrt((2 * G * AT) / (B + B * CWP));
    transom = FnT < 5 ? q * AT * 0.2 * (1 - 0.2 * FnT) : 0;
  }
  const c4 = Math.min(TF / L, 0.04);
  const CA = 0.006 * (L + 100) ** -0.16 - 0.00205 + 0.003 * Math.sqrt(L / 7.5) * CB ** 4 * c2 * (0.04 - c4);
  const correlation = q * S * CA;
  return {
    total: friction + appendage + wave + bulb + transom + correlation,
    friction,
    appendage,
    wave,
    bulb,
    transom,
    correlation,
    wettedArea: S,
    formFactor: k1,
  };
}

// DSYHS-style residuary resistance of a moderate cruiser-racer canoe body
// (∇^⅓/LWL ≈ 0.18, Cp ≈ 0.55): Rr/(ρ g ∇) against Fn, condensed from the
// Delft series trend, scaled with (∇^⅓/LWL)/0.18 for slenderness.
const DSYHS_FN = [0, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7];
const DSYHS_RR = [0, 0.0001, 0.0003, 0.0008, 0.002, 0.0045, 0.01, 0.02, 0.033, 0.042, 0.048, 0.055];

export interface YachtHull {
  lwl: number;
  volume: number;
  wettedArea: number; // canoe body, m²
  formFactor: number; // 1 + k
}

export function yachtResistance(h: YachtHull, V: number): number {
  const fn = V / Math.sqrt(G * h.lwl);
  const slender = h.volume ** (1 / 3) / h.lwl / 0.18;
  const rr = interpolate(DSYHS_FN, DSYHS_RR, fn) * RHO * G * h.volume * slender;
  const rf = 0.5 * RHO * V * V * h.wettedArea * ittc57((V * 0.7 * h.lwl) / NU_SEAWATER) * h.formFactor;
  return rr + rf;
}

export interface PlaningHull {
  mass: number; // kg
  beam: number; // chine beam b, m
  deadrise: number; // rad, at the transom
  lcg: number; // CG forward of the transom, m
  length: number; // waterline length at rest, m (for the hump's Froude number)
}

export interface SavitskyResult {
  resistance: number;
  trim: number; // rad
  wettedLengthBeams: number; // λ
}

// Savitsky planing prismatic with the thrust through the CG: solve the trim
// at which the centre of pressure lies under the CG.
export function savitsky(h: PlaningHull, V: number): SavitskyResult {
  const W = h.mass * G;
  const b = h.beam;
  const beta = h.deadrise / (Math.PI / 180);
  const cv = V / Math.sqrt(G * b);
  const clb = W / (0.5 * RHO * V * V * b * b);
  // C_Lβ = C_L0 − 0.0065 β C_L0^0.6
  let cl0 = clb;
  for (let i = 0; i < 40; i++) {
    const f = cl0 - 0.0065 * beta * cl0 ** 0.6 - clb;
    const df = 1 - 0.0039 * beta * cl0 ** -0.4;
    cl0 = Math.max(1e-6, cl0 - f / df);
  }
  const lambdaFor = (tauDeg: number): number => {
    const target = cl0 / tauDeg ** 1.1;
    let lo = 0.05;
    let hi = 40;
    for (let i = 0; i < 60; i++) {
      const mid = 0.5 * (lo + hi);
      const v = 0.012 * Math.sqrt(mid) + (0.0055 * mid ** 2.5) / (cv * cv);
      if (v > target) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  };
  const lpFor = (lambda: number): number =>
    (0.75 - 1 / ((5.21 * cv * cv) / (lambda * lambda) + 2.39)) * lambda * b;
  let lo = 0.5;
  let hi = 15;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    // Higher trim → shorter wetted length → centre of pressure further aft.
    if (lpFor(lambdaFor(mid)) > h.lcg) lo = mid;
    else hi = mid;
  }
  const tauDeg = 0.5 * (lo + hi);
  const lambda = lambdaFor(tauDeg);
  const tau = tauDeg * (Math.PI / 180);
  const lift = 0.012 * Math.sqrt(lambda) * tauDeg ** 1.1;
  const vm =
    V * Math.sqrt(Math.max(0.5, 1 - (lift - 0.0065 * beta * lift ** 0.6) / (lambda * Math.cos(tau))));
  const cf = ittc57((vm * lambda * b) / NU_SEAWATER) + 0.0004;
  const df = (0.5 * RHO * vm * vm * cf * lambda * b * b) / Math.cos(h.deadrise);
  return { resistance: W * Math.tan(tau) + df / Math.cos(tau), trim: tau, wettedLengthBeams: lambda };
}

// Pre-planing R/Δ against the volumetric Froude number, Mercier–Savitsky-style
// for a hull with L/∇^⅓ ≈ 5; shorter, beamier hulls hump harder.
const HUMP_FN = [0, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5];
const HUMP_R = [0, 0.012, 0.03, 0.065, 0.1, 0.12, 0.125, 0.12, 0.105];

export function planingResistance(h: PlaningHull, V: number): number {
  const volume = h.mass / RHO;
  const fnv = V / Math.sqrt(G * volume ** (1 / 3));
  const slender = h.length / volume ** (1 / 3);
  const hump = interpolate(HUMP_FN, HUMP_R, fnv) * Math.sqrt(Math.max(1, 5 / slender)) * h.mass * G;
  if (fnv <= 2) return hump;
  const plane = savitsky(h, V).resistance;
  if (fnv >= 3) return plane;
  const t = fnv - 2;
  return hump * (1 - t) + plane * t;
}

export function interpolate(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 1;
  while (xs[i]! < x) i++;
  const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
  return ys[i - 1]! + (ys[i]! - ys[i - 1]!) * t;
}
