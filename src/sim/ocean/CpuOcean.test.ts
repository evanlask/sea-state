import { describe, expect, it } from 'vite-plus/test';

import { type CascadeConfig, PHYSICS_CASCADES, signedMode } from './cascades';
import {
  CH_DX,
  CH_DY,
  CH_DZ,
  type CpuCascade,
  CpuOcean,
  FIELD_CHANNELS,
  OCEAN_UPDATE_INTERVAL,
  TEXEL_STRIDE,
} from './CpuOcean';
import { type CascadeSpectrum, OceanSpectrumBuilder } from './h0';
import { resolveSpectrum, T_REPEAT } from './spectrum';

function physicsSpectra(windSpeed: number, choppiness = 1, seed = 1): CascadeSpectrum[] {
  const r = resolveSpectrum({ windSpeed, windFrom: 0.6, fetch: 400_000, choppiness });
  return new OceanSpectrumBuilder(PHYSICS_CASCADES, [], seed).build(r).physics;
}

// Displacement by direct summation over modes: Re Σ D(k) e^{ik·x} at grid point (col, row).
function directSum(
  c: CpuCascade,
  col: number,
  row: number,
  t: number,
  lambda: number,
): [number, number, number] {
  const n = c.n;
  const dk = (2 * Math.PI) / c.size;
  const x = (col * c.size) / n;
  const z = (row * c.size) / n;
  const tr = t % T_REPEAT;
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (let i = 0; i < c.active.length; i++) {
    const p = c.active[i] as number;
    const m = signedMode(p % n, n);
    const nz = signedMode(Math.floor(p / n), n);
    const h0 = c.to;
    const w = (c.omega[i] as number) * tr;
    const hr =
      (h0[4 * p] ?? 0) * Math.cos(w) +
      (h0[4 * p + 1] ?? 0) * Math.sin(w) +
      (h0[4 * p + 2] ?? 0) * Math.cos(w) -
      (h0[4 * p + 3] ?? 0) * Math.sin(w);
    const hi =
      (h0[4 * p + 1] ?? 0) * Math.cos(w) -
      (h0[4 * p] ?? 0) * Math.sin(w) +
      (h0[4 * p + 2] ?? 0) * Math.sin(w) +
      (h0[4 * p + 3] ?? 0) * Math.cos(w);
    const phase = m * dk * x + nz * dk * z;
    const cs = Math.cos(phase);
    const sn = Math.sin(phase);
    const re = hr * cs - hi * sn; // Re(h e^{ik·x})
    const im = hr * sn + hi * cs; // Im(h e^{ik·x})
    dy += re;
    // Re(i·λ·k̂·h·e^{ik·x}) = −λ·k̂·Im(h e^{ik·x})
    dx -= lambda * (c.kxHat[i] as number) * im;
    dz -= lambda * (c.kzHat[i] as number) * im;
  }
  return [dx, dy, dz];
}

describe('CpuOcean', () => {
  it('matches a direct modal sum for every channel (packing, signs, index mapping)', () => {
    const ocean = new CpuOcean(PHYSICS_CASCADES);
    const spectra = physicsSpectra(12, 1.2);
    ocean.setSpectra(spectra);
    const t = 37.5;
    ocean.prepare(t);
    const slot = ocean.slotOf(ocean.sampleIndex(t));
    for (let ci = 0; ci < ocean.cascades.length; ci++) {
      const c = ocean.cascades[ci] as CpuCascade;
      const lambda = spectra[ci]?.choppiness ?? 0;
      let scale = 0;
      let maxErr = 0;
      for (const [col, row] of [
        [0, 0],
        [17, 91],
        [127, 3],
        [64, 64],
      ] as const) {
        const ref = directSum(c, col, row, t, lambda);
        const o = (row * c.n + col) * TEXEL_STRIDE + slot * FIELD_CHANNELS;
        const got = [c.field[o + CH_DX] ?? 0, c.field[o + CH_DY] ?? 0, c.field[o + CH_DZ] ?? 0];
        for (let j = 0; j < 3; j++) {
          scale = Math.max(scale, Math.abs(ref[j] ?? 0));
          maxErr = Math.max(maxErr, Math.abs((got[j] ?? 0) - (ref[j] ?? 0)));
        }
      }
      expect(scale, `cascade ${ci}`).toBeGreaterThan(0);
      expect(maxErr / scale, `cascade ${ci}`).toBeLessThan(1e-4);
    }
  });

  it('repeats exactly after T_REPEAT', () => {
    const ocean = new CpuOcean(PHYSICS_CASCADES);
    ocean.setSpectra(physicsSpectra(10));
    ocean.prepare(12.3);
    const before = ocean.cascades.map((c) => c.field.slice());
    ocean.prepare(12.3 + T_REPEAT);
    ocean.cascades.forEach((c, i) => expect(c.field).toEqual(before[i]));
    // And differs in between.
    ocean.prepare(12.3 + T_REPEAT / 2);
    expect(ocean.cascades[1]?.field).not.toEqual(before[1]);
    // Several full-cascade FFT updates: give a loaded machine room.
  }, 20_000);

  it('only recomputes when time leaves the bracket', () => {
    const ocean = new CpuOcean(PHYSICS_CASCADES);
    ocean.setSpectra(physicsSpectra(8));
    ocean.prepare(1);
    const count = ocean.updateCount;
    ocean.prepare(1 + OCEAN_UPDATE_INTERVAL / 2);
    expect(ocean.updateCount).toBe(count);
    ocean.prepare(1 + OCEAN_UPDATE_INTERVAL);
    expect(ocean.updateCount).toBe(count + 1);
  });

  it('blends between spectra over a transition and freezes it when restarted', () => {
    const calm = physicsSpectra(5);
    const rough = physicsSpectra(15);
    const ocean = new CpuOcean(PHYSICS_CASCADES);
    ocean.setSpectra(calm);
    ocean.setSpectra(rough, 100, 10);
    expect(ocean.blendWeight(99)).toBe(0);
    expect(ocean.blendWeight(110)).toBe(1);
    const reference = new CpuOcean(PHYSICS_CASCADES);
    reference.setSpectra(rough);
    ocean.prepare(120);
    reference.prepare(120);
    expect(ocean.cascades[1]?.field).toEqual(reference.cascades[1]?.field);
    // Restarting halfway freezes the half-blended h0 as the new starting point.
    const again = new CpuOcean(PHYSICS_CASCADES);
    again.setSpectra(calm);
    again.setSpectra(rough, 100, 10);
    again.setSpectra(calm, 105, 10);
    const c = PHYSICS_CASCADES[1] as CascadeConfig;
    const texel = 4 * (5 * c.resolution + 7);
    const mid = ((calm[1]?.h0[texel] ?? 0) + (rough[1]?.h0[texel] ?? 0)) / 2;
    expect(again.fromH0(1)[texel]).toBeCloseTo(mid, 6);
  });

  it('updates the four physics cascades in a few milliseconds', () => {
    const ocean = new CpuOcean(PHYSICS_CASCADES);
    ocean.setSpectra(physicsSpectra(12));
    for (let i = 0; i < 10; i++) ocean.prepare(i * OCEAN_UPDATE_INTERVAL); // warm up
    const runs = 30;
    const started = performance.now();
    for (let i = 0; i < runs; i++) ocean.prepare((100 + i) * OCEAN_UPDATE_INTERVAL);
    const ms = (performance.now() - started) / runs;
    console.log(`CpuOcean update (4 cascades, 6 IFFTs of 128²): ${ms.toFixed(2)} ms`);
    expect(ms).toBeLessThan(15);
  });
});
