import { describe, expect, it } from 'vite-plus/test';

import { moonIlluminanceAt, rgbLuminance, sunIlluminanceAt, transmittanceToTop } from './atmosphereCpu';
import {
  atmosphereWithHaze,
  diskFractionAboveHorizon,
  EARTH_ATMOSPHERE,
  lommelSeeligerPhase,
  moonIlluminanceToa,
  SUN_ANGULAR_RADIUS,
  SUN_ILLUMINANCE_TOA,
} from './atmosphereParams';

const DEG = Math.PI / 180;

describe('CPU transmittance and sea-level illuminance', () => {
  it('gives roughly 100 klux of direct sun at high noon', () => {
    const lux = rgbLuminance(sunIlluminanceAt(EARTH_ATMOSPHERE, 90 * DEG));
    expect(lux).toBeGreaterThan(95_000);
    expect(lux).toBeLessThan(SUN_ILLUMINANCE_TOA);
  });

  it('falls monotonically as the sun sinks, reaching zero once it has set', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let elevation = 90; elevation >= -1; elevation -= 0.5) {
      const lux = rgbLuminance(sunIlluminanceAt(EARTH_ATMOSPHERE, elevation * DEG));
      expect(lux).toBeLessThanOrEqual(previous + 1e-9);
      previous = lux;
    }
    expect(rgbLuminance(sunIlluminanceAt(EARTH_ATMOSPHERE, -1 * DEG))).toBe(0);
  });

  it('reddens the sun toward the horizon', () => {
    const ratio = (elevation: number): number => {
      const [r, , b] = sunIlluminanceAt(EARTH_ATMOSPHERE, elevation * DEG);
      return r / b;
    };
    expect(ratio(60)).toBeLessThan(ratio(20));
    expect(ratio(20)).toBeLessThan(ratio(5));
    expect(ratio(5)).toBeLessThan(ratio(1));
    expect(ratio(1)).toBeGreaterThan(3);
  });

  it('is blocked by the planet below the geometric horizon', () => {
    expect(transmittanceToTop(EARTH_ATMOSPHERE, 0.002, -0.1)).toEqual([0, 0, 0]);
    const up = transmittanceToTop(EARTH_ATMOSPHERE, 0.002, 1);
    for (const channel of up) expect(channel).toBeGreaterThan(0.6);
  });

  it('dims the sun more in haze', () => {
    const hazy = atmosphereWithHaze(EARTH_ATMOSPHERE, 5);
    const clear = rgbLuminance(sunIlluminanceAt(EARTH_ATMOSPHERE, 20 * DEG));
    expect(rgbLuminance(sunIlluminanceAt(hazy, 20 * DEG))).toBeLessThan(clear * 0.95);
  });

  it('fades the setting disk by the fraction still above the horizon', () => {
    expect(diskFractionAboveHorizon(SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS)).toBeCloseTo(1);
    expect(diskFractionAboveHorizon(0, SUN_ANGULAR_RADIUS)).toBeCloseTo(0.5);
    expect(diskFractionAboveHorizon(-SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS)).toBeCloseTo(0);
  });
});

describe('moon photometry', () => {
  it('gives about a quarter of a lux for a full moon', () => {
    expect(moonIlluminanceToa(0)).toBeGreaterThan(0.2);
    expect(moonIlluminanceToa(0)).toBeLessThan(0.3);
    const high = rgbLuminance(moonIlluminanceAt(EARTH_ATMOSPHERE, 60 * DEG, 0));
    expect(high).toBeGreaterThan(0.18);
    expect(high).toBeLessThan(0.27);
  });

  it('dims with phase angle', () => {
    expect(moonIlluminanceToa(Math.PI / 2)).toBeLessThan(moonIlluminanceToa(0) * 0.15);
    expect(moonIlluminanceToa(2.5)).toBeLessThan(moonIlluminanceToa(Math.PI / 2));
    expect(lommelSeeligerPhase(0)).toBeCloseTo(1, 3);
    expect(lommelSeeligerPhase(Math.PI / 2)).toBeLessThan(lommelSeeligerPhase(0.5));
  });
});
