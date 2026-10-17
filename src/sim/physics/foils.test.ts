import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import { type FoilSpec, foilCoefficients, foilForce, foilState, liftSlope } from './foils';

const rudder: FoilSpec = {
  name: 'test rudder',
  kind: 'rudder',
  centre: vec3(0, -1, 4),
  spanAxis: vec3(0, -1, 0),
  chordAxis: vec3(0, 0, 1),
  span: 1.5,
  area: 0.75,
  effectiveAspectRatio: 3,
  stallAngle: 32 * DEG,
};

describe('foils', () => {
  it('uses the aspect-ratio-corrected (Helmbold) lift slope', () => {
    const a = liftSlope(3);
    expect(a).toBeCloseTo((2 * Math.PI * 3) / (2 + Math.sqrt(13)), 12);
    expect(liftSlope(1000)).toBeCloseTo(2 * Math.PI, 1); // → 2D thin-airfoil limit
    const c = foilCoefficients(rudder, 4 * DEG, { cl: 0, cd: 0 });
    expect(c.cl / (4 * DEG)).toBeCloseTo(a, 10);
    // Induced drag CL²/(π e A) on top of CD0.
    expect(c.cd).toBeCloseTo(0.008 + (c.cl * c.cl) / (Math.PI * 0.9 * 3), 10);
  });

  it('stalls near 32° and falls back to flat-plate behaviour', () => {
    const at = (deg: number) => foilCoefficients(rudder, deg * DEG, { cl: 0, cd: 0 });
    const peak = at(32).cl;
    expect(at(28).cl).toBeLessThan(peak);
    expect(at(40).cl).toBeLessThan(0.6 * peak);
    const plate = at(90);
    expect(plate.cl).toBeCloseTo(0, 6);
    expect(plate.cd).toBeCloseTo(0.008 + 1.2, 6);
    expect(at(-10).cl).toBeCloseTo(-at(10).cl, 12);
  });

  it('pushes toward the side the flow comes from (lift ⟂ inflow) at the dynamic pressure', () => {
    // Boat moving ahead at 5 m/s: water flows aft (+z) past the rudder. Deflecting the
    // chord by +10° about the downward span axis gives a sideways force.
    const state = foilState();
    foilForce(rudder, vec3(0, 0, 5), 10 * DEG, 1, state);
    expect(Math.abs(state.alpha)).toBeCloseTo(10 * DEG, 10);
    const q = 0.5 * RHO_SEAWATER * 25 * rudder.area;
    const lift = Math.abs(state.force.x);
    expect(lift).toBeCloseTo(q * Math.abs(state.cl), 6);
    expect(state.force.z).toBeGreaterThan(0); // drag acts downstream (aft)
    expect(state.force.y).toBeCloseTo(0, 10);
    // Opposite deflection mirrors the side force.
    const mirror = foilState();
    foilForce(rudder, vec3(0, 0, 5), -10 * DEG, 1, mirror);
    expect(mirror.force.x).toBeCloseTo(-state.force.x, 8);
  });

  it('resists leeway: a boat slipping to starboard gets a keel force to port', () => {
    // Slipping to starboard while sailing ahead: the water moves aft and to port (−x).
    const state = foilState();
    foilForce(rudder, vec3(-1, 0, 5), 0, 1, state);
    expect(state.force.x).toBeLessThan(0); // pushed along the cross-flow
  });

  it('scales with immersion and vanishes out of the water', () => {
    const full = foilState();
    const half = foilState();
    const dry = foilState();
    foilForce(rudder, vec3(-1, 0, 5), 0, 1, full);
    foilForce(rudder, vec3(-1, 0, 5), 0, 0.5, half);
    foilForce(rudder, vec3(-1, 0, 5), 0, 0, dry);
    expect(half.force.x).toBeCloseTo(full.force.x / 2, 10);
    expect(dry.force.x).toBe(0);
  });
});
