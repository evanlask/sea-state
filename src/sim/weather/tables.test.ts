import { describe, expect, it } from 'vite-plus/test';

import { knotsToMs } from '../core/units';
import {
  BEAUFORT,
  beaufortFromWind,
  DOUGLAS,
  douglasFromHs,
  douglasRepresentativeHs,
  saffirSimpsonFromWind,
} from './tables';

describe('Beaufort', () => {
  it('covers forces 0–12 with contiguous ranges', () => {
    expect(BEAUFORT.map((b) => b.force)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (let i = 1; i < BEAUFORT.length; i++) {
      const prev = BEAUFORT[i - 1];
      const cur = BEAUFORT[i];
      expect(cur?.minMs).toBeCloseTo((prev?.maxMs ?? 0) + 0.1, 6);
      expect(cur?.minKn).toBe((prev?.maxKn ?? 0) + 1);
    }
  });

  it('uses the WMO wave heights', () => {
    const probable = BEAUFORT.map((b) => b.probableWaveHeight);
    const max = BEAUFORT.map((b) => b.maxWaveHeight);
    expect(probable.slice(3)).toEqual([0.6, 1, 2, 3, 4, 5.5, 7, 9, 11.5, 14]);
    expect(max.slice(3)).toEqual([1, 1.5, 2.5, 4, 5.5, 7.5, 10, 12.5, 16, null]);
  });

  it('looks up forces from m/s', () => {
    expect(beaufortFromWind(0).force).toBe(0);
    expect(beaufortFromWind(1).force).toBe(1);
    expect(beaufortFromWind(5.4).force).toBe(3);
    expect(beaufortFromWind(5.5).force).toBe(4);
    expect(beaufortFromWind(10).force).toBe(5);
    expect(beaufortFromWind(17.2).force).toBe(8);
    expect(beaufortFromWind(20.75).force).toBe(9);
    expect(beaufortFromWind(32.6).force).toBe(11);
    expect(beaufortFromWind(32.7).force).toBe(12);
    expect(beaufortFromWind(80).force).toBe(12);
    expect(beaufortFromWind(knotsToMs(38)).force).toBe(8);
    expect(beaufortFromWind(knotsToMs(52)).force).toBe(10);
  });
});

describe('Douglas sea state', () => {
  it('has the WMO 3700 names', () => {
    expect(DOUGLAS.map((d) => d.name)).toEqual([
      'Calm (glassy)',
      'Calm (rippled)',
      'Smooth (wavelets)',
      'Slight',
      'Moderate',
      'Rough',
      'Very rough',
      'High',
      'Very high',
      'Phenomenal',
    ]);
  });

  it('looks up codes from Hs', () => {
    const cases: [number, number][] = [
      [0, 0],
      [0.05, 1],
      [0.1, 1],
      [0.3, 2],
      [0.5, 2],
      [1, 3],
      [1.25, 3],
      [2, 4],
      [3, 5],
      [5, 6],
      [7, 7],
      [10, 8],
      [14, 8],
      [15, 9],
    ];
    for (const [hs, code] of cases) expect(douglasFromHs(hs).code, `Hs ${hs}`).toBe(code);
  });

  it('maps codes back to an Hs inside the range', () => {
    for (let code = 1; code <= 9; code++)
      expect(douglasFromHs(douglasRepresentativeHs(code)).code).toBe(code);
    expect(douglasRepresentativeHs(0)).toBe(0);
  });
});

describe('Saffir-Simpson', () => {
  it('returns null below hurricane force', () => {
    expect(saffirSimpsonFromWind(knotsToMs(63))).toBeNull();
    expect(saffirSimpsonFromWind(20)).toBeNull();
  });

  it('looks up categories from m/s', () => {
    const cases: [number, number][] = [
      [64, 1],
      [82, 1],
      [83, 2],
      [95, 2],
      [96, 3],
      [112, 3],
      [113, 4],
      [136, 4],
      [137, 5],
      [180, 5],
    ];
    for (const [kn, category] of cases) expect(saffirSimpsonFromWind(knotsToMs(kn))?.category).toBe(category);
  });
});
