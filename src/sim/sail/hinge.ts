// A sail on a 1-DOF hinge held by a sheet: the boom about the mast, or the genoa's clew about the
// forestay. The sail's aerodynamic moment, gravity when the boat heels and damping drive it; the
// sheet is a rope, so it only limits how far OUT the hinge can swing (|angle| ≤ limit, on either
// side) and snubs the swing with a small bounce when it fetches up. Nothing stops it crossing the
// centreline, which is exactly how an accidental gybe happens: when the wind gets behind the sail
// the boom swings across the whole sheet span and slams into the sheet on the other side.

import type { HingeSpec } from './rig';

// A crossing counts once the hinge is this far over on the new side.
const CROSSING_ANGLE = 0.15;
// A snub only counts as a slam after the hinge has swung at least this far free of the sheet.
const FREE_SWING = 0.05;

export class SheetedHinge {
  readonly spec: HingeSpec;
  angle = 0; // rad, + to starboard
  rate = 0; // rad/s
  limit: number; // rad, sheet limit (how far out the sail may go)
  // Angular momentum about the body +Y axis handed to the boat this step (sheet snubs), N·m·s.
  reactionImpulse = 0;
  lastImpactSpeed = 0; // rad/s at the last snub
  impacts = 0; // snubs harder than IMPACT_SPEED
  crossings = 0; // completed swings from one side to the other
  private travel = 0; // furthest the hinge has been from the sheet since it last fetched up
  side: -1 | 0 | 1 = 0; // 0 until the hinge first swings clear of the centreline

  static readonly IMPACT_SPEED = 0.6; // rad/s

  constructor(spec: HingeSpec, limit: number) {
    this.spec = spec;
    this.limit = limit;
  }

  reset(angle: number, limit: number): void {
    this.angle = angle;
    this.rate = 0;
    this.limit = limit;
    this.reactionImpulse = 0;
    this.lastImpactSpeed = 0;
    this.impacts = 0;
    this.crossings = 0;
    this.travel = 0;
    this.side = Math.abs(angle) > CROSSING_ANGLE ? (angle < 0 ? -1 : 1) : 0;
  }

  // Gravity's moment about the (vertical) hinge for body-frame gravity g: τ_y = r_z·F_x − r_x·F_z with
  // the hinge CG at (sin θ, 0, cos θ)·r.
  gravityTorque(gx: number, gz: number): number {
    return this.spec.massMoment * (Math.cos(this.angle) * gx - Math.sin(this.angle) * gz);
  }

  step(dt: number, torque: number): void {
    const s = this.spec;
    // Semi-implicit Euler; the damping term is implicit so a light hinge can't go unstable.
    this.rate = (this.rate + (torque / s.inertia) * dt) / (1 + (s.damping / s.inertia) * dt);
    this.angle += this.rate * dt;
    this.reactionImpulse = 0;
    const limit = Math.max(0, this.limit);
    if (this.angle > limit || this.angle < -limit) {
      const sign = this.angle > 0 ? 1 : -1;
      this.angle = sign * limit;
      if (this.rate * sign > 0) {
        const before = this.rate;
        this.rate = -s.restitution * before;
        // The sheet stops the swing; the boat takes the momentum (equal and opposite).
        this.reactionImpulse = s.inertia * (before - this.rate);
        const speed = Math.abs(before);
        // A sail held hard against its sheet chatters on it every step; only a real swing counts.
        if (speed > SheetedHinge.IMPACT_SPEED && this.travel > FREE_SWING) {
          this.lastImpactSpeed = speed;
          this.impacts++;
        }
        this.travel = 0;
      }
    } else {
      this.travel = Math.max(this.travel, limit - Math.abs(this.angle));
    }
    const now = this.angle > CROSSING_ANGLE ? 1 : this.angle < -CROSSING_ANGLE ? -1 : 0;
    if (now !== 0 && now !== this.side) {
      if (this.side !== 0) this.crossings++;
      this.side = now;
    }
  }
}
