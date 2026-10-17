import { describe, expect, it } from 'vite-plus/test';

import {
  planThunder,
  thunderAttenuation,
  thunderDelay,
  thunderEnvelope,
  type ThunderStrike,
} from './thunderPlan';

const strike = (x: number, cloudToGround = true, intensity = 1): ThunderStrike => ({
  x,
  y: 0,
  z: 0,
  time: 0,
  intensity,
  cloudToGround,
});

describe('thunder planning', () => {
  it('delays the sound by distance / 343 m/s', () => {
    expect(thunderDelay(343)).toBeCloseTo(1);
    expect(thunderDelay(3430)).toBeCloseTo(10);
    expect(planThunder(strike(6860), 0, 0, 0).delay).toBeCloseTo(20);
    // Distance is 3-D from the listener.
    expect(planThunder({ ...strike(300), y: 400 }, 0, 0, 0).delay).toBeCloseTo(500 / 343);
  });

  it('attenuates with distance and vanishes beyond ~25 km', () => {
    expect(thunderAttenuation(500)).toBe(1);
    expect(thunderAttenuation(3000)).toBeLessThan(thunderAttenuation(1000));
    expect(thunderAttenuation(30000)).toBe(0);
  });

  it('gives close cloud-to-ground strikes a crack, distant ones a low soft roll', () => {
    const near = planThunder(strike(400), 0, 0, 0);
    const far = planThunder(strike(9000), 0, 0, 0);
    expect(near.crackGain).toBeGreaterThan(0.5);
    expect(far.crackGain).toBe(0);
    expect(far.gain).toBeLessThan(near.gain);
    expect(far.cutoffStart).toBeLessThan(near.cutoffStart);
    expect(far.duration).toBeGreaterThan(near.duration);
    expect(planThunder(strike(400, false), 0, 0, 0).crackGain).toBe(0);
  });

  it('builds a bounded rolling envelope that ends silent', () => {
    const plan = planThunder(strike(2000), 0, 0, 0);
    const env = thunderEnvelope(plan, 7);
    expect(env.length).toBe(Math.round(plan.duration * 60));
    expect(Math.max(...env)).toBeCloseTo(plan.gain, 5);
    expect(Math.min(...env)).toBeGreaterThanOrEqual(0);
    expect(env[env.length - 1]).toBe(0);
    expect(thunderEnvelope(plan, 7)).toEqual(env); // deterministic per seed
  });
});
