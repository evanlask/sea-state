import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../boats/specs/index';
import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import type { BoatKind } from '../world/protocol';
import { BoatDynamics } from './BoatDynamics';
import { type BoatModel, buildBoatModel } from './boatModel';
import { RollDamper } from './damping';
import { Hydrostatics, rollPeriod } from './hydrostatics';
import { RigidBody } from './RigidBody';
import { flatWater, GerstnerWave } from './water';

const MASTER = 1 / 120;
const models = new Map<BoatKind, BoatModel>();
const model = (kind: BoatKind): BoatModel => {
  let m = models.get(kind);
  if (!m) {
    m = buildBoatModel(BOAT_SPECS[kind]);
    models.set(kind, m);
  }
  return m;
};

// Plausible AVS / reserve ranges by type.
const avsRange: Record<BoatKind, [number, number]> = {
  cargo: [90, 180],
  cruise: [90, 180],
  crab: [120, 180], // empty deck, ballasted to carry pots; 120 pots → ~97°, 200 → ~50° (loading.test)
  sail: [115, 125],
  powerboat: [80, 120],
  pwc: [30, 70],
  hydro: [80, 100], // wide and shallow: it floats as well upside down (cockpit capsule, sealed hull)
};

const att = { heading: 0, pitch: 0, roll: 0 };
const rollOf = (dyn: BoatDynamics): number => attitudeFromQuat(dyn.body.orientation, att).roll;

describe('boat hydrostatics', () => {
  for (const kind of Object.keys(BOAT_SPECS) as BoatKind[]) {
    describe(kind, () => {
      it('floats at its design draft (±5%) at the spec mass, level', () => {
        const m = model(kind);
        const eq = new Hydrostatics(m.buoyant).equilibrium(m.cg, m.designVolume, 0, true);
        const origin = eq.height - m.cg.y; // body origin height above the water
        const draft = (m.hull.params as { draft: number }).draft - origin;
        expect(Math.abs(draft / m.spec.dimensions.draft - 1)).toBeLessThan(0.05);
        expect(Math.abs(eq.trim)).toBeLessThan(0.2 * DEG);
      });

      it('has the target GM and a plausible GZ curve / AVS', () => {
        const m = model(kind);
        const curve = new Hydrostatics(m.buoyant).gzCurve(m.cg, m.designVolume, { step: 5 * DEG });
        expect(Math.abs(curve.gm / m.spec.gmTarget - 1)).toBeLessThan(0.03);
        const [lo, hi] = avsRange[kind];
        expect(curve.avs / DEG).toBeGreaterThanOrEqual(lo);
        expect(curve.avs / DEG).toBeLessThanOrEqual(hi);
        // Positive righting all the way to the AVS.
        for (let i = 1; i < curve.angles.length && curve.angles[i]! < curve.avs - 1e-9; i++) {
          expect(curve.gz[i]).toBeGreaterThan(0);
        }
        if (kind === 'cargo' || kind === 'cruise') expect(curve.maxGz).toBeGreaterThan(1);
      });

      it('free-rolls in calm water with period 2π·k/√(g·GM) (±15%)', () => {
        const m = model(kind);
        const spec = m.spec;
        const dyn = new BoatDynamics(m);
        const expected = rollPeriod(spec.gyration.roll * Math.sqrt(1 + spec.addedMass.roll), m.gm);
        dyn.placeAtRest(0, 0, 0, 3 * DEG);
        const crossings: number[] = [];
        let prev = rollOf(dyn);
        const steps = Math.ceil((2.6 * expected) / MASTER);
        for (let i = 0; i < steps; i++) {
          dyn.step(MASTER, flatWater, null, i * MASTER);
          const roll = rollOf(dyn);
          if (prev > 0 !== roll > 0) crossings.push((i + 0.5) * MASTER);
          prev = roll;
        }
        expect(crossings.length).toBeGreaterThanOrEqual(4);
        const measured = crossings[3]! - crossings[1]!;
        expect(Math.abs(measured / expected - 1)).toBeLessThan(0.15);
      });

      it('settles without exploding after a 1 m drop', () => {
        const m = model(kind);
        const dyn = new BoatDynamics(m);
        dyn.body.position.y += 1;
        let peak = 0;
        const big = kind === 'cargo' || kind === 'cruise' || kind === 'crab';
        const seconds = big ? 30 : 15;
        for (let i = 0; i < seconds * 120; i++) {
          dyn.step(MASTER, flatWater, null, i * MASTER);
          peak = Math.max(peak, Math.abs(dyn.body.position.y - m.cg.y));
        }
        const b = dyn.body;
        expect(Number.isFinite(b.position.y)).toBe(true);
        expect(peak).toBeLessThan(1.5);
        const settled = big ? 0.15 : 0.02;
        expect(Math.abs(b.position.y - m.cg.y)).toBeLessThan(settled);
        expect(Math.abs(rollOf(dyn))).toBeLessThan(1 * DEG);
      });
    });
  }
});

describe('boat dynamics', () => {
  it('a jet ski hitting a steep Gerstner wave at 25 m/s stays finite at 120 Hz × 4', () => {
    const dyn = new BoatDynamics(model('pwc'));
    expect(dyn.model.spec.substeps).toBe(4);
    const wave = new GerstnerWave({ amplitude: 0.9, wavelength: 15, directionX: 0, directionZ: 1 }); // k·a 0.38
    dyn.body.velocity.z = -25;
    let maxSpin = 0;
    let maxSpeed = 0;
    for (let i = 0; i < 120 * 10; i++) {
      dyn.step(MASTER, wave, null, i * MASTER);
      const b = dyn.body;
      maxSpin = Math.max(maxSpin, Math.hypot(b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z));
      maxSpeed = Math.max(maxSpeed, Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z));
    }
    const b = dyn.body;
    for (const v of [b.position.x, b.position.y, b.position.z, b.orientation.w, b.velocity.y]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(maxSpeed).toBeLessThan(30);
    expect(maxSpin).toBeLessThan(20);
    expect(dyn.maxSlamStrength).toBeGreaterThan(0);
  });

  it('a sailboat knocked down below its AVS rights itself', () => {
    const dyn = new BoatDynamics(model('sail'));
    dyn.placeAtRest(0, 0, 0, 100 * DEG);
    for (let i = 0; i < 120 * 15; i++) dyn.step(MASTER, flatWater, null, i * MASTER);
    expect(Math.abs(rollOf(dyn))).toBeLessThan(10 * DEG);
  });

  it('a jet ski rolled past its AVS capsizes and stays inverted', () => {
    const dyn = new BoatDynamics(model('pwc'));
    dyn.placeAtRest(0, 0, 0, 80 * DEG);
    for (let i = 0; i < 120 * 15; i++) dyn.step(MASTER, flatWater, null, i * MASTER);
    expect(Math.abs(rollOf(dyn))).toBeGreaterThan(150 * DEG);
  });

  it('roll damping opposes the roll rate', () => {
    const body = new RigidBody({ mass: 1000, inertia: vec3(1000, 1000, 1000) });
    body.immersion = 1;
    body.angularVelocity.z = 0.5;
    new RollDamper({ zeta: 0.1 }, 1, 1, 1200).apply(body);
    expect(body.torque.z).toBeLessThan(0);
  });
});
