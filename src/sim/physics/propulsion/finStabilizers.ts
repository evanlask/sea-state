// Active fin stabilisers (cruise ship): a pair of retractable foils at the bilge, one each side, turned
// in opposite senses by a roll controller so their lift makes a roll moment against the roll. Lift grows
// with the square of the speed through the water, so they work under way (a stabiliser is sized for
// service speed; below ~8 kn there is little left) and do nothing stopped. The controller feeds back
// mostly roll rate (damping) and some roll angle, as real ones do; it cannot hold a ship up against a
// steady wind heel, which takes tens of times their moment, but it takes most of the wave-driven roll
// out at speed. [E] sizes: two fins of ~15 m² each on a 120,000 GT cruise ship (Rolls-Royce/Brown
// Brothers Neptune, Fincantieri/SKF class figures), flap-assisted, ±25°, ~15°/s.
//
// Telemetry: finAngle (rad, starboard fin, + leading edge up), finMoment (N·m, + rights a starboard heel).

import { attitudeFromQuat } from '../../core/attitude';
import { qRotateInverse, vec3 } from '../../core/math';
import { RHO_SEAWATER } from '../../core/units';
import type { ForceContext, ForceModule } from '../modules';
import { waterSample } from '../water';
import { applyBodyForce, clamp, pointFlow, rateLimit, samplePointFlow } from './common';

export interface FinStabilizerSpec {
  area: number; // m² per fin
  position: { x: number; y: number; z: number }; // starboard fin's centre of pressure, body (port mirrored)
  maxAngle: number; // rad
  rate: number; // rad/s
  liftSlope: number; // dC_L/dα per rad (with the flap)
  maxLift: number; // C_L at the stall
  rollGain: number; // fin angle per rad of heel
  rateGain: number; // fin angle per rad/s of roll rate
}

const wb = vec3();
const MIN_SPEED = 0.5; // m/s

export class FinStabilizers implements ForceModule {
  readonly spec: FinStabilizerSpec;
  angle = 0; // starboard fin, rad
  moment = 0;
  private readonly attitude = { heading: 0, pitch: 0, roll: 0 };
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly port: { x: number; y: number; z: number };

  constructor(spec: FinStabilizerSpec) {
    this.spec = spec;
    this.port = { ...spec.position, x: -spec.position.x };
  }

  apply(ctx: ForceContext): void {
    const { body, dt } = ctx;
    const s = this.spec;
    const att = attitudeFromQuat(body.orientation, this.attitude);
    qRotateInverse(wb, body.orientation, body.angularVelocity);
    // + roll is starboard down, a rotation about −z body: roll rate = −ω_z. Lift up on the starboard
    // fin (+ angle) rights a starboard heel.
    const order = clamp(s.rollGain * att.roll - s.rateGain * wb.z, -s.maxAngle, s.maxAngle);
    this.angle = rateLimit(this.angle, order, s.rate, dt);
    this.moment = 0;
    for (let side = -1; side <= 1; side += 2) {
      const f = samplePointFlow(
        body,
        side > 0 ? s.position : this.port,
        ctx.water,
        ctx.time,
        this.sample,
        this.flow,
      );
      const u = -f.flow.z; // through the water, ahead
      if (f.head <= 0 || u < MIN_SPEED) continue;
      // The starboard fin at +angle lifts up, the port one (at −angle) down.
      const cl = clamp(s.liftSlope * side * this.angle, -s.maxLift, s.maxLift);
      const lift = 0.5 * RHO_SEAWATER * u * u * s.area * cl;
      applyBodyForce(body, 1, 0, lift, 0, f.world);
      this.moment += lift * side * Math.abs(s.position.x);
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    out['finAngle'] = this.angle;
    out['finMoment'] = this.moment;
  }

  reset(): void {
    this.angle = 0;
    this.moment = 0;
  }
}
