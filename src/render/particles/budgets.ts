// Per-quality effect budgets (particle pool 16k / 48k / 128k / 256k).
// Physics never depends on these; only how much spray and rain is drawn.
import type { QualityPreset } from '../../app/Scenario';

export interface FxBudget {
  particles: number; // pool capacity
  emitPerFrame: number; // CPU-queued spawns per frame
  spumeCandidates: number; // GPU spume test points per frame at full gale
  rainSplashes: number; // GPU rain splash crowns per frame at full intensity
  rainDrops: number; // rain streaks at full intensity
}

export const FX_BUDGETS: Readonly<Record<QualityPreset, Readonly<FxBudget>>> = {
  low: { particles: 16_384, emitPerFrame: 2_048, spumeCandidates: 1_024, rainSplashes: 64, rainDrops: 8_192 },
  medium: {
    particles: 49_152,
    emitPerFrame: 4_096,
    spumeCandidates: 3_072,
    rainSplashes: 160,
    rainDrops: 16_384,
  },
  high: {
    particles: 131_072,
    emitPerFrame: 8_192,
    spumeCandidates: 8_192,
    rainSplashes: 320,
    rainDrops: 32_768,
  },
  ultra: {
    particles: 262_144,
    emitPerFrame: 16_384,
    spumeCandidates: 16_384,
    rainSplashes: 512,
    rainDrops: 65_536,
  },
};

// A preset's budget with the particle pool set by graphics.particleBudget (the Custom preset);
// spawn and spume rates scale with the pool. The presets' own particle counts give the table as is.
export function fxBudgetFor(quality: QualityPreset, particles?: number): FxBudget {
  const base = FX_BUDGETS[quality];
  if (particles === undefined || !Number.isFinite(particles) || particles === base.particles)
    return { ...base };
  const pool = Math.round(Math.min(1_048_576, Math.max(1_024, particles)));
  const ratio = pool / base.particles;
  return {
    ...base,
    particles: pool,
    emitPerFrame: Math.max(256, Math.round(base.emitPerFrame * ratio)),
    spumeCandidates: Math.max(256, Math.round(base.spumeCandidates * ratio)),
  };
}
