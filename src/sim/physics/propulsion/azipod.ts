// Azimuthing podded propulsors (cruise ship): an electric motor in a pod that
// turns ±35° (or more) to steer by thrust vectoring; the pod housing and strut
// also act as a rudder-like foil. Pulling propeller, electric drive (reverses
// without stopping first). Both pods follow the helm; power from the telegraph.
//
// Telemetry (pods numbered from port, i = 0, 1): pod{i}Angle (rad, + steers to
// starboard like a rudder), pod{i}Thrust (−1..1 of full ahead), plus for the
// whole plant: telegraphOrder, telegraphResponse, rpm, maxRpm, load.

import { type Vec3 } from '../../core/math';
import { foilForce, foilState, type FoilSpec } from '../foils';
import type { ForceContext, ForceModule } from '../modules';
import { waterSample } from '../water';
import {
  applyBodyForce,
  clamp,
  compression,
  discImmersion,
  pointFlow,
  rateLimit,
  samplePointFlow,
} from './common';
import { Engine, type EngineSpec, FourQuadrantPropeller, type PropellerCurve } from './propeller';

export interface AzipodSpec {
  index: number;
  position: Vec3; // propeller centre, body
  engine: EngineSpec;
  propeller: PropellerCurve;
  wake: number;
  thrustDeduction: number;
  maxAngle: number;
  rate: number; // realistic slew rate, rad/s
  housing: FoilSpec; // strut + pod body as a foil
  fullThrust: number; // N, for the −1..1 readout
}

export class Azipod implements ForceModule {
  readonly spec: AzipodSpec;
  readonly engine: Engine;
  readonly propeller: FourQuadrantPropeller;
  angle = 0;
  thrust = 0;
  order = 0;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly foil = foilState();

  constructor(spec: AzipodSpec) {
    this.spec = spec;
    this.engine = new Engine(spec.engine);
    this.propeller = new FourQuadrantPropeller(spec.propeller);
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt } = ctx;
    const s = this.spec;
    this.angle = rateLimit(
      this.angle,
      clamp(ctx.controls.steer, -1, 1) * s.maxAngle,
      tuning?.rudderRate ?? s.rate,
      dt,
    );
    const f = samplePointFlow(body, s.position, ctx.water, ctx.time, this.sample, this.flow);
    // Flow along the pod's axis (pointing forward at angle ψ: (−sin ψ, 0, −cos ψ)).
    const sin = Math.sin(this.angle);
    const cos = Math.cos(this.angle);
    const along = -sin * f.flow.x - cos * f.flow.z;
    const va = (1 - s.wake) * along;
    const imm = discImmersion(f.head, s.propeller.diameter / 2) ** 1.5;
    this.propeller.evaluate(this.engine.n, va);
    this.thrust = this.propeller.thrust * imm;
    this.order = ctx.controls.brake ? 0 : clamp(ctx.controls.throttle, -1, 1);
    this.engine.step(
      this.order,
      this.propeller.torque * imm,
      dt,
      tuning?.engineRampTime ?? s.engine.rampTime,
      tuning?.reversalDelay ?? s.engine.reversalDelay,
    );
    const k = compression(tuning);
    const t = this.thrust * (1 - s.thrustDeduction);
    applyBodyForce(body, k, -sin * t, 0, -cos * t, f.world);
    // Housing lift: water-relative inflow is −flow; the foil is deflected opposite to the helm sign.
    f.flow.x = -f.flow.x;
    f.flow.y = -f.flow.y;
    f.flow.z = -f.flow.z;
    foilForce(s.housing, f.flow, -this.angle, imm, this.foil);
    const boost = tuning?.turnBoost ?? 1;
    applyBodyForce(body, k * boost, this.foil.force.x, this.foil.force.y, 0, f.world);
    applyBodyForce(body, 1, 0, 0, this.foil.force.z, f.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    const i = this.spec.index;
    out[`pod${i}Angle`] = this.angle;
    out[`pod${i}Thrust`] = clamp(this.thrust / this.spec.fullThrust, -1, 1);
    if (i === 0) {
      const e = this.engine;
      out['telegraphOrder'] = this.order;
      out['telegraphResponse'] = clamp(e.n / e.ratedN, -1, 1);
      out['rpm'] = e.n * 60;
      out['maxRpm'] = this.spec.engine.ratedRpm;
      out['load'] = e.load;
      out['propEmersion'] = 0;
    }
  }

  prime(order: number): void {
    this.engine.prime(order);
  }

  reset(): void {
    this.engine.reset();
    this.angle = 0;
    this.thrust = 0;
  }
}
