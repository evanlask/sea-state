import { describe, expect, it } from 'vite-plus/test';

import {
  addBead,
  clearLensDrops,
  createLensDrops,
  LENS_DROP_CAP,
  type LensDropInputs,
  type LensDrops,
  mergeDrops,
  packLensDrops,
  R_SLIDE_LENS,
  RAIN_R_MAX,
  splash,
  stepLensDrops,
} from './lensDrops';

const frame = (inputs: Partial<LensDropInputs> = {}): LensDropInputs => ({
  dt: 1 / 60,
  mode: 'lens',
  aspect: 16 / 9,
  rain: 0,
  exposure: 0.5,
  gravity: { x: 0, y: 1 },
  spume: 0,
  wash: 0,
  splashes: [],
  underwater: false,
  ...inputs,
});

const run = (state: LensDrops, inputs: Partial<LensDropInputs>, seconds: number): LensDrops => {
  const f = frame(inputs);
  for (let t = 0; t < seconds; t += f.dt) stepLensDrops(state, f);
  return state;
};

// A lens state on glass with nothing landing (step once so the mode is set).
const lens = (seed = 1): LensDrops => run(createLensDrops(seed), {}, 1 / 60);

const beads = (s: LensDrops) => s.drops.slice(0, s.count).filter((d) => !d.sheet);
const totalVolume = (s: LensDrops): number => beads(s).reduce((v, d) => v + d.r ** 3, 0);

describe('lens drops: merging', () => {
  it('coalesces touching beads into one, conserving volume and the centre of mass', () => {
    const s = lens();
    addBead(s, 0.5, 0.5, 0.006);
    addBead(s, 0.509, 0.5, 0.004);
    const before = totalVolume(s);
    mergeDrops(s);
    expect(s.count).toBe(1);
    const d = s.drops[0]!;
    expect(d.r).toBeCloseTo(Math.cbrt(0.006 ** 3 + 0.004 ** 3), 9);
    expect(totalVolume(s)).toBeCloseTo(before, 12);
    const w = 0.004 ** 3 / (0.006 ** 3 + 0.004 ** 3);
    expect(d.x).toBeCloseTo(0.5 + 0.009 * w, 9);
  });

  it('leaves beads apart when there is a gap between them', () => {
    const s = lens();
    addBead(s, 0.5, 0.5, 0.004);
    addBead(s, 0.515, 0.5, 0.004); // 7 mm-equivalent gap
    addBead(s, 1.2, 0.2, 0.01);
    mergeDrops(s);
    expect(s.count).toBe(3);
  });

  it('merges a cluster over a few frames, whatever the bead sizes', () => {
    const s = lens();
    addBead(s, 0.3, 0.3, 0.03); // big enough to make the grid coarse
    for (let i = 0; i < 6; i++) addBead(s, 0.8 + i * 0.003, 0.6 + (i % 2) * 0.002, 0.004);
    const before = totalVolume(s);
    for (let k = 0; k < 6; k++) mergeDrops(s);
    expect(s.count).toBe(2);
    expect(totalVolume(s)).toBeCloseTo(before, 12);
  });
});

describe('lens drops: running', () => {
  it('pins small beads and runs big ones down, faster the bigger they are', () => {
    const s = lens();
    const small = addBead(s, 0.3, 0.2, R_SLIDE_LENS * 0.6)!;
    const mid = addBead(s, 0.9, 0.2, R_SLIDE_LENS * 1.6)!;
    const big = addBead(s, 1.5, 0.2, R_SLIDE_LENS * 2.4)!;
    run(s, {}, 0.25);
    expect(small.y).toBeCloseTo(0.2, 6);
    expect(mid.y).toBeGreaterThan(0.21);
    expect(big.y - 0.2).toBeGreaterThan(mid.y - 0.2);
  });

  it('runs along gravity on the glass, and not at all looking straight down', () => {
    const tilted = lens();
    const d = addBead(tilted, 0.9, 0.5, R_SLIDE_LENS * 2.5)!;
    run(tilted, { gravity: { x: 0.7, y: 0.7 } }, 0.15);
    expect(d.x).toBeGreaterThan(0.92);
    const down = lens();
    const e = addBead(down, 0.9, 0.5, R_SLIDE_LENS * 2.5)!;
    run(down, { gravity: { x: 0, y: 0 } }, 0.3);
    expect(e.y).toBeCloseTo(0.5, 6);
  });

  it('leaves a trail of tiny beads, taking their volume from the runner', () => {
    const s = lens();
    const d = addBead(s, 0.9, 0.05, R_SLIDE_LENS * 2.5)!;
    const r0 = d.r;
    let most = 0;
    const f = frame();
    for (let t = 0; t < 0.4; t += f.dt) {
      stepLensDrops(s, f);
      most = Math.max(most, s.count);
    }
    expect(most).toBeGreaterThan(3);
    expect(d.r).toBeLessThan(r0);
    for (const b of beads(s)) if (b !== d) expect(b.r).toBeLessThan(0.3 * r0);
  });
});

describe('lens drops: rain, splashes and drying', () => {
  it('builds sparse small beads in ordinary rain and more in a downpour', () => {
    const rain = run(lens(), { rain: 0.5, exposure: 0.6 }, 12);
    expect(rain.count).toBeGreaterThan(5);
    expect(rain.count).toBeLessThan(90);
    const mean = beads(rain).reduce((m, d) => m + d.r, 0) / rain.count;
    expect(mean).toBeLessThan(RAIN_R_MAX);
    const storm = run(lens(), { rain: 1, exposure: 1 }, 12);
    expect(storm.count).toBeGreaterThan(rain.count);
  });

  it('never holds more than the cap', () => {
    const s = lens();
    const f = frame({ rain: 1, exposure: 1, spume: 1, wash: 1, splashes: [1, 1] });
    for (let t = 0; t < 5; t += f.dt) {
      stepLensDrops(s, f);
      expect(s.count).toBeLessThanOrEqual(LENS_DROP_CAP);
    }
    expect(s.count).toBeGreaterThan(LENS_DROP_CAP * 0.5);
  });

  it('splashes a burst of mixed sizes and a sheet, which breaks into beads and runs off', () => {
    const s = lens(7);
    splash(s, 0.8, { x: 0.9, y: 0.3 });
    const sheets = s.drops.slice(0, s.count).filter((d) => d.sheet);
    expect(sheets.length).toBeGreaterThanOrEqual(1);
    const radii = beads(s)
      .map((d) => d.r)
      .sort((a, b) => a - b);
    expect(radii.length).toBeGreaterThan(40);
    const median = radii[Math.floor(radii.length / 2)]!;
    expect(radii[radii.length - 1]! / radii[0]!).toBeGreaterThan(4); // a wide spread of sizes
    expect(median).toBeLessThan(0.5 * radii[radii.length - 1]!); // mostly small
    run(s, {}, 1.2);
    expect(s.drops.slice(0, s.count).some((d) => d.sheet)).toBe(false);
  });

  it('splashes a light hit with beads only', () => {
    const s = lens();
    splash(s, 0.1);
    expect(s.count).toBeGreaterThan(5);
    expect(s.drops.slice(0, s.count).some((d) => d.sheet)).toBe(false);
  });

  it('clears within a few seconds once the rain and spray stop', () => {
    const s = run(lens(), { rain: 0.8, exposure: 1 }, 10);
    splash(s, 1);
    const wet = s.count;
    expect(wet).toBeGreaterThan(100);
    run(s, {}, 3);
    expect(s.count).toBeLessThan(wet * 0.6);
    run(s, {}, 5);
    expect(s.count).toBe(0);
  });

  it('starts dry on a different surface or with no glass, and streams off after surfacing', () => {
    const s = run(lens(), { rain: 1, exposure: 1 }, 3);
    expect(s.count).toBeGreaterThan(0);
    run(s, { mode: 'window', rain: 0 }, 1 / 60);
    expect(s.count).toBe(0);
    run(s, { rain: 1, exposure: 1 }, 2);
    run(s, { mode: 'none' }, 1 / 60);
    expect(s.count).toBe(0);
    run(s, { underwater: true }, 1);
    expect(s.count).toBe(0);
    run(s, {}, 1 / 60);
    expect(s.drops.slice(0, s.count).filter((d) => d.sheet).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps dry glass perfectly dry: no rain, no spray, no drops, ever', () => {
    // A ship's bridge windows in fair weather, and an external lens; a one-frame dip below the
    // surface (a probe glitch, a wave crest) leaves nothing either.
    for (const mode of ['window', 'lens'] as const) {
      const s = createLensDrops(5);
      run(s, { mode, underwater: true }, 1 / 60);
      const f = frame({ mode, exposure: 0.08 });
      for (let t = 0; t < 60; t += f.dt) {
        stepLensDrops(s, f);
        expect(s.count).toBe(0);
      }
    }
    // Windows are never submerged: no surfacing splash however long the flag says so.
    const window = run(createLensDrops(), { mode: 'window', underwater: true }, 2);
    run(window, { mode: 'window' }, 1 / 60);
    expect(window.count).toBe(0);
  });

  it('dries the glass completely once the rain stops', () => {
    const s = run(lens(), { mode: 'window', rain: 1, exposure: 0.6 }, 15);
    expect(s.count).toBeGreaterThan(50);
    run(s, { mode: 'window' }, 12);
    expect(s.count).toBe(0);
  });
});

describe('lens drops: upload', () => {
  it('packs every live drop, sheets stretched and fading', () => {
    const s = lens(3);
    splash(s, 1);
    const shape = new Float32Array(LENS_DROP_CAP * 4);
    const look = new Float32Array(LENS_DROP_CAP * 4);
    const n = packLensDrops(s, shape, look);
    expect(n).toBe(s.count);
    const i = s.drops.findIndex((d) => d.sheet);
    expect(shape[i * 4 + 3]).toBeGreaterThan(2);
    expect(look[i * 4 + 2]).toBeGreaterThan(0);
    clearLensDrops(s);
    expect(packLensDrops(s, shape, look)).toBe(0);
  });
});
