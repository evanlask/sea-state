// Droplet size distribution and the spray scale of a hull.
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import { hullSprayScale, powerLawRadius } from './sprayMath';

const samples = (alpha: number, min = 0.004, max = 0.03, n = 2000): number[] =>
  Array.from({ length: n }, (_, i) => powerLawRadius(min, max, alpha, (i + 0.5) / n));

describe('power-law droplet sizes', () => {
  it('stays within its range and grows with u', () => {
    for (const alpha of [0, 1, 2.5, 3]) {
      const r = samples(alpha);
      expect(Math.min(...r)).toBeGreaterThanOrEqual(0.004 - 1e-9);
      expect(Math.max(...r)).toBeLessThanOrEqual(0.03 + 1e-9);
      for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
    }
    expect(powerLawRadius(0.01, 0.01, 3, 0.5)).toBe(0.01);
  });

  it('is uniform at alpha 0 and log-uniform at alpha 1', () => {
    expect(powerLawRadius(1, 3, 0, 0.5)).toBeCloseTo(2);
    expect(powerLawRadius(1, 100, 1, 0.5)).toBeCloseTo(10);
    expect(powerLawRadius(1, 100, 1.0005, 0.5)).toBeCloseTo(10, 1); // continuous through alpha 1
  });

  it('makes most spray droplets small and a few large', () => {
    const r = samples(2.5);
    const median = r[r.length / 2]!;
    expect(median).toBeLessThan(0.0065); // half are under ~6 mm
    expect(r.filter((x) => x > 0.02).length / r.length).toBeLessThan(0.05); // under 5 % over 2 cm
    // Yet the big ones still cover a good share of the view (area ∝ r²).
    const area = (lo: number, hi: number): number =>
      r.filter((x) => x >= lo && x < hi).reduce((sum, x) => sum + x * x, 0);
    expect(area(0.012, 0.031) / area(0, 0.031)).toBeGreaterThan(0.25);
  });
});

describe('hull spray scale', () => {
  it('is 1 for the center console and grows with the hull, within limits', () => {
    expect(hullSprayScale(BOAT_SPECS.powerboat.dimensions.lwl)).toBeCloseTo(1, 1);
    expect(hullSprayScale(BOAT_SPECS.pwc.dimensions.lwl)).toBeCloseTo(0.57, 1);
    expect(hullSprayScale(BOAT_SPECS.crab.dimensions.lwl)).toBeCloseTo(1.94, 1);
    expect(hullSprayScale(BOAT_SPECS.cargo.dimensions.lwl)).toBe(4);
    expect(hullSprayScale(0.1)).toBe(0.5);
  });
});
