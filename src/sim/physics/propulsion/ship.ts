// Ship drive train (container ship, crab boat): a fixed-pitch propeller on a
// shaft driven from the engine-order telegraph, an MMG-style rudder in the
// propeller slipstream, and a bow tunnel thruster.
//
// Telemetry
//   ShaftPropeller: telegraphOrder (−1..1 lever), telegraphResponse (−1..1 shaft
//     rpm / rated), rpm (signed shaft rpm), maxRpm, load (0..1 of MCR),
//     thrust (N), propSlip (0..1), propEmersion (0 deep .. 1 out of the water)
//   ShipRudder: rudderOrder, rudderAngle, rudderMax (rad, + starboard helm)
//   BowThruster: thruster (−1 port .. 1 starboard, delivered), thrusterAvailable (0/1)

import { qRotateInverse, type Vec3, vec3 } from '../../core/math';
import { RHO_SEAWATER } from '../../core/units';
import { foilCoefficients, type FoilCoefficients, type FoilSpec } from '../foils';
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

export interface ShaftSpec {
  engine: EngineSpec;
  propeller: PropellerCurve;
  position: Vec3; // propeller centre, body frame
  wake: number; // w, straight running
  thrustDeduction: number; // t
}

export class ShaftPropeller implements ForceModule {
  readonly spec: ShaftSpec;
  readonly engine: Engine;
  readonly propeller: FourQuadrantPropeller;
  order = 0;
  // Propeller thrust (before deduction) and advance speed, read by the rudder for its slipstream.
  thrust = 0;
  advanceSpeed = 0;
  immersion = 1;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();

  constructor(spec: ShaftSpec) {
    this.spec = spec;
    this.engine = new Engine(spec.engine);
    this.propeller = new FourQuadrantPropeller(spec.propeller);
  }

  apply(ctx: ForceContext): void {
    const { body, tuning } = ctx;
    const f = samplePointFlow(body, this.spec.position, ctx.water, ctx.time, this.sample, this.flow);
    const u = -f.flow.z;
    const v = f.flow.x;
    const U = Math.hypot(u, v);
    // Wake fraction falls off with drift (Yasukawa).
    const drift = U > 0.1 ? v / U : 0;
    const w = this.spec.wake * Math.exp(-4 * drift * drift);
    const va = (1 - w) * u;
    this.advanceSpeed = va;
    this.immersion = discImmersion(f.head, this.propeller.diameter / 2);
    const imm = this.immersion ** 1.5;
    const eng = this.engine;
    this.propeller.evaluate(eng.n, va);
    this.thrust = this.propeller.thrust * imm;
    this.order = ctx.controls.brake ? 0 : clamp(ctx.controls.throttle, -1, 1);
    eng.step(
      this.order,
      this.propeller.torque * imm,
      ctx.dt,
      tuning?.engineRampTime ?? this.spec.engine.rampTime,
      tuning?.reversalDelay ?? this.spec.engine.reversalDelay,
    );
    applyBodyForce(body, compression(tuning), 0, 0, -this.thrust * (1 - this.spec.thrustDeduction), f.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    const eng = this.engine;
    out['telegraphOrder'] = this.order;
    out['telegraphResponse'] = clamp(eng.n / eng.ratedN, -1, 1);
    out['rpm'] = eng.n * 60;
    out['maxRpm'] = this.spec.engine.ratedRpm;
    out['load'] = eng.load;
    out['thrust'] = this.thrust;
    out['propSlip'] =
      Math.abs(eng.n) > 0.05 ? clamp(1 - this.propeller.advance / this.spec.propeller.j0, 0, 1) : 0;
    out['propEmersion'] = 1 - this.immersion;
  }

  prime(order: number): void {
    this.engine.prime(order);
  }

  reset(): void {
    this.engine.reset();
    this.thrust = 0;
    this.order = 0;
  }
}

// Rudder–hull–propeller interaction (MMG standard method, Yasukawa & Yoshimura 2015).
export interface RudderInteraction {
  tR: number; // steering resistance deduction
  aH: number; // rudder force increase factor
  xH: number; // x'_H, acting point of the hull's extra lateral force, fraction of L (− aft)
  gammaPlus: number; // flow straightening, β_R > 0
  gammaMinus: number;
  lR: number; // l'_R, effective rudder position for the flow straightening
  epsilon: number; // wake ratio rudder/propeller
  kappa: number; // slipstream constant
  eta: number; // propeller diameter / rudder span
}

export interface ShipRudderSpec {
  foil: FoilSpec; // geometry, area, aspect ratio and stall
  maxAngle: number;
  rate: number; // realistic rad/s
  length: number; // L for the non-dimensional factors
  wake: number; // w at the propeller
  interaction: RudderInteraction;
}

const coeff: FoilCoefficients = { cl: 0, cd: 0 };
const wBody = vec3();

export class ShipRudder implements ForceModule {
  readonly spec: ShipRudderSpec;
  readonly propeller: ShaftPropeller | null;
  angle = 0;
  orderAngle = 0;
  normalForce = 0;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly mid = pointFlow();
  private readonly midPoint: Vec3;
  private readonly hullPoint: Vec3;

  constructor(spec: ShipRudderSpec, propeller: ShaftPropeller | null) {
    this.spec = spec;
    this.propeller = propeller;
    this.midPoint = { x: 0, y: spec.foil.centre.y * 0.5, z: 0 };
    this.hullPoint = { x: 0, y: spec.foil.centre.y * 0.5, z: -spec.interaction.xH * spec.length };
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt } = ctx;
    const s = this.spec;
    const I = s.interaction;
    this.orderAngle = clamp(ctx.controls.steer, -1, 1) * s.maxAngle;
    this.angle = rateLimit(this.angle, this.orderAngle, tuning?.rudderRate ?? s.rate, dt);
    const delta = this.angle;
    const f = samplePointFlow(body, s.foil.centre, ctx.water, ctx.time, this.sample, this.flow);
    // Midship sway at the CG's height, so roll motion does not feed the steering forces.
    this.midPoint.y = body.cg.y;
    const m = samplePointFlow(body, this.midPoint, ctx.water, ctx.time, this.sample, this.mid);
    const u = -m.flow.z;
    const vMid = m.flow.x;
    // Yaw rate, + bow to starboard: rotation about body −y.
    qRotateInverse(wBody, body.orientation, body.angularVelocity);
    const r = -wBody.y;
    const uP = (1 - s.wake) * u;
    let uR: number;
    const prop = this.propeller;
    const thrust = prop ? Math.max(0, prop.thrust) : 0;
    if (prop && thrust > 0 && uP > -0.5) {
      const D = prop.propeller.diameter;
      const up = Math.max(0, uP);
      const induced = Math.sqrt(up * up + (8 * thrust) / (Math.PI * RHO_SEAWATER * D * D));
      const slip = up + I.kappa * (induced - up);
      uR = I.epsilon * Math.sqrt(I.eta * slip * slip + (1 - I.eta) * up * up);
    } else {
      uR = I.epsilon * uP;
    }
    // Flow straightening by the hull (β_R = β − l'_R·r').
    const vRaw = -vMid - I.lR * s.length * r;
    const vR = (vRaw > 0 ? I.gammaPlus : I.gammaMinus) * vRaw;
    const alpha = delta - Math.atan2(vR, uR);
    foilCoefficients(s.foil, alpha, coeff);
    const cn = coeff.cl * Math.cos(alpha) + coeff.cd * Math.sin(alpha);
    const imm = discImmersion(f.head, s.foil.span / 2);
    const fn = 0.5 * RHO_SEAWATER * s.foil.area * (uR * uR + vR * vR) * cn * imm;
    this.normalForce = fn;
    // Arcade boost acts in the compressed share only (at the CG height: no extra heel).
    const k = compression(tuning) * (tuning?.turnBoost ?? 1);
    const cos = Math.cos(delta);
    // MMG: X_R = −(1 − t_R) F_N sin δ, Y_R = −(1 + a_H) F_N cos δ (body x = starboard, z = aft).
    applyBodyForce(body, k, -fn * cos, 0, 0, f.world);
    // Steering drag stays real (not compressed or boosted), so Arcade turns keep their speed.
    applyBodyForce(body, 1, 0, 0, (1 - I.tR) * fn * Math.sin(delta), f.world);
    body.bodyToWorldPoint(m.world, this.hullPoint);
    applyBodyForce(body, k, -I.aH * fn * cos, 0, 0, m.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    out['rudderOrder'] = this.orderAngle;
    out['rudderAngle'] = this.angle;
    out['rudderMax'] = this.spec.maxAngle;
  }

  reset(): void {
    this.angle = 0;
    this.orderAngle = 0;
  }
}

export interface BowThrusterSpec {
  position: Vec3; // tunnel centre, body frame
  maxThrust: number; // N at zero speed
  rampTime: number; // realistic spool-up, s
  fadeSpeed: number; // m/s where the thrust has faded out (~5 kn)
}

export class BowThruster implements ForceModule {
  readonly spec: BowThrusterSpec;
  level = 0;
  effectiveness = 1;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();

  constructor(spec: BowThrusterSpec) {
    this.spec = spec;
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt } = ctx;
    const ramp = tuning && tuning.mode === 'arcade' ? 1 : this.spec.rampTime;
    this.level = rateLimit(this.level, clamp(ctx.controls.thruster, -1, 1), 1 / ramp, dt);
    const f = samplePointFlow(body, this.spec.position, ctx.water, ctx.time, this.sample, this.flow);
    // Tunnel thrusters lose effect with forward speed (the jet is bent aft and entrained).
    const u = Math.abs(f.flow.z);
    const x = u / this.spec.fadeSpeed;
    this.effectiveness = clamp(1 - x * x, 0, 1) * discImmersion(f.head, 1);
    const t = this.level * this.spec.maxThrust * this.effectiveness;
    // Arcade ships turn on their thrusters as quickly as on the rudder (the same turn boost).
    if (t !== 0) applyBodyForce(body, compression(tuning) * (tuning?.turnBoost ?? 1), t, 0, 0, f.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    out['thruster'] = this.level * this.effectiveness;
    out['thrusterAvailable'] = this.effectiveness > 0.25 ? 1 : 0;
  }

  reset(): void {
    this.level = 0;
  }
}
