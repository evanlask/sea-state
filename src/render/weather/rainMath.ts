// Pure rain maths shared by the GPU rain volume and its tests: rain rate and
// drop fall speed from a 0..1 intensity, and the streak each drop paints
// during one exposure, as seen from a (possibly moving) camera.
import type { Vec3Like } from '../particles/emissionQueue';

// 0 = none, ~0.1 drizzle, ~0.5 heavy, 1 = torrential (~100 mm/h).
export function rainRate(intensity: number): number {
  const i = Math.min(Math.max(intensity, 0), 1);
  return 100 * i ** 2.5; // mm/h
}

// Median drop diameter (Marshall–Palmer, D0 ≈ 0.89·R^0.21 mm) and its terminal
// speed (Atlas et al. 1973: vt ≈ 9.65 − 10.3·e^(−0.6·D) m/s).
export function rainFallSpeed(intensity: number): number {
  const rate = Math.max(rainRate(intensity), 0.05);
  const diameter = 0.89 * rate ** 0.21;
  return Math.max(9.65 - 10.3 * Math.exp(-0.6 * diameter), 1);
}

export interface RainStreak {
  // Unit direction of the streak in world space (the drop's apparent motion).
  dx: number;
  dy: number;
  dz: number;
  length: number; // m
  slant: number; // radians from vertical
  speed: number; // apparent drop speed relative to the camera, m/s
}

// Drops fall at their terminal speed and drift with the wind; the camera's own
// velocity is subtracted so rain slants towards a moving observer.
export function rainStreak(
  wind: Vec3Like,
  cameraVelocity: Vec3Like,
  fallSpeed: number,
  exposure: number,
  maxLength = 2.5,
): RainStreak {
  const rx = wind.x - cameraVelocity.x;
  const ry = -fallSpeed + wind.y - cameraVelocity.y;
  const rz = wind.z - cameraVelocity.z;
  const speed = Math.hypot(rx, ry, rz);
  if (speed < 1e-6) return { dx: 0, dy: -1, dz: 0, length: 0, slant: 0, speed: 0 };
  return {
    dx: rx / speed,
    dy: ry / speed,
    dz: rz / speed,
    length: Math.min(speed * exposure, maxLength),
    slant: Math.atan2(Math.hypot(rx, rz), Math.abs(ry)),
    speed,
  };
}

// Fraction of the drop pool drawn: density grows quickly at first, so drizzle
// is sparse but visible and heavy rain saturates the pool.
export function rainDropFraction(intensity: number): number {
  const i = Math.min(Math.max(intensity, 0), 1);
  return i <= 0 ? 0 : Math.min(1, 0.08 + 0.92 * i ** 0.8);
}

// How long a streak each drop paints: about a 1/70 s exposure, so drizzle shows short dashes and
// hurricane rain driven at 70 m/s streaks a metre or so, never across the whole view.
export const RAIN_EXPOSURE = 1 / 70; // s
export const RAIN_MAX_STREAK = 1.5; // m

// Opacity of a streak relative to a still drop. A drop crosses each point of its streak in a
// fraction of the exposure, so a long streak is fainter than a short one; the real ratio (drop
// width over streak length) would hide rain altogether, so it is softened to a square root about
// a reference length of 15 cm.
export function rainStreakOpacity(length: number): number {
  const reference = 0.15;
  return Math.sqrt(reference / (reference + Math.max(length, 0)));
}
