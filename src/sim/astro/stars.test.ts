// Star catalogue format and photometry tests.

import { describe, expect, it } from 'vite-plus/test';

import type { StarRecord } from './stars';
import {
  colorIndexToRgb,
  colorIndexToTemperature,
  decodeStarCatalog,
  encodeStarCatalog,
  magnitudeToIntensity,
  starAt,
  temperatureToColorIndex,
} from './stars';

const luminance = (rgb: number[]): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

describe('star catalogue format', () => {
  const stars: StarRecord[] = [
    { rightAscension: 1.7677953, declination: -0.2917512, magnitude: -1.46, colorIndex: 0 }, // Sirius
    { rightAscension: 0.6622, declination: 1.558, magnitude: 2.02, colorIndex: 0.6 }, // Polaris
    { rightAscension: 1.5497, declination: 0.1293, magnitude: 0.5, colorIndex: 1.85 }, // Betelgeuse
  ];

  it('round-trips records at float32 precision', () => {
    const catalog = decodeStarCatalog(encodeStarCatalog(stars));
    expect(catalog.count).toBe(3);
    expect(catalog.data.length).toBe(12);
    stars.forEach((star, i) => {
      const decoded = starAt(catalog, i);
      expect(decoded.rightAscension).toBeCloseTo(star.rightAscension, 6);
      expect(decoded.declination).toBeCloseTo(star.declination, 6);
      expect(decoded.magnitude).toBeCloseTo(star.magnitude, 6);
      expect(decoded.colorIndex).toBeCloseTo(star.colorIndex, 6);
    });
  });

  it('rejects foreign or truncated data', () => {
    const buffer = encodeStarCatalog(stars);
    expect(() => decodeStarCatalog(buffer.slice(0, buffer.byteLength - 4))).toThrow(/truncated/);
    const bad = buffer.slice(0);
    new DataView(bad).setUint32(0, 0x12345678, true);
    expect(() => decodeStarCatalog(bad)).toThrow(/magic/);
    expect(() => decodeStarCatalog(new ArrayBuffer(3))).toThrow(/truncated/);
  });
});

describe('star photometry', () => {
  it('follows the Pogson magnitude scale', () => {
    expect(magnitudeToIntensity(0)).toBe(1);
    expect(magnitudeToIntensity(5)).toBeCloseTo(0.01, 12);
    expect(magnitudeToIntensity(-1.46) / magnitudeToIntensity(1)).toBeCloseTo(9.64, 1);
  });

  it('maps B−V to plausible temperatures and back', () => {
    expect(colorIndexToTemperature(0.65)).toBeGreaterThan(5600); // the Sun, ~5770 K
    expect(colorIndexToTemperature(0.65)).toBeLessThan(6000);
    expect(colorIndexToTemperature(-0.3)).toBeGreaterThan(15000); // Ballesteros runs cool for B stars
    for (const bv of [-0.3, 0, 0.65, 1.5]) {
      expect(temperatureToColorIndex(colorIndexToTemperature(bv))).toBeCloseTo(bv, 9);
    }
  });

  it('colours hot stars blue and cool stars orange-red at unit luminance', () => {
    const hot = colorIndexToRgb(-0.2);
    expect(hot[2]).toBeGreaterThan(hot[0]);
    expect(hot[2]).toBeGreaterThan(hot[1]);
    const cool = colorIndexToRgb(1.5);
    expect(cool[0]).toBeGreaterThan(cool[1]);
    expect(cool[1]).toBeGreaterThan(cool[2]);
    expect(cool[0] / cool[2]).toBeGreaterThan(3);
    const sunlike = colorIndexToRgb(0.65);
    expect(sunlike[0]).toBeGreaterThan(sunlike[2]);
    expect(sunlike[2] / sunlike[0]).toBeGreaterThan(0.7);
    for (const rgb of [hot, cool, sunlike]) {
      expect(luminance(rgb)).toBeCloseTo(1, 9);
      for (const c of rgb) expect(c).toBeGreaterThanOrEqual(0);
    }
  });
});
