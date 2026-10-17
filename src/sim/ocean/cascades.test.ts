import { describe, expect, it } from 'vite-plus/test';

import {
  type CascadeConfig,
  modeIndex,
  modeInCascade,
  type OceanQuality,
  PHYSICS_BAND_RADIUS,
  PHYSICS_CASCADES,
  PHYSICS_K_MAX,
  signedMode,
  VISUAL_QUALITY,
  visualCascades,
} from './cascades';

const QUALITIES: OceanQuality[] = ['low', 'medium', 'high', 'ultra'];

function modesOf(cascade: CascadeConfig): [number, number][] {
  const n = cascade.resolution;
  const modes: [number, number][] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const m = signedMode(col, n);
      const nz = signedMode(row, n);
      if (modeInCascade(cascade, m, nz)) modes.push([m, nz]);
    }
  }
  return modes;
}

describe('cascades', () => {
  it('has four physics cascades of N = 128 with the planned sizes', () => {
    expect(PHYSICS_CASCADES.map((c) => c.size)).toEqual([4096, 800, 128, 20]);
    for (const c of PHYSICS_CASCADES) expect(c.resolution).toBe(128);
    // The 20 m cascade stops at λ = 0.625 m.
    expect((2 * Math.PI) / PHYSICS_K_MAX).toBeCloseTo(0.625, 9);
  });

  it('tiles k-space with disjoint, gap-free annuli for every quality', () => {
    for (const quality of QUALITIES) {
      const all = [...PHYSICS_CASCADES, ...visualCascades(quality)];
      expect(all[0]?.kMin).toBe((2 * Math.PI) / 4096);
      for (let i = 0; i < all.length; i++) {
        const c = all[i] as CascadeConfig;
        expect(c.index).toBe(i);
        expect(c.kMax).toBeGreaterThan(c.kMin);
        if (i > 0) expect(c.kMin).toBe(all[i - 1]?.kMax);
      }
      expect(visualCascades(quality)[0]?.kMin).toBe(PHYSICS_K_MAX);
    }
  });

  it('band-limits physics cascades to |m|, |n| ≤ 32 and keeps every mode partner representable', () => {
    for (const c of PHYSICS_CASCADES) {
      const modes = modesOf(c);
      expect(modes.length).toBeGreaterThan(2500);
      let maxIndex = 0;
      let unpaired = 0;
      for (const [m, n] of modes) {
        maxIndex = Math.max(maxIndex, Math.abs(m), Math.abs(n));
        if (!modeInCascade(c, -m, -n)) unpaired++;
      }
      expect(maxIndex).toBeLessThanOrEqual(PHYSICS_BAND_RADIUS);
      expect(unpaired).toBe(0);
    }
  });

  it('keeps visual cascades below Nyquist with several modes across the inner radius', () => {
    for (const quality of QUALITIES) {
      for (const c of visualCascades(quality)) {
        let maxIndex = 0;
        for (const [m, n] of modesOf(c)) maxIndex = Math.max(maxIndex, Math.abs(m), Math.abs(n));
        expect(maxIndex).toBeLessThan(c.resolution / 2);
        expect((c.kMin * c.size) / (2 * Math.PI)).toBeGreaterThanOrEqual(4.9);
      }
    }
    const end = visualCascades('ultra').at(-1) as CascadeConfig;
    expect((2 * Math.PI) / end.kMax).toBeCloseTo(0.01, 6);
    // Low and medium share the patch, so their common modes are the same waves.
    expect(visualCascades('low')[0]?.size).toBeCloseTo(visualCascades('medium')[0]?.size ?? 0, 9);
  });

  it('builds every detail layout the settings offer, matching the tiers where they coincide', () => {
    const end = (count: number, resolution: number): number =>
      (visualCascades({ count, resolution }).at(-1) as CascadeConfig).kMax;
    for (const count of [1, 2]) {
      for (const resolution of [64, 128, 256, 512]) {
        const visual = visualCascades({ count, resolution });
        expect(visual).toHaveLength(count);
        expect(visual[0]?.kMin).toBe(PHYSICS_K_MAX);
        visual.forEach((c, i) => {
          expect(c.resolution).toBe(resolution);
          expect(c.index).toBe(PHYSICS_CASCADES.length + i);
          if (i > 0) expect(c.kMin).toBe(visual[i - 1]?.kMax);
          let maxIndex = 0;
          for (const [m, n] of modesOf(c)) maxIndex = Math.max(maxIndex, Math.abs(m), Math.abs(n));
          expect(maxIndex).toBeLessThan(c.resolution / 2);
          expect((c.kMin * c.size) / (2 * Math.PI)).toBeGreaterThanOrEqual(4.9);
        });
        // A bigger FFT always reaches shorter waves.
        if (resolution > 64) expect(end(count, resolution)).toBeGreaterThan(end(count, resolution / 2));
      }
    }
    for (const quality of QUALITIES) {
      const { count, resolution } = VISUAL_QUALITY[quality];
      expect(visualCascades({ count, resolution })).toEqual(visualCascades(quality));
    }
    // GpuFft stops at 512.
    expect(visualCascades({ count: 2, resolution: 1024 })[0]?.resolution).toBe(512);
  });

  it('stores signed modes in FFT order', () => {
    expect(modeIndex(0, 128)).toBe(0);
    expect(modeIndex(5, 128)).toBe(5);
    expect(modeIndex(-1, 128)).toBe(127);
    expect(modeIndex(-64, 128)).toBe(64);
    for (let i = 0; i < 128; i++) expect(modeIndex(signedMode(i, 128), 128)).toBe(i);
  });
});
