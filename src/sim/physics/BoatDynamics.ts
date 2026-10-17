// Boat integrator: gravity, Kerner hull forces, roll (and optionally heave and
// pitch) damping, windage and the boat's force modules (drive train, MMG hull,
// calibrated resistance, deck water, flooding, breaking waves, sails) on a
// RigidBody, with per-boat substeps.
//
// Without modules (as in the hydrostatic tests) the spec's foils are applied at
// fixed deflections; with modules the drive train owns the foils.
//
// Arcade time compression (tuning.ts): Kerner's horizontal drag and friction
// get the extra (k − 1) share at the CG height (yaw part of their moment only).

import { attitudeFromQuat } from '../core/attitude';
import { headingToYaw } from '../core/conventions';
import {
  type Quat,
  qFromAxisAngle,
  qMultiply,
  qRotate,
  qRotateInverse,
  quatIdentity,
  vec3,
} from '../core/math';
import { GRAVITY } from '../core/units';
import { type BoatControls, neutralControls } from '../world/protocol';
import { type BoatModel, type MassProperties, riderlessMassProperties, riderlessWindage } from './boatModel';
import { HeavePitchDamper, RollDamper } from './damping';
import { applyFoil, foilState, type FoilState } from './foils';
import { KernerHull, kernerResult } from './kerner';
import type { ForceContext, ForceModule } from './modules';
import { RigidBody } from './RigidBody';
import { physicsTuning, type PhysicsTuning } from './tuning';
import { waterSample, type WaterSampler } from './water';
import type { WindSampler } from './windage';
import { applyWindage, type WindageSpec, windageResult } from './windage';

const Y_AXIS = vec3(0, 1, 0);
const BOW_AXIS = vec3(0, 0, -1);
const PITCH_AXIS = vec3(1, 0, 0); // + bow up
const UP = vec3(0, 1, 0);
const rollQuat: Quat = quatIdentity();
const origin = vec3();
const orientation: Quat = quatIdentity();
const scratch = vec3();
const up = vec3();
const vBody = vec3();
const calmAir: WindSampler = {
  sample(_x, _y, _z, _t, out) {
    out.x = out.y = out.z = 0;
    return out;
  },
};

export interface BoatDynamicsOptions {
  modules?: ForceModule[];
  tuning?: PhysicsTuning;
}

export class BoatDynamics {
  readonly model: BoatModel;
  readonly body: RigidBody;
  readonly kerner: KernerHull;
  readonly damper: RollDamper;
  readonly heavePitch: HeavePitchDamper | null;
  readonly hullForces = kernerResult();
  readonly windForces = windageResult();
  readonly foilStates: FoilState[];
  readonly foilDeflections: Float64Array;
  readonly modules: ForceModule[];
  readonly builtInFoils: boolean;
  tuning: PhysicsTuning;
  windScale = 1;
  // Largest slam seen since the caller last reset it (for spray/audio events).
  maxSlamStrength = 0;
  maxSlamSpeed = 0;
  readonly maxSlamPoint = vec3();
  // The rider (spec.rider) aboard; off, the craft has his mass taken out (riderAboard / setRiderAboard).
  riderAboard = true;
  private dryMass: number;
  private readonly riderless: MassProperties | null;
  private windage: WindageSpec; // the spec's, or without the rider
  private readonly ctx: ForceContext;
  private readonly cgSample = waterSample();
  private readonly attitude = { heading: 0, pitch: 0, roll: 0 };

  constructor(model: BoatModel, options: BoatDynamicsOptions = {}) {
    this.model = model;
    const spec = model.spec;
    this.body = new RigidBody({
      mass: model.mass,
      inertia: model.inertia,
      cg: model.cg,
      addedMass: spec.addedMass,
    });
    this.dryMass = model.mass;
    this.riderless = spec.rider ? riderlessMassProperties(model) : null;
    this.windage = spec.windage;
    this.kerner = new KernerHull(model.buoyant, spec.kerner, model.designVolume);
    this.damper = new RollDamper(
      spec.rollDamping,
      model.designVolume,
      model.gm,
      model.inertia.z * (1 + spec.addedMass.roll),
    );
    this.heavePitch = spec.heavePitchDamping
      ? new HeavePitchDamper(
          spec.heavePitchDamping,
          model.design.waterplaneArea,
          model.design.waterplaneIzz,
          model.mass * (1 + spec.addedMass.heave),
          model.inertia.x * (1 + spec.addedMass.pitch),
        )
      : null;
    this.foilStates = spec.foils.map(() => foilState());
    this.foilDeflections = new Float64Array(spec.foils.length);
    this.modules = options.modules ?? [];
    this.builtInFoils = options.modules === undefined;
    this.tuning = options.tuning ?? physicsTuning(spec.kind, 'realistic');
    this.ctx = {
      body: this.body,
      water: { sample: (_x, _y, _z, _t, out) => out },
      wind: calmAir,
      time: 0,
      dt: 0,
      controls: neutralControls(),
      physicsMode: this.tuning.mode,
      tuning: this.tuning,
      hull: this.hullForces,
    };
    this.setTuning(this.tuning);
    this.placeAtRest(0, 0, 0);
  }

  setTuning(tuning: PhysicsTuning): void {
    this.tuning = tuning;
    this.ctx.tuning = tuning;
    this.ctx.physicsMode = tuning.mode;
    this.windScale = tuning.windScale;
    this.kerner.slamScale = tuning.slamScale;
  }

  // Origin on the design waterline at (x, 0, z), level, bow on the heading.
  placeAtRest(x: number, z: number, heading: number, heel = 0, y = 0): void {
    origin.x = x;
    origin.y = y;
    origin.z = z;
    qFromAxisAngle(orientation, Y_AXIS, headingToYaw(heading));
    // Starboard down = positive rotation about the bow axis (−Z body), applied before the yaw.
    if (heel !== 0) qMultiply(orientation, orientation, qFromAxisAngle(rollQuat, BOW_AXIS, heel));
    this.body.setOriginPose(origin, orientation);
    const b = this.body;
    b.velocity.x = b.velocity.y = b.velocity.z = 0;
    b.angularVelocity.x = b.angularVelocity.y = b.angularVelocity.z = 0;
    b.immersion = 1;
    b.mass = this.dryMass;
    this.kerner.reset();
    for (const m of this.modules) m.reset?.();
  }

  // As placeAtRest, but already running ahead at `speed` (m/s) in the attitude it runs at: the origin
  // `sinkage` higher and the bow `trim` (rad) up. A hydroplane dropped level into the water at speed is
  // launched off its own bottom and blows over; its running attitude is the calibration tank's.
  placeUnderWay(
    x: number,
    z: number,
    heading: number,
    speed: number,
    sinkage: number,
    trim: number,
    y = 0,
  ): void {
    this.placeAtRest(x, z, heading, 0, y + sinkage);
    const b = this.body;
    b.getOrigin(origin);
    qMultiply(orientation, b.orientation, qFromAxisAngle(rollQuat, PITCH_AXIS, trim));
    b.setOriginPose(origin, orientation);
    qRotate(scratch, b.orientation, BOW_AXIS);
    const len = Math.hypot(scratch.x, scratch.z) || 1;
    b.velocity.x = (scratch.x / len) * speed;
    b.velocity.z = (scratch.z / len) * speed;
  }

  // The rider thrown off (false) or back aboard (true), for a craft with one (spec.rider): the mass,
  // CG, inertia and windage lose or regain his, the boat keeping its pose and motion (the body's
  // reference point, the CG, moves within the hull), and the modules hear of it (ForceModule.setRider:
  // his balance goes, the lanyard stops a jet ski's engine, nobody leans it into a carve).
  setRiderAboard(aboard: boolean): void {
    const off = this.riderless;
    if (!off || aboard === this.riderAboard) return;
    this.riderAboard = aboard;
    const m = this.model;
    const next = aboard ? m : off;
    const b = this.body;
    scratch.x = next.cg.x - b.cg.x;
    scratch.y = next.cg.y - b.cg.y;
    scratch.z = next.cg.z - b.cg.z;
    qRotate(up, b.orientation, scratch);
    b.position.x += up.x;
    b.position.y += up.y;
    b.position.z += up.z;
    const w = b.angularVelocity;
    b.velocity.x += w.y * up.z - w.z * up.y;
    b.velocity.y += w.z * up.x - w.x * up.z;
    b.velocity.z += w.x * up.y - w.y * up.x;
    b.cg.x = next.cg.x;
    b.cg.y = next.cg.y;
    b.cg.z = next.cg.z;
    b.inertia.x = next.inertia.x;
    b.inertia.y = next.inertia.y;
    b.inertia.z = next.inertia.z;
    this.dryMass = next.mass;
    b.mass = next.mass;
    this.windage = aboard ? m.spec.windage : riderlessWindage(m.spec);
    // The added mass and inertia are the water's, set by the hull's shape: the same kilograms without
    // him, so a larger share of the lighter craft.
    const a = m.spec.addedMass;
    const k = m.mass / next.mass;
    b.addedMass.surge = a.surge * k;
    b.addedMass.sway = a.sway * k;
    b.addedMass.heave = a.heave * k;
    b.addedMass.pitch = (a.pitch * m.inertia.x) / next.inertia.x;
    b.addedMass.yaw = (a.yaw * m.inertia.y) / next.inertia.y;
    b.addedMass.roll = (a.roll * m.inertia.z) / next.inertia.z;
    for (const mod of this.modules) mod.setRider?.(aboard);
  }

  prime(order: number): void {
    for (const m of this.modules) m.prime?.(order);
  }

  // Cuts the engines that have a kill switch (ForceModule.setKillSwitch); placing the boat again
  // (placeAtRest, as Recover does) resets the modules and restarts them.
  setKillSwitch(killed: boolean): void {
    for (const m of this.modules) m.setKillSwitch?.(killed);
  }

  // Advances dt (one master step) in spec.substeps substeps.
  step(
    dt: number,
    water: WaterSampler,
    wind: WindSampler | null,
    time: number,
    controls: BoatControls | null = null,
  ): void {
    const spec = this.model.spec;
    const n = spec.substeps;
    const h = dt / n;
    const body = this.body;
    const ctx = this.ctx;
    const modules = this.modules;
    const k = this.tuning.timeCompression;
    const dryMass = this.dryMass;
    ctx.water = water;
    ctx.wind = wind ?? calmAir;
    if (controls) ctx.controls = controls;
    for (let s = 0; s < n; s++) {
      const t = time + s * h;
      ctx.time = t;
      ctx.dt = h;
      let carried = 0;
      for (let i = 0; i < modules.length; i++) carried += modules[i]!.carriedMass ?? 0;
      body.mass = dryMass + carried;
      body.clearForces();
      body.force.y -= dryMass * GRAVITY;
      const hull = this.kerner.apply(body, water, t, h, this.hullForces);
      body.immersion = hull.immersion;
      if (k !== 1 && spec.kerner.horizontalVelocityTerms) {
        const e = k - 1;
        body.force.x += e * (hull.pressureDrag.x + hull.friction.x);
        body.force.z += e * (hull.pressureDrag.z + hull.friction.z);
        body.torque.y += e * hull.dragYawTorque;
      }
      if (hull.slamStrength > this.maxSlamStrength) {
        this.maxSlamStrength = hull.slamStrength;
        this.maxSlamSpeed = hull.slamSpeed;
        this.maxSlamPoint.x = hull.slamPoint.x;
        this.maxSlamPoint.y = hull.slamPoint.y;
        this.maxSlamPoint.z = hull.slamPoint.z;
      }
      this.damper.apply(body);
      if (this.heavePitch) {
        water.sample(body.position.x, body.position.y, body.position.z, t, this.cgSample);
        const scale = spec.heavePitchDamping?.wetted
          ? Math.min(1, hull.wettedArea / this.model.design.wettedArea)
          : hull.immersion;
        this.heavePitch.apply(body, this.cgSample.velocityY, scale);
      }
      // A flying hull (spec.aero) meets the air of its own speed even without wind: its drag is
      // half of what holds it back at speed.
      const air = wind ?? (spec.aero ? calmAir : null);
      if (air) applyWindage(body, this.windage, air, t, this.windForces, this.windScale);
      if (this.builtInFoils) {
        for (let i = 0; i < spec.foils.length; i++) {
          applyFoil(body, spec.foils[i]!, this.foilDeflections[i]!, water, t, this.foilStates[i]!);
        }
      }
      for (let i = 0; i < modules.length; i++) modules[i]!.apply(ctx);
      if (this.tuning.capsizeAssist) this.applyCapsizeAssist();
      body.integrate(h);
    }
  }

  // Gentle righting torque past 30° of heel, about a quarter of a typical GZ peak.
  private applyCapsizeAssist(): void {
    const body = this.body;
    qRotate(up, body.orientation, UP);
    const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
    if (tilt < 0.5) return;
    // Axis of the rotation that would bring body up to world up: up × UP.
    const ax = -up.z;
    const az = up.x;
    const len = Math.hypot(ax, az) || 1;
    const m =
      0.25 * body.mass * GRAVITY * this.model.spec.dimensions.beam * 0.25 * Math.min(1, (tilt - 0.5) * 2);
    body.torque.x += (m * ax) / len;
    body.torque.z += (m * az) / len;
  }

  // Common readouts (keys documented in sim/world/telemetry.ts).
  writeTelemetry(out: Record<string, number>): void {
    const body = this.body;
    const hull = this.hullForces;
    qRotateInverse(vBody, body.orientation, body.velocity);
    const att = attitudeFromQuat(body.orientation, this.attitude);
    out['surge'] = -vBody.z;
    out['sway'] = vBody.x;
    out['speedThroughWater'] = Math.hypot(vBody.x, vBody.z);
    qRotateInverse(scratch, body.orientation, body.angularVelocity);
    out['yawRate'] = -scratch.y;
    out['heel'] = att.roll;
    out['trim'] = att.pitch;
    out['immersion'] = hull.immersion;
    out['wettedArea'] = hull.wettedArea;
    // A hydroplane at speed touches the water with only its pads and propeller (a few tenths of a m²).
    out['airborne'] = hull.wettedArea < (this.model.spec.aero ? 0.002 : 0.02) * this.model.hullArea ? 1 : 0;
    out['mass'] = body.mass;
    for (let i = 0; i < this.modules.length; i++) this.modules[i]!.writeTelemetry(out);
  }
}
