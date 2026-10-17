import { describe, expect, it } from 'vite-plus/test';

import { createBoatDynamics } from '../../boats/drivetrains';
import { knotsToMs } from '../../core/units';
import { neutralControls } from '../../world/protocol';
import { holtropMennen } from '../resistance';
import { physicsTuning } from '../tuning';
import { FlatWater, flatWater } from '../water';
import { UniformWind } from '../windage';
import { FinStabilizers } from './finStabilizers';
import { JetDrive } from './jet';
import { Engine, type EngineSpec, FourQuadrantPropeller } from './propeller';
import { ShaftPropeller } from './ship';

const curve = { diameter: 4, kt0: 0.45, j0: 1.0, kq0: 0.06, j0q: 1.15 };

describe('four-quadrant propeller', () => {
  it('follows the open-water line ahead and gives ~65% thrust astern at the same torque', () => {
    const p = new FourQuadrantPropeller(curve);
    p.evaluate(2, 0);
    const bollard = p.thrust;
    expect(bollard / (1025 * 4 * 256)).toBeCloseTo(0.45, 2);
    const qAhead = p.torque;
    p.evaluate(-2, 0);
    expect(p.thrust).toBeLessThan(0);
    expect(-p.thrust / bollard).toBeCloseTo(0.65, 1);
    expect(-p.torque / qAhead).toBeCloseTo(1, 1);
    // Thrust falls with advance and reverses past J0.
    p.evaluate(2, 0.5 * 2 * 4);
    expect(p.thrust).toBeLessThan(bollard);
    p.evaluate(2, 1.3 * 2 * 4);
    expect(p.thrust).toBeLessThan(0);
  });

  it('brakes a ship moving ahead when turning astern (crash-stop quadrant) and windmills when stopped', () => {
    const p = new FourQuadrantPropeller(curve);
    p.evaluate(-2, 6);
    expect(p.thrust).toBeLessThan(0);
    p.evaluate(0, 6);
    expect(p.thrust).toBeLessThan(0); // locked-propeller drag
    expect(p.torque).toBeLessThan(0); // the flow drives it round ahead
  });
});

describe('engine', () => {
  const spec: EngineSpec = {
    power: 5e6,
    ratedRpm: 120,
    idleRpm: 30,
    asternRpm: 0.8,
    torqueFactor: 1,
    inertia: 2000,
    rampTime: 20,
    reversal: 'direct',
    reversalDelay: 10,
    brakeTorque: 0.3,
  };

  it('follows the telegraph through the load programme and must stop before going astern', () => {
    const e = new Engine(spec);
    const prop = new FourQuadrantPropeller(curve);
    const run = (order: number, seconds: number): void => {
      for (let i = 0; i < seconds * 50; i++) {
        prop.evaluate(e.n, 0);
        e.step(order, prop.torque, 0.02, spec.rampTime, spec.reversalDelay);
      }
    };
    run(1, 10);
    expect(e.program).toBeCloseTo(0.5, 1); // half way through the 20 s programme
    run(1, 30);
    expect(e.n * 60).toBeGreaterThan(100);
    run(-1, 5);
    expect(e.n).toBeGreaterThanOrEqual(0); // still stopping, never jumps through zero
    run(-1, 60);
    expect(e.n * 60).toBeLessThan(-60);
  });
});

describe('jet drive', () => {
  it('cannot steer without thrust', () => {
    const d = createBoatDynamics('pwc', physicsTuning('pwc', 'realistic'));
    const c = { ...neutralControls(), steer: 1 };
    for (let i = 0; i < 240; i++) d.step(1 / 120, flatWater, null, i / 120, c);
    expect(Math.abs(d.body.angularVelocity.y)).toBeLessThan(0.01);
    c.throttle = 1;
    for (let i = 0; i < 120; i++) d.step(1 / 120, flatWater, null, 2 + i / 120, c);
    expect(Math.abs(d.body.angularVelocity.y)).toBeGreaterThan(0.1);
  });

  it('ventilates and loses its thrust when the intake leaves the water; the engine races', () => {
    const d = createBoatDynamics('pwc', physicsTuning('pwc', 'realistic'));
    const jet = d.modules.find((m) => m instanceof JetDrive) as JetDrive;
    const c = { ...neutralControls(), throttle: 1 };
    for (let i = 0; i < 120; i++) d.step(1 / 120, flatWater, null, i / 120, c);
    expect(jet.thrust).toBeGreaterThan(1000);
    const rpm = jet.n;
    // Water dropped 1 m under the hull: airborne.
    const low = new FlatWater(-1);
    for (let i = 0; i < 12; i++) d.step(1 / 120, low, null, 1 + i / 120, c);
    expect(jet.ventilated).toBeGreaterThan(0.9);
    expect(Math.abs(jet.thrust)).toBeLessThan(10);
    expect(jet.n).toBeGreaterThanOrEqual(rpm);
    const tel: Record<string, number> = {};
    d.writeTelemetry(tel);
    expect(tel['airborne']).toBe(1);
  });

  it('brakes with the reverse bucket', () => {
    const d = createBoatDynamics('pwc', physicsTuning('pwc', 'realistic'));
    d.body.velocity.z = -15;
    d.prime(0.5);
    const c = { ...neutralControls(), brake: true };
    for (let i = 0; i < 60; i++) d.step(1 / 120, flatWater, null, i / 120, c);
    const jet = d.modules.find((m) => m instanceof JetDrive) as JetDrive;
    expect(jet.thrust).toBeLessThan(0);
  });
});

describe('ship propulsion and resistance', () => {
  it('Holtrop-Mennen puts the KCS at ~2 MN at 24 kn', () => {
    const r = holtropMennen(
      {
        L: 232.5,
        B: 32.2,
        T: 10.8,
        TF: 10.8,
        volume: 52030,
        lcb: -1.48,
        CM: 0.985,
        CWP: 0.82,
        ABT: 14,
        hB: 4.9,
        AT: 0,
        Sapp: 90,
        k2app: 1.5,
        Cstern: 10,
      },
      knotsToMs(24),
    );
    expect(r.total).toBeGreaterThan(1.5e6);
    expect(r.total).toBeLessThan(2.5e6);
  });

  it('the telegraph order drives the shaft; telemetry reports order and response', () => {
    const d = createBoatDynamics('crab', physicsTuning('crab', 'arcade'));
    const c = { ...neutralControls(), throttle: 0.65 };
    for (let i = 0; i < 60 * 20; i++) d.step(1 / 60, flatWater, null, i / 60, c);
    const tel: Record<string, number> = {};
    d.writeTelemetry(tel);
    expect(tel['telegraphOrder']).toBeCloseTo(0.65, 5);
    expect(tel['telegraphResponse']).toBeGreaterThan(0.55);
    expect(tel['rpm']).toBeGreaterThan(0);
    expect(tel['surge']).toBeGreaterThan(3);
    expect(d.modules.some((m) => m instanceof ShaftPropeller)).toBe(true);
  });
});

describe('fin stabilisers', () => {
  // The cruise ship heeled 5° to starboard, moving ahead at `speed` in calm water: the fins' roll
  // moment once they have turned (+ rights the heel).
  const finMoment = (speed: number): number => {
    const d = createBoatDynamics('cruise', physicsTuning('cruise', 'realistic'));
    d.placeAtRest(0, 0, 0, 5 * (Math.PI / 180));
    const fins = d.modules.find((m) => m instanceof FinStabilizers) as FinStabilizers;
    d.body.velocity.z = -speed; // heading north: ahead is −z
    for (let i = 0; i < 30; i++)
      fins.apply({
        body: d.body,
        water: flatWater,
        wind: new UniformWind(0, 0),
        time: 0,
        dt: 0.1,
        controls: neutralControls(),
        physicsMode: 'realistic',
      });
    return fins.moment;
  };

  it('right a heel under way, with lift growing as the square of the speed, and do nothing stopped', () => {
    const service = finMoment(knotsToMs(21));
    expect(service).toBeGreaterThan(1e7);
    expect(finMoment(knotsToMs(10.5)) / service).toBeCloseTo(0.25, 1);
    expect(finMoment(0)).toBe(0);
  });
});
