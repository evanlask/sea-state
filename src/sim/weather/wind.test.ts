import { describe, expect, it } from 'vite-plus/test';

import { vec3 } from '../core/math';
import { WindField } from './wind';

describe('WindField', () => {
  it('averages to U10 over a long window', () => {
    const wind = new WindField({ speed: 12, from: 0.3, gustFactor: 1.45 }, 7);
    let sum = 0;
    let count = 0;
    for (let t = 0; t < 3600; t += 0.5, count++) sum += wind.speedAt(10, t);
    expect(Math.abs(sum / count / 12 - 1)).toBeLessThan(0.02);
  });

  it('reaches about the gust factor as a 10-minute peak', () => {
    const gustFactor = 1.4;
    let peaks = 0;
    let windows = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const wind = new WindField({ speed: 10, from: 0, gustFactor }, seed);
      for (let w = 0; w < 6; w++, windows++) {
        let peak = 0;
        for (let t = w * 600; t < (w + 1) * 600; t += 0.5) peak = Math.max(peak, wind.speedAt(10, t) / 10);
        peaks += peak;
      }
    }
    expect(Math.abs(peaks / windows - gustFactor) / (gustFactor - 1)).toBeLessThan(0.15);
  });

  it('is steady with a gust factor of 1', () => {
    const wind = new WindField({ speed: 8, from: 2, gustFactor: 1 }, 3);
    for (let t = 0; t < 100; t += 7) expect(wind.speedAt(10, t)).toBeCloseTo(8, 9);
  });

  it('blows away from the "from" direction', () => {
    const wind = new WindField({ speed: 10, from: 0, gustFactor: 1 }, 1);
    const v = wind.velocityAt(0, 10, 0, 0, vec3());
    // A north wind blows toward the south (+Z).
    expect(v.z).toBeCloseTo(10, 9);
    expect(v.x).toBeCloseTo(0, 9);
  });

  it('advects gusts downwind with the mean flow', () => {
    const wind = new WindField({ speed: 10, from: Math.PI / 2, gustFactor: 1.5 }, 11);
    // An east wind moves air toward -X: the gust at the origin reaches x = -100 m ten seconds later.
    const a = wind.velocityAt(0, 10, 0, 50, vec3());
    const b = wind.velocityAt(-100, 10, 0, 60, vec3());
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(a.z, 9);
  });

  it('follows the log profile', () => {
    const wind = new WindField({ speed: 10, from: 0, gustFactor: 1 }, 1);
    expect(wind.shear(10)).toBeCloseTo(1, 12);
    const ratio = wind.speedAt(30, 0) / wind.speedAt(10, 0);
    expect(ratio).toBeGreaterThan(1.06);
    expect(ratio).toBeLessThan(1.12);
    expect(wind.shear(0)).toBe(wind.shear(0.5));
    expect(wind.shear(2)).toBeLessThan(1);
  });

  it('is deterministic per seed', () => {
    const a = new WindField({ speed: 10, from: 1, gustFactor: 1.3 }, 5);
    const b = new WindField({ speed: 10, from: 1, gustFactor: 1.3 }, 5);
    const c = new WindField({ speed: 10, from: 1, gustFactor: 1.3 }, 6);
    expect(a.speedAt(10, 123.4)).toBe(b.speedAt(10, 123.4));
    expect(a.speedAt(10, 123.4)).not.toBe(c.speedAt(10, 123.4));
  });
});
