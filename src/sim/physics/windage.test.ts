import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../boats/specs/index';
import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { BoatDynamics } from './BoatDynamics';
import { buildBoatModel } from './boatModel';
import { RigidBody } from './RigidBody';
import { flatWater } from './water';
import {
  applyWindage,
  BLENDERMANN,
  blendermann,
  LogShearWind,
  RHO_AIR_BLENDERMANN,
  UniformWind,
  type WindageSpec,
  windageResult,
} from './windage';

const spec: WindageSpec = {
  type: 'containerShipLoaded',
  lateralArea: 5800,
  frontalArea: 900,
  length: 243,
  lateralCentreHeight: 13,
  lateralCentreForward: -10,
  frontalCentreHeight: 15,
};

describe('windage (Blendermann)', () => {
  it('reduces to the drag coefficients in head and beam winds', () => {
    const c = BLENDERMANN.containerShipLoaded;
    const out = { cx: 0, cy: 0, arm: 0 };
    blendermann(c, spec, 0, out);
    expect(out.cx).toBeCloseTo(-0.55, 12);
    expect(out.cy).toBeCloseTo(0, 12);
    blendermann(c, spec, Math.PI / 2, out);
    expect(out.cy).toBeCloseTo(-0.9, 12);
    expect(out.arm).toBeCloseTo(-10, 12); // at the lateral centroid in a beam wind
    blendermann(c, spec, Math.PI, out);
    expect(out.cx).toBeCloseTo(0.55, 12); // stern wind pushes ahead
  });

  it('heels to leeward and pushes downwind in a beam wind', () => {
    const body = new RigidBody({ mass: 5e7, inertia: vec3(1e10, 1e10, 1e10), cg: vec3(0, 0, 0) });
    const wind = new UniformWind(20, 90 * DEG); // from the east = from starboard, bow north
    const r = applyWindage(body, spec, wind, 0, windageResult());
    expect(r.apparentAngle).toBeCloseTo(Math.PI / 2, 10);
    const q = 0.5 * RHO_AIR_BLENDERMANN * 400;
    expect(r.force.x).toBeCloseTo(-q * spec.lateralArea * 0.9, 3);
    // Lateral force above the CG: torque about +z raises starboard = port (leeward) down.
    expect(body.torque.z).toBeGreaterThan(0);
    expect(body.torque.z).toBeCloseTo(q * spec.lateralArea * 0.9 * 1.4 * spec.lateralCentreHeight, -2);
  });

  it('uses relative wind: a boat running at wind speed feels none', () => {
    const body = new RigidBody({ mass: 1000, inertia: vec3(1, 1, 1) });
    body.velocity.z = 10; // moving south at 10 m/s with a 10 m/s northerly
    const r = applyWindage(body, spec, new UniformWind(10, 0), 0, windageResult());
    expect(r.apparentSpeed).toBeCloseTo(0, 10);
  });

  it('shears the wind with a log profile anchored at 10 m', () => {
    const wind = new LogShearWind(15, 0);
    const v = vec3();
    expect(Math.hypot(wind.sample(0, 10, 0, 0, v).z, v.x)).toBeCloseTo(15, 10);
    expect(wind.sample(0, 2, 0, 0, v).z).toBeLessThan(15);
    expect(wind.sample(0, 40, 0, 0, v).z).toBeGreaterThan(15);
  });

  it('makes a sailboat heel to leeward and drift downwind in a beam wind', () => {
    const dyn = new BoatDynamics(buildBoatModel(BOAT_SPECS.sail));
    const wind = new UniformWind(20, 90 * DEG);
    const att = { heading: 0, pitch: 0, roll: 0 };
    for (let i = 0; i < 120 * 6; i++) dyn.step(1 / 120, flatWater, wind, i / 120);
    attitudeFromQuat(dyn.body.orientation, att);
    expect(att.roll).toBeLessThan(-2 * DEG); // port (leeward) side down
    expect(dyn.body.velocity.x).toBeLessThan(-0.2); // drifting west, downwind
    expect(dyn.body.velocity.x).toBeGreaterThan(-3); // the keel resists leeway
  });
});
