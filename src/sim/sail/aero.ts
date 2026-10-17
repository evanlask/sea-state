// Sail aerodynamics: lift/drag polars against angle of attack for a soft, cambered sail, the apparent
// wind, and the resulting force in the sail's section plane.
//
// Angle of attack α is measured in the plane perpendicular to the mast between the incoming flow and
// the sail's chord (boom or tack→clew line). A soft sail can't hold its shape at small α: below
// `fillAngle` the luff starts to back and below `collapseAngle` the whole sail flogs (no lift, flog
// drag). Filled, lift rises from the camber lift with Helmbold's finite-span slope to a rounded CLmax,
// then stalls into a separated-flow regime that ends at flat-plate normal drag square to the wind.
// Induced drag is CL²/(π·e·AR) with the effective aspect ratio of the rig. Because a sail turns inside
// out when backed, CL is odd and CD even in α; past ±90° the leech leads (reversed, weak lift).
//
// Sign conventions (body frame, x starboard, z aft): the flow angle θ_f = atan2(v_x, v_z) and the
// chord angle (β, γ) are both measured from aft (+Z) toward starboard (+X). α = θ_chord − θ_flow.
// Lift acts along (−d_z, d_x)·sign-of-CL, drag along the flow d.

import { type Vec3 } from '../core/math';
import { liftSlope } from '../physics/foils';
import { clamp, smoothstep } from './util';

const DEG = Math.PI / 180;

export interface SailPolar {
  camberLift: number; // CL of the filled sail at α = 0
  clMax: number;
  collapseAngle: number; // rad, fully luffing below this
  fillAngle: number; // rad, fully drawing above this
  stallAngle: number; // rad, start of separation
  stallWidth: number; // rad, blend into the separated regime
  profileDrag: number; // CD0 of the filled sail (incl. mast/forestay interference)
  flogDrag: number; // CD of a flogging sail
  plateNormal: number; // CD square to the wind
  oswald: number; // span efficiency of the loading
  reverseLift: number; // lift factor with the leech leading
}

// Fit to published soft-sail data (Marchaj; Hazen's VPP coefficients) and tuned against the ORC polar.
export const MAIN_POLAR: SailPolar = {
  camberLift: 0.35,
  clMax: 1.6,
  collapseAngle: 1.5 * DEG,
  fillAngle: 7 * DEG,
  stallAngle: 21 * DEG,
  stallWidth: 8 * DEG,
  profileDrag: 0.03,
  flogDrag: 0.09,
  plateNormal: 1.35, // a cupped soft sail square to the wind
  oswald: 0.8,
  reverseLift: 0.5,
};

// The overlapping genoa leads with clean air and the slot, so it fills at a smaller α and lifts more.
export const GENOA_POLAR: SailPolar = {
  camberLift: 0.4,
  clMax: 1.65,
  collapseAngle: 1 * DEG,
  fillAngle: 5.5 * DEG,
  stallAngle: 20 * DEG,
  stallWidth: 8 * DEG,
  profileDrag: 0.025,
  flogDrag: 0.08,
  plateNormal: 1.3,
  oswald: 0.85,
  reverseLift: 0.5,
};

export interface SailCoefficients {
  cl: number; // signed (odd in α)
  cd: number;
  fill: number; // 0 flogging .. 1 drawing
  stall: number; // 0 attached .. 1 fully separated
}

export const sailCoefficientsResult = (): SailCoefficients => ({ cl: 0, cd: 0, fill: 0, stall: 0 });

// Lift of the filled, attached sail: linear from the camber lift, rounded off into CLmax.
function attachedLift(camberLift: number, clMax: number, slope: number, a: number): number {
  const x = camberLift + slope * a;
  const knee = 0.8 * clMax;
  if (x <= knee) return x;
  const band = clMax - knee;
  return clMax - band * Math.exp(-(x - knee) / band);
}

// Coefficients for |α| ≤ 90° (a ≥ 0); the caller handles sign and reversed flow.
function forwardCoefficients(
  p: SailPolar,
  aspectRatio: number,
  a: number,
  clMaxScale: number,
  out: SailCoefficients,
): void {
  const ar = Math.max(aspectRatio, 0.5);
  const slope = liftSlope(ar);
  const clMax = p.clMax * clMaxScale;
  const clAtt = attachedLift(p.camberLift, clMax, slope, a);
  const induced = 1 / (Math.PI * p.oswald * ar);
  const cdAtt = p.profileDrag + clAtt * clAtt * induced;
  // Separated regime: lift falls to zero square to the wind, drag rises to the flat plate.
  const span = Math.PI / 2 - p.stallAngle;
  const x = clamp((a - p.stallAngle) / span, 0, 1);
  const clSep = clMax * (1 - x ** 1.6);
  const cdStall = p.profileDrag + clMax * clMax * induced;
  const s = Math.sin(x * (Math.PI / 2));
  const cdSep = cdStall + (p.plateNormal - cdStall) * s * s;
  const w = smoothstep((a - p.stallAngle) / p.stallWidth);
  const fill = smoothstep((a - p.collapseAngle) / (p.fillAngle - p.collapseAngle));
  const clFilled = clAtt + (clSep - clAtt) * w;
  const cdFilled = cdAtt + (cdSep - cdAtt) * w;
  out.cl = clFilled * fill;
  out.cd = cdFilled * fill + p.flogDrag * (1 - fill);
  out.fill = fill;
  out.stall = w;
}

// Lift and drag coefficients at angle of attack α ∈ (−π, π]. `clMaxScale` derates a sail with a poor
// shape (e.g. a part-furled genoa).
export function sailCoefficients(
  p: SailPolar,
  aspectRatio: number,
  alpha: number,
  out: SailCoefficients,
  clMaxScale = 1,
): SailCoefficients {
  const sign = alpha < 0 ? -1 : 1;
  let a = Math.abs(alpha);
  let liftScale = 1;
  if (a > Math.PI / 2) {
    a = Math.PI - a;
    liftScale = -p.reverseLift;
  }
  forwardCoefficients(p, aspectRatio, a, clMaxScale, out);
  out.cl *= sign * liftScale;
  return out;
}

// Wraps an angle into (−π, π].
function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

// Air velocity relative to a point moving with the boat: true wind minus the point's velocity.
export function apparentWind(out: Vec3, trueWind: Vec3, pointVelocity: Vec3): Vec3 {
  out.x = trueWind.x - pointVelocity.x;
  out.y = trueWind.y - pointVelocity.y;
  out.z = trueWind.z - pointVelocity.z;
  return out;
}

// Apparent-wind angle off the bow from a BODY-frame relative air velocity: 0 head to wind, +π/2 from
// starboard, ±π from astern (same convention as windage.ts and the HUD).
export const windAngleOffBow = (airX: number, airZ: number): number => Math.atan2(-airX, airZ);

// Flow angle of a body-frame air velocity, measured like the boom (from aft toward starboard).
const flowAngle = (airX: number, airZ: number): number => Math.atan2(airX, airZ);

export interface SailForce {
  alpha: number; // rad
  speed: number; // m/s, in the section plane
  q: number; // Pa
  cl: number;
  cd: number;
  fill: number;
  stall: number;
  fx: number; // body-frame force, N
  fz: number;
}

export const sailForceResult = (): SailForce => ({
  alpha: 0,
  speed: 0,
  q: 0,
  cl: 0,
  cd: 0,
  fill: 0,
  stall: 0,
  fx: 0,
  fz: 0,
});

const coeff = sailCoefficientsResult();

// Force on one sail from the body-frame relative air (airX, airZ: already projected into the plane
// perpendicular to the mast, so heel reduces it) with the chord at `chordAngle`.
export function sailForce(
  p: SailPolar,
  area: number,
  aspectRatio: number,
  chordAngle: number,
  airX: number,
  airZ: number,
  rho: number,
  out: SailForce,
  clMaxScale = 1,
): SailForce {
  const speed = Math.hypot(airX, airZ);
  out.speed = speed;
  if (speed < 1e-6 || area <= 0) {
    out.alpha = 0;
    out.q = 0;
    out.cl = out.cd = out.fx = out.fz = out.fill = out.stall = 0;
    return out;
  }
  const alpha = wrapAngle(chordAngle - flowAngle(airX, airZ));
  sailCoefficients(p, aspectRatio, alpha, coeff, clMaxScale);
  const q = 0.5 * rho * speed * speed;
  const k = q * area;
  const dx = airX / speed;
  const dz = airZ / speed;
  out.alpha = alpha;
  out.q = q;
  out.cl = coeff.cl;
  out.cd = coeff.cd;
  out.fill = coeff.fill;
  out.stall = coeff.stall;
  out.fx = k * (coeff.cl * -dz + coeff.cd * dx);
  out.fz = k * (coeff.cl * dx + coeff.cd * dz);
  return out;
}
