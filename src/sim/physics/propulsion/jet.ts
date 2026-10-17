// Jet drive (jet ski): an engine-driven axial pump takes water in through a
// flush intake under the hull and throws it out of a steerable nozzle:
//   ṁ = ρ·A_n·V_j,  V_j² = η_r·V_in² + (k_p·n)²,  absorbed power P = ṁ·(k_p·n)²/(2·η_p),
//   axial T = ṁ·(V_j·cos δ − V_in),  side force ṁ·V_j·sin δ (the nozzle turns the
//   whole jet; the axial ram drag of the intake stays along the hull), plus the
//   lateral ram drag −ṁ·v_lat of the water's sideways motion at the intake.
// η_r is the intake's ram recovery. The intake ventilates when it leaves the
// water (airborne, or jumping a wave): the flow and thrust collapse and the
// engine races to the limiter. Steering is purely the nozzle deflecting the
// jet, so there is no steering without thrust. A reverse bucket drops over the
// nozzle for brake / reverse. A speed limiter (US governed 67 mph) trims engine
// speed near the cap. The kill-switch lanyard on the rider's wrist stops the
// engine when he comes off in a capsize (setRider): no thrust, no steering, until
// Recover puts him back and it is restarted.
//
// Telemetry: throttle (0..1), rpm, maxRpm, nozzle (rad, + starboard), nozzleMax,
// bucket (0 ahead, 1 neutral, 2 brake, 3 reverse), ventilated (0..1),
// thrust (N), propEmersion (= ventilated).

import { type Vec3 } from '../../core/math';
import { RHO_SEAWATER } from '../../core/units';
import type { ForceContext, ForceModule } from '../modules';
import { waterSample } from '../water';
import { applyBodyForce, clamp, compression, pointFlow, rateLimit, samplePointFlow } from './common';

export interface JetSpec {
  intake: Vec3; // body
  nozzle: Vec3; // body
  nozzleArea: number; // m²
  pumpConstant: number; // k_p: jet speed per rev/s at standstill, m
  pumpEfficiency: number;
  power: number; // W
  maxRpm: number;
  idleRpm: number;
  inertia: number; // engine + impeller, kg·m²
  spoolTime: number; // throttle response, s
  intakeWake: number; // V_in = (1 − w)·u
  maxNozzle: number; // rad
  nozzleRate: number; // rad/s
  reverseEfficiency: number; // bucket redirect
  speedLimit: number; // m/s (governor)
  brakeRpm: number; // fraction of max rpm the brake uses
}

const GOVERNOR_LAG = 1.5; // s
// Intake ram recovery: the duct and grate keep ~65% of the inflow's dynamic head,
// which puts the ungoverned top speed ~13% above the 67 mph limit (real
// de-restricted craft gain about that); lossless it would be 86 mph, leaving a
// thrust reserve so large that no turn could slow the craft under the limiter.
const RAM_RECOVERY = 0.65;
// The flush intake draws from the sheet of water under the planing bottom: the
// undisturbed-surface head under-reads it by the planing depression and spray
// root, and a carving V lifts its keel a few cm. It ventilates once it is clearly
// out (5–10 cm above the surface): airborne, jumping a wave, or past the chine.
const INTAKE_DRY = 0.1; // m
// Re-priming once the intake is back in the water: under way the ram inflow
// refills the duct and pump bowl (about a metre from grate to impeller) in the
// time the water takes to run through it, a few hundredths of a second at
// planing speed, so a skip off a wavelet costs only the time in the air. From
// low speed the impeller has to draw the water in itself, ~0.3 s.
const PRIME_DUCT = 1; // m
// Water in the intake duct and pump bowl, m³: once the grate is clear the pump
// keeps throwing it out at its own flow, emptying it in ~0.08 s at full power.
const DUCT_VOLUME = 0.02;
const PRIME_MIN = 0.05; // s
const PRIME_MAX = 0.3; // s
const ENGINE_STOP_TIME = 0.5; // s for a stopped engine and impeller to run down

const BUCKET_AHEAD = 0;
const BUCKET_NEUTRAL = 1;
const BUCKET_BRAKE = 2;
const BUCKET_REVERSE = 3;

export class JetDrive implements ForceModule {
  readonly spec: JetSpec;
  n = 0; // impeller rev/s
  throttle = 0;
  nozzle = 0;
  bucket = BUCKET_NEUTRAL;
  bucketPos = 0.69; // 0 up (ahead) .. 1 fully down (reverse)
  ventilated = 0;
  thrust = 0;
  load = 0; // engine power / rated, 0..1
  engineOff = false; // the lanyard pulled: the rider is off
  private primeLevel = 1; // re-priming after ventilation
  private governor = 1; // speed limiter's engine-speed factor
  private readonly sample = waterSample();
  private readonly flow = pointFlow();
  private readonly nozzleFlow = pointFlow();

  constructor(spec: JetSpec) {
    this.spec = spec;
  }

  apply(ctx: ForceContext): void {
    const { body, tuning, dt, controls } = ctx;
    const s = this.spec;
    if (this.engineOff) {
      // Stopped: the impeller runs down and nothing comes out of the nozzle (the water a dead pump
      // lets through the duct is left out).
      this.n = Math.max(0, this.n - (this.n * dt) / ENGINE_STOP_TIME);
      this.throttle = 0;
      this.thrust = 0;
      this.load = 0;
      return;
    }
    const cmd = clamp(controls.throttle, -1, 1);
    let demand: number;
    if (controls.brake) {
      this.bucket = BUCKET_BRAKE;
      demand = s.brakeRpm;
    } else if (cmd < -0.02) {
      this.bucket = BUCKET_REVERSE;
      demand = -cmd * 0.6;
    } else if (cmd > 0.02) {
      this.bucket = BUCKET_AHEAD;
      demand = cmd;
    } else {
      this.bucket = BUCKET_NEUTRAL;
      demand = 0;
    }
    this.throttle = demand;
    // Neutral parks the bucket where the forward and deflected jets cancel.
    const neutral = 1 / (1 + s.reverseEfficiency);
    const bucketTarget = this.bucket === BUCKET_AHEAD ? 0 : this.bucket === BUCKET_NEUTRAL ? neutral : 1;
    this.bucketPos = rateLimit(this.bucketPos, bucketTarget, 3, dt);
    this.nozzle = rateLimit(this.nozzle, clamp(controls.steer, -1, 1) * s.maxNozzle, s.nozzleRate, dt);

    // Intake: ventilates once clear of the water (see INTAKE_DRY) and the pump has
    // emptied the duct; re-primes as the inflow refills it (PRIME_DUCT).
    const f = samplePointFlow(body, s.intake, ctx.water, ctx.time, this.sample, this.flow);
    const u = -f.flow.z;
    const vin = Math.max(0, (1 - s.intakeWake) * u);
    const pumpV = s.pumpConstant * Math.max(0, this.n);
    const vj = Math.sqrt(RAM_RECOVERY * vin * vin + pumpV * pumpV);
    const wet = clamp((f.head + INTAKE_DRY) / 0.05, 0, 1);
    const primeTime = clamp(PRIME_DUCT / Math.max(vin, 1e-3), PRIME_MIN, PRIME_MAX);
    const drain = (s.nozzleArea * vj) / DUCT_VOLUME; // 1/s
    this.primeLevel =
      wet < 0.2 ? Math.max(0, this.primeLevel - dt * drain) : Math.min(wet, this.primeLevel + dt / primeTime);
    this.ventilated = 1 - this.primeLevel;
    const mdot = RHO_SEAWATER * s.nozzleArea * vj * this.primeLevel;
    const absorbed = (mdot * pumpV * pumpV) / (2 * s.pumpEfficiency);
    const pumpTorque = this.n > 1 ? absorbed / (2 * Math.PI * this.n) : 0;

    // Engine: speed set-point from the throttle, power-limited; governor caps the speed.
    const nMax = s.maxRpm / 60;
    const nIdle = s.idleRpm / 60;
    let target = nIdle + (nMax - nIdle) * demand;
    // Limiter eases the engine off over the last 0.6 m/s below the cap, on the
    // speed through the water (a sliding craft is not slower), filtered like a
    // GPS/ECU loop: a fast limiter fights the steering, since the nozzle force
    // scales with the jet it is throttling.
    const over = Math.hypot(f.flow.x, f.flow.z) - (s.speedLimit - 0.6);
    const cap = clamp(1 - over / 1.2, 0, 1);
    this.governor += (cap - this.governor) * Math.min(1, dt / GOVERNOR_LAG);
    if (this.governor < 1) target = Math.max(nIdle, target * this.governor);
    const ratedTorque = s.power / (2 * Math.PI * nMax);
    const powerLimit = s.power / (2 * Math.PI * Math.max(this.n, nIdle));
    const err = (target - this.n) / nMax;
    const q = clamp(ratedTorque * (0.5 + 8 * err), 0, Math.min(1.3 * ratedTorque, powerLimit));
    // Rev limiter / fuel cut above max.
    const engineTorque = this.n > nMax * 1.05 ? 0 : q;
    this.load = clamp((engineTorque * 2 * Math.PI * this.n) / s.power, 0, 1);
    const friction = 0.03 * ratedTorque;
    this.n += ((engineTorque - pumpTorque - friction) / (2 * Math.PI * s.inertia)) * dt;
    if (this.n < 0) this.n = 0;
    const spool = Math.min(1, dt / s.spoolTime);
    if (demand <= 0 && this.n > target) this.n += (target - this.n) * spool;

    // The nozzle turns the whole jet (momentum flux ṁ·V_j), while the intake's ram
    // drag ṁ·V_in stays along the hull: axial ṁ·(V_j·cos δ − V_in), side ṁ·V_j·sin δ.
    // At speed the gross jet is several times the net thrust, which is where a jet
    // ski's steering authority comes from; a turn also costs thrust. The bucket
    // blends toward reverse (the reversed jet exits forward, so its side force flips).
    const b = this.bucketPos;
    const bucket = 1 - b - b * s.reverseEfficiency;
    const sn = Math.sin(this.nozzle);
    const cn = Math.cos(this.nozzle);
    const ahead = bucket * mdot * (vj * cn - vin);
    const side = -bucket * mdot * vj * sn;
    this.thrust = ahead;
    const nf = samplePointFlow(body, s.nozzle, ctx.water, ctx.time, this.sample, this.nozzleFlow);
    applyBodyForce(body, compression(tuning), side, 0, -ahead, nf.world);
    // The intake also swallows the water's sideways motion relative to a sliding or
    // yawing hull, and the pump straightens it: lateral ram drag −ṁ·v_lat at the intake.
    // It steadies a slide (the intake is aft of the CG) and is part of its drag.
    if (mdot > 0) applyBodyForce(body, compression(tuning), -mdot * f.flow.x, 0, 0, f.world);
  }

  writeTelemetry(out: Record<string, number>): void {
    const s = this.spec;
    out['throttle'] = this.throttle;
    out['rpm'] = this.n * 60;
    out['maxRpm'] = s.maxRpm;
    out['load'] = this.load;
    out['nozzle'] = this.nozzle;
    out['nozzleMax'] = s.maxNozzle;
    out['bucket'] = this.bucket;
    out['ventilated'] = this.ventilated;
    out['thrust'] = this.thrust;
    out['propEmersion'] = this.ventilated;
  }

  setRider(aboard: boolean): void {
    this.engineOff = !aboard;
    if (aboard) this.n = s0(this.spec);
  }

  prime(order: number): void {
    this.n = (Math.max(0, order) * this.spec.maxRpm) / 60;
    this.bucketPos = order > 0 ? 0 : 1 / (1 + this.spec.reverseEfficiency);
  }

  reset(): void {
    this.n = s0(this.spec);
    this.nozzle = 0;
    this.thrust = 0;
    this.load = 0;
    this.primeLevel = 1;
    this.governor = 1;
    this.bucketPos = 1 / (1 + this.spec.reverseEfficiency);
  }
}

const s0 = (spec: JetSpec): number => spec.idleRpm / 60;
