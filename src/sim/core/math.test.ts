import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from './attitude';
import { DEG, headingToYaw } from './conventions';
import {
  qFromAxisAngle,
  qIntegrate,
  qMultiply,
  qRotate,
  qRotateInverse,
  qSlerp,
  quatIdentity,
  vec3,
} from './math';

const Y = vec3(0, 1, 0);
const Z = vec3(0, 0, 1);
const X = vec3(1, 0, 0);

describe('quaternions', () => {
  it('rotates the bow to the heading given by headingToYaw', () => {
    const q = qFromAxisAngle(quatIdentity(), Y, headingToYaw(90 * DEG));
    const bow = qRotate(vec3(), q, vec3(0, 0, -1));
    expect(bow.x).toBeCloseTo(1);
    expect(bow.z).toBeCloseTo(0);
  });

  it('inverts rotations', () => {
    const q = qFromAxisAngle(quatIdentity(), vec3(0.6, 0.8, 0), 1.1);
    const v = vec3(1, 2, 3);
    const back = qRotateInverse(vec3(), q, qRotate(vec3(), q, v));
    expect(back.x).toBeCloseTo(1);
    expect(back.y).toBeCloseTo(2);
    expect(back.z).toBeCloseTo(3);
  });

  it('integrates a constant yaw rate to the expected angle', () => {
    let q = quatIdentity();
    for (let i = 0; i < 1000; i++) q = qIntegrate(q, q, vec3(0, 0.5, 0), 0.001);
    const expected = qFromAxisAngle(quatIdentity(), Y, 0.5);
    expect(Math.abs(q.x * expected.x + q.y * expected.y + q.z * expected.z + q.w * expected.w)).toBeCloseTo(
      1,
      6,
    );
  });

  it('slerps halfway between two rotations', () => {
    const a = quatIdentity();
    const b = qFromAxisAngle(quatIdentity(), Y, 1);
    const mid = qSlerp(quatIdentity(), a, b, 0.5);
    const expected = qFromAxisAngle(quatIdentity(), Y, 0.5);
    expect(mid.y).toBeCloseTo(expected.y);
    expect(mid.w).toBeCloseTo(expected.w);
  });
});

describe('attitude', () => {
  it('reads heading from yaw', () => {
    const q = qFromAxisAngle(quatIdentity(), Y, headingToYaw(200 * DEG));
    expect(attitudeFromQuat(q).heading / DEG).toBeCloseTo(200);
  });

  it('reports starboard-down heel as positive roll', () => {
    // Rolling about the bow axis (-Z) by a positive angle lowers starboard.
    const q = qFromAxisAngle(quatIdentity(), vec3(0, 0, -1), 20 * DEG);
    const attitude = attitudeFromQuat(q);
    expect(attitude.roll / DEG).toBeCloseTo(20);
    expect(attitude.pitch).toBeCloseTo(0);
  });

  it('reports bow-up as positive pitch', () => {
    const q = qFromAxisAngle(quatIdentity(), X, 10 * DEG);
    expect(attitudeFromQuat(q).pitch / DEG).toBeCloseTo(10);
  });

  it('reports a capsized boat as 180° roll', () => {
    const q = qFromAxisAngle(quatIdentity(), Z, Math.PI);
    expect(Math.abs(attitudeFromQuat(q).roll) / DEG).toBeCloseTo(180);
  });

  it('combines heading and heel independently', () => {
    const yaw = qFromAxisAngle(quatIdentity(), Y, headingToYaw(45 * DEG));
    const heel = qFromAxisAngle(quatIdentity(), vec3(0, 0, -1), 15 * DEG);
    const attitude = attitudeFromQuat(qMultiply(quatIdentity(), yaw, heel));
    expect(attitude.heading / DEG).toBeCloseTo(45);
    expect(attitude.roll / DEG).toBeCloseTo(15);
  });
});
