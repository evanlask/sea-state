import { describe, expect, it } from 'vite-plus/test';

import {
  RIPPLE_CELL,
  RIPPLE_FOOTPRINT_FULL,
  RIPPLE_FOOTPRINT_GONE,
  RIPPLE_MAX_RADIUS,
  rainRippleParams,
} from './rainRipples';

describe('rain ripples', () => {
  it('are off while it is dry', () => {
    expect(rainRippleParams(0)).toMatchObject({ density: 0, slope: 0, variance: 0 });
    expect(rainRippleParams(-1).density).toBe(0);
  });

  it('grow denser, steeper and rougher with the rain', () => {
    let previous = rainRippleParams(0.05);
    expect(previous.density).toBeGreaterThan(0);
    for (const rain of [0.2, 0.5, 0.8, 1]) {
      const next = rainRippleParams(rain);
      expect(next.density).toBeGreaterThan(previous.density);
      expect(next.slope).toBeGreaterThan(previous.slope);
      expect(next.variance).toBeGreaterThan(previous.variance);
      previous = next;
    }
    expect(rainRippleParams(2)).toEqual(rainRippleParams(1));
    expect(rainRippleParams(1).density).toBeLessThanOrEqual(1);
  });

  it('keep a fixed period, so a weather blend never restarts the rings', () => {
    expect(rainRippleParams(0.1).period).toBe(rainRippleParams(0.9).period);
    // The ripple clock wraps at an hour: a whole number of periods, so no phase jump.
    expect((3600 / rainRippleParams(0.5).period) % 1).toBeCloseTo(0);
  });

  it('stay inside their cell and fade to roughness before they alias', () => {
    expect(RIPPLE_MAX_RADIUS + RIPPLE_CELL * 0.15).toBeLessThan(RIPPLE_CELL * 0.75);
    expect(RIPPLE_FOOTPRINT_FULL).toBeLessThan(RIPPLE_FOOTPRINT_GONE);
    // Mean-square slope added far away stays a light roughening, never a matte sea.
    expect(rainRippleParams(1).variance).toBeLessThan(0.03);
  });
});
