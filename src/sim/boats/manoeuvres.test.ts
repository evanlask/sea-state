import { describe, expect, it } from 'vite-plus/test';

import type { BoatDynamics } from '../physics/BoatDynamics';
import { physicsTuning } from '../physics/tuning';
import { flatWater } from '../physics/water';
import { type BoatControls, type BoatKind, neutralControls, type PhysicsMode } from '../world/protocol';
import { createBoatDynamics } from './drivetrains';
import { BOAT_SPECS } from './specs/index';

const SHIPS = new Set<BoatKind>(['cargo', 'cruise', 'crab']);

const boat = (kind: BoatKind, mode: PhysicsMode): BoatDynamics =>
  createBoatDynamics(kind, physicsTuning(kind, mode));
const dtFor = (kind: BoatKind): number => (SHIPS.has(kind) ? 1 / 40 : 1 / 120);
const top = (kind: BoatKind): number => BOAT_SPECS[kind].propulsion.topSpeed;

function run(
  d: BoatDynamics,
  seconds: number,
  c: BoatControls,
  dt: number,
  each?: (t: number) => boolean,
): number {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    d.step(dt, flatWater, null, i * dt, c);
    if (each?.((i + 1) * dt)) return (i + 1) * dt;
  }
  return seconds;
}

function underWay(kind: BoatKind, mode: PhysicsMode, fraction: number): BoatDynamics {
  const d = boat(kind, mode);
  d.body.velocity.z = -fraction * top(kind);
  d.prime(1);
  return d;
}

function turn(mode: PhysicsMode, seconds: number) {
  const kind = 'cargo';
  const d = underWay(kind, mode, 1);
  const c = { ...neutralControls(), throttle: 1 };
  const dt = dtFor(kind);
  run(d, 20, c, dt);
  const x0 = d.body.position.x;
  c.steer = 1;
  let heading = 0;
  let t90 = Infinity;
  let tactical = NaN;
  const tel: Record<string, number> = {};
  run(d, seconds, c, dt, (t) => {
    d.writeTelemetry(tel);
    heading += (tel['yawRate'] ?? 0) * dt;
    if (t90 === Infinity && heading >= Math.PI / 2) t90 = t;
    if (heading >= Math.PI) {
      tactical = (d.body.position.x - x0) / BOAT_SPECS[kind].dimensions.lwl;
      return true;
    }
    return false;
  });
  return { t90, tactical };
}

function crashStop(mode: PhysicsMode, seconds: number) {
  const kind = 'cargo';
  const d = underWay(kind, mode, 1);
  const c = { ...neutralControls(), throttle: 1 };
  const dt = dtFor(kind);
  run(d, 10, c, dt);
  const z0 = d.body.position.z;
  c.throttle = -1;
  const time = run(d, seconds, c, dt, () => -d.body.velocity.z < 0.05);
  return { time, reach: (z0 - d.body.position.z) / BOAT_SPECS[kind].dimensions.lwl };
}

describe('container ship manoeuvres', () => {
  it('Realistic: tactical diameter 3–3.5 L at 35° rudder', () => {
    const { tactical } = turn('realistic', 500);
    expect(tactical).toBeGreaterThanOrEqual(3);
    expect(tactical).toBeLessThanOrEqual(3.5);
  }, 30_000);

  it('Realistic: crash stop (Full Ahead → Full Astern) in 10–15 L and 6–9 min', () => {
    const { time, reach } = crashStop('realistic', 700);
    expect(reach).toBeGreaterThanOrEqual(10);
    expect(reach).toBeLessThanOrEqual(15);
    expect(time / 60).toBeGreaterThanOrEqual(6);
    expect(time / 60).toBeLessThanOrEqual(9);
  }, 30_000);

  it('Arcade: turns 90° in ≤ 40 s with a ~2 L tactical diameter and crash-stops in ≤ 45 s', () => {
    const { t90, tactical } = turn('arcade', 120);
    expect(t90).toBeLessThanOrEqual(40);
    expect(tactical).toBeGreaterThan(1.5);
    expect(tactical).toBeLessThan(2.6);
    expect(crashStop('arcade', 90).time).toBeLessThanOrEqual(45);
  }, 30_000);
});
