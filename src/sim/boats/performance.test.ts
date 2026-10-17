import { describe, expect, it } from 'vite-plus/test';

import { MPH } from '../core/units';
import type { BoatDynamics } from '../physics/BoatDynamics';
import { physicsTuning } from '../physics/tuning';
import { flatWater } from '../physics/water';
import { type BoatControls, type BoatKind, neutralControls, type PhysicsMode } from '../world/protocol';
import { createBoatDynamics } from './drivetrains';
import { BOAT_SPECS } from './specs/index';

const POWERED: readonly BoatKind[] = ['cargo', 'cruise', 'crab', 'powerboat', 'pwc'];
const SHIPS = new Set<BoatKind>(['cargo', 'cruise', 'crab']);

const boat = (kind: BoatKind, mode: PhysicsMode): BoatDynamics =>
  createBoatDynamics(kind, physicsTuning(kind, mode));
const dtFor = (kind: BoatKind): number => (SHIPS.has(kind) ? 1 / 40 : 1 / 120);
const speedOf = (d: BoatDynamics): number => Math.hypot(d.body.velocity.x, d.body.velocity.z);
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

// Time until the boat reaches `speed` from rest at full throttle.
function timeTo(kind: BoatKind, mode: PhysicsMode, speed: number, limit: number): number {
  const d = boat(kind, mode);
  const c = { ...neutralControls(), throttle: 1 };
  return run(d, limit, c, dtFor(kind), () => speedOf(d) >= speed);
}

describe('top speed with full power (calm water)', () => {
  for (const mode of ['realistic', 'arcade'] as const) {
    for (const kind of POWERED) {
      it(`${kind} settles within ±5% of ${(top(kind) / 0.5144).toFixed(0)} kn (${mode})`, () => {
        const d = underWay(kind, mode, 0.97);
        const c = { ...neutralControls(), throttle: 1 };
        run(d, SHIPS.has(kind) ? (mode === 'arcade' ? 60 : 150) : 25, c, dtFor(kind));
        expect(Math.abs(speedOf(d) / top(kind) - 1)).toBeLessThan(0.05);
      }, 30_000);
    }
  }
});

describe('acceleration', () => {
  it('the center console gets on the plane in 3–5 s and does 0–30 mph in 6–8 s (±1.5 s)', () => {
    const plane = timeTo('powerboat', 'realistic', 8, 15);
    const thirty = timeTo('powerboat', 'realistic', 30 * MPH, 20);
    expect(plane).toBeGreaterThan(2);
    expect(plane).toBeLessThan(6);
    expect(thirty).toBeGreaterThan(4.5);
    expect(thirty).toBeLessThan(9.5);
  });

  it('the jet ski does 0–30 mph in about 1.8 s, and the same in Arcade (±10%)', () => {
    const real = timeTo('pwc', 'realistic', 30 * MPH, 6);
    const arcade = timeTo('pwc', 'arcade', 30 * MPH, 6);
    expect(real).toBeGreaterThan(1.2);
    expect(real).toBeLessThan(2.6);
    expect(Math.abs(arcade / real - 1)).toBeLessThanOrEqual(0.1);
  });

  it('Arcade: the container ship goes from 0 to 90% of top speed in ≤ 60 s', () => {
    expect(timeTo('cargo', 'arcade', 0.9 * top('cargo'), 90)).toBeLessThanOrEqual(60);
  }, 30_000);
});
