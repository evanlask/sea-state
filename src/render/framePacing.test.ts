import { describe, expect, it } from 'vite-plus/test';

import { DynamicResolution, dynamicTargetFps, FrameLimiter } from './framePacing';

// Feeds `seconds` of frames; `frame(scale, t)` returns the rAF interval for a frame at that scale.
function run(
  controller: DynamicResolution,
  start: number,
  seconds: number,
  frame: (scale: number, t: number) => number,
): { end: number; changes: number[] } {
  const changes: number[] = [];
  let now = start;
  while (now < start + seconds * 1000) {
    const frameMs = frame(controller.scale, now);
    now += frameMs;
    const next = controller.update({ now, frameMs });
    if (next !== null) changes.push(next);
  }
  return { end: now, changes };
}

// A 60 Hz display: a frame that needs `ms` of work shows at the next vsync.
const vsync = (ms: number): number => Math.ceil(ms / 16.667 - 1e-9) * 16.667;

describe('DynamicResolution', () => {
  it('starts at the preset scale and leaves a frame on budget alone', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    expect(c.scale).toBe(1);
    expect(run(c, 0, 20, () => 16.667).changes).toEqual([]);
  });

  it('ignores hitches: shader builds and the odd long frame never lower the resolution', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    // A 3 s freeze (a settings change rebuilding pipelines), a 600 ms one, and a 40 ms frame every
    // half second (GC, a HUD write).
    let n = 0;
    const { changes } = run(c, 0, 30, (_s, t) => {
      n++;
      if (Math.abs(t - 5000) < 9) return 3000;
      if (Math.abs(t - 15000) < 9) return 600;
      return n % 30 === 0 ? 40 : 16.667;
    });
    expect(changes).toEqual([]);
    expect(c.scale).toBe(1);
  });

  it('steps down under sustained load until the frame fits, never below the minimum', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1, minScale: 0.5 });
    // Work proportional to pixels: 25 ms at full scale (every frame misses a vsync).
    const { changes } = run(c, 0, 30, (s) => vsync(25 * s * s));
    expect(changes.length).toBeGreaterThan(0);
    expect(25 * c.scale * c.scale).toBeLessThanOrEqual(16.667 * LATE_OK);
    expect(c.scale).toBeGreaterThanOrEqual(0.5);
  });

  it('defaults to a floor of 0.7: below that a lower preset looks better', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    run(c, 0, 60, () => 33.33);
    expect(c.scale).toBeCloseTo(0.7);
  });

  it('climbs back when the load goes away (within a minute, after its failed probes are forgotten)', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    run(c, 0, 20, (s) => vsync(25 * s * s));
    expect(c.scale).toBeLessThan(1);
    run(c, 20_000, 60, () => 16.667);
    expect(c.scale).toBe(1);
  });

  it('backs off after failed probes but tries again later', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    // Fits at 0.8 but not at 0.85 or above.
    const heavy = (s: number): number => vsync(s > 0.82 ? 25 : 15);
    run(c, 0, 20, heavy);
    expect(c.scale).toBeLessThan(0.85);
    const { changes } = run(c, 20_000, 60, heavy);
    // Probes keep happening, ever more rarely, and it never settles above what fits.
    expect(changes.filter((x) => x > 0.82).length).toBeGreaterThan(0);
    expect(changes.filter((x) => x > 0.82).length).toBeLessThan(8);
    expect(c.scale).toBeLessThanOrEqual(0.85);
  });

  it('respects a lowered maximum (the player changed the render scale)', () => {
    const c = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    c.configure({ maxScale: 0.8 });
    expect(c.scale).toBe(0.8);
    run(c, 0, 20, () => 16.667);
    expect(c.scale).toBe(0.8);
  });
});

const LATE_OK = 1.25;

describe('FrameLimiter', () => {
  const count = (limiter: FrameLimiter, hz: number, seconds: number): number => {
    let n = 0;
    for (let i = 0; i < hz * seconds; i++) {
      const jitter = (i % 3) * 0.3 - 0.3;
      if (limiter.shouldRender((i * 1000) / hz + jitter)) n++;
    }
    return n;
  };

  it('renders every frame when uncapped', () => {
    expect(count(new FrameLimiter(0), 120, 2)).toBe(240);
  });

  it('caps a 120 Hz display at 60 and 30', () => {
    expect(count(new FrameLimiter(60), 120, 2)).toBeGreaterThanOrEqual(118);
    expect(count(new FrameLimiter(60), 120, 2)).toBeLessThanOrEqual(121);
    expect(Math.abs(count(new FrameLimiter(30), 120, 2) - 60)).toBeLessThanOrEqual(1);
  });

  it('does not halve a 60 Hz display capped at 60', () => {
    expect(count(new FrameLimiter(60), 60, 2)).toBeGreaterThanOrEqual(119);
  });

  it('averages an uneven ratio (40 on 144 Hz)', () => {
    expect(Math.abs(count(new FrameLimiter(40), 144, 5) - 200)).toBeLessThanOrEqual(3);
  });
});

describe('dynamicTargetFps', () => {
  it('aims no higher than the FPS cap', () => {
    expect(dynamicTargetFps(60, 0)).toBe(60);
    expect(dynamicTargetFps(60, 120)).toBe(60);
    expect(dynamicTargetFps(60, 30)).toBe(30);
  });

  it('keeps full resolution at a 30 cap that the GPU meets', () => {
    // A 30 FPS cap on a 60 Hz display: every frame lands 33 ms apart. Against the raw 60 target all
    // of them would be late.
    const c = new DynamicResolution({ targetFps: dynamicTargetFps(60, 30), maxScale: 1 });
    expect(run(c, 0, 20, () => 33.333).changes).toEqual([]);
    const uncapped = new DynamicResolution({ targetFps: 60, maxScale: 1 });
    expect(run(uncapped, 0, 20, () => 33.333).changes.length).toBeGreaterThan(0);
  });
});
