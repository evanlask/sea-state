// Small shared pieces for the drive-train force modules.

import { qRotate, qRotateInverse, type Vec3, vec3 } from '../../core/math';
import type { RigidBody } from '../RigidBody';
import type { PhysicsTuning } from '../tuning';
import type { WaterSample, WaterSampler } from '../water';

export function rateLimit(value: number, target: number, rate: number, dt: number): number {
  const step = rate * dt;
  const d = target - value;
  return Math.abs(d) <= step ? target : value + Math.sign(d) * step;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const compression = (tuning: PhysicsTuning | undefined): number => tuning?.timeCompression ?? 1;

// Water at a body-frame point: head (depth below the local surface, m) and
// the water-relative flow seen by the point, in body axes.
export interface PointFlow {
  world: Vec3; // the point, world
  head: number; // pressure head, m (> 0 submerged)
  flow: Vec3; // velocity of the point relative to the water, BODY axes
}

export const pointFlow = (): PointFlow => ({ world: vec3(), head: 0, flow: vec3() });

const pv = vec3();
const rel = vec3();

export function samplePointFlow(
  body: RigidBody,
  bodyPoint: Vec3,
  water: WaterSampler,
  time: number,
  sample: WaterSample,
  out: PointFlow,
): PointFlow {
  body.bodyToWorldPoint(out.world, bodyPoint);
  const p = out.world;
  water.sample(p.x, p.y, p.z, time, sample);
  out.head = sample.pressureHead;
  body.pointVelocity(pv, p);
  rel.x = pv.x - sample.velocityX;
  rel.y = pv.y - sample.velocityY;
  rel.z = pv.z - sample.velocityZ;
  qRotateInverse(out.flow, body.orientation, rel);
  return out;
}

const fw = vec3();
const fb = vec3();

// Body-frame force at a body point, time-compressed by k (see tuning.ts).
export function applyBodyForce(
  body: RigidBody,
  k: number,
  fx: number,
  fy: number,
  fz: number,
  worldPoint: Vec3,
): void {
  fb.x = fx;
  fb.y = fy;
  fb.z = fz;
  qRotate(fw, body.orientation, fb);
  body.addForceAtPointXYZ(fw.x, fw.y, fw.z, worldPoint.x, worldPoint.y, worldPoint.z);
  if (k !== 1) {
    const e = k - 1;
    body.addForceAtPointXYZ(e * fw.x, 0, e * fw.z, worldPoint.x, body.position.y, worldPoint.z);
  }
}

// Immersion of a disc/foil of radius r whose centre is `head` below the surface.
export const discImmersion = (head: number, radius: number): number =>
  clamp((head + radius) / (2 * radius), 0, 1);
