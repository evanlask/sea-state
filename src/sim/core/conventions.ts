// Coordinate and angle conventions shared by the simulation and the renderer.
//
// World frame: right-handed, +Y up, north = -Z, east = +X. A default three.js
// camera therefore looks north.
//
// Body frame (boats): bow = -Z, up = +Y, starboard = +X. The identity
// orientation is a level boat heading north.
//
// Headings and bearings are radians clockwise from north, normalized to
// [0, 2π). Wind and swell directions are meteorological "from" directions; the
// matching velocity vector points the opposite way.

export const TWO_PI = Math.PI * 2;
export const DEG = Math.PI / 180;

export interface Vec2Like {
  x: number;
  z: number;
}

// Wraps any angle into [0, 2π).
export function normalizeHeading(angle: number): number {
  const wrapped = angle % TWO_PI;
  if (wrapped >= 0) return wrapped;
  // A tiny negative angle plus 2π rounds to exactly 2π, outside [0, 2π).
  const shifted = wrapped + TWO_PI;
  return shifted >= TWO_PI ? 0 : shifted;
}

// Wraps any angle into (-π, π].
export function signedAngle(angle: number): number {
  const wrapped = normalizeHeading(angle);
  return wrapped > Math.PI ? wrapped - TWO_PI : wrapped;
}

// Unit vector on the horizontal plane pointing along a heading.
export function headingToVector(heading: number, out: Vec2Like = { x: 0, z: 0 }): Vec2Like {
  out.x = Math.sin(heading);
  out.z = -Math.cos(heading);
  return out;
}

// Heading of a horizontal vector (x east, z south).
export function vectorToHeading(x: number, z: number): number {
  return normalizeHeading(Math.atan2(x, -z));
}

// Velocity of air or water moving away from a "from" direction.
export function fromDirectionToVelocity(
  fromHeading: number,
  speed: number,
  out: Vec2Like = { x: 0, z: 0 },
): Vec2Like {
  out.x = -Math.sin(fromHeading) * speed;
  out.z = Math.cos(fromHeading) * speed;
  return out;
}

// "From" direction of a horizontal velocity. Zero velocity reports north.
export function velocityToFromDirection(x: number, z: number): number {
  if (x === 0 && z === 0) return 0;
  return vectorToHeading(-x, -z);
}

// Rotation about +Y (three.js yaw) that points the bow along a heading.
export function headingToYaw(heading: number): number {
  return -heading;
}

export function yawToHeading(yaw: number): number {
  return normalizeHeading(-yaw);
}

// Bearing of a target relative to the bow in (-π, π]; positive is to starboard.
export function relativeBearing(boatHeading: number, targetBearing: number): number {
  return signedAngle(targetBearing - boatHeading);
}
