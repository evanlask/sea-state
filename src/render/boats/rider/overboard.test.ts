import { describe, expect, it } from 'vite-plus/test';

import {
  createOverboard,
  depth,
  detach,
  type DetachInput,
  limpWeight,
  OVERBOARD,
  type OverboardState,
  resetOverboard,
  stepOverboard,
  tumbleRate,
  wantsDetach,
} from './overboard';

const input = (over: Partial<DetachInput> = {}): DetachInput => ({
  hips: { x: 0, y: 0.6, z: 0 },
  boatVelocity: { x: 0, y: 0, z: -4 },
  away: { x: 1, z: 0 },
  surface: 0,
  seed: 0.3,
  ...over,
});

function run(s: OverboardState, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds; t += dt) stepOverboard(s, dt);
}

describe('rider overboard', () => {
  it('goes over when the boat capsizes, and only once armed after a reset', () => {
    const s = createOverboard();
    expect(wantsDetach(s, false)).toBe(false);
    expect(wantsDetach(s, true)).toBe(true);
    detach(s, input());
    expect(s.phase).toBe('falling');
    expect(wantsDetach(s, true)).toBe(false);
    resetOverboard(s);
    expect(s.phase).toBe('seated');
    // A snapshot from before the recovery still says capsized: he stays on.
    expect(wantsDetach(s, true)).toBe(false);
    expect(wantsDetach(s, false)).toBe(false);
    expect(wantsDetach(s, true)).toBe(true);
  });

  it('falls off beside the hull into the water, then sinks steadily', () => {
    const s = createOverboard();
    detach(s, input());
    run(s, 0.2);
    expect(s.phase).toBe('falling');
    run(s, 0.8);
    expect(s.phase).toBe('sinking');
    // Off to the side he was thrown, and carried along a little.
    expect(s.position.x).toBeGreaterThan(0.3);
    expect(s.position.z).toBeLessThan(-0.5);
    run(s, 10);
    expect(s.velocity.y).toBeCloseTo(-OVERBOARD.sinkSpeed, 2);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeLessThan(0.15);
    const before = depth(s);
    run(s, 5);
    expect(depth(s) - before).toBeCloseTo(5 * OVERBOARD.sinkSpeed, 1);
  });

  it('is gone once deeper than anyone can see, in a minute or so', () => {
    const s = createOverboard();
    detach(s, input());
    run(s, 50);
    expect(s.phase).toBe('sinking');
    run(s, 40);
    expect(s.phase).toBe('gone');
    expect(depth(s)).toBeGreaterThan(OVERBOARD.goneDepth);
    const at = { ...s.position };
    run(s, 5);
    expect(s.position).toEqual(at);
  });

  it('starts sinking at once when he lets go under water (an inverted hull)', () => {
    const s = createOverboard();
    detach(s, input({ hips: { x: 0, y: -0.8, z: 0 } }));
    expect(s.phase).toBe('sinking');
    expect(s.velocity.y).toBeLessThanOrEqual(0);
  });

  it('gives up a fall that never meets the water', () => {
    const s = createOverboard();
    detach(s, input({ surface: -50 }));
    run(s, OVERBOARD.maxFall + 0.1);
    expect(s.phase).toBe('sinking');
  });

  it('relaxes into the limp pose and slows his tumble', () => {
    const s = createOverboard();
    expect(limpWeight(s)).toBe(0);
    expect(tumbleRate(s)).toBe(0);
    detach(s, input());
    expect(limpWeight(s)).toBe(0);
    const early = tumbleRate(s);
    run(s, OVERBOARD.limpTime / 2);
    expect(limpWeight(s)).toBeCloseTo(0.5, 1);
    run(s, OVERBOARD.limpTime);
    expect(limpWeight(s)).toBe(1);
    run(s, 10);
    expect(tumbleRate(s)).toBeLessThan(early);
    expect(tumbleRate(s)).toBeGreaterThan(0.05);
    expect(Math.hypot(s.axis.x, s.axis.y, s.axis.z)).toBeCloseTo(1, 9);
  });

  it('drifts off the hull when the boat was still', () => {
    const s = createOverboard();
    detach(s, input({ boatVelocity: { x: 0, y: 0, z: 0 }, away: { x: 0, z: 0 } }));
    run(s, 20);
    expect(Math.hypot(s.velocity.x, s.velocity.z)).toBeCloseTo(OVERBOARD.drift, 2);
  });
});
