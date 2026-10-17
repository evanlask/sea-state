// Drive of a three-point hydroplane: a free-power-turbine turboshaft (the Lycoming T55 of the
// Unlimited class) through a gearbox to one surface-piercing propeller behind the transom, plus the
// transom rudder.
//
// Turbine: the throttle sets the gas generator's power g (0..1 of rated), which follows it slowly,
// the spool lag of a turbine: seconds from idle to full and back. The free power turbine, coupled to
// the propeller only through the gas, gives the classic torque line of a free turbine for that gas
// power, Q = 2·Q_r·g·(1 − n/2n_r): twice its rated torque at stall, its rated power at rated speed.
// So with the propeller out of the water nothing holds it and it races until the overspeed governor
// cuts the fuel. No clutch and no reverse: off the throttle it idles, and the hull's drag stops it.
// The gas generator's speed N1 (the HUD's and the sound's) follows its power: about 60 % at idle,
// N1 = 0.6 + 0.4·√((g − idle) / (1 − idle)) above it (gas power grows steeply with N1).
//
// Kill switch: after a capsize or a blow-over (WorldBoat) the fuel is cut and the turbine winds
// down, the propeller stops, until Recover resets the module and it relights at idle.
//
// Propeller: the calibrated open-water curve (propeller.ts) at the share of the disc in the water: a
// surface-piercing propeller runs half out, its thrust and torque scale with the immersed disc
// (discImmersion), and it ventilates and unloads when the stern leaves the water. Its thrust line
// slopes up forward by the shaft angle, and its blades working in the lower half of the disc give a
// lift of `verticalForce` × the thrust: with the sponsons, the third point the boat rides on at speed.
//
// Rudder: a small blade behind the transom, steered at the wheel's rate; it pierces the surface too
// (immersion along its span from the local head, foils.ts).
//
// Telemetry: throttle (0..1), gasGenerator (0..1), n1 (gas-generator speed, share of rated),
// n1Order (the N1 the throttle is asking for), rpm (propeller), maxRpm, turbineRpm (power turbine),
// load (0..1 of rated power), thrust (N), propEmersion (0..1), propLift (N), killSwitch (0/1),
// steering, steeringMax, rudderAngle, rudderMax (rad, + starboard).

import { qRotate, type Vec3, vec3 } from '../../core/math';
import { applyFoil, foilState, type FoilSpec } from '../foils';
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
import { FourQuadrantPropeller, type PropellerCurve } from './propeller';

export interface TurbineSpec {
  power: number; // W at the propeller shaft at full power
  ratedRpm: number; // propeller rpm at rated power
  gearRatio: number; // power-turbine rpm / propeller rpm
  idle: number; // gas-generator power at idle, share of rated
  spoolUp: number; // s, idle → full power
  spoolDown: number; // s, full → idle
  inertia: number; // kg·m² at the propeller shaft (power turbine and gearbox reflected, propeller)
  overspeed: number; // propeller speed / rated where the governor has cut the fuel
}

export interface SurfacePropSpec {
  turbine: TurbineSpec;
  propeller: PropellerCurve;
  position: Vec3; // hub, body
  shaftAngle: number; // rad, thrust line up from the body's fore-and-aft axis
  verticalForce: number; // lift of the half-immersed disc per unit thrust
  wake: number;
  thrustDeduction: number;
  rudder: FoilSpec;
  maxRudder: number; // rad
  rudderRate: number; // rad/s
}

const GOVERNOR_BAND = 0.03; // share of rated speed over which the governor cuts the fuel
const IDLE_N1 = 0.6; // gas-generator speed at idle, share of rated
const WIND_DOWN = 8; // s for the gas generator to run down from idle once the fuel is cut

// Gas-generator speed (share of rated) for its power g (share of rated) and the idle power.
export function gasGeneratorSpeed(g: number, idle: number): number {
  if (!(g > 0)) return 0;
  if (g <= idle) return (IDLE_N1 * g) / idle;
  return IDLE_N1 + (1 - IDLE_N1) * Math.sqrt(Math.min(1, (g - idle) / (1 - idle)));
}

export class SurfaceProp implements ForceModule {
  readonly spec: SurfacePropSpec;
  readonly propeller: FourQuadrantPropeller;
  n = 0; // propeller rev/s
  gas = 0; // gas-generator power, share of rated
  throttle = 0;
  thrust = 0;
  lift = 0;
  immersion = 1;
  load = 0;
  rudderAngle = 0;
  killed = false; // the kill switch: fuel cut after a capsize, until reset()
  readonly worldForce = vec3(); // thrust and lift, world, N (the towing tank's)
  private readonly forceBody = vec3();
  private readonly ratedN: number;
  private readonly ratedTorque: number;
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly rudderState = foilState();

  constructor(spec: SurfacePropSpec) {
    this.spec = spec;
    this.propeller = new FourQuadrantPropeller(spec.propeller);
    this.ratedN = spec.turbine.ratedRpm / 60;
    this.ratedTorque = spec.turbine.power / (2 * Math.PI * this.ratedN);
    this.reset();
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt, controls } = ctx;
    const s = this.spec;
    const tb = s.turbine;
    // No reverse and no clutch: brake or astern is the throttle closed.
    this.throttle = controls.brake || this.killed ? 0 : clamp(controls.throttle, 0, 1);
    const demand = this.killed ? 0 : tb.idle + (1 - tb.idle) * this.throttle;
    const rate =
      demand > this.gas
        ? (1 - tb.idle) / tb.spoolUp
        : this.gas > tb.idle
          ? (1 - tb.idle) / tb.spoolDown
          : tb.idle / WIND_DOWN;
    this.gas = rateLimit(this.gas, demand, rate, dt);

    const f = samplePointFlow(body, s.position, ctx.water, ctx.time, this.sample, this.flow);
    const ca = Math.cos(s.shaftAngle);
    const sa = Math.sin(s.shaftAngle);
    // Shaft direction (forward thrust): along the bow, sloping up by the shaft angle.
    const dy = sa;
    const dz = -ca;
    const va = (1 - s.wake) * (dy * f.flow.y + dz * f.flow.z);
    this.immersion = discImmersion(f.head, s.propeller.diameter / 2);
    const imm = this.immersion;
    this.propeller.evaluate(this.n, va);
    this.thrust = this.propeller.thrust * imm;
    const propTorque = this.propeller.torque * imm;

    // Free power turbine on the gas power, governed against overspeed.
    const nr = this.ratedN;
    const governor = clamp((tb.overspeed - this.n / nr) / GOVERNOR_BAND, 0, 1);
    const q = 2 * this.ratedTorque * this.gas * Math.max(0, 1 - this.n / (2 * nr)) * governor;
    const friction = 0.01 * this.ratedTorque * clamp(this.n / (0.05 * nr), -1, 1);
    this.n += ((q - propTorque - friction) / (2 * Math.PI * tb.inertia)) * dt;
    if (this.n < 0 && q > 0) this.n = Math.max(this.n, 0);
    this.load = clamp((q * 2 * Math.PI * this.n) / tb.power, 0, 1);

    const k = compression(tuning);
    const t = this.thrust * (1 - s.thrustDeduction);
    this.lift = Math.max(0, this.thrust) * s.verticalForce;
    const fb = this.forceBody;
    fb.x = 0;
    fb.y = dy * t + this.lift;
    fb.z = dz * t;
    qRotate(this.worldForce, body.orientation, fb);
    applyBodyForce(body, k, fb.x, fb.y, fb.z, f.world);

    // Rudder (positive foil deflection swings the trailing edge to port, a port turn: negated).
    const order = clamp(controls.steer, -1, 1) * s.maxRudder;
    this.rudderAngle = rateLimit(this.rudderAngle, order, s.rudderRate, dt);
    applyFoil(body, s.rudder, -this.rudderAngle, ctx.water, ctx.time, this.rudderState);
    if (k !== 1) {
      const rf = this.rudderState.worldForce;
      const rp = this.rudderState.worldPoint;
      body.addForceAtPointXYZ((k - 1) * rf.x, 0, (k - 1) * rf.z, rp.x, body.position.y, rp.z);
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    const tb = this.spec.turbine;
    out['throttle'] = this.throttle;
    out['gasGenerator'] = this.gas;
    out['n1'] = gasGeneratorSpeed(this.gas, tb.idle);
    out['n1Order'] = this.killed ? 0 : gasGeneratorSpeed(tb.idle + (1 - tb.idle) * this.throttle, tb.idle);
    out['killSwitch'] = this.killed ? 1 : 0;
    out['rpm'] = Math.abs(this.n) * 60;
    out['maxRpm'] = tb.ratedRpm;
    out['turbineRpm'] = Math.abs(this.n) * 60 * tb.gearRatio;
    out['load'] = this.load;
    out['thrust'] = this.thrust;
    out['propLift'] = this.lift;
    out['propEmersion'] = 1 - this.immersion;
    out['steering'] = this.rudderAngle;
    out['steeringMax'] = this.spec.maxRudder;
    out['rudderAngle'] = this.rudderAngle;
    out['rudderMax'] = this.spec.maxRudder;
  }

  // Spawned under way: the turbine spooled to the order and the propeller turning at its speed.
  prime(order: number): void {
    const tb = this.spec.turbine;
    const o = clamp(order, 0, 1);
    this.gas = tb.idle + (1 - tb.idle) * o;
    this.n = o * this.ratedN;
  }

  // Thrown after a capsize: the fuel is cut and the turbine winds down; reset() relights it.
  setKillSwitch(killed: boolean): void {
    this.killed = killed;
  }

  reset(): void {
    this.killed = false;
    this.gas = this.spec.turbine.idle;
    this.n = 0;
    this.thrust = 0;
    this.lift = 0;
    this.load = 0;
    this.rudderAngle = 0;
  }
}
