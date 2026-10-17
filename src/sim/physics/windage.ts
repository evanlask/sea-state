// Above-water wind loads with Blendermann's (1994) coefficient model, from
// the lateral and frontal projected areas and their centres of effort.
//
//   denominator D(ε) = 1 − δ/2·(1 − CDl/CDt)·sin²(2ε),  CDl = CDl_AF·A_F/A_L
//   longitudinal  X = −q·A_F·CDl_AF·cos ε / D
//   lateral       Y = −q·A_L·CDt·sin ε / D
//   yaw arm       x_N = L·(s_L/L − 0.18·(|ε| − π/2))        (forward of the origin)
//   heel          the lateral force acts at κ·s_H above the waterline
//
// ε is the apparent-wind angle off the bow (0 = head wind, π/2 = from starboard)
// and q = ½ρ_air·V_rel², with the relative wind sampled at the lateral centre
// of effort height (sheared) and averaged over three points along the length
// (the centre and ±35% of L_oa): a long hull spans several gust patches.
// Forces point downwind; with the CG below the centre of effort a beam wind
// heels the boat to leeward and makes it drift.

import { fromDirectionToVelocity } from '../core/conventions';
import { type Vec3, qRotate, qRotateInverse, vec3 } from '../core/math';
import type { RigidBody } from './RigidBody';

export const RHO_AIR_BLENDERMANN = 1.224; // kg/m³, Blendermann's reference density

// Air velocity (world, m/s) at a world point and time; y is height above the
// mean sea level.
export interface WindSampler {
  sample(x: number, y: number, z: number, time: number, out: Vec3): Vec3;
}

export class UniformWind implements WindSampler {
  readonly velocity: Vec3;

  constructor(speed: number, fromDirection: number) {
    const v = fromDirectionToVelocity(fromDirection, speed);
    this.velocity = vec3(v.x, 0, v.z);
  }

  sample(_x: number, _y: number, _z: number, _time: number, out: Vec3): Vec3 {
    out.x = this.velocity.x;
    out.y = 0;
    out.z = this.velocity.z;
    return out;
  }
}

// Neutral log-law profile anchored at 10 m: U(y) = U10·ln(y/z0)/ln(10/z0).
export class LogShearWind implements WindSampler {
  readonly dirX: number;
  readonly dirZ: number;
  readonly speed10: number;
  readonly roughness: number;

  constructor(speed10: number, fromDirection: number, roughness = 2e-4) {
    const v = fromDirectionToVelocity(fromDirection, 1);
    this.dirX = v.x;
    this.dirZ = v.z;
    this.speed10 = speed10;
    this.roughness = roughness;
  }

  sample(_x: number, y: number, _z: number, _time: number, out: Vec3): Vec3 {
    const height = Math.max(y, 2 * this.roughness);
    const speed = (this.speed10 * Math.log(height / this.roughness)) / Math.log(10 / this.roughness);
    out.x = this.dirX * speed;
    out.y = 0;
    out.z = this.dirZ * speed;
    return out;
  }
}

export interface BlendermannCoefficients {
  cdt: number; // transverse drag coefficient (A_L based)
  cdlHead: number; // longitudinal coefficient, head wind (A_F based)
  cdlStern: number; // longitudinal coefficient, stern wind (A_F based)
  delta: number; // cross-force parameter δ
  kappa: number; // rolling-moment factor κ
}

// Verified Blendermann table values [V].
export const BLENDERMANN = {
  containerShipLoaded: { cdt: 0.9, cdlHead: 0.55, cdlStern: 0.55, delta: 0.4, kappa: 1.4 },
  passengerLiner: { cdt: 0.9, cdlHead: 0.4, cdlStern: 0.4, delta: 0.8, kappa: 1.2 },
  fishingVessel: { cdt: 0.95, cdlHead: 0.7, cdlStern: 0.7, delta: 0.4, kappa: 1.1 },
  speedBoat: { cdt: 0.9, cdlHead: 0.55, cdlStern: 0.6, delta: 0.6, kappa: 1.1 },
} as const satisfies Record<string, BlendermannCoefficients>;

type BlendermannType = keyof typeof BLENDERMANN;

export interface WindageSpec {
  type: BlendermannType;
  lateralArea: number; // A_L, m²
  frontalArea: number; // A_F, m²
  length: number; // L_oa, m
  lateralCentreHeight: number; // s_H, centroid of A_L above the waterline, m
  lateralCentreForward: number; // s_L, centroid of A_L forward of the body origin, m
  frontalCentreHeight: number; // centroid of A_F above the waterline, m
  waterlineY?: number; // body y of the design waterline, default 0
}

export interface WindageResult {
  apparentSpeed: number;
  apparentAngle: number; // ε, rad off the bow (0 head, +π/2 from starboard, ±π astern)
  force: Vec3; // world, N
  forceBody: Vec3; // body frame, N
}

export const windageResult = (): WindageResult => ({
  apparentSpeed: 0,
  apparentAngle: 0,
  force: vec3(),
  forceBody: vec3(),
});

// Blendermann non-dimensional forces for apparent-wind angle ε: X along the
// bow (positive forward) on A_F, Y to starboard on A_L, and the yaw arm.
export function blendermann(
  c: BlendermannCoefficients,
  spec: WindageSpec,
  eps: number,
  out: { cx: number; cy: number; arm: number },
): { cx: number; cy: number; arm: number } {
  const absEps = Math.abs(eps);
  const cdlAF = absEps <= Math.PI / 2 ? c.cdlHead : c.cdlStern;
  const cdl = (cdlAF * spec.frontalArea) / spec.lateralArea;
  const s2 = Math.sin(2 * eps);
  const denom = 1 - (c.delta / 2) * (1 - cdl / c.cdt) * s2 * s2;
  out.cx = (-cdlAF * Math.cos(eps)) / denom;
  out.cy = (-c.cdt * Math.sin(eps)) / denom;
  // Lateral centre migrates toward the windward end of the ship.
  out.arm = spec.lateralCentreForward - 0.18 * spec.length * (absEps - Math.PI / 2);
  return out;
}

const coeffs = { cx: 0, cy: 0, arm: 0 };
const ceWorld = vec3();
const ceBody = vec3();
const wind = vec3();
const pointVel = vec3();
const rel = vec3();
const relBody = vec3();
const fBody = vec3();
const fWorld = vec3();

export function applyWindage(
  body: RigidBody,
  spec: WindageSpec,
  sampler: WindSampler,
  time: number,
  out: WindageResult,
  scale = 1,
  rho = RHO_AIR_BLENDERMANN,
): WindageResult {
  const c = BLENDERMANN[spec.type];
  const wl = spec.waterlineY ?? 0;
  // Relative wind at the lateral centre of effort's height, averaged along the length.
  rel.x = rel.y = rel.z = 0;
  for (const along of ALONG) {
    ceBody.x = 0;
    ceBody.y = wl + spec.lateralCentreHeight;
    ceBody.z = -spec.lateralCentreForward + along * spec.length;
    body.bodyToWorldPoint(ceWorld, ceBody);
    sampler.sample(ceWorld.x, Math.max(ceWorld.y, 0.1), ceWorld.z, time, wind);
    body.pointVelocity(pointVel, ceWorld);
    rel.x += (wind.x - pointVel.x) / ALONG.length;
    rel.y += (wind.y - pointVel.y) / ALONG.length;
    rel.z += (wind.z - pointVel.z) / ALONG.length;
  }
  qRotateInverse(relBody, body.orientation, rel);
  // Air moving with velocity relBody comes FROM −relBody: forward = −z, starboard = +x.
  const fromForward = relBody.z; // component of −rel along the bow (−z)
  const fromStarboard = -relBody.x;
  const speed2 = fromForward * fromForward + fromStarboard * fromStarboard;
  out.apparentSpeed = Math.sqrt(speed2);
  const eps = Math.atan2(fromStarboard, fromForward);
  out.apparentAngle = eps;
  if (speed2 < 1e-8) {
    out.force.x = out.force.y = out.force.z = 0;
    out.forceBody.x = out.forceBody.y = out.forceBody.z = 0;
    return out;
  }
  blendermann(c, spec, eps, coeffs);
  const q = 0.5 * rho * speed2 * scale;
  // Heel turns the lateral area away from the wind.
  qRotate(fWorld, body.orientation, UP);
  const upright = Math.max(0, fWorld.y);
  const forward = q * spec.frontalArea * coeffs.cx;
  const lateral = q * spec.lateralArea * coeffs.cy * upright;
  // Lateral force at κ·s_H above the waterline and the yaw arm forward of the origin.
  fBody.x = lateral;
  fBody.y = 0;
  fBody.z = 0;
  ceBody.y = wl + c.kappa * spec.lateralCentreHeight;
  ceBody.z = -coeffs.arm;
  body.addBodyForceAtBodyPoint(fBody, ceBody);
  // Longitudinal force on the centreline at the frontal centre height.
  fBody.x = 0;
  fBody.z = -forward;
  ceBody.y = wl + spec.frontalCentreHeight;
  ceBody.z = -spec.lateralCentreForward;
  body.addBodyForceAtBodyPoint(fBody, ceBody);
  out.forceBody.x = lateral;
  out.forceBody.y = 0;
  out.forceBody.z = -forward;
  qRotate(out.force, body.orientation, out.forceBody);
  return out;
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const ALONG = [-0.35, 0, 0.35]; // × L_oa along the hull from the centre of effort
