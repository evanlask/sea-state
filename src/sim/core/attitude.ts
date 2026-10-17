// Boat attitude (heading, pitch, roll) derived from a body orientation, using
// the conventions in conventions.ts.
import { normalizeHeading } from './conventions';
import { type Quat, type Vec3, qRotate, vec3 } from './math';

export interface Attitude {
  heading: number; // radians clockwise from north, [0, 2π)
  pitch: number; // radians, positive bow up, [-π/2, π/2]
  roll: number; // radians, positive starboard down, (-π, π]
}

const BOW: Vec3 = { x: 0, y: 0, z: -1 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const STARBOARD: Vec3 = { x: 1, y: 0, z: 0 };
const forward = vec3();
const up = vec3();
const starboard = vec3();

export function attitudeFromQuat(q: Quat, out: Attitude = { heading: 0, pitch: 0, roll: 0 }): Attitude {
  qRotate(forward, q, BOW);
  qRotate(up, q, UP);
  qRotate(starboard, q, STARBOARD);
  out.heading = normalizeHeading(Math.atan2(forward.x, -forward.z));
  out.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
  out.roll = Math.atan2(-starboard.y, up.y);
  return out;
}
