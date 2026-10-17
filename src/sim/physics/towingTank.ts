// Virtual towing tank: the hull model (Kerner forces + damping, no drive
// train) is towed through calm water at a fixed speed with surge, sway, yaw
// and roll locked and heave and pitch free, so it settles at its dynamic
// sinkage and trim. Returns the time-averaged horizontal hull resistance, or with
// `modules` (a hydroplane's aerodynamics, appendages and propeller) the whole
// boat's: then the air of its own speed counts too (BoatDynamics applies its windage).

import { qFromAxisAngle, qRotate, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import { neutralControls } from '../world/protocol';
import { BoatDynamics } from './BoatDynamics';
import type { BoatModel } from './boatModel';
import type { ForceModule } from './modules';
import { SurfaceProp } from './propulsion/surfaceProp';
import { flatWater } from './water';

export interface TankResult {
  speed: number; // m/s
  resistance: number; // N, hull model only
  sinkage: number; // m, body origin height (− = down)
  trim: number; // rad, + bow up
  wettedArea: number; // m²
}

const X_AXIS = vec3(1, 0, 0);
const BOW = vec3(0, 0, -1);
const fwd = vec3();
const origin = vec3();

export function towBoat(
  model: BoatModel,
  speed: number,
  seconds: number,
  dt = 1 / 120,
  modules: ForceModule[] = [],
): TankResult {
  const dyn = new BoatDynamics(model, { modules });
  const whole = modules.length > 0;
  const body = dyn.body;
  dyn.placeAtRest(0, 0, 0);
  // A hydroplane rides on its propeller: it is towed with it running, the throttle trimmed until
  // the thrust matches the resistance, and the resistance is everything but the propeller's force.
  const prop = modules.find((m) => m instanceof SurfaceProp);
  const controls = neutralControls();
  if (prop) {
    controls.throttle = 0.3;
    prop.prime(0.3);
  }
  const steps = Math.round(seconds / dt);
  const from = Math.floor(steps * 0.7);
  let r = 0;
  let sink = 0;
  let trim = 0;
  let wet = 0;
  let count = 0;
  for (let i = 0; i < steps; i++) {
    body.velocity.x = 0;
    // Dropped into the water at speed a hydroplane is launched (and blows over): it is towed up to
    // speed over the first half of the run instead.
    body.velocity.z = -speed * (prop ? Math.min(1, i / (0.5 * steps)) : 1);
    dyn.step(dt, flatWater, null, i * dt, controls);
    let resistance = whole ? body.force.z : dyn.hullForces.force.z;
    if (prop) {
      resistance -= prop.worldForce.z;
      const error = (resistance + prop.worldForce.z) / (0.1 * model.mass * GRAVITY);
      controls.throttle = Math.max(0, Math.min(1, controls.throttle + 0.5 * error * dt));
    }
    // Lock everything but heave and pitch.
    qRotate(fwd, body.orientation, BOW);
    const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
    const origin0 = body.getOrigin(origin);
    const y = origin0.y;
    qFromAxisAngle(body.orientation, X_AXIS, pitch);
    body.getOrigin(origin);
    body.position.x -= origin.x;
    body.position.y += y - origin.y;
    body.position.z -= origin.z;
    const wx = body.angularVelocity.x;
    body.angularVelocity.x = wx;
    body.angularVelocity.y = 0;
    body.angularVelocity.z = 0;
    if (i >= from) {
      r += resistance;
      sink += y;
      trim += pitch;
      wet += dyn.hullForces.wettedArea;
      count++;
    }
  }
  return { speed, resistance: r / count, sinkage: sink / count, trim: trim / count, wettedArea: wet / count };
}
