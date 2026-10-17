import { describe, expect, it } from 'vite-plus/test';

import { qFromAxisAngle, quatIdentity, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import { inertiaFromGyration, RigidBody, stepRigidBody } from './RigidBody';

const makeBody = (): RigidBody =>
  new RigidBody({
    mass: 1000,
    inertia: inertiaFromGyration(1000, { roll: 1, pitch: 2, yaw: 3 }),
    cg: vec3(0, -0.5, 1),
    addedMass: { surge: 0.1, sway: 0.5, heave: 1, roll: 0.2, pitch: 0.4, yaw: 0.6 },
  });

describe('RigidBody', () => {
  it('maps radii of gyration onto body axes (x pitch, y yaw, z roll)', () => {
    const inertia = inertiaFromGyration(10, { roll: 1, pitch: 2, yaw: 3 });
    expect(inertia).toEqual({ x: 40, y: 90, z: 10 });
  });

  it('falls freely at g when dry, whatever the added mass', () => {
    const body = makeBody();
    stepRigidBody(body, 1, 100, (b) => b.addGravity());
    expect(body.velocity.y).toBeCloseTo(-GRAVITY, 10);
    // Semi-implicit Euler: x = −g·dt²·n(n+1)/2.
    expect(body.position.y).toBeCloseTo(-GRAVITY * 0.0001 * 5050, 8);
  });

  it('applies per-axis added mass in the body frame, scaled by immersion', () => {
    const body = makeBody();
    body.immersion = 0.5;
    body.force.y = 1000;
    body.force.z = 1000;
    body.integrate(1);
    expect(body.velocity.y).toBeCloseTo(1 / (1 + 1 * 0.5), 10); // heave
    expect(body.velocity.z).toBeCloseTo(1 / (1 + 0.1 * 0.5), 10); // surge
    expect(body.effectiveMass(0)).toBeCloseTo(1000 * 1.25, 10);
    expect(body.effectiveInertia(2)).toBeCloseTo(1000 * 1.1, 10);
  });

  it('turns a force at an offset point into a torque about the CG', () => {
    const body = makeBody();
    body.addForceAtPoint(vec3(0, 10, 0), vec3(2, 0, 0)); // CG at the world origin
    expect(body.torque).toEqual({ x: 0, y: 0, z: 20 });
    body.integrate(0.1);
    expect(body.angularVelocity.z).toBeCloseTo((20 / body.inertia.z) * 0.1, 10);
  });

  it('round-trips body and world points around the CG offset', () => {
    const body = makeBody();
    const q = qFromAxisAngle(quatIdentity(), vec3(0, 1, 0), 0.7);
    body.setOriginPose(vec3(5, 1, -3), q);
    const origin = body.getOrigin(vec3());
    expect(origin.x).toBeCloseTo(5, 12);
    expect(origin.y).toBeCloseTo(1, 12);
    expect(origin.z).toBeCloseTo(-3, 12);
    const p = vec3(1, 2, 3);
    const back = body.worldToBodyPoint(vec3(), body.bodyToWorldPoint(vec3(), p));
    expect(back.x).toBeCloseTo(1, 12);
    expect(back.y).toBeCloseTo(2, 12);
    expect(back.z).toBeCloseTo(3, 12);
  });

  it('gives rigid point velocities v + ω × r', () => {
    const body = makeBody();
    body.velocity.x = 1;
    body.angularVelocity.y = 2;
    const v = body.pointVelocity(vec3(), vec3(0, 0, 1));
    expect(v).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('conserves rotational energy of a torque-free spin about a principal axis', () => {
    const body = makeBody();
    body.angularVelocity.y = 1;
    const energy = (): number => {
      const w = body.angularVelocity;
      return w.x * w.x * body.inertia.x + w.y * w.y * body.inertia.y + w.z * w.z * body.inertia.z;
    };
    const e0 = energy();
    stepRigidBody(body, 10, 4800, () => {});
    expect(energy()).toBeCloseTo(e0, 6);
  });
});
