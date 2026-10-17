import { describe, expect, it } from 'vite-plus/test';

import { type CascadeConfig, modeIndex, PHYSICS_CASCADES, visualCascades } from './cascades';
import { blendH0, H0Generator, OceanSpectrumBuilder, transitionBlend } from './h0';
import { resolveSpectrum } from './spectrum';

const spectrum = resolveSpectrum({ windSpeed: 11, windFrom: 0.7, fetch: 400_000 });

function texel(c: CascadeConfig, m: number, n: number): number {
  return modeIndex(n, c.resolution) * c.resolution + modeIndex(m, c.resolution);
}

describe('h0', () => {
  it('is deterministic for a seed and changes with it', () => {
    const c = PHYSICS_CASCADES[1] as CascadeConfig;
    const a = new H0Generator(c, 42).build(spectrum).h0;
    const b = new H0Generator(c, 42).build(spectrum).h0;
    const d = new H0Generator(c, 43).build(spectrum).h0;
    expect(a).toEqual(b);
    expect(a).not.toEqual(d);
  });

  it('does not depend on N for modes both grids hold', () => {
    const small: CascadeConfig = {
      index: 4,
      kind: 'visual',
      size: 3,
      resolution: 64,
      kMin: 5,
      kMax: 60,
      bandRadius: 32,
    };
    const large: CascadeConfig = { ...small, resolution: 128 };
    const a = new H0Generator(small, 9).build(spectrum).h0;
    const b = new H0Generator(large, 9).build(spectrum).h0;
    let compared = 0;
    for (let m = -31; m < 32; m++) {
      for (let n = -31; n < 32; n++) {
        const ia = 4 * texel(small, m, n);
        const ib = 4 * texel(large, m, n);
        for (let j = 0; j < 4; j++) expect(a[ia + j]).toBe(b[ib + j]);
        if (a[ia] !== 0) compared++;
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('stores conj(h0(−k)) beside h0(k) and zeros modes outside the annulus', () => {
    const c = PHYSICS_CASCADES[2] as CascadeConfig;
    const h0 = new H0Generator(c, 1).build(spectrum).h0;
    for (const [m, n] of [
      [7, -3],
      [-12, 20],
      [0, 6],
    ] as const) {
      const p = 4 * texel(c, m, n);
      const q = 4 * texel(c, -m, -n);
      expect(h0[p + 2]).toBe(h0[q]);
      expect(h0[p + 3]).toBe(-(h0[q + 1] ?? 0));
    }
    // DC, inside kMin and beyond kMax.
    for (const [m, n] of [
      [0, 0],
      [2, 2],
      [40, 0],
      [25, 25],
    ] as const) {
      const p = 4 * texel(c, m, n);
      expect([h0[p], h0[p + 1], h0[p + 2], h0[p + 3]]).toEqual([0, 0, 0, 0]);
    }
  });

  it('rescales amplitudes with the weather but keeps every phase', () => {
    const c = PHYSICS_CASCADES[1] as CascadeConfig;
    const generator = new H0Generator(c, 5);
    const calm = generator.build(resolveSpectrum({ windSpeed: 6, windFrom: 0, fetch: 400_000 })).h0;
    const rough = generator.build(resolveSpectrum({ windSpeed: 18, windFrom: 0, fetch: 400_000 })).h0.slice();
    let checked = 0;
    for (let i = 0; i < calm.length; i += 4) {
      const a = Math.atan2(calm[i + 1] ?? 0, calm[i] ?? 0);
      const b = Math.atan2(rough[i + 1] ?? 0, rough[i] ?? 0);
      if ((calm[i] ?? 0) === 0 || Math.hypot(calm[i] ?? 0, calm[i + 1] ?? 0) < 1e-6) continue;
      expect(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))).toBeLessThan(1e-5);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('captures the requested Hs across all cascades, with physics holding most of the energy', () => {
    // 'high' reaches 1.5 cm; the energy beyond is far below the tolerance.
    const builder = new OceanSpectrumBuilder(PHYSICS_CASCADES, visualCascades('high'), 1);
    for (const windSpeed of [3, 7, 12, 20, 30]) {
      const r = resolveSpectrum({ windSpeed, windFrom: 1.1, fetch: 400_000 });
      const spectra = builder.build(r);
      let physics = 0;
      for (const c of spectra.physics) physics += c.m0;
      let visual = 0;
      for (const c of spectra.visual) visual += c.m0;
      const hs = 4 * Math.sqrt(physics + visual);
      expect(Math.abs(hs / r.seaHs - 1), `U10 ${windSpeed}`).toBeLessThan(0.05);
      expect(physics / (physics + visual), `U10 ${windSpeed}`).toBeGreaterThan(0.95);
    }
  });

  it('realizes about the expected variance', () => {
    const c = PHYSICS_CASCADES[1] as CascadeConfig;
    const result = new H0Generator(c, 3).build(spectrum);
    let realized = 0;
    for (let i = 0; i < result.h0.length; i += 4) {
      realized += (result.h0[i] ?? 0) ** 2 + (result.h0[i + 1] ?? 0) ** 2;
      realized += (result.h0[i + 2] ?? 0) ** 2 + (result.h0[i + 3] ?? 0) ** 2;
    }
    // Every texel holds h0(k) and h0(−k), so the sum counts each mode twice: E = 2 · Σ ½ S Δk² = m0.
    expect(realized / result.m0).toBeGreaterThan(0.8);
    expect(realized / result.m0).toBeLessThan(1.2);
  });

  it('caps choppiness so physics stays foldless and leaves visual a share', () => {
    const r = resolveSpectrum({ windSpeed: 25, windFrom: 0, fetch: 400_000, choppiness: 3 });
    const spectra = new OceanSpectrumBuilder(PHYSICS_CASCADES, visualCascades('high'), 2).build(r);
    expect(spectra.choppinessPhysics).toBeLessThan(3);
    expect(spectra.choppinessPhysics).toBeGreaterThan(0.5);
    expect(spectra.choppinessVisual).toBeGreaterThan(0);
    for (const c of spectra.physics) expect(c.choppiness).toBe(spectra.choppinessPhysics);
    // A gentle sea is not capped.
    const gentle = new OceanSpectrumBuilder(PHYSICS_CASCADES, [], 2).build(
      resolveSpectrum({ windSpeed: 5, windFrom: 0, fetch: 400_000, choppiness: 1 }),
    );
    expect(gentle.choppinessPhysics).toBe(1);
  });
});

describe('transitions', () => {
  it('never returns NaN for a NaN duration or time', () => {
    expect(transitionBlend(10, Number.NaN, 12)).toBe(1);
    expect(transitionBlend(10, Number.NaN, 9)).toBe(0);
    expect(transitionBlend(10, 4, Number.NaN)).toBe(0);
  });

  it('blends with a smoothstep over the window', () => {
    expect(transitionBlend(10, 4, 9)).toBe(0);
    expect(transitionBlend(10, 4, 10)).toBe(0);
    expect(transitionBlend(10, 4, 12)).toBeCloseTo(0.5, 12);
    expect(transitionBlend(10, 4, 14)).toBe(1);
    expect(transitionBlend(10, 0, 10)).toBe(1);
    expect(transitionBlend(10, 0, 9.9)).toBe(0);
    let last = 0;
    for (let t = 10; t <= 14; t += 0.1) {
      const w = transitionBlend(10, 4, t);
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it('blends h0 element-wise', () => {
    const a = new Float32Array([0, 2, -4]);
    const b = new Float32Array([1, 2, 4]);
    expect(Array.from(blendH0(new Float32Array(3), a, b, 0.25))).toEqual([0.25, 2, -2]);
  });
});
