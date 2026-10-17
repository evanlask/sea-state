// Fleet autopilots for the boats nobody is helming, driven purely through
// BoatControls like a human helm: drift (engines stopped), hold course and
// speed, follow (keep station on another boat), circle, and for the sailboat
// windAngle: hold a true wind angle (the boat's auto-trim sets the sails).

import { signedAngle, vectorToHeading } from '../core/conventions';
import type { AutopilotSetting, BoatControls } from './protocol';

export interface PilotState {
  heading: number; // rad
  speed: number; // m/s, surge
  yawRate: number; // rad/s, + starboard
  x: number;
  z: number;
  windFrom?: number; // rad, the mean true wind's "from" direction (windAngle)
}

// windAngle keeps out of irons and off a dead run (where an accidental gybe waits).
export const MIN_WIND_ANGLE = 40 * (Math.PI / 180);
export const MAX_WIND_ANGLE = 170 * (Math.PI / 180);

// A true wind angle (+ wind from starboard) clamped to what a sailboat can hold, keeping its tack.
export function holdableWindAngle(twa: number): number {
  const side = twa < 0 ? -1 : 1;
  return side * clamp(Math.abs(twa), MIN_WIND_ANGLE, MAX_WIND_ANGLE);
}

// The heading that puts the true wind at `twa` off the bow (+ from starboard).
const headingForWindAngle = (windFrom: number, twa: number): number => windFrom - twa;

// The nearest heading to `heading` a sailboat on `heading` now can hold: out of the no-go zone and off
// a dead run, staying on its present tack when the wanted heading is in either.
export function sailableHeading(windFrom: number, heading: number, current: number): number {
  const twa = signedAngle(windFrom - heading);
  const a = Math.abs(twa);
  if (a >= MIN_WIND_ANGLE && a <= MAX_WIND_ANGLE) return heading;
  const side = signedAngle(windFrom - current) < 0 ? -1 : 1;
  return headingForWindAngle(windFrom, side * clamp(a, MIN_WIND_ANGLE, MAX_WIND_ANGLE));
}

export interface PilotTarget {
  heading: number;
  speed: number; // m/s over ground
  x: number;
  z: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// A boat whose throttle doesn't map linearly onto speed, or that is too fast to drive flat out in a
// fleet: the Unlimited hydroplane. Without one, the autopilot drives the plain linear law.
export interface PilotTuning {
  cruise: number; // m/s, hold's speed when none is set
  maxSpeed: number; // m/s, the most hold and follow will ask for
  // Throttle that holds each speed in calm water (measured), for the feed-forward.
  feedForward: { speeds: readonly number[]; throttle: readonly number[] };
  circle: { speed: number; steer: number }; // circle at this speed, this much helm
  // Helm limit at speed: full lock up to `from` (m/s), easing to `limit` by `to`.
  helmAtSpeed: { from: number; to: number; limit: number };
}

// Unlimited hydroplane (calm water, Arcade and Realistic alike): throttle 0.15 holds 25 kn, 0.25
// 70 kn, 0.5 124 kn, full 174 kn. It holds 70 kn (80 mph) in a fleet, circles to the right (its weak
// side, the gentler circle) at 60 kn with 0.6 of its helm, and above 135 mph eases the helm, as full
// lock to the left trips it over from 180 mph.
export const HYDRO_PILOT: PilotTuning = {
  cruise: 36,
  maxSpeed: 71.5,
  feedForward: {
    speeds: [0, 4.9, 8, 12.8, 19, 22.5, 27.5, 31, 36, 41.4, 44.4, 55.5, 63.7, 75.9, 89],
    throttle: [0, 0.05, 0.1, 0.15, 0.2, 0.21, 0.22, 0.23, 0.25, 0.28, 0.3, 0.4, 0.5, 0.7, 1],
  },
  circle: { speed: 31, steer: 0.6 },
  helmAtSpeed: { from: 60, to: 80, limit: 0.4 },
};

function interpolateTable(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 1;
  while (xs[i]! < x) i++;
  const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!);
  return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
}

export class Autopilot {
  setting: AutopilotSetting;
  readonly topSpeed: number;
  readonly turnLag: number; // s: how far ahead the yaw rate is anticipated
  // A sailboat: hold and follow keep it out of irons and off a dead run (sailableHeading).
  readonly sails: boolean;
  readonly tuning: PilotTuning | null;
  private holdHeading: number | null = null;
  private holdTwa: number | null = null;
  private trim = 0; // tuned boats: integral throttle trim on top of the feed-forward

  constructor(
    setting: AutopilotSetting,
    topSpeed: number,
    turnLag: number,
    sails = false,
    tuning: PilotTuning | null = null,
  ) {
    this.setting = setting;
    this.topSpeed = topSpeed;
    this.turnLag = turnLag;
    this.sails = sails;
    this.tuning = tuning;
  }

  // The heading to steer for `heading`: as is, or for a sailboat the nearest it can sail.
  private course(own: PilotState, heading: number): number {
    return this.sails && own.windFrom !== undefined
      ? sailableHeading(own.windFrom, heading, own.heading)
      : heading;
  }

  steerTo(own: PilotState, heading: number): number {
    const err = signedAngle(heading - own.heading - own.yawRate * this.turnLag);
    const h = this.tuning?.helmAtSpeed;
    const limit = h ? 1 - (1 - h.limit) * clamp((own.speed - h.from) / (h.to - h.from), 0, 1) : 1;
    return clamp(err * 2.5, -limit, limit);
  }

  // dt: s since the last call, for a tuned boat's integral trim.
  throttleFor(own: PilotState, speed: number, dt = 0): number {
    const t = this.tuning;
    if (t) {
      // The measured throttle for the speed, trimmed by the error and its integral (which takes up
      // the drag of a turn, a sea or another loading); a boat with no reverse.
      const v = Math.min(speed, t.maxSpeed);
      const ff = interpolateTable(t.feedForward.speeds, t.feedForward.throttle, v);
      const err = (v - own.speed) / t.maxSpeed;
      // Only near the speed: no wind-up while it accelerates from rest.
      if (Math.abs(v - own.speed) < 5) this.trim = clamp(this.trim + 0.15 * err * dt, -0.3, 0.3);
      return clamp(ff + 1.5 * err + this.trim, 0, 1);
    }
    const ff = clamp(speed / this.topSpeed, -1, 1);
    return clamp(ff + (2 * (speed - own.speed)) / this.topSpeed, -1, 1);
  }

  // Writes the helm for this step (dt s long).
  control(own: PilotState, target: PilotTarget | null, out: BoatControls, dt = 1 / 120): void {
    out.thruster = 0;
    out.trim = 0;
    out.mainSheet = 0;
    out.jibSheet = 0;
    out.brake = false;
    out.letFly = false;
    const s = this.setting;
    switch (s.mode) {
      case 'drift':
        out.throttle = 0;
        out.steer = 0;
        return;
      case 'circle':
        if (this.tuning) {
          out.throttle = this.throttleFor(own, this.tuning.circle.speed, dt);
          out.steer = this.tuning.circle.steer;
          return;
        }
        out.throttle = 0.5;
        out.steer = 0.6;
        return;
      case 'hold': {
        if (this.holdHeading === null) this.holdHeading = s.heading ?? own.heading;
        out.steer = this.steerTo(own, this.course(own, this.holdHeading));
        out.throttle = this.throttleFor(own, s.speed ?? this.tuning?.cruise ?? 0.75 * this.topSpeed, dt);
        return;
      }
      case 'windAngle': {
        out.throttle = 0;
        const from = own.windFrom;
        if (from === undefined) {
          out.steer = 0;
          return;
        }
        if (this.holdTwa === null) this.holdTwa = holdableWindAngle(s.twa ?? signedAngle(from - own.heading));
        out.steer = this.steerTo(own, headingForWindAngle(from, this.holdTwa));
        return;
      }
      case 'follow': {
        if (!target) {
          out.throttle = 0;
          out.steer = 0;
          return;
        }
        // Station relative to the target's heading.
        const f = s.offsetForward ?? 0;
        const r = s.offsetStarboard ?? 0;
        const sin = Math.sin(target.heading);
        const cos = Math.cos(target.heading);
        const sx = target.x + f * sin + r * cos;
        const sz = target.z - f * cos + r * sin;
        const dx = sx - own.x;
        const dz = sz - own.z;
        const dist = Math.hypot(dx, dz);
        // Far: head for the station; close: match the target's course.
        const blend = clamp((dist - 20) / 80, 0, 1);
        const toStation = vectorToHeading(dx, dz);
        const heading =
          blend > 0 ? target.heading + signedAngle(toStation - target.heading) * blend : target.heading;
        out.steer = this.steerTo(own, this.course(own, heading));
        // Close the along-track gap.
        const along = dx * sin - dz * cos;
        const cap = s.speed ?? this.topSpeed;
        out.throttle = this.throttleFor(own, clamp(target.speed + 0.05 * along, 0, cap), dt);
        return;
      }
    }
  }

  reset(): void {
    this.holdHeading = null;
    this.holdTwa = null;
    this.trim = 0;
  }
}
