// Cloud quality tiers (resolution, march steps, env/shadow budgets) and the buffer sizes derived
// from them. Pure TS.

import type { QualityPreset } from '../../app/Scenario';
import type { CloudResolution } from '../../settings/schema';

export interface CloudQuality {
  resolution: number; // output buffer scale per axis (0.25 or 0.5 of the drawing buffer)
  // Temporal upscale factor: each frame marches one pixel of every k×k block and reprojection
  // fills the rest (1 = march every output pixel every frame).
  upscale: 1 | 2;
  steps: number; // primary samples across the cloud shell
  lightSteps: number; // cone samples toward the sun/moon
  detail: boolean; // high-frequency erosion noise
  envSize: readonly [number, number]; // environment panorama (azimuth × elevation)
  envSteps: number;
  envLightSteps: number;
  envSlices: number; // the panorama refreshes 1/envSlices of its columns per frame
  // Cloud-shadow map texels per side over SHADOW_EXTENT (32 km): 62.5 m texels on High and Ultra,
  // 125 m on Medium, ~170 m on Low (a binomial blur then softens the edges, CloudSystem).
  shadowSize: number;
  shadowSteps: number;
  // The shadow map re-marches 1/shadowSlices of its rows per frame (size must be a multiple of
  // 8 × shadowSlices, whole workgroups of marched rows).
  shadowSlices: number;
  historyWeight: number; // weight of the reprojected history for freshly marched pixels
  varianceGamma: number; // neighbourhood clip width in standard deviations
}

export const CLOUD_QUALITY: Readonly<Record<QualityPreset, CloudQuality>> = {
  low: {
    resolution: 0.25,
    upscale: 1,
    steps: 48,
    lightSteps: 3,
    detail: false,
    envSize: [192, 48],
    envSteps: 32,
    envLightSteps: 3,
    envSlices: 8,
    shadowSize: 192,
    shadowSteps: 12,
    shadowSlices: 6,
    historyWeight: 0.85,
    varianceGamma: 1.25,
  },
  medium: {
    resolution: 0.25,
    upscale: 1,
    steps: 64,
    lightSteps: 5,
    detail: true,
    envSize: [256, 64],
    envSteps: 40,
    envLightSteps: 3,
    envSlices: 6,
    shadowSize: 256,
    shadowSteps: 16,
    shadowSlices: 4,
    historyWeight: 0.88,
    varianceGamma: 1.25,
  },
  high: {
    resolution: 0.5,
    upscale: 2,
    steps: 96,
    lightSteps: 6,
    detail: true,
    envSize: [256, 64],
    envSteps: 48,
    envLightSteps: 4,
    envSlices: 4,
    shadowSize: 512,
    shadowSteps: 20,
    shadowSlices: 8,
    historyWeight: 0.8,
    varianceGamma: 1.6,
  },
  ultra: {
    resolution: 0.5,
    upscale: 1,
    steps: 128,
    lightSteps: 6,
    detail: true,
    envSize: [384, 96],
    envSteps: 64,
    envLightSteps: 4,
    envSlices: 4,
    shadowSize: 512,
    shadowSteps: 24,
    shadowSlices: 8,
    historyWeight: 0.88,
    varianceGamma: 1.25,
  },
};

export interface CloudSettingsOverride {
  resolution: CloudResolution;
  steps: number;
}

// Preset tier, optionally overridden by the player's custom graphics settings.
export function cloudQualityFor(preset: QualityPreset, override?: CloudSettingsOverride): CloudQuality {
  const base = CLOUD_QUALITY[preset];
  if (!override) return base;
  const resolution = override.resolution === 'half' ? 0.5 : 0.25;
  const steps = Math.round(Math.min(256, Math.max(16, override.steps)));
  // Half resolution at a step count past the High budget stops upscaling (Ultra-like cost).
  const upscale: 1 | 2 = resolution === 0.5 && steps <= 96 ? 2 : 1;
  const tier = upscale === 2 ? CLOUD_QUALITY.high : base;
  return {
    ...base,
    resolution,
    steps,
    upscale,
    historyWeight: tier.historyWeight,
    varianceGamma: tier.varianceGamma,
  };
}

export interface CloudBufferSizes {
  output: readonly [number, number]; // resolved, temporally stable buffer the sky samples
  march: readonly [number, number]; // pixels raymarched per frame
}

export function cloudBufferSizes(width: number, height: number, quality: CloudQuality): CloudBufferSizes {
  const ow = Math.max(8, Math.ceil(width * quality.resolution));
  const oh = Math.max(8, Math.ceil(height * quality.resolution));
  const k = quality.upscale;
  return { output: [ow, oh], march: [Math.ceil(ow / k), Math.ceil(oh / k)] };
}
