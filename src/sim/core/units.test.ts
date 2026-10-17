import { describe, expect, it } from 'vite-plus/test';

import { convertLength, convertSpeed, knotsToMs, msToKnots } from './units';

describe('units', () => {
  it('converts knots exactly (1 kn = 1852 m/h)', () => {
    expect(knotsToMs(1)).toBeCloseTo(0.514444, 6);
    expect(msToKnots(knotsToMs(24))).toBeCloseTo(24);
  });

  it('converts display speeds', () => {
    expect(convertSpeed(10, 'kn')).toBeCloseTo(19.4384, 3);
    expect(convertSpeed(10, 'mph')).toBeCloseTo(22.3694, 3);
    expect(convertSpeed(10, 'kmh')).toBeCloseTo(36);
  });

  it('converts lengths', () => {
    expect(convertLength(3.048, 'ft')).toBeCloseTo(10);
    expect(convertLength(5, 'm')).toBe(5);
  });
});
