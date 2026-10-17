// Sidereal time and frame-transform tests.
//
// References: Meeus, Astronomical Algorithms (2nd ed.) examples 12.a/12.b
// (GMST), 13.b (Venus from Washington, horizontal coordinates) and 21.b
// (precession of θ Persei). Polaris J2000 position from the BSC5 / SIMBAD.

import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { qRotate, vec3 } from '../core/math';
import type { Mat3 } from './sidereal';
import {
  celestialToWorldMatrix,
  directionToHorizontal,
  equatorialToCelestialVector,
  equatorialToDirection,
  equatorialToHorizontal,
  greenwichMeanSiderealTime,
  hoursToRadians,
  horizontalToDirection,
  localSiderealTime,
  mat3ApplyToVec3,
  mat3ToQuat,
  precessionMatrix,
  starFieldToWorldMatrix,
} from './sidereal';
import { julianDay } from './time';

const hms = (h: number, m: number, s: number): number => hoursToRadians(h + m / 60 + s / 3600);
const dms = (d: number, m: number, s: number): number =>
  Math.sign(d || 1) * (Math.abs(d) + m / 60 + s / 3600) * DEG;

function expectVecClose(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): void {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
  expect(a.z).toBeCloseTo(b.z, 9);
}

function determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[7] * m[5]) -
    m[3] * (m[1] * m[8] - m[7] * m[2]) +
    m[6] * (m[1] * m[5] - m[4] * m[2])
  );
}

describe('sidereal time', () => {
  it('matches Meeus example 12.a (0h UT)', () => {
    const jd = julianDay(new Date('1987-04-10T00:00:00Z'));
    expect(greenwichMeanSiderealTime(jd)).toBeCloseTo(hms(13, 10, 46.3668), 7);
  });

  it('matches Meeus example 12.b (19:21 UT)', () => {
    const jd = julianDay(new Date('1987-04-10T19:21:00Z'));
    expect(greenwichMeanSiderealTime(jd)).toBeCloseTo(hms(8, 34, 57.0896), 7);
  });

  it('adds east longitude for local sidereal time', () => {
    const jd = julianDay(new Date('1987-04-10T19:21:00Z'));
    const lst = localSiderealTime(jd, 90 * DEG);
    expect(lst).toBeCloseTo(hms(8, 34, 57.0896) + 90 * DEG, 7);
  });
});

describe('equatorial → horizontal', () => {
  it('matches Meeus example 13.b (Venus from Washington)', () => {
    const lst = hms(8, 34, 56.853) - dms(77, 3, 56); // apparent GST, 77°03′56″ W
    const h = equatorialToHorizontal(hms(23, 9, 16.641), dms(-6, 43, 11.61), lst, dms(38, 55, 17));
    // Meeus measures azimuth from the south; ours is from the north.
    expect(h.azimuth / DEG).toBeCloseTo(68.0337 + 180, 3);
    expect(h.elevation / DEG).toBeCloseTo(15.1249, 3);
  });

  it('puts Polaris near due north at an elevation equal to the latitude', () => {
    const ra = hms(2, 31, 49.09);
    const dec = dms(89, 15, 50.8);
    const jd = julianDay(new Date('2026-07-15T22:00:00Z'));
    for (const latDeg of [20, 45, 60]) {
      const lat = latDeg * DEG;
      const dir = equatorialToDirection(ra, dec, localSiderealTime(jd, -30 * DEG), lat, vec3());
      const h = directionToHorizontal(dir);
      expect(Math.abs(h.elevation / DEG - latDeg)).toBeLessThan(1);
      const azDeg = h.azimuth / DEG;
      expect(Math.min(azDeg, 360 - azDeg)).toBeLessThan(2);
      // North is −Z in world space.
      expect(dir.z).toBeLessThan(0);
      expect(Math.abs(dir.x)).toBeLessThan(0.03);
    }
  });

  it('maps horizontal directions onto the world axes', () => {
    expectVecClose(horizontalToDirection(0, 0, vec3()), vec3(0, 0, -1)); // north
    expectVecClose(horizontalToDirection(90 * DEG, 0, vec3()), vec3(1, 0, 0)); // east
    expectVecClose(horizontalToDirection(0, 90 * DEG, vec3()), vec3(0, 1, 0)); // zenith
    const h = directionToHorizontal(horizontalToDirection(200 * DEG, 30 * DEG, vec3()));
    expect(h.azimuth / DEG).toBeCloseTo(200, 9);
    expect(h.elevation / DEG).toBeCloseTo(30, 9);
  });
});

describe('celestial → world rotation', () => {
  const lst = 1.234;
  const lat = 41 * DEG;

  it('is a proper rotation that agrees with equatorialToDirection', () => {
    const m = celestialToWorldMatrix(lst, lat);
    expect(determinant(m)).toBeCloseTo(1, 12);
    for (const [ra, dec] of [
      [0.3, 0.2],
      [4.1, -0.9],
      [2.5, 1.4],
    ]) {
      const c = equatorialToCelestialVector(ra, dec, vec3());
      expectVecClose(mat3ApplyToVec3(m, c, vec3()), equatorialToDirection(ra, dec, lst, lat, vec3()));
    }
  });

  it('converts to an equivalent quaternion', () => {
    const m = celestialToWorldMatrix(lst, lat);
    const q = mat3ToQuat(m, { x: 0, y: 0, z: 0, w: 1 });
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
    const v = vec3(0.48, -0.6, 0.64);
    expectVecClose(qRotate(vec3(), q, v), mat3ApplyToVec3(m, v, vec3()));
  });

  it('precesses θ Persei as in Meeus example 21.b', () => {
    // Meeus' J2000 position with 28.87 years of proper motion already applied.
    const c = equatorialToCelestialVector(41.054063 * DEG, 49.22775 * DEG, vec3());
    const p = mat3ApplyToVec3(precessionMatrix(2462088.69), c, vec3());
    const ra = Math.atan2(p.y, p.x) / DEG;
    const dec = Math.asin(p.z) / DEG;
    expect(ra).toBeCloseTo(41.547214, 4);
    expect(dec).toBeCloseTo(49.348483, 4);
  });

  it('folds precession into the star-field matrix', () => {
    const jd = julianDay(new Date('2026-07-15T22:00:00Z'));
    const lon = -30 * DEG;
    const star = starFieldToWorldMatrix(jd, lat, lon);
    expect(determinant(star)).toBeCloseTo(1, 12);
    const c = equatorialToCelestialVector(1.1, 0.4, vec3());
    const ofDate = mat3ApplyToVec3(precessionMatrix(jd), c, vec3());
    const expected = mat3ApplyToVec3(celestialToWorldMatrix(localSiderealTime(jd, lon), lat), ofDate, vec3());
    expectVecClose(mat3ApplyToVec3(star, c, vec3()), expected);
  });
});
