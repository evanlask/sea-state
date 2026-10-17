import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../boats/specs/index';
import { DEG } from '../core/conventions';
import { qFromAxisAngle, quatIdentity, vec3 } from '../core/math';
import { GRAVITY, RHO_SEAWATER } from '../core/units';
import { buildBoatModel } from './boatModel';
import { Hydrostatics } from './hydrostatics';
import { ittc57, type KernerParams, KernerHull, kernerResult } from './kerner';
import { boxMesh } from './mesh';
import { RigidBody } from './RigidBody';
import { AiryWave, flatWater, GerstnerWave, waterSample } from './water';

const params: KernerParams = {
  referenceSpeed: 5,
  pressureDragLinear: 0.3,
  pressureDragQuadratic: 0.3,
  pressureFalloff: 0.5,
  suctionDragLinear: 0.2,
  suctionDragQuadratic: 0.2,
  suctionFalloff: 0.5,
  slamGammaMax: 20,
  slamExponent: 2,
  slamStopTime: 0.5,
  waterlineLength: 10,
  airDragCoefficient: 0,
  horizontalVelocityTerms: true,
};

// 4 × 3 × 10 m box with its centre 0.5 m above the CG origin: keel at −1, deck at +2.
const box = boxMesh(0, 0.5, 0, 4, 3, 10);
const boxBody = (): RigidBody => new RigidBody({ mass: 41_000, inertia: vec3(1e5, 1e5, 1e5) });
const Z = vec3(0, 0, 1);

describe('Kerner hull forces', () => {
  it('reproduces Archimedes and a zero moment for a level box', () => {
    const body = boxBody();
    const hull = new KernerHull(box, params, 40);
    const r = hull.apply(body, flatWater, 0, 1 / 120, kernerResult());
    expect(r.hydrostatic.y).toBeCloseTo(RHO_SEAWATER * GRAVITY * 40, 4);
    expect(Math.abs(r.hydrostatic.x) + Math.abs(r.hydrostatic.z)).toBeLessThan(1e-6);
    expect(Math.hypot(r.torque.x, r.torque.y, r.torque.z)).toBeLessThan(1e-4);
    expect(r.submergedVolume).toBeCloseTo(40, 8);
    expect(r.immersion).toBeCloseTo(1, 8);
    expect(r.wettedArea).toBeCloseTo(68, 8);
    expect(body.force.y).toBeCloseTo(r.force.y, 8);
  });

  it('matches the hydrostatic righting moment ρ·g·∇·GZ when heeled', () => {
    const cg = vec3(0, 0.3, 0);
    const hs = new Hydrostatics(box);
    const heel = 15 * DEG;
    const eq = hs.equilibrium(cg, 40, heel, false);
    const body = new RigidBody({ mass: 41_000, inertia: vec3(1e5, 1e5, 1e5), cg });
    qFromAxisAngle(body.orientation, Z, -heel); // starboard down
    body.position.y = eq.height;
    const r = new KernerHull(box, params, 40).apply(body, flatWater, 0, 1 / 120, kernerResult());
    expect(r.hydrostatic.y).toBeCloseTo(RHO_SEAWATER * GRAVITY * 40, 3);
    expect(r.torque.z / (RHO_SEAWATER * GRAVITY * 40)).toBeCloseTo(eq.gz, 6);
  });

  it('applies Froude-Krylov pressure in every direction in a wave', () => {
    const wave = new AiryWave({
      amplitude: 1,
      wavelength: 30,
      directionX: 1,
      directionZ: 0,
      phase: Math.PI / 2,
    });
    const r = new KernerHull(box, params, 40).apply(boxBody(), wave, 0, 1 / 120, kernerResult());
    expect(Math.abs(r.hydrostatic.x)).toBeGreaterThan(1000);
  });

  it('attenuates wave pressure with depth (deep hulls feel short waves less)', () => {
    const wave = new AiryWave({ amplitude: 0.5, wavelength: 8, directionX: 1, directionZ: 0 });
    const shallow = waterSample();
    const deep = waterSample();
    wave.sample(0, -0.5, 0, 0, shallow);
    wave.sample(0, -6, 0, 0, deep);
    // η = 0.5 here: head = −y + η·e^{k(y − η)}.
    expect(shallow.pressureHead - 0.5).toBeCloseTo(0.5 * Math.exp((-1 * 2 * Math.PI) / 8), 10);
    expect(deep.pressureHead - 6).toBeLessThan(0.005);
  });

  it('uses the ITTC-1957 friction line', () => {
    expect(ittc57(1e7)).toBeCloseTo(0.075 / 25, 12);
    expect(ittc57(10)).toBe(ittc57(1e5)); // clamped at low Re
  });

  it('produces planing lift on a V-hull at speed and positive trim', () => {
    const model = buildBoatModel(BOAT_SPECS.powerboat);
    const hull = new KernerHull(model.buoyant, model.spec.kerner, model.designVolume);
    const lift = (speed: number, trimDeg: number): number => {
      const body = new RigidBody({ mass: model.mass, inertia: model.inertia, cg: model.cg });
      body.setOriginPose(vec3(), qFromAxisAngle(quatIdentity(), vec3(1, 0, 0), trimDeg * DEG));
      body.velocity.z = -speed; // bow (−Z) first
      hull.reset();
      return hull.apply(body, flatWater, 0, 1 / 480, kernerResult()).pressureDrag.y;
    };
    expect(lift(15, 4)).toBeGreaterThan(0);
    expect(lift(20, 4)).toBeGreaterThan(lift(10, 4));
    expect(lift(15, 4)).toBeGreaterThan(0.2 * model.mass * GRAVITY);
  });

  it('can drop the velocity-dependent horizontal terms (MMG ships) but keep vertical ones', () => {
    const body = boxBody();
    body.velocity.x = 2;
    body.velocity.y = -1;
    const on = new KernerHull(box, params, 40).apply(body, flatWater, 0, 1 / 120, kernerResult());
    const off = new KernerHull(box, { ...params, horizontalVelocityTerms: false }, 40).apply(
      body,
      flatWater,
      0,
      1 / 120,
      kernerResult(),
    );
    expect(Math.abs(on.pressureDrag.x)).toBeGreaterThan(100);
    expect(off.pressureDrag.x).toBe(0);
    expect(off.friction.x).toBe(0);
    // Off: only the vertical relative motion drives the velocity terms.
    body.velocity.x = 0;
    const vertical = new KernerHull(box, params, 40).apply(body, flatWater, 0, 1 / 120, kernerResult());
    expect(off.pressureDrag.y).toBeCloseTo(vertical.pressureDrag.y, 8);
    expect(off.hydrostatic.x).toBeCloseTo(on.hydrostatic.x, 8);
  });

  it('reports slams when the swept volume grows fast, not when leaving the water', () => {
    const hull = new KernerHull(box, params, 40);
    const body = boxBody();
    body.position.y = 1.05; // keel just above the water
    body.velocity.y = -6;
    const dt = 1 / 480;
    const r = kernerResult();
    let slam = 0;
    let slamY = 0;
    for (let i = 0; i < 40; i++) {
      body.clearForces();
      hull.apply(body, flatWater, i * dt, dt, r);
      if (r.slamStrength > slam) {
        slam = r.slamStrength;
        slamY = r.slamPoint.y;
      }
      body.position.y += body.velocity.y * dt;
    }
    expect(slam).toBeGreaterThan(0.5);
    expect(slamY).toBeLessThan(0.01); // on the wetted bottom
    body.velocity.y = 6;
    hull.apply(body, flatWater, 1, dt, r);
    hull.apply(body, flatWater, 1, dt, r);
    expect(r.slamStrength).toBe(0);
  });
});

describe('analytic seas', () => {
  it('Gerstner: the inverted surface point has zero pressure head', () => {
    const wave = new GerstnerWave({ amplitude: 1, wavelength: 12, directionX: 0.6, directionZ: 0.8 });
    const s = waterSample();
    for (const x of [-3, 0, 1.7, 5]) {
      wave.sample(x, 0, 2, 1.3, s);
      const h = s.height;
      wave.sample(x, h, 2, 1.3, s);
      expect(s.pressureHead).toBeCloseTo(0, 6);
      expect(Math.hypot(s.normalX, s.normalY, s.normalZ)).toBeCloseTo(1, 12);
    }
  });

  it('Airy: orbital velocity decays as e^{ky}', () => {
    const wave = new AiryWave({ amplitude: 1, wavelength: 20, directionX: 1, directionZ: 0 });
    const a = waterSample();
    const b = waterSample();
    wave.sample(0, 1, 0, 0, a); // crest (η = 1) and 5 m below it
    wave.sample(0, -4, 0, 0, b);
    expect(b.velocityX / a.velocityX).toBeCloseTo(Math.exp((-5 * 2 * Math.PI) / 20), 10);
  });
});
