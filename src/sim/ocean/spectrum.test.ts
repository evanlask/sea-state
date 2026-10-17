import { describe, expect, it } from 'vite-plus/test';

import { GRAVITY } from '../core/units';
import { piersonMoskowitz as pmBulk } from '../weather/seaState';
import {
  alphaForHs,
  directionalSpectrum,
  donelanBanner,
  donelanBannerBeta,
  jonswap,
  jonswapShapeIntegral,
  OMEGA_0,
  PM_ALPHA,
  piersonMoskowitzSpectrum,
  quantizedDispersion,
  resolveSpectrum,
  swellSpreadNorm,
  T_REPEAT,
  waveNumberSpectrum,
} from './spectrum';

function integrate(f: (x: number) => number, a: number, b: number, steps = 4000): number {
  const h = (b - a) / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += f(a + (i + 0.5) * h);
  return sum * h;
}

describe('frequency spectra', () => {
  it('JONSWAP with γ = 1 integrates to α g² / (5 ωp⁴)', () => {
    expect(jonswapShapeIntegral(1)).toBeCloseTo(0.2, 6);
    expect(jonswapShapeIntegral(3.3)).toBeGreaterThan(0.25);
  });

  it('solves α so m0 matches the requested Hs', () => {
    const omegaP = 0.8;
    const alpha = alphaForHs(3, omegaP, 3.3);
    const m0 = integrate((w) => jonswap(w, alpha, omegaP, 3.3), 0.1, 30, 20000);
    expect(4 * Math.sqrt(m0)).toBeCloseTo(3, 2);
  });

  it('is consistent with the Pierson-Moskowitz bulk relations', () => {
    const u = 12;
    const bulk = pmBulk(u);
    const alpha = alphaForHs(bulk.hs, (2 * Math.PI) / bulk.tp, 1);
    expect(Math.abs(alpha / PM_ALPHA - 1)).toBeLessThan(0.02);
    const m0 = integrate((w) => piersonMoskowitzSpectrum(w, u), 0.05, 20, 20000);
    expect(Math.abs((4 * Math.sqrt(m0)) / bulk.hs - 1)).toBeLessThan(0.01);
  });
});

describe('directional spreading', () => {
  it('Donelan-Banner is normalized for every β', () => {
    for (const ratio of [0.5, 0.8, 1, 1.3, 2, 4]) {
      const beta = donelanBannerBeta(ratio);
      expect(integrate((t) => donelanBanner(t, beta), -Math.PI, Math.PI)).toBeCloseTo(1, 6);
    }
    // Narrowest at the peak.
    expect(donelanBannerBeta(0.95)).toBeGreaterThan(donelanBannerBeta(2));
  });

  it('swell spreading is normalized', () => {
    for (const s of [2, 15.5, 40, 80]) {
      const q = swellSpreadNorm(s);
      expect(integrate((t) => q * Math.cos(t / 2) ** (2 * s), -Math.PI, Math.PI)).toBeCloseTo(1, 5);
    }
  });
});

describe('wavenumber spectrum', () => {
  it('integrates over k-space to the wind-sea plus swell variance', () => {
    const r = resolveSpectrum({
      windSpeed: 9,
      windFrom: 0.4,
      fetch: 400_000,
      swell: { height: 1.5, period: 13, from: 2 },
    });
    // Polar integral ∫∫ S(k) k dk dθ on a log-k grid.
    let m0 = 0;
    const steps = 1000;
    const lnA = Math.log(1e-3);
    const lnB = Math.log(50);
    const dln = (lnB - lnA) / steps;
    const angles = 360;
    for (let i = 0; i < steps; i++) {
      const k = Math.exp(lnA + (i + 0.5) * dln);
      let ring = 0;
      for (let j = 0; j < angles; j++) {
        const t = ((j + 0.5) / angles) * 2 * Math.PI;
        ring += waveNumberSpectrum(r, k * Math.cos(t), k * Math.sin(t));
      }
      m0 += ring * ((2 * Math.PI) / angles) * k * k * dln;
    }
    const expected = (r.seaHs ** 2 + r.swellHs ** 2) / 16;
    expect(Math.abs(m0 / expected - 1)).toBeLessThan(0.01);
  });

  it('points the wind sea downwind', () => {
    // North wind: waves travel south (+z).
    const r = resolveSpectrum({ windSpeed: 10, windFrom: 0, fetch: 400_000 });
    const omega = (2 * Math.PI) / r.seaTp;
    expect(directionalSpectrum(r, omega, 0, 1)).toBeGreaterThan(100 * directionalSpectrum(r, omega, 0, -1));
  });

  it('honors a target Hs', () => {
    const r = resolveSpectrum({ windSpeed: 10, windFrom: 0, fetch: 400_000, hs: 4, tp: 9 });
    expect(r.seaHs).toBe(4);
    expect(r.seaAlpha).toBeCloseTo(alphaForHs(4, (2 * Math.PI) / 9, 3.3), 12);
  });
});

describe('quantized dispersion', () => {
  it('makes every frequency a whole multiple of 2π / T_REPEAT', () => {
    for (const k of [0.0015, 0.02, 0.3, 1.7, 9.9, 400]) {
      const w = quantizedDispersion(k);
      const cycles = (w * T_REPEAT) / (2 * Math.PI);
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(1e-6);
      expect(w).toBeLessThanOrEqual(Math.sqrt(GRAVITY * k));
      expect(Math.sqrt(GRAVITY * k) - w).toBeLessThan(OMEGA_0);
    }
  });
});
