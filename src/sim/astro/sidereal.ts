// Sidereal time and the celestial → horizontal → world transforms.
//
// Celestial (equatorial) frame: right-handed Cartesian with +X toward the
// vernal equinox (RA 0h), +Y toward RA 6h and +Z toward the north celestial
// pole, so a star is (cos δ cos α, cos δ sin α, sin δ).
//
// World frame (see core/conventions): +Y up, north = -Z, east = +X. Azimuth is
// radians clockwise from north; elevation is radians above the horizon.
//
// Mat3 values are 9 numbers in column-major order, the layout three.js
// Matrix3.fromArray() and WGSL mat3x3 expect, so a whole star field can be
// rotated on the GPU with one uniform.

import { normalizeHeading, TWO_PI } from '../core/conventions';
import type { Quat, Vec3 } from '../core/math';
import { qSet, v3Set } from '../core/math';
import { julianCentury, JD_J2000 } from './time';

export type Mat3 = number[] | Float32Array | Float64Array;

const createMat3 = (): number[] => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface Horizontal {
  azimuth: number; // radians clockwise from north, [0, 2π)
  elevation: number; // radians above the horizon
}

const ARCSEC = Math.PI / (180 * 3600);

// Greenwich mean sidereal time (IAU 1982, Meeus eq. 12.4) in radians [0, 2π).
// Good to ~0.1 s over centuries; nutation (apparent sidereal time) adds ≤1.2 s.
export function greenwichMeanSiderealTime(jd: number): number {
  const t = julianCentury(jd);
  const degrees = 280.46061837 + 360.98564736629 * (jd - JD_J2000) + t * t * (0.000387933 - t / 38_710_000);
  return normalizeHeading(((degrees % 360) * Math.PI) / 180);
}

// Local mean sidereal time; longitude in radians, east positive.
export function localSiderealTime(jd: number, longitude: number): number {
  return normalizeHeading(greenwichMeanSiderealTime(jd) + longitude);
}

// Equatorial (RA/Dec) → horizontal for an observer at `latitude` (radians).
export function equatorialToHorizontal(
  rightAscension: number,
  declination: number,
  lst: number,
  latitude: number,
  out: Horizontal = { azimuth: 0, elevation: 0 },
): Horizontal {
  const hourAngle = lst - rightAscension;
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const cosH = Math.cos(hourAngle);
  const east = -cosDec * Math.sin(hourAngle);
  const north = sinDec * cosLat - cosDec * cosH * sinLat;
  const up = sinDec * sinLat + cosDec * cosH * cosLat;
  out.azimuth = normalizeHeading(Math.atan2(east, north));
  out.elevation = Math.asin(Math.max(-1, Math.min(1, up)));
  return out;
}

// Unit world-space vector toward a horizontal direction.
export function horizontalToDirection(azimuth: number, elevation: number, out: Vec3): Vec3 {
  const cosEl = Math.cos(elevation);
  return v3Set(out, cosEl * Math.sin(azimuth), Math.sin(elevation), -cosEl * Math.cos(azimuth));
}

// Inverse of horizontalToDirection for any non-zero vector.
export function directionToHorizontal(
  direction: Vec3,
  out: Horizontal = { azimuth: 0, elevation: 0 },
): Horizontal {
  const horizontal = Math.hypot(direction.x, direction.z);
  out.azimuth = normalizeHeading(Math.atan2(direction.x, -direction.z));
  out.elevation = Math.atan2(direction.y, horizontal);
  return out;
}

const scratchHorizontal: Horizontal = { azimuth: 0, elevation: 0 };

// RA/Dec → unit world-space direction.
export function equatorialToDirection(
  rightAscension: number,
  declination: number,
  lst: number,
  latitude: number,
  out: Vec3,
): Vec3 {
  const h = equatorialToHorizontal(rightAscension, declination, lst, latitude, scratchHorizontal);
  return horizontalToDirection(h.azimuth, h.elevation, out);
}

// Celestial unit vector for RA/Dec (see the frame at the top of the file).
export function equatorialToCelestialVector(rightAscension: number, declination: number, out: Vec3): Vec3 {
  const cosDec = Math.cos(declination);
  return v3Set(
    out,
    cosDec * Math.cos(rightAscension),
    cosDec * Math.sin(rightAscension),
    Math.sin(declination),
  );
}

// Row-major scratch so the composed transforms do not allocate.
const rowA = new Float64Array(9);
const rowB = new Float64Array(9);
const rowC = new Float64Array(9);

// Celestial-of-date → world rotation, row-major. Derived by expanding
// equatorialToHorizontal with H = LST − α in terms of the celestial vector.
function worldRows(lst: number, latitude: number, rows: Float64Array): Float64Array {
  const sL = Math.sin(lst);
  const cL = Math.cos(lst);
  const sP = Math.sin(latitude);
  const cP = Math.cos(latitude);
  // x = east, y = up, z = −north.
  rows[0] = -sL;
  rows[1] = cL;
  rows[2] = 0;
  rows[3] = cP * cL;
  rows[4] = cP * sL;
  rows[5] = sP;
  rows[6] = sP * cL;
  rows[7] = sP * sL;
  rows[8] = -cP;
  return rows;
}

// J2000 mean equator → mean equator of date (Meeus ch. 21, rigorous method),
// row-major. Over decades this shifts stars by ~50″/year, i.e. ~0.35° by 2026.
function precessionRows(jd: number, rows: Float64Array): Float64Array {
  const t = julianCentury(jd);
  const zeta = (2306.2181 + (0.30188 + 0.017998 * t) * t) * t * ARCSEC;
  const z = (2306.2181 + (1.09468 + 0.018203 * t) * t) * t * ARCSEC;
  const theta = (2004.3109 - (0.42665 + 0.041833 * t) * t) * t * ARCSEC;
  const cZeta = Math.cos(zeta);
  const sZeta = Math.sin(zeta);
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const cTh = Math.cos(theta);
  const sTh = Math.sin(theta);
  rows[0] = cZeta * cTh * cZ - sZeta * sZ;
  rows[1] = -sZeta * cTh * cZ - cZeta * sZ;
  rows[2] = -sTh * cZ;
  rows[3] = cZeta * cTh * sZ + sZeta * cZ;
  rows[4] = -sZeta * cTh * sZ + cZeta * cZ;
  rows[5] = -sTh * sZ;
  rows[6] = cZeta * sTh;
  rows[7] = -sZeta * sTh;
  rows[8] = cTh;
  return rows;
}

function multiplyRows(a: Float64Array, b: Float64Array, out: Float64Array): Float64Array {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out;
}

function rowsToColumnMajor(rows: Float64Array, out: Mat3): Mat3 {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 3 + r] = rows[r * 3 + c];
  }
  return out;
}

// Rotation from the celestial frame (equator and equinox of date) to world for
// a given local sidereal time and latitude. Column-major.
export function celestialToWorldMatrix(lst: number, latitude: number, out: Mat3 = createMat3()): Mat3 {
  return rowsToColumnMajor(worldRows(lst, latitude, rowA), out);
}

// Rotation from J2000 catalogue coordinates to world, folding in precession so
// the star field needs a single matrix per frame. Column-major.
export function starFieldToWorldMatrix(
  jd: number,
  latitude: number,
  longitude: number,
  out: Mat3 = createMat3(),
): Mat3 {
  worldRows(localSiderealTime(jd, longitude), latitude, rowA);
  precessionRows(jd, rowB);
  return rowsToColumnMajor(multiplyRows(rowA, rowB, rowC), out);
}

// J2000 → equator of date, column-major (also usable on the CPU via mat3ApplyToVec3).
export function precessionMatrix(jd: number, out: Mat3 = createMat3()): Mat3 {
  return rowsToColumnMajor(precessionRows(jd, rowA), out);
}

// out = m · v for a column-major Mat3. `out` may alias `v`.
export function mat3ApplyToVec3(m: Mat3, v: Vec3, out: Vec3): Vec3 {
  const { x, y, z } = v;
  return v3Set(
    out,
    m[0] * x + m[3] * y + m[6] * z,
    m[1] * x + m[4] * y + m[7] * z,
    m[2] * x + m[5] * y + m[8] * z,
  );
}

// Unit quaternion for a column-major rotation matrix (Shepperd's method), in
// the same convention as core/math qRotate: qRotate(q, v) === m · v.
export function mat3ToQuat(m: Mat3, out: Quat): Quat {
  const m00 = m[0];
  const m10 = m[1];
  const m20 = m[2];
  const m01 = m[3];
  const m11 = m[4];
  const m21 = m[5];
  const m02 = m[6];
  const m12 = m[7];
  const m22 = m[8];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return qSet(out, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
  }
  if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    return qSet(out, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
  }
  if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    return qSet(out, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
  }
  const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
  return qSet(out, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
}

// Hours of RA or hour angle → radians, for readable constants in callers.
export const hoursToRadians = (hours: number): number => (hours / 24) * TWO_PI;
