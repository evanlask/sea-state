import { describe, expect, it } from 'vite-plus/test';

import { sailSpec } from '../boats/specs/sail';
import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { KNOT } from '../core/units';
import type { ForceContext } from '../physics/modules';
import { RigidBody } from '../physics/RigidBody';
import { flatWater } from '../physics/water';
import { UniformWind } from '../physics/windage';
import { neutralControls } from '../world/protocol';
import { ORC_SPEED_KN, ORC_TWA_DEG, ORC_TWS_KN, polarAngles, polarSpeed } from './orcPolar';
import { createSailModule } from './sailModule';
import { steadyStateRun } from './steadyState';
import { SAIL_KEYS } from './telemetry';

describe('ORC polar', () => {
  it('reproduces the table and the 10 kn targets from the plan', () => {
    expect(polarSpeed(10 * KNOT, 52 * DEG) / KNOT).toBeCloseTo(7.29, 6);
    expect(polarSpeed(10 * KNOT, -90 * DEG) / KNOT).toBeCloseTo(7.77, 6);
    expect(polarSpeed(10 * KNOT, 120 * DEG) / KNOT).toBeCloseTo(7.74, 6);
    expect(polarSpeed(10 * KNOT, 150 * DEG) / KNOT).toBeCloseTo(6.73, 6);
    expect(ORC_SPEED_KN.length).toBe(ORC_TWA_DEG.length);
    for (const row of ORC_SPEED_KN) expect(row.length).toBe(ORC_TWS_KN.length);
  });

  it('falls to zero head to wind and gives the beat/run VMG angles', () => {
    expect(polarSpeed(10 * KNOT, 0)).toBe(0);
    const a = polarAngles(10 * KNOT);
    expect(a.beatTwa / DEG).toBeCloseTo(38.8, 6);
    expect(a.runTwa / DEG).toBeCloseTo(152.3, 6);
    expect(a.beatSpeed * Math.cos(a.beatTwa)).toBeCloseTo(5.14 * KNOT, 6);
  });
});

// Steady state with the hull, keel, rudder, windage and auto-trimmed sails (realistic mode, no assists),
// heading held by a PD helmsman. Hull resistance uses the harness's documented resistance calibration.
// The ORC numbers from 110° down assume a spinnaker, which this boat lacks, so the 150° points sit low.
describe('sail model against the C&C 115 ORC polar (±20%)', () => {
  for (const tws of [6, 10, 16]) {
    it(`${tws} kn TWS`, () => {
      for (const twa of [52, 90, 120, 150]) {
        const target = polarSpeed(tws * KNOT, twa * DEG);
        const r = steadyStateRun(tws * KNOT, twa * DEG, 0.9 * target);
        const ratio = r.speed / target;
        expect(ratio, `${tws} kn @ ${twa}°: ${(r.speed / KNOT).toFixed(2)} kn`).toBeGreaterThan(0.8);
        expect(ratio, `${tws} kn @ ${twa}°: ${(r.speed / KNOT).toFixed(2)} kn`).toBeLessThan(1.2);
        expect(Math.abs(r.heel) / DEG).toBeLessThan(35);
      }
    }, 60_000);
  }
});

describe('sail force module', () => {
  const makeCtx = (): ForceContext => {
    const body = new RigidBody({ mass: 5572, inertia: vec3(46000, 46000, 13400), cg: vec3(0, 0.13, 0.83) });
    body.velocity.z = -3;
    return {
      body,
      water: flatWater,
      wind: new UniformWind(6, 60 * DEG), // from 60° off the bow of a north-heading boat
      time: 0,
      dt: 1 / 240,
      controls: neutralControls(),
      physicsMode: 'arcade',
    };
  };

  it('drives the boat forward, heels it to leeward and writes every telemetry key', () => {
    const sails = createSailModule(sailSpec);
    const ctx = makeCtx();
    for (let i = 0; i < 240 * 5; i++) {
      ctx.body.clearForces();
      sails.apply(ctx);
      ctx.time += ctx.dt;
    }
    const t: Record<string, number> = {};
    sails.writeTelemetry(t);
    for (const key of Object.values(SAIL_KEYS)) expect(Number.isFinite(t[key]), key).toBe(true);
    expect(ctx.body.force.z).toBeLessThan(0); // forward
    expect(ctx.body.force.x).toBeLessThan(0); // pushed to port
    expect(t[SAIL_KEYS.heelMoment]).toBeLessThan(0); // heels to port
    expect(t[SAIL_KEYS.autoTrim]).toBe(1); // arcade default
    expect(t[SAIL_KEYS.twa]! / DEG).toBeCloseTo(60, 6);
    expect(t[SAIL_KEYS.awa]!).toBeGreaterThan(0);
    expect(t[SAIL_KEYS.awa]!).toBeLessThan(60 * DEG);
    expect(t[SAIL_KEYS.mainTrim]).toBe(0);
  });

  it('handles reef, furl and auto-trim commands; realistic mode starts manual; recover keeps the reef', () => {
    const sails = createSailModule(sailSpec);
    const ctx = { ...makeCtx(), physicsMode: 'realistic' as const };
    sails.apply(ctx);
    expect(sails.rig.autoTrim).toBe(false);
    expect(sails.command({ type: 'reef', boatId: 's', delta: 1 })).toBe(true);
    expect(sails.command({ type: 'reef', boatId: 's', delta: 1 })).toBe(true);
    expect(sails.command({ type: 'furl', boatId: 's' })).toBe(true);
    expect(sails.command({ type: 'autoTrim', boatId: 's', enabled: true })).toBe(true);
    expect(sails.command({ type: 'recover', boatId: 's' })).toBe(false);
    expect(sails.rig.reefTarget).toBe(2);
    expect(sails.rig.furlTarget).toBeCloseTo(1 / 3, 9);
    expect(sails.rig.autoTrim).toBe(true);
    // Put back upright (recover), the boat keeps the reef and furl its crew set.
    sails.reset();
    expect(sails.rig.reefTarget).toBe(2);
    expect(sails.rig.reef).toBe(2);
    expect(sails.rig.furlTarget).toBeCloseTo(1 / 3, 9);
    expect(sails.rig.autoTrim).toBe(false);
  });

  it('does not count negative gybes after recover when earlier crossings were tacks', () => {
    const sails = createSailModule(sailSpec);
    const upwind = makeCtx();
    sails.apply(upwind);
    sails.rig.boom.crossings = 3; // three tacks, not gybes
    sails.apply(upwind);
    sails.reset(); // the hinge's own crossing counter goes back to zero
    const downwind = { ...makeCtx(), wind: new UniformWind(6, 180 * DEG) }; // dead astern
    sails.apply(downwind);
    const t: Record<string, number> = {};
    sails.writeTelemetry(t);
    expect(t[SAIL_KEYS.boomCrossings]).toBe(0);
    expect(t[SAIL_KEYS.gybes]).toBe(0);
  });
});
