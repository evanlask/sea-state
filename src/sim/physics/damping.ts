// Extra roll damping (bilge keels, eddy making, viscous hull damping) that the
// per-triangle Kerner terms under-predict at low speed. Specified as a
// fraction of critical damping about the roll axis, scaled by immersion.
//
//   M = −2ζ·√(C44·I44)·p − B2·|p|·p,   C44 = ρ g ∇ GM,   I44 = I_roll·(1 + a_roll)
//
// The quadratic part is the bilge keels' eddy making, which grows with the roll
// amplitude (Ikeda): given as the extra equivalent ζ_q it adds at a 20° roll at
// the natural period, B2 = ζ_q·2√(C44·I44) / ((8/3π)·ω_n·φ_a).

import { type Vec3, qRotate, qRotateInverse, vec3 } from '../core/math';
import { GRAVITY, RHO_SEAWATER } from '../core/units';
import type { RigidBody } from './RigidBody';

export interface RollDampingSpec {
  zeta: number; // fraction of critical, linear
  quadratic?: number; // B2 coefficient, N·m·s² (optional)
  quadraticZeta?: number; // or B2 as the extra equivalent ζ at a 20° roll (see above)
}

const QUADRATIC_REFERENCE = (20 * Math.PI) / 180; // rad

const wb = vec3();
const bow = vec3();
const BOW = vec3(0, 0, -1);
const torqueBody = vec3();
const torqueWorld: Vec3 = vec3();

export class RollDamper {
  readonly linear: number; // N·m·s/rad at full immersion
  readonly quadratic: number;

  constructor(spec: RollDampingSpec, displacedVolume: number, gm: number, rollInertia: number) {
    const c44 = RHO_SEAWATER * GRAVITY * displacedVolume * Math.max(gm, 0.01);
    const critical = 2 * Math.sqrt(c44 * rollInertia);
    this.linear = spec.zeta * critical;
    const omega = Math.sqrt(c44 / rollInertia);
    this.quadratic =
      (spec.quadratic ?? 0) +
      ((spec.quadraticZeta ?? 0) * critical) / ((8 / (3 * Math.PI)) * omega * QUADRATIC_REFERENCE);
  }

  // Roll is rotation about the body z (fore-aft) axis.
  apply(body: RigidBody): void {
    if (body.immersion <= 0) return;
    qRotateInverse(wb, body.orientation, body.angularVelocity);
    const p = wb.z;
    torqueBody.x = 0;
    torqueBody.y = 0;
    torqueBody.z = -(this.linear * p + this.quadratic * Math.abs(p) * p) * body.immersion;
    qRotate(torqueWorld, body.orientation, torqueBody);
    body.addTorque(torqueWorld);
  }
}

// Heave and pitch radiation damping that the pressure-only hull model lacks
// (big ships otherwise bob for half a minute after a disturbance). Linear, as
// a fraction of critical, on the motion RELATIVE to the water's vertical
// orbital velocity, so it damps the response to waves rather than the waves.
//
//   F = −2ζ₃·√(C33·M33)·(w − w_water)·s,   C33 = ρ g A_wp
//   M = −2ζ₅·√(C55·I55)·q·s,               C55 = ρ g I_L (waterplane, longitudinal)
//
// s is the immersion, or for a planing hull (`wetted`) the wetted fraction of its
// design wetted surface: the damping comes from the bottom pressing on the
// water, which a planing hull keeps about a third of at a tenth of its
// displacement and which stops growing once the bottom is all wet. Immersion
// scaling would be far too weak on a chop yet far too strong when buried.
export interface HeavePitchDampingSpec {
  heave: number; // ζ₃
  pitch: number; // ζ₅
  wetted?: boolean; // scale with the wetted surface rather than the immersion (planing hulls)
}

export class HeavePitchDamper {
  readonly heave: number; // N·s/m at full immersion
  readonly pitch: number; // N·m·s/rad

  constructor(
    spec: HeavePitchDampingSpec,
    waterplaneArea: number,
    waterplaneIzz: number,
    heaveMass: number,
    pitchInertia: number,
  ) {
    const c33 = RHO_SEAWATER * GRAVITY * waterplaneArea;
    const c55 = RHO_SEAWATER * GRAVITY * waterplaneIzz;
    this.heave = 2 * spec.heave * Math.sqrt(c33 * heaveMass);
    this.pitch = 2 * spec.pitch * Math.sqrt(c55 * pitchInertia);
  }

  // waterVelocityY: vertical orbital velocity of the surface over the CG;
  // imm: the scale s (the immersion by default).
  apply(body: RigidBody, waterVelocityY: number, imm = body.immersion): void {
    if (imm <= 0) return;
    body.force.y -= this.heave * imm * (body.velocity.y - waterVelocityY);
    // Pitch: on the rate of change of trim (the bow's elevation), i.e. the rotation
    // about the horizontal axis across the bow, a = f × up / |f × up|. Not on the
    // body's x angular velocity, which in a banked turn includes r·sin φ of the yaw
    // rate: a steady turn would be damped as if it were pitching.
    const w = body.angularVelocity;
    const f = qRotate(bow, body.orientation, BOW);
    const len = Math.hypot(f.x, f.z);
    if (len < 0.1) return; // bow straight up or down
    const ax = -f.z / len;
    const az = f.x / len;
    const m = -this.pitch * imm * (w.x * ax + w.z * az);
    body.torque.x += m * ax;
    body.torque.z += m * az;
  }
}
