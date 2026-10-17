import { describe, expect, it } from 'vite-plus/test';

import { Rng, deriveSeed } from './rng';

describe('Rng', () => {
  it('is deterministic for a seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('stays in [0, 1)', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('produces roughly standard-normal gaussians', () => {
    const rng = new Rng(3);
    let sum = 0;
    let sumSquares = 0;
    const n = 50_000;
    for (let i = 0; i < n; i++) {
      const g = rng.gaussian();
      sum += g;
      sumSquares += g * g;
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(sumSquares / n - mean * mean).toBeCloseTo(1, 1);
  });

  it('derives distinct, stable sub-seeds', () => {
    expect(deriveSeed(1, 'ocean')).toBe(deriveSeed(1, 'ocean'));
    expect(deriveSeed(1, 'ocean')).not.toBe(deriveSeed(1, 'clouds'));
    expect(deriveSeed(1, 'ocean')).not.toBe(deriveSeed(2, 'ocean'));
  });
});
