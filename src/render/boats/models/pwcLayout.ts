// Jet ski layout shared by the model (pwc.ts) and its rider (rider/pose.ts): the seat, the
// footwells and the handlebar grips, in the body frame (bow −Z, up +Y, starboard +X, 0 = waterline).

import { Matrix4, Vector3 } from 'three/webgpu';

export const FOOT_Y = 0.25; // footwell floor
export const SEAT_HW = 0.26; // seat pedestal half width
export const SEAT_BASE = 0.5;
export const FOOT_FRONT = -0.4;
export const FOOT_AFT = 0.98;
export const BAR = { y: 0.86, z: -0.42, tilt: 0.45 }; // handlebar pivot and column rake
export const GRIP = [0.32, 0.03, 0.045] as const; // right grip in the bar frame
export const GRIP_RADIUS = 0.019;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Stepped three-seat saddle: a superelliptic section (exponent SEAT_N) on SEAT_BASE + 0.02, from the
// nose at z = SEAT_Z0 to the tail at SEAT_Z1.
export const SEAT_Z0 = -0.38;
export const SEAT_Z1 = 0.98;
const SEAT_N = 3.6;

export function seatSection(z: number): { hw: number; top: number } {
  const t = (z - SEAT_Z0) / (SEAT_Z1 - SEAT_Z0);
  const nose = Math.min(1, Math.max(0, t) / 0.06) ** 0.5;
  const tail = Math.min(1, Math.max(0, 1 - t) / 0.05) ** 0.5;
  const s = nose * tail;
  const top = 0.62 + 0.04 * smooth(0.3, 0.42, z) + 0.035 * smooth(0.68, 0.78, z);
  return {
    hw: (0.2 + 0.07 * smooth(-0.35, 0.0, z)) * Math.max(0.3, s),
    top: (top - SEAT_BASE - 0.02) * Math.max(0.25, s),
  };
}

// Height of the seat's upper surface at (x, z), or -Infinity off the seat.
export function seatSurfaceY(x: number, z: number): number {
  if (z < SEAT_Z0 || z > SEAT_Z1) return -Infinity;
  const { hw, top } = seatSection(z);
  const u = Math.abs(x) / hw;
  if (u >= 1) return -Infinity;
  return SEAT_BASE + 0.02 + top * (1 - u ** SEAT_N) ** (1 / SEAT_N);
}

const tiltMatrix = new Matrix4();
const steerMatrix = new Matrix4();

function barFrame(steer: number): Matrix4 {
  tiltMatrix.makeRotationX(BAR.tilt).setPosition(0, BAR.y, BAR.z);
  return steerMatrix.makeRotationY(steer).premultiply(tiltMatrix);
}

// Centre of a grip (side −1 port, +1 starboard) for a handlebar steer angle (the 'handlebar' node's yaw).
export function gripAt(side: number, steer: number, out: Vector3): Vector3 {
  return out.set(side * GRIP[0], GRIP[1], GRIP[2]).applyMatrix4(barFrame(steer));
}

// Unit axis along a grip, pointing outboard.
export function gripAxis(side: number, steer: number, out: Vector3): Vector3 {
  // The grip capsule runs from (gx − 0.05, gy, gz) to (gx + 0.06, gy + 0.005, gz + 0.015).
  return out
    .set(side * 0.11, 0.005, 0.015)
    .transformDirection(barFrame(steer))
    .normalize();
}
