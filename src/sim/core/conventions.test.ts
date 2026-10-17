import { describe, expect, it } from 'vite-plus/test';

import {
  DEG,
  fromDirectionToVelocity,
  headingToVector,
  headingToYaw,
  normalizeHeading,
  relativeBearing,
  signedAngle,
  vectorToHeading,
  velocityToFromDirection,
  yawToHeading,
} from './conventions';

describe('heading conventions', () => {
  it('points north along -Z and east along +X', () => {
    const north = headingToVector(0);
    expect(north.x).toBeCloseTo(0);
    expect(north.z).toBeCloseTo(-1);
    const east = headingToVector(90 * DEG);
    expect(east.x).toBeCloseTo(1);
    expect(east.z).toBeCloseTo(0);
  });

  it('round-trips headings through vectors', () => {
    for (const degrees of [0, 45, 90, 135, 180, 225, 270, 315, 359]) {
      const v = headingToVector(degrees * DEG);
      expect(vectorToHeading(v.x, v.z) / DEG).toBeCloseTo(degrees, 6);
    }
  });

  it('wraps angles into [0, 2π) and (-π, π]', () => {
    expect(normalizeHeading(-90 * DEG) / DEG).toBeCloseTo(270);
    expect(normalizeHeading(450 * DEG) / DEG).toBeCloseTo(90);
    expect(signedAngle(270 * DEG) / DEG).toBeCloseTo(-90);
    expect(signedAngle(180 * DEG) / DEG).toBeCloseTo(180);
  });

  it('keeps a tiny negative angle inside [0, 2π)', () => {
    expect(normalizeHeading(-1e-20)).toBe(0);
    expect(normalizeHeading(-1e-20)).toBeLessThan(2 * Math.PI);
    expect(signedAngle(-1e-20)).toBeLessThanOrEqual(Math.PI);
  });

  it('round-trips yaw and heading', () => {
    expect(yawToHeading(headingToYaw(1.234))).toBeCloseTo(1.234);
  });

  it('measures relative bearings positive to starboard', () => {
    expect(relativeBearing(0, 30 * DEG) / DEG).toBeCloseTo(30);
    expect(relativeBearing(350 * DEG, 10 * DEG) / DEG).toBeCloseTo(20);
    expect(relativeBearing(10 * DEG, 350 * DEG) / DEG).toBeCloseTo(-20);
  });
});

describe('"from" directions', () => {
  it('makes a northerly wind blow toward the south (+Z)', () => {
    const v = fromDirectionToVelocity(0, 10);
    expect(v.x).toBeCloseTo(0);
    expect(v.z).toBeCloseTo(10);
  });

  it('makes a westerly wind blow toward the east (+X)', () => {
    const v = fromDirectionToVelocity(270 * DEG, 5);
    expect(v.x).toBeCloseTo(5);
    expect(v.z).toBeCloseTo(0);
  });

  it('round-trips velocity and "from" direction', () => {
    for (const degrees of [0, 30, 120, 200, 330]) {
      const v = fromDirectionToVelocity(degrees * DEG, 7);
      expect(velocityToFromDirection(v.x, v.z) / DEG).toBeCloseTo(degrees, 6);
    }
  });
});
