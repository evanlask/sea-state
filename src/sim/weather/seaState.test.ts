import { describe, expect, it } from 'vite-plus/test';

import { knotsToMs } from '../core/units';
import {
  autoSeaBulk,
  fullyDevelopedTp,
  HS_CAP,
  jonswapFetchLimited,
  PM_HS_COEFF,
  PM_TP_COEFF,
  piersonMoskowitz,
  resolveSeaState,
  softCapHs,
} from './seaState';

describe('Pierson-Moskowitz', () => {
  it('matches the practical coefficients', () => {
    expect(PM_HS_COEFF).toBeCloseTo(0.0224, 3);
    expect(PM_TP_COEFF).toBeCloseTo(0.75, 2);
  });

  it('gives Hs ≈ 2.2 m and Tp ≈ 7.5 s at 10 m/s', () => {
    const pm = piersonMoskowitz(10);
    expect(pm.hs).toBeGreaterThan(2.15);
    expect(pm.hs).toBeLessThan(2.3);
    expect(pm.tp).toBeCloseTo(7.5, 1);
  });
});

describe('JONSWAP fetch-limited', () => {
  it('gives Hs ≈ 3.3 m at 20 m/s over 100 km', () => {
    const j = jonswapFetchLimited(20, 100_000);
    expect(j.hs).toBeGreaterThan(3.15);
    expect(j.hs).toBeLessThan(3.4);
    expect(Math.abs(j.tp / (0.62 * Math.cbrt(20 * 100)) - 1)).toBeLessThan(0.01);
  });

  it('meets Pierson-Moskowitz with a matching period where the curves cross', () => {
    const u = 15;
    // 0.0163 U √F_km = PM_HS_COEFF U² → F in metres:
    const crossing = 1000 * ((PM_HS_COEFF * u) / 0.0163) ** 2;
    const j = jonswapFetchLimited(u, crossing);
    const pm = piersonMoskowitz(u);
    expect(Math.abs(j.hs - pm.hs) / pm.hs).toBeLessThan(0.02);
    expect(Math.abs(j.tp - pm.tp) / pm.tp).toBeLessThan(0.05);
  });
});

describe('auto sea state', () => {
  it('takes the smaller of the two limits', () => {
    expect(autoSeaBulk(8).hs).toBeCloseTo(piersonMoskowitz(8).hs, 6);
    expect(autoSeaBulk(25).hs).toBeCloseTo(jonswapFetchLimited(25, 400_000).hs, 6);
    expect(autoSeaBulk(25, 400_000, true).hs).toBeCloseTo(softCapHs(piersonMoskowitz(25).hs), 6);
  });

  it('roughly follows the Beaufort probable heights with the default fetch', () => {
    expect(autoSeaBulk(knotsToMs(18)).hs).toBeCloseTo(2, 0);
    expect(autoSeaBulk(knotsToMs(52)).hs).toBeCloseTo(9, 0);
  });

  it('caps hurricane seas softly and continuously', () => {
    expect(softCapHs(5)).toBe(5);
    expect(softCapHs(12)).toBe(12);
    expect(softCapHs(12.001)).toBeCloseTo(12.001, 3);
    expect(softCapHs(40)).toBeLessThan(HS_CAP);
    for (let hs = 12; hs < 60; hs += 1) expect(softCapHs(hs + 1)).toBeGreaterThan(softCapHs(hs));
    const cat5 = autoSeaBulk(knotsToMs(145), 250_000).hs;
    expect(cat5).toBeGreaterThan(16);
    expect(cat5).toBeLessThan(HS_CAP);
  });
});

describe('resolveSeaState', () => {
  it('derives a manual sea from a Douglas code and a fully developed period', () => {
    const sea = resolveSeaState(
      {
        mode: 'manual',
        height: { kind: 'douglas', code: 5 },
        tp: null,
        choppiness: 1.2,
        crestLength: 'long',
        directionOffset: 0.2,
        swell: { height: 2, period: 14, from: 1 },
      },
      10,
      0.5,
    );
    expect(sea.hs).toBeCloseTo(3.25, 6);
    expect(sea.tp).toBeCloseTo(fullyDevelopedTp(3.25), 6);
    expect(sea.windSeaFrom).toBeCloseTo(0.7, 9);
    expect(sea.spreading).toBeGreaterThan(1);
    expect(sea.totalHs).toBeCloseTo(Math.hypot(3.25, 2), 9);
    expect(sea.douglas).toBe(5);
  });

  it('follows the wind in auto mode', () => {
    const sea = resolveSeaState({ mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null }, 10, 1);
    expect(sea.hs).toBeCloseTo(piersonMoskowitz(10).hs, 6);
    expect(sea.windSeaFrom).toBe(1);
    expect(sea.swell).toBeNull();
  });

  it('ignores a swell with no period, as the spectrum does', () => {
    const swell = { height: 3, period: 0, from: 1 };
    const sea = resolveSeaState({ mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell }, 10, 1);
    expect(sea.swell).toBeNull();
    expect(sea.totalHs).toBeCloseTo(sea.hs, 12);
  });
});
