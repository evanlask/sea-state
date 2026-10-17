// Steerable, trimmable outboard engines (center console, twin). Each engine
// swings ±30° on the transom to steer by thrust vectoring and its lower unit is
// a small foil. Trimming out tilts the propeller shaft so the thrust points
// slightly down relative to the hull: with the propeller below and aft of the
// CG that is a bow-up moment (trim in → bow down). High-revving engine through
// a gearbox (neutral, forward, reverse at reduced power).
//
// Telemetry (engines numbered from port): eng{i}Throttle (−1..1), eng{i}Rpm
// (engine crank rpm), eng{i}Trim (0 down .. 1 fully up), eng{i}Load (0..1 of rated power), plus
// maxRpm (crank), rpm and load (the busier engine's, for the engine sound), steering (rad,
// + starboard), steeringMax, outboardTrim (0..1), thrust (N, total), propEmersion (0..1, worst engine).

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

export interface OutboardSpec {
  index: number;
  position: Vec3; // propeller centre at zero trim, body
  engine: EngineSpec; // shaft (propeller) rpm in engine.ratedRpm
  gearRatio: number; // crank / propeller
  propeller: PropellerCurve;
  wake: number;
  thrustDeduction: number;
  maxSteer: number; // rad
  steerRate: number; // rad/s
  trimMin: number; // rad (trimmed in)
  trimMax: number; // rad (trimmed out)
  trimRate: number; // rad/s
  lowerUnit: FoilSpec;
}

export class Outboard implements ForceModule {
  readonly spec: OutboardSpec;
  readonly engine: Engine;
  readonly propeller: FourQuadrantPropeller;
  steer = 0;
  trim = 0;
  thrust = 0;
  throttle = 0;
  immersion = 1;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly foil = foilState();

  constructor(spec: OutboardSpec) {
    this.spec = spec;
    this.engine = new Engine(spec.engine);
    this.propeller = new FourQuadrantPropeller(spec.propeller);
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt, controls } = ctx;
    const s = this.spec;
    this.steer = rateLimit(this.steer, clamp(controls.steer, -1, 1) * s.maxSteer, s.steerRate, dt);
    this.trim = clamp(this.trim + clamp(controls.trim, -1, 1) * s.trimRate * dt, s.trimMin, s.trimMax);
    // Brake = throttle back to neutral.
    this.throttle = controls.brake ? 0 : clamp(controls.throttle, -1, 1);
    const f = samplePointFlow(body, s.position, ctx.water, ctx.time, this.sample, this.flow);
    const ss = Math.sin(this.steer);
    const cs = Math.cos(this.steer);
    const st = Math.sin(this.trim);
    const ct = Math.cos(this.trim);
    // Shaft direction (forward thrust): steered like a rudder, trimmed out → pointing down.
    const dx = -ss * ct;
    const dy = -st;
    const dz = -cs * ct;
    const along = dx * f.flow.x + dy * f.flow.y + dz * f.flow.z;
    const va = (1 - s.wake) * along;
    this.immersion = discImmersion(f.head, s.propeller.diameter / 2);
    const imm = this.immersion ** 1.5;
    this.propeller.evaluate(this.engine.n, va);
    this.thrust = this.propeller.thrust * imm;
    // Reverse gear: limited throttle (the gearbox and exhaust limit it to ~35%).
    const order = this.throttle >= 0 ? this.throttle : 0.35 * this.throttle;
    this.engine.step(order, this.propeller.torque * imm, dt, s.engine.rampTime, s.engine.reversalDelay);
    const k = compression(tuning);
    const t = this.thrust * (1 - s.thrustDeduction);
    applyBodyForce(body, k, dx * t, dy * t, dz * t, f.world);
    f.flow.x = -f.flow.x;
    f.flow.y = -f.flow.y;
    f.flow.z = -f.flow.z;
    foilForce(s.lowerUnit, f.flow, -this.steer, Math.min(1, this.immersion * 1.5), this.foil);
    applyBodyForce(body, k, this.foil.force.x, this.foil.force.y, this.foil.force.z, f.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    const s = this.spec;
    const i = s.index;
    const trim01 = (this.trim - s.trimMin) / (s.trimMax - s.trimMin);
    const rpm = Math.abs(this.engine.n) * 60 * s.gearRatio;
    const load = this.engine.load;
    out[`eng${i}Throttle`] = this.throttle;
    out[`eng${i}Rpm`] = rpm;
    out[`eng${i}Trim`] = trim01;
    out[`eng${i}Load`] = load;
    // Engines write in index order: the first resets the aggregates, the rest take the maximum.
    out['rpm'] = i === 0 ? rpm : Math.max(out['rpm'] ?? 0, rpm);
    out['load'] = i === 0 ? load : Math.max(out['load'] ?? 0, load);
    out['maxRpm'] = s.engine.ratedRpm * s.gearRatio;
    out['steering'] = this.steer;
    out['steeringMax'] = s.maxSteer;
    out['outboardTrim'] = trim01;
    out['thrust'] = (i === 0 ? 0 : (out['thrust'] ?? 0)) + this.thrust;
    out['propEmersion'] = Math.max(i === 0 ? 0 : (out['propEmersion'] ?? 0), 1 - this.immersion);
  }

  prime(order: number): void {
    this.engine.prime(order);
  }

  reset(): void {
    this.engine.reset();
    this.steer = 0;
    this.thrust = 0;
  }
}
