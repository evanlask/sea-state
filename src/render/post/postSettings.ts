// Graphics settings → post-processing plan (pure, Node-testable): which anti-aliasing node runs,
// whether the scene pass writes motion vectors, and the parameters of every optional effect
// (bloom, GTAO, sun flare, lens droplets, depth of field, ocean SSR) per quality
// preset. An effect that is off is `null`/`false` here and never enters the node graph.

import type { QualityPreset } from '../../app/Scenario';
import type { AmbientOcclusion, AntiAliasing, GraphicsSettings, ReflectionMode } from '../../settings/schema';

export type AntiAliasingMode = AntiAliasing | 'off';

export interface PostSettings {
  aa: AntiAliasingMode;
  bloom: boolean;
  ao?: AmbientOcclusion; // default 'off'
  lensDroplets?: boolean; // default false
  reflections?: ReflectionMode; // ocean SSR (OceanMaterial); default 'env'
}

export interface BloomParams {
  strength: number;
  radius: number; // 0..1, three's mip blend
  // Pre-exposed luminance where bloom starts. The image is pre-exposed so ~1 is diffuse white:
  // only glints, the sun and lamps (≫ 1) bloom, never bright foam or sky.
  threshold: number;
}

interface AoParams {
  resolutionScale: number; // 0.5 (half) or 1 (full)
  samples: number; // GTAO samples per pixel (baked into the shader)
  radius: number; // m, view space
  thickness: number; // m, depth difference still counted as an occluder
  intensity: number; // 0..1 blend toward the raw AO
}

interface FlareParams {
  strength: number; // overall gain (the flare is pre-exposed like the image)
  ghosts: number; // ghost discs along the sun → centre axis
}

export interface SsrParams {
  steps: number; // march samples along the clipped screen-space ray
  refine: number; // binary-search iterations after a hit
  maxDistance: number; // m, longest reflected ray
  resolutionScale: number; // of the trace pass (OceanReflections.ts): 0.5 (half) or 1 (full)
}

export interface PostPlan {
  aa: AntiAliasingMode;
  motionVectors: boolean; // scene pass writes velocity (TRAA, GTAO's ocean mask)
  // ssr: the scene pass also writes the sea's reflection rays (OceanReflections.ts)
  bloom: BloomParams | null;
  ao: AoParams | null;
  flare: FlareParams | null;
  droplets: boolean;
  ssr: SsrParams | null;
}

// Kept low and tight: at night the frame is mostly near-black, so a wide or strong bloom off a
// flood-lit deck or a cabin lamp spreads into a grey veil over everything.
export const BLOOM_BY_QUALITY: Readonly<Record<QualityPreset, BloomParams>> = {
  low: { strength: 0.05, radius: 0.15, threshold: 2 },
  medium: { strength: 0.055, radius: 0.2, threshold: 1.8 },
  high: { strength: 0.06, radius: 0.2, threshold: 1.6 },
  ultra: { strength: 0.06, radius: 0.25, threshold: 1.6 },
};

const AO_BY_MODE: Readonly<Record<Exclude<AmbientOcclusion, 'off'>, AoParams>> = {
  'gtao-half': { resolutionScale: 0.5, samples: 12, radius: 1.2, thickness: 1.5, intensity: 0.85 },
  'gtao-full': { resolutionScale: 1, samples: 16, radius: 1.2, thickness: 1.5, intensity: 0.85 },
};

// The trace is a post pass of its own (OceanReflections.ts): "half" traces a quarter of the pixels
// with half the march samples, upsampled by depth.
const SSR_BY_MODE: Readonly<Record<Exclude<ReflectionMode, 'env'>, SsrParams>> = {
  'ssr-half': { steps: 20, refine: 4, maxDistance: 400, resolutionScale: 0.5 },
  'ssr-full': { steps: 40, refine: 6, maxDistance: 600, resolutionScale: 1 },
};

// The sun flare is a High-and-above touch.
const FLARE_BY_QUALITY: Readonly<Record<QualityPreset, FlareParams | null>> = {
  low: null,
  medium: null,
  high: { strength: 1, ghosts: 5 },
  ultra: { strength: 1, ghosts: 7 },
};

export interface PostCapabilities {
  // TRAA needs motion vectors from every moving surface; when false, SMAA stands in.
  temporal: boolean;
}

export function planPost(settings: PostSettings, quality: QualityPreset, caps: PostCapabilities): PostPlan {
  const aa = settings.aa === 'traa' && !caps.temporal ? 'smaa' : settings.aa;
  const aoMode = settings.ao ?? 'off';
  const ao = aoMode === 'off' ? null : { ...AO_BY_MODE[aoMode] };
  const reflections = settings.reflections ?? 'env';
  return {
    aa,
    // From Medium up the scene always writes velocity, whatever the AA / AO choice: three
    // keys every scene pipeline on the pass's outputs, so toggling them would otherwise rebuild the
    // whole scene (seconds in a fleet). The extra target costs far less than that pause. Low keeps
    // the lean single-output pass unless something needs it.
    motionVectors: (caps.temporal && quality !== 'low') || aa === 'traa' || ao !== null,
    bloom: settings.bloom ? { ...BLOOM_BY_QUALITY[quality] } : null,
    ao,
    flare: FLARE_BY_QUALITY[quality] ? { ...FLARE_BY_QUALITY[quality] } : null,
    droplets: settings.lensDroplets === true,
    ssr: reflections === 'env' ? null : { ...SSR_BY_MODE[reflections] },
  };
}

// True when going from plan `a` to `b` changes the node graph (a shader compile); everything else
// is uniforms.
export function postGraphChanged(a: PostPlan, b: PostPlan): boolean {
  return (
    a.aa !== b.aa ||
    a.motionVectors !== b.motionVectors ||
    (a.bloom === null) !== (b.bloom === null) ||
    a.ao?.resolutionScale !== b.ao?.resolutionScale ||
    a.ao?.samples !== b.ao?.samples ||
    a.flare?.ghosts !== b.flare?.ghosts ||
    a.droplets !== b.droplets ||
    a.ssr?.steps !== b.ssr?.steps ||
    a.ssr?.refine !== b.ssr?.refine ||
    a.ssr?.maxDistance !== b.ssr?.maxDistance ||
    a.ssr?.resolutionScale !== b.ssr?.resolutionScale
  );
}

// The post-relevant slice of the player's graphics settings.
export function postSettingsFrom(
  graphics: Pick<GraphicsSettings, 'aa' | 'bloom' | 'ao' | 'lensDroplets' | 'reflections'>,
): PostSettings {
  return {
    aa: graphics.aa,
    bloom: graphics.bloom,
    ao: graphics.ao,
    lensDroplets: graphics.lensDroplets,
    reflections: graphics.reflections,
  };
}

// --- Depth of field (photo camera) ---------------------------------------------------------------

export interface DofSettings {
  enabled: boolean;
  focusDistance: number; // m from the camera
  aperture: number; // 0 (pinhole, all sharp) .. 1 (widest, shallowest focus), as CameraRig.dof
}

const DOF_SENSOR_HEIGHT = 0.024; // m, full-frame 36 × 24 mm
export const DOF_MAX_BLUR_PX = 24; // largest circle of confusion (radius), pixels
const F_NUMBER_CLOSED = 22;
const F_NUMBER_OPEN = 1.4;

// Aperture 0..1 → f-number, logarithmically from f/22 (0) to f/1.4 (1).
export const fNumberFromAperture = (aperture: number): number =>
  F_NUMBER_CLOSED * (F_NUMBER_OPEN / F_NUMBER_CLOSED) ** Math.min(1, Math.max(0, aperture));

// Circle-of-confusion radius in pixels per unit of |D − S| / D, for a thin lens matching the
// camera's vertical FOV on a full-frame sensor: c = f² / (N (S − f)) · |D − S| / D on the sensor.
// A closed (0) aperture is a pinhole: no blur.
export function cocScalePx(dof: DofSettings, fovYDeg: number, heightPx: number): number {
  if (dof.aperture <= 0) return 0;
  const focal = DOF_SENSOR_HEIGHT / 2 / Math.tan((Math.max(1, fovYDeg) * Math.PI) / 360);
  const n = fNumberFromAperture(dof.aperture);
  const s = Math.max(dof.focusDistance, focal * 1.01);
  const diameter = (focal * focal) / (n * (s - focal));
  return (diameter / 2 / DOF_SENSOR_HEIGHT) * heightPx;
}
