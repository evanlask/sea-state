// Time-domain steady-state harness for validating the sail model against the ORC polar: the sailboat
// hull (hydrostatics, heave/pitch/roll from the Kerner pressure terms), fin keel and spade rudder foils,
// hull windage and the sail module, with a PD helmsman holding the heading. Runs in tests and tools.
//
// Resistance calibration: the Kerner velocity terms over-predict the sailboat's calm-water resistance
// at low speed (≈2.0 kN at 6 kn against ≈0.5 kN for a 10 m-waterline cruiser-racer) and lack the
// wave-making hump, so the harness turns Kerner's horizontal velocity terms off and applies an
// explicit upright resistance instead: ITTC-57 friction on the ORC wetted area with a form factor, plus a Delft-series-shaped
// residuary curve Rr/(ρg∇) against Froude number. `resistanceScale` multiplies the whole curve.

import type { BoatSpec } from '../boats/BoatSpec';
import { sailSpec } from '../boats/specs/sail';
import { attitudeFromQuat } from '../core/attitude';
import { DEG, headingToYaw, signedAngle } from '../core/conventions';
import { type Quat, qFromAxisAngle, quatIdentity, vec3 } from '../core/math';
import { GRAVITY, NU_SEAWATER, RHO_SEAWATER } from '../core/units';
import { type BoatModel, buildBoatModel } from '../physics/boatModel';
import { RollDamper } from '../physics/damping';
import { applyFoil, foilState } from '../physics/foils';
import { KernerHull, kernerResult } from '../physics/kerner';
import type { ForceContext } from '../physics/modules';
import { RigidBody } from '../physics/RigidBody';
import { flatWater } from '../physics/water';
import { applyWindage, LogShearWind, windageResult } from '../physics/windage';
import { neutralControls, type PhysicsMode } from '../world/protocol';
import { createSailModule, type SailModule } from './sailModule';
import { clamp } from './util';

const WETTED_AREA = 28.59; // m², ORC certificate [V]
const FORM_FACTOR = 1.1;

// Rr/(ρ g ∇) by Froude number: the shape of the Delft series for a moderate cruiser-racer [E].
const RESIDUARY_FN = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const RESIDUARY = [0, 0.0001, 0.0003, 0.0006, 0.0013, 0.003, 0.0075, 0.017, 0.03, 0.045, 0.058];

function calibratedResistance(speed: number, lwl: number, volume: number, scale = 1): number {
  const v = Math.abs(speed);
  if (v < 1e-4) return 0;
  const re = Math.max((v * 0.7 * lwl) / NU_SEAWATER, 1e5);
  const cf = 0.075 / (Math.log10(re) - 2) ** 2;
  const friction = 0.5 * RHO_SEAWATER * v * v * WETTED_AREA * cf * FORM_FACTOR;
  const fn = v / Math.sqrt(GRAVITY * lwl);
  let rr: number;
  const n = RESIDUARY_FN.length;
  if (fn <= RESIDUARY_FN[0]!) rr = 0;
  else if (fn >= RESIDUARY_FN[n - 1]!) rr = RESIDUARY[n - 1]! * (fn / RESIDUARY_FN[n - 1]!) ** 2;
  else {
    let i = 0;
    while (fn > RESIDUARY_FN[i + 1]!) i++;
    const t = (fn - RESIDUARY_FN[i]!) / (RESIDUARY_FN[i + 1]! - RESIDUARY_FN[i]!);
    rr = RESIDUARY[i]! + (RESIDUARY[i + 1]! - RESIDUARY[i]!) * t;
  }
  return (friction + rr * RHO_SEAWATER * GRAVITY * volume) * scale;
}

export interface SteadyStateOptions {
  physicsMode?: PhysicsMode;
  duration?: number; // s simulated
  average?: number; // s at the end to average over
  resistanceScale?: number;
  startSpeed?: number; // m/s, defaults to 0.85 × the polar estimate the caller gives
  spec?: BoatSpec;
  onStep?: (time: number, sails: SailModule, body: RigidBody) => void;
}

export interface SteadyStateResult {
  speed: number; // m/s, mean forward speed over the averaging window
  heel: number; // rad, mean
  leeway: number; // rad, mean
  rudder: number; // rad, mean
  boomAngle: number;
  jibAngle: number;
  sails: SailModule;
}

let cachedModel: BoatModel | null = null;

function harnessModel(spec: BoatSpec): BoatModel {
  if (spec === sailSpec && cachedModel) return cachedModel;
  const calibrated: BoatSpec = { ...spec, kerner: { ...spec.kerner, horizontalVelocityTerms: false } };
  const m = buildBoatModel(calibrated);
  if (spec === sailSpec) cachedModel = m;
  return m;
}

const Y_AXIS = vec3(0, 1, 0);
const RUDDER_RATE = 20 * DEG; // rad/s
const dragPoint = vec3(0, -0.2, 0);

// Sails the boat on a fixed heading (north) with the true wind (speed at 10 m) at `twa` off the
// starboard bow, auto-trimmed, and returns the averaged steady state.
export function steadyStateRun(
  tws: number,
  twa: number,
  startSpeed: number,
  options: SteadyStateOptions = {},
): SteadyStateResult {
  const spec = options.spec ?? sailSpec;
  const model = harnessModel(spec);
  const duration = options.duration ?? 40;
  const average = options.average ?? 15;
  const body = new RigidBody({
    mass: model.mass,
    inertia: model.inertia,
    cg: model.cg,
    addedMass: spec.addedMass,
  });
  const q: Quat = qFromAxisAngle(quatIdentity(), Y_AXIS, headingToYaw(0));
  body.setOriginPose(vec3(0, 0, 0), q);
  body.immersion = 1;
  body.velocity.z = -startSpeed;
  const kerner = new KernerHull(model.buoyant, model.spec.kerner, model.designVolume);
  const damper = new RollDamper(
    spec.rollDamping,
    model.designVolume,
    model.gm,
    model.inertia.z * (1 + spec.addedMass.roll),
  );
  const hull = kernerResult();
  const windRes = windageResult();
  const foils = spec.foils.map(() => foilState());
  const rudderIndex = spec.foils.findIndex((f) => f.kind === 'rudder');
  const rudderMax = spec.foils[rudderIndex]?.maxDeflection ?? 35 * DEG;
  const wind = new LogShearWind(tws, twa);
  const sails = createSailModule(spec);
  const mode = options.physicsMode ?? 'realistic';
  const controls = neutralControls();
  const ctx: ForceContext = { body, water: flatWater, wind, time: 0, dt: 0, controls, physicsMode: mode };
  sails.apply({ ...ctx, dt: 0 });
  sails.rig.autoTrim = true;
  const att = { heading: 0, pitch: 0, roll: 0 };
  const master = 1 / 120;
  const n = spec.substeps;
  const h = master / n;
  const steps = Math.round(duration / master);
  const avgFrom = steps - Math.round(average / master);
  let sumSpeed = 0;
  let sumHeel = 0;
  let sumLeeway = 0;
  let sumRudder = 0;
  let count = 0;
  let rudder = 0;
  const vb = vec3();
  const drag = vec3();
  for (let i = 0; i < steps; i++) {
    for (let s = 0; s < n; s++) {
      const t = (i * n + s) * h;
      body.clearForces();
      body.addGravity();
      kerner.apply(body, flatWater, t, h, hull);
      body.immersion = hull.immersion;
      damper.apply(body);
      applyWindage(body, spec.windage, wind, t, windRes);
      // PD helmsman on heading 0 (yaw rate about +Y turns the bow to port).
      attitudeFromQuat(body.orientation, att);
      const err = signedAngle(att.heading);
      // Positive deflection swings the trailing edge to port, turning the bow to port.
      const target = clamp(2.5 * err - 1.2 * body.angularVelocity.y, -rudderMax, rudderMax);
      rudder += clamp(target - rudder, -RUDDER_RATE * h, RUDDER_RATE * h);
      for (let f = 0; f < spec.foils.length; f++) {
        applyFoil(body, spec.foils[f]!, f === rudderIndex ? rudder : 0, flatWater, t, foils[f]!);
      }
      ctx.time = t;
      ctx.dt = h;
      sails.apply(ctx);
      // Calibrated upright resistance against the horizontal velocity, at the waterline under the CG.
      const vx = body.velocity.x;
      const vz = body.velocity.z;
      const v = Math.hypot(vx, vz);
      if (v > 1e-4) {
        const r = calibratedResistance(
          v,
          model.spec.dimensions.lwl,
          model.designVolume,
          options.resistanceScale,
        );
        drag.x = (-vx / v) * r;
        drag.y = 0;
        drag.z = (-vz / v) * r;
        dragPoint.z = model.cg.z;
        body.addForceAtBodyPoint(drag, dragPoint);
      }
      body.integrate(h);
    }
    options.onStep?.((i + 1) * master, sails, body);
    if (i >= avgFrom) {
      body.worldToBodyDirection(vb, body.velocity);
      attitudeFromQuat(body.orientation, att);
      sumSpeed += -vb.z;
      sumLeeway += Math.atan2(vb.x, -vb.z);
      sumHeel += att.roll;
      sumRudder += rudder;
      count++;
    }
  }
  return {
    speed: sumSpeed / count,
    heel: sumHeel / count,
    leeway: sumLeeway / count,
    rudder: sumRudder / count,
    boomAngle: sails.rig.boomAngle,
    jibAngle: sails.rig.jibAngle,
    sails,
  };
}
