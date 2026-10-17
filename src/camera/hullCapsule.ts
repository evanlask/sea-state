// Bounding capsules around hulls. External and director cameras are kept outside them, and blends
// between camera modes are routed around them rather than straight through the boat.
//
// The capsule lives in the boat's body frame: a segment along the keel line (z) swept by an
// ellipse (x half-width, y half-height) with ellipsoidal end caps. The ellipse is the smallest one
// through the corners of the hull's beam × height section, so everything from the waterline to the
// masthead is inside; the caps reach a little past the bow and stern.

import { Quaternion, Vector3 } from 'three/webgpu';

import type { Vec3Like } from './boatCameraInfo';

export interface HullCapsule {
  halfLength: number; // half the straight segment along body z
  centerY: number;
  radiusX: number;
  radiusY: number;
  radiusZ: number; // end-cap reach beyond the segment
}

export interface HullSize {
  length: number;
  beam: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function hullCapsule(size: HullSize, margin = 0): HullCapsule {
  const rx = (size.beam / 2) * Math.SQRT2;
  const ry = (size.height / 2) * Math.SQRT2;
  // Caps reach rx beyond the segment, which stops 0.3 rx short of the bow and stern: a square
  // transom's deck corners are (just) inside, and so is everything forward of a raked bow.
  return {
    halfLength: Math.max(0, size.length / 2 - 0.3 * rx),
    centerY: size.height / 2,
    radiusX: rx + margin,
    radiusY: ry + margin,
    radiusZ: rx + margin,
  };
}

// Normalized distance of a body-frame point from the capsule's core: < 1 inside, 1 on the surface.
export function capsuleNorm(c: HullCapsule, p: Vec3Like): number {
  const dz = p.z - clamp(p.z, -c.halfLength, c.halfLength);
  return Math.hypot(p.x / c.radiusX, (p.y - c.centerY) / c.radiusY, dz / c.radiusZ);
}

// Moves a body-frame point out to normalized distance `min` (1 = the surface) if it is closer.
// The push is radial from the core, tilted upward by `upBias` (0 = radial; 1 = favour going over
// the top, which is how blends route around a hull: never under it, where the sea is). The result
// is continuous in the input point, so a path pushed point by point stays smooth.
export function pushOut(c: HullCapsule, p: Vector3, min = 1, upBias = 0): boolean {
  const cz = clamp(p.z, -c.halfLength, c.halfLength);
  const nx = p.x / c.radiusX;
  const ny = (p.y - c.centerY) / c.radiusY;
  const nz = (p.z - cz) / c.radiusZ;
  const d2 = nx * nx + ny * ny + nz * nz;
  if (d2 >= min * min) return false;
  // Direction in normalized space; at the dead centre with no bias, go straight up.
  let dx = nx;
  let dy = ny + upBias;
  let dz = nz;
  let len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) {
    dx = 0;
    dy = 1;
    dz = 0;
    len = 1;
  }
  dx /= len;
  dy /= len;
  dz /= len;
  // Solve |n + λd| = min for λ ≥ 0 (n is inside, so there is exactly one root).
  const nd = nx * dx + ny * dy + nz * dz;
  const lambda = -nd + Math.sqrt(Math.max(0, nd * nd - (d2 - min * min)));
  p.set(
    (nx + lambda * dx) * c.radiusX,
    c.centerY + (ny + lambda * dy) * c.radiusY,
    cz + (nz + lambda * dz) * c.radiusZ,
  );
  return true;
}

export interface HullPose {
  position: Vector3;
  quaternion: Quaternion;
}

const local = new Vector3();
const inverse = new Quaternion();

function toBody(world: Vec3Like, pose: HullPose, out: Vector3): Vector3 {
  inverse.copy(pose.quaternion).invert();
  return out.set(world.x, world.y, world.z).sub(pose.position).applyQuaternion(inverse);
}

// Normalized distance of a world point from a posed hull's capsule (< 1 inside).
export function hullNorm(world: Vec3Like, c: HullCapsule, pose: HullPose): number {
  return capsuleNorm(c, toBody(world, pose, local));
}

// World-space pushOut for a posed hull; moves `world` in place and returns true if it moved.
export function pushOutOfHull(world: Vector3, c: HullCapsule, pose: HullPose, min = 1, upBias = 0): boolean {
  toBody(world, pose, local);
  if (!pushOut(c, local, min, upBias)) return false;
  world.copy(local.applyQuaternion(pose.quaternion).add(pose.position));
  return true;
}
