import { describe, expect, it } from 'vite-plus/test';

import { DRY_SECONDS, stepWetness, wetnessTarget } from './wetness';

const run = (start: number, target: number, seconds: number, dt = 1 / 60): number => {
  let w = start;
  for (let t = 0; t < seconds; t += dt) w = stepWetness(w, target, dt);
  return w;
};

describe('boat wetness', () => {
  it('follows rain and spray', () => {
    expect(wetnessTarget(0, 0)).toBe(0);
    expect(wetnessTarget(0.2, 0)).toBeGreaterThan(0.5); // drizzle wets the decks
    expect(wetnessTarget(1, 0)).toBe(1);
    expect(wetnessTarget(0, 0.7)).toBeCloseTo(0.7);
  });

  it('soaks in within seconds and dries over a minute or two', () => {
    expect(run(0, 1, 10)).toBeGreaterThan(0.9);
    expect(run(1, 0, 30)).toBeGreaterThan(0.5);
    expect(run(1, 0, DRY_SECONDS + 1)).toBe(0);
    expect(DRY_SECONDS).toBeGreaterThanOrEqual(60);
    expect(DRY_SECONDS).toBeLessThanOrEqual(120);
  });

  it('dries only down to what the weather keeps wet', () => {
    expect(run(1, 0.4, 200)).toBeCloseTo(0.4);
    expect(stepWetness(0.5, 0.5, 1)).toBe(0.5);
  });
});
