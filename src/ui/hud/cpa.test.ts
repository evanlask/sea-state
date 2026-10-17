import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../../sim/core/conventions';
import { closestApproach, trackFrom } from './cpa';

describe('CPA / TCPA', () => {
  it('meets head-on vessels at zero CPA halfway in time', () => {
    const own = trackFrom(0, 0, 0, 5); // north at 5 m/s
    const other = trackFrom(0, 1000, Math.PI, 5); // 1 km ahead, heading south
    const a = closestApproach(own, other);
    expect(a.range).toBeCloseTo(1000);
    expect(a.cpa).toBeCloseTo(0, 6);
    expect(a.tcpa).toBeCloseTo(100);
  });

  it('finds the miss distance of a crossing vessel', () => {
    // Own boat north at 5 m/s; the other 1 km east, heading west at 5 m/s, 200 m further north.
    const own = trackFrom(0, 0, 0, 5);
    const other = { x: 1000, y: 200, vx: -5, vy: 0 };
    const a = closestApproach(own, other);
    expect(a.tcpa).toBeCloseTo(120);
    expect(a.cpa).toBeCloseTo(Math.SQRT2 * 400, 3);
  });

  it('reports a negative TCPA once the closest point has passed', () => {
    const own = trackFrom(0, 0, 0, 5);
    const other = trackFrom(180 * DEG, 500, 180 * DEG, 5); // astern and opening
    const a = closestApproach(own, other);
    expect(a.tcpa).toBeLessThan(0);
  });

  it('treats vessels on the same course and speed as not closing', () => {
    const own = trackFrom(0, 0, 90 * DEG, 6);
    const other = trackFrom(0, 300, 90 * DEG, 6);
    const a = closestApproach(own, other);
    expect(a.tcpa).toBe(0);
    expect(a.cpa).toBeCloseTo(300);
  });

  it('builds tracks from bearings and courses (east = +x, north = +y)', () => {
    const t = trackFrom(90 * DEG, 100, 180 * DEG, 2);
    expect(t.x).toBeCloseTo(100);
    expect(t.y).toBeCloseTo(0);
    expect(t.vx).toBeCloseTo(0);
    expect(t.vy).toBeCloseTo(-2);
  });
});
