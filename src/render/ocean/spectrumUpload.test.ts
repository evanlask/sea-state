import { describe, expect, it } from 'vite-plus/test';

import { PHYSICS_CASCADES } from '../../sim/ocean/cascades';
import { CpuOcean } from '../../sim/ocean/CpuOcean';
import { type CascadeSpectrum, OceanSpectrumBuilder } from '../../sim/ocean/h0';
import { resolveSpectrum } from '../../sim/ocean/spectrum';
import type { GpuCascade } from './GpuOcean';
import { SpectrumBlend } from './spectrumUpload';

function physicsSpectra(windSpeed: number, choppiness = 1): CascadeSpectrum[] {
  const r = resolveSpectrum({ windSpeed, windFrom: 0.6, fetch: 400_000, choppiness });
  return new OceanSpectrumBuilder(PHYSICS_CASCADES, [], 7).build(r).physics;
}

const gpu = (spectra: readonly CascadeSpectrum[]): GpuCascade[] =>
  spectra.map((s) => ({
    size: s.cascade.resolution,
    patchLength: s.cascade.size,
    h0: s.h0,
    omega: new Float32Array(0),
    choppiness: s.choppiness,
  }));

describe('SpectrumBlend', () => {
  it('keeps exactly the h0 the CPU physics ocean blends, through overlapping transitions', () => {
    const calm = physicsSpectra(5, 0.6);
    const rough = physicsSpectra(16, 1);
    const fair = physicsSpectra(9, 0.8);
    const cpu = new CpuOcean(PHYSICS_CASCADES);
    cpu.setSpectra(calm);
    const blend = new SpectrumBlend(gpu(calm));
    // Rough sea from t = 100 over 60 s, interrupted at 130 by a change to fair over 20 s.
    cpu.setSpectra(rough, 100, 60);
    blend.install(gpu(rough), 100, 60);
    cpu.setSpectra(fair, 130, 20);
    blend.install(gpu(fair), 130, 20);
    PHYSICS_CASCADES.forEach((_, i) => {
      expect(blend.from[i]).toEqual(cpu.fromH0(i));
      expect(blend.to[i]).toEqual(cpu.cascades[i]?.to);
      expect(blend.chopFrom[i]).toBe(cpu.cascades[i]?.chopFrom);
      expect(blend.chopTo[i]).toBe(cpu.cascades[i]?.chopTo);
    });
    for (const t of [120, 130, 137.5, 150, 200]) expect(blend.weight(t)).toBe(cpu.blendWeight(t));
    expect(blend.weight(129)).toBe(0);
    expect(blend.weight(150)).toBe(1);
  });

  it('switches at once without a transition', () => {
    const calm = physicsSpectra(5);
    const rough = physicsSpectra(16);
    const blend = new SpectrumBlend(gpu(calm));
    expect(blend.weight(0)).toBe(1);
    blend.install(gpu(rough));
    expect(blend.weight(0)).toBe(1);
    expect(blend.to[1]).toEqual(rough[1]?.h0);
    expect(blend.from[1]).toEqual(calm[1]?.h0);
  });
});
