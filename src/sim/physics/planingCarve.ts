// Carving of a planing V-hull in a turn. A deep-V boat banks into a hard turn
// and carries the turn's side force on its banked bottom: the outer (leading)
// chine planes harder as the hull slides, the inner chine digs in. The canoe
// mesh is too coarse for that: its bottom normals meet below the CG of these
// high-CG small craft, so on its own the side force of a hard turn rolls the
// boat outward and trips it over the outer chine, which a real deep-V (or a
// ridden jet ski) doesn't do in calm water. This adds the missing roll moment
// as a stiffness toward the coordinated bank atan(V·χ̇/g) of the turn the helm
// makes (TurnSense below: χ̇ is the course rate, not the yaw rate; level with the
// helm amidships), capped at the bank the hull carves at (about its deadrise),
// and scaled by the planing load q·A_wet·B so it vanishes off the plane, in the
// air and at low speed:
//
//   M = clamp(K·(φ* − φ) − D·p, ±M_max),  K = c·½ρU²·A_wet·B,  D = 2ζ√(K·I_roll)
//
// U is the speed of the water over the bottom, surge and sway together, not the
// surge alone: in a slide (40-60° to the course at full lock in a chop) the surge
// drops but the bottom still crosses the water fast, planes on its leading chine,
// and the carve must not fade out or the coarse bottom trips the boat.
//
// It only acts while planing (above a per-boat speed), so a boat lying beam-on to
// breaking seas, or knocked past ~60°, rolls and capsizes on the hull alone.
//
// With `onWater` (the center console) the bank φ* is sought relative to the sea
// surface across the hull (its heights at the chines at the wetted centroid's
// station, so waves shorter than the beam average out), and the moment is capped
// at the bottom's lift acting at a chine, L·B/2 (L the hull's vertical water
// force). Held level against the horizon instead, the carve would hold the boat
// up across a breaking face and through landings. The jet ski keeps its carve
// against the horizon: it stands in for its rider's knees as much as for its
// hull, and the rider balances by gravity (propulsion/rider.ts). Once a capsize
// has thrown him off (setRider) only the hull is left and the carve is taken on
// the sea surface as for the center console.

import { attitudeFromQuat } from '../core/attitude';
import { signedAngle } from '../core/conventions';
import { type Vec3, qRotate, qRotateInverse, vec3 } from '../core/math';
import { GRAVITY, RHO_SEAWATER } from '../core/units';
import type { ForceContext, ForceModule } from './modules';
import { waterSample } from './water';

export interface CarveSpec {
  maxBank: number; // rad, the bank the hull carves at in a hard turn
  stiffness: number; // c, roll stiffness per unit q·A_wet·B, per rad
  damping?: number; // ζ, default 1
  maxMoment: number; // N·m
  beam: number; // chine beam B, m
  planingSpeed: [number, number]; // m/s: no carve below the first, full above the second
  onWater?: boolean; // bank relative to the sea surface, moment capped by the bottom's lift (see above)
}

// Into a turn the bank follows at once; coming out it eases off over a short
// lag, so the snap of the yaw rate when the helm is released straightens the
// boat without rocking it the other way.
const BANK_LAG = 0.3; // s

const STARBOARD = vec3(1, 0, 0);
const MAX_SURFACE_ROLL = 0.6; // rad

const wb = vec3();
const vb = vec3();
const sb = vec3();
const tb = vec3();
const tw = vec3();

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Coordinated bank for a turn at forward speed u and yaw rate r (+ starboard).
const coordinatedBank = (u: number, r: number): number => Math.atan((u * r) / GRAVITY);

// The turn a planing craft banks into, sensed the way its rider feels it: the
// centripetal acceleration of the path, V·χ̇ (χ the course), smoothed over a
// fraction of a second. Not the hull's yaw rate: in a chop every wave jolts the
// heading by 5-10°/s while the path hardly bends. In a steady turn the course
// rate equals the yaw rate.
//
// The bank is only sought while the helm is over (what the driver or a jet
// ski's rider leaning in does). With the helm amidships the target is level, so
// K holds the hull upright; otherwise a hull heeled by a wave would start the
// slight turn a heeled V makes, K would hold that bank, and the craft would
// spiral off course.
const TURN_LAG = 0.25; // s
const MAX_COURSE_RATE = 2; // rad/s
const HELM_TURN = 0.3; // helm (−1..1) from which the full turn bank is sought

// 0 with the helm amidships .. 1 from HELM_TURN over.
export const helmTurn = (steer: number): number => Math.min(1, Math.abs(steer) / HELM_TURN);

export class TurnSense {
  rate = 0; // smoothed course rate, rad/s, + to starboard
  private course = Number.NaN;

  // Advances one substep; returns the coordinated bank of the sensed turn (+ starboard down).
  update(velocity: Vec3, dt: number): number {
    const v = Math.hypot(velocity.x, velocity.z);
    if (v < 0.5) {
      this.course = Number.NaN;
      this.rate *= 1 - Math.min(1, dt / TURN_LAG);
      return 0;
    }
    const course = Math.atan2(velocity.x, -velocity.z);
    let r = 0;
    if (!Number.isNaN(this.course) && dt > 0) {
      r = signedAngle(course - this.course) / dt;
      r = Math.max(-MAX_COURSE_RATE, Math.min(MAX_COURSE_RATE, r));
    }
    this.course = course;
    this.rate += (r - this.rate) * Math.min(1, dt / TURN_LAG);
    return coordinatedBank(v, this.rate);
  }

  reset(): void {
    this.rate = 0;
    this.course = Number.NaN;
  }
}

export class PlaningCarve implements ForceModule {
  readonly spec: CarveSpec;
  bank = 0;
  surfaceRoll = 0; // rad, + the surface across the hull falls to starboard
  riderAboard = true; // a sit-on craft's rider (the carve stands in for his knees): off, onWater
  private readonly sample = waterSample();
  private readonly turn = new TurnSense();
  private readonly attitude = { heading: 0, pitch: 0, roll: 0 };

  constructor(spec: CarveSpec) {
    this.spec = spec;
  }

  apply(ctx: ForceContext): void {
    const s = this.spec;
    const body = ctx.body;
    const att = attitudeFromQuat(body.orientation, this.attitude);
    const wet = ctx.hull?.wettedArea ?? 0;
    qRotateInverse(vb, body.orientation, body.velocity);
    const u = Math.hypot(vb.x, vb.z); // over the bottom, surge and sway (see above)
    const planing = smoothstep(s.planingSpeed[0], s.planingSpeed[1], u);
    const turnBank = this.turn.update(body.velocity, ctx.dt);
    if (planing <= 0 || wet <= 0 || Math.abs(att.roll) > 1.05) {
      this.bank *= 1 - Math.min(1, ctx.dt / BANK_LAG);
      return;
    }
    qRotateInverse(wb, body.orientation, body.angularVelocity);
    // + roll is starboard down (rotation about −z body); a starboard turn is about −y.
    const max = s.maxBank;
    const target = Math.min(max, Math.max(-max, turnBank)) * planing * helmTurn(ctx.controls.steer);
    const deeper = target * this.bank >= 0 && Math.abs(target) >= Math.abs(this.bank);
    this.bank = deeper ? target : this.bank + (target - this.bank) * Math.min(1, ctx.dt / BANK_LAG);
    const onWater = s.onWater || !this.riderAboard;
    this.surfaceRoll = onWater ? this.surfaceSlope(ctx) : 0;
    const k = s.stiffness * 0.5 * RHO_SEAWATER * u * u * wet * s.beam * planing;
    const d = 2 * (s.damping ?? 1) * Math.sqrt(k * body.effectiveInertia(2));
    const m = k * (att.roll - this.bank - this.surfaceRoll) - d * wb.z;
    const cap = onWater
      ? Math.min(s.maxMoment, Math.max(0, ctx.hull?.force.y ?? 0) * 0.5 * s.beam)
      : s.maxMoment;
    tb.x = 0;
    tb.y = 0;
    tb.z = Math.min(cap, Math.max(-cap, m));
    qRotate(tw, body.orientation, tb);
    body.addTorque(tw);
  }

  // Roll of the sea surface across the hull: its heights half the chine beam either side of the wetted
  // centroid, along the horizontal starboard direction (port higher: the surface falls to starboard, +).
  private surfaceSlope(ctx: ForceContext): number {
    const c = ctx.hull?.wettedCentroid;
    if (!c) return 0;
    qRotate(sb, ctx.body.orientation, STARBOARD);
    const len = Math.hypot(sb.x, sb.z);
    if (len < 0.1) return 0;
    const h = (0.5 * this.spec.beam) / len;
    const s = this.sample;
    const starboard = ctx.water.sample(c.x + sb.x * h, c.y, c.z + sb.z * h, ctx.time, s).height;
    const port = ctx.water.sample(c.x - sb.x * h, c.y, c.z - sb.z * h, ctx.time, s).height;
    const roll = Math.atan((port - starboard) / this.spec.beam);
    return Math.min(MAX_SURFACE_ROLL, Math.max(-MAX_SURFACE_ROLL, roll));
  }

  writeTelemetry(): void {}

  setRider(aboard: boolean): void {
    this.riderAboard = aboard;
  }

  reset(): void {
    this.bank = 0;
    this.surfaceRoll = 0;
    this.turn.reset();
  }
}
