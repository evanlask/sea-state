// Lifting foils for rudders, keels, skegs and trim tabs: aspect-ratio-corrected
// lift slope (Helmbold), induced drag, stall near 30–35° blending into
// flat-plate normal-force behaviour, and reverse flow when going astern.
//
// Geometry is body frame. At zero deflection the chord axis points from the
// leading to the trailing edge (aft for a rudder or keel). Positive deflection
// rotates the chord about the span axis by the right-hand rule.

import { type Vec3, qRotate, qRotateInverse, vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import type { RigidBody } from './RigidBody';
import type { WaterSampler, WaterSample } from './water';
import { waterSample } from './water';

type FoilKind = 'keel' | 'rudder' | 'skeg' | 'trimTab' | 'fin';

export interface FoilSpec {
  name: string;
  kind: FoilKind;
  centre: Vec3; // centre of pressure (quarter chord, mid span), body frame
  spanAxis: Vec3; // unit, root → tip (e.g. (0, −1, 0) for a downward fin)
  chordAxis: Vec3; // unit, leading → trailing edge at zero deflection
  span: number; // m
  area: number; // planform area, m²
  // Effective aspect ratio for the lift slope; a fin under a hull (end plate)
  // is about twice its geometric span²/area. Defaults to 2·span²/area.
  effectiveAspectRatio?: number;
  stallAngle?: number; // rad, default 32°
  zeroLiftDrag?: number; // CD0, default 0.008
  oswald?: number; // span efficiency, default 0.9
  flatPlateDrag?: number; // CD at 90°, default 1.2
  maxDeflection?: number; // rad, for steerable foils
  ballast?: { mass: number; centre: Vec3 }; // e.g. a lead bulb (already in the boat's CG/mass)
}

export interface FoilCoefficients {
  cl: number;
  cd: number;
}

export interface FoilState {
  alpha: number; // angle of attack, rad
  cl: number;
  cd: number;
  speed: number; // inflow speed in the section plane, m/s
  immersion: number;
  force: Vec3; // body frame, N
  worldForce: Vec3;
  worldPoint: Vec3;
}

export const foilState = (): FoilState => ({
  alpha: 0,
  cl: 0,
  cd: 0,
  speed: 0,
  immersion: 0,
  force: vec3(),
  worldForce: vec3(),
  worldPoint: vec3(),
});

const aspectRatioOf = (foil: FoilSpec): number =>
  foil.effectiveAspectRatio ?? (2 * foil.span * foil.span) / foil.area;

// Helmbold's lift-curve slope for a finite wing, per radian.
export const liftSlope = (aspectRatio: number): number =>
  (2 * Math.PI * aspectRatio) / (2 + Math.sqrt(aspectRatio * aspectRatio + 4));

const smoothstep = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Lift and drag coefficients at angle of attack α ∈ (−π, π].
export function foilCoefficients(foil: FoilSpec, alpha: number, out: FoilCoefficients): FoilCoefficients {
  const ar = aspectRatioOf(foil);
  const stall = foil.stallAngle ?? (32 * Math.PI) / 180;
  const cd0 = foil.zeroLiftDrag ?? 0.008;
  const e = foil.oswald ?? 0.9;
  const cd90 = foil.flatPlateDrag ?? 1.2;
  // Reverse flow (trailing edge first): fold into ±90°, with a weaker slope.
  let a = alpha;
  let slopeScale = 1;
  if (a > Math.PI / 2) {
    a -= Math.PI;
    slopeScale = 0.6;
  } else if (a < -Math.PI / 2) {
    a += Math.PI;
    slopeScale = 0.6;
  }
  const attachedCl = liftSlope(ar) * slopeScale * a;
  const attachedCd = cd0 + (attachedCl * attachedCl) / (Math.PI * e * ar);
  // Flat plate: normal force CN = cd90·sin α resolved into lift and drag.
  const sin = Math.sin(alpha);
  const cos = Math.cos(alpha);
  const plateCl = cd90 * sin * cos;
  const plateCd = cd0 + cd90 * sin * sin;
  const w = smoothstep((Math.abs(a) - stall) / (4 * (Math.PI / 180)));
  out.cl = attachedCl + (plateCl - attachedCl) * w;
  out.cd = attachedCd + (plateCd - attachedCd) * w;
  return out;
}

const coeff: FoilCoefficients = { cl: 0, cd: 0 };
const chord = vec3();
const tmp = vec3();

// Force on a foil from the WATER-relative inflow velocity (the velocity of
// the water as seen by the foil, body frame). Writes body-frame force.
export function foilForce(
  foil: FoilSpec,
  inflow: Vec3,
  deflection: number,
  immersion: number,
  out: FoilState,
  rho = RHO_SEAWATER,
): FoilState {
  const s = foil.spanAxis;
  // Chord rotated by the deflection about the span axis (Rodrigues; c ⟂ s).
  const c0 = foil.chordAxis;
  const cos = Math.cos(deflection);
  const sin = Math.sin(deflection);
  const sxcx = s.y * c0.z - s.z * c0.y;
  const sxcy = s.z * c0.x - s.x * c0.z;
  const sxcz = s.x * c0.y - s.y * c0.x;
  chord.x = c0.x * cos + sxcx * sin;
  chord.y = c0.y * cos + sxcy * sin;
  chord.z = c0.z * cos + sxcz * sin;
  // Normal n = s × c; inflow projected onto the section plane.
  const nx = s.y * chord.z - s.z * chord.y;
  const ny = s.z * chord.x - s.x * chord.z;
  const nz = s.x * chord.y - s.y * chord.x;
  const along = inflow.x * s.x + inflow.y * s.y + inflow.z * s.z;
  const ux = inflow.x - along * s.x;
  const uy = inflow.y - along * s.y;
  const uz = inflow.z - along * s.z;
  const speed = Math.hypot(ux, uy, uz);
  out.speed = speed;
  out.immersion = immersion;
  if (speed < 1e-6 || immersion <= 0) {
    out.alpha = 0;
    out.cl = 0;
    out.cd = 0;
    out.force.x = out.force.y = out.force.z = 0;
    return out;
  }
  const alpha = Math.atan2(ux * nx + uy * ny + uz * nz, ux * chord.x + uy * chord.y + uz * chord.z);
  foilCoefficients(foil, alpha, coeff);
  const q = 0.5 * rho * speed * speed * foil.area * immersion;
  const inv = 1 / speed;
  // Drag along the inflow, lift along s × û (perpendicular, in the section plane).
  const dx = ux * inv;
  const dy = uy * inv;
  const dz = uz * inv;
  const lx = s.y * dz - s.z * dy;
  const ly = s.z * dx - s.x * dz;
  const lz = s.x * dy - s.y * dx;
  out.alpha = alpha;
  out.cl = coeff.cl;
  out.cd = coeff.cd;
  out.force.x = q * (coeff.cl * lx + coeff.cd * dx);
  out.force.y = q * (coeff.cl * ly + coeff.cd * dy);
  out.force.z = q * (coeff.cl * lz + coeff.cd * dz);
  return out;
}

const water: WaterSample = waterSample();
const pointVel = vec3();
const inflowBody = vec3();

// Samples the water at the foil, computes immersion along the span and the
// water-relative inflow, and applies the force to the body at the centre of
// pressure.
export function applyFoil(
  body: RigidBody,
  foil: FoilSpec,
  deflection: number,
  sampler: WaterSampler,
  time: number,
  out: FoilState,
): FoilState {
  body.bodyToWorldPoint(out.worldPoint, foil.centre);
  const p = out.worldPoint;
  sampler.sample(p.x, p.y, p.z, time, water);
  // Depth of the root and tip from the head at the centre and the span's tilt.
  qRotate(tmp, body.orientation, foil.spanAxis);
  const half = foil.span / 2;
  const dRoot = water.pressureHead + tmp.y * half;
  const dTip = water.pressureHead - tmp.y * half;
  let immersion: number;
  if (dRoot >= 0 && dTip >= 0) immersion = 1;
  else if (dRoot <= 0 && dTip <= 0) immersion = 0;
  else immersion = Math.max(dRoot, dTip) / Math.abs(dRoot - dTip);
  body.pointVelocity(pointVel, p);
  tmp.x = water.velocityX - pointVel.x;
  tmp.y = water.velocityY - pointVel.y;
  tmp.z = water.velocityZ - pointVel.z;
  qRotateInverse(inflowBody, body.orientation, tmp);
  foilForce(foil, inflowBody, deflection, immersion, out);
  qRotate(out.worldForce, body.orientation, out.force);
  body.addForceAtPoint(out.worldForce, p);
  return out;
}
