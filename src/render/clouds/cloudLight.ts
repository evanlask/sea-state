// How the cloud-shadow map turns into the scene's sun/moon light. Pure TS; CloudSystem's shadow
// kernel runs the same transmittance formulas in TSL.
//
// The shadow map stores the optical depth τ of the cloud layer along the light ray. Light through
// a cloud splits into:
//   - a near-forward part that still comes from the sun's direction and casts (soft) shadows: the
//     direct beam plus the droplets' sharp forward (diffraction) peak. δ-Eddington scaling [K:
//     Joseph, Wiscombe & Weinman 1976] treats the peak, a fraction g² of the scattering, as
//     unscattered, so this part falls as e^(−(1−g²)τ);
//   - the rest, diffused through the cloud and out of its base in every direction. The volumetric
//     clouds already light their bases with it, and the environment probe captures those bases,
//     so it reaches the scene as sky light (IBL), not from the sun's direction.
// The directional light therefore carries only the first part: shadows under heaps go to the sky
// light alone, and a thick deck leaves essentially no sunlight, only the flat light of its base.

const CLOUD_FORWARD_G = 0.85; // asymmetry of cloud droplets' phase function (visible light)
export const DIRECT_EXTINCTION = 1 - CLOUD_FORWARD_G * CLOUD_FORWARD_G; // ≈ 0.28 of τ

// Share of the sun/moon light that keeps its direction through optical depth tau (δ-Eddington).
export const directTransmittance = (tau: number): number => Math.exp(-DIRECT_EXTINCTION * Math.max(tau, 0));

// Share of that directional light that is the unscattered beam, e^(−τ) / directTransmittance: the
// part a mirror (the ocean's glint) images as a crisp sun or moon.
export const beamShare = (tau: number): number => Math.exp(-(1 - DIRECT_EXTINCTION) * Math.max(tau, 0));

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Overcast flattening, 0 (broken cloud: moving shadows) .. 1 (a closed deck: shadowless light), from
// the layer's coverage. A deck's thin spots and gaps would otherwise let moving patches of weak sun
// through; under a real closed overcast the light is flat. Squalls (0.6) keep their shadows.
const OVERCAST_START = 0.75;
const OVERCAST_FULL = 0.95;
export const overcastWeight = (coverage: number): number =>
  smoothstep(OVERCAST_START, OVERCAST_FULL, coverage);

// Sky (diffuse) to direct light on a horizontal surface under a clear or broken sky, versus the
// light's elevation (sine): ~0.2 with a high sun (blue sky plus sunlit cloud sides), rising as the
// low sun's slant path weakens the beam [K: clear-sky diffuse fractions ~0.15 overhead, ~0.4 at 10°].
export const skyToDirectRatio = (sinElevation: number): number => 0.15 + 0.05 / Math.max(sinElevation, 0.05);

// Fraction of the scene's light drop under cloud that the auto-exposure keeps (the eye and a camera
// adapt, but not completely): the scene visibly dims as a cloud passes over.
export const CLOUD_DIM_KEEP = 0.25;

export interface CloudDimmingInputs {
  transmittance: number; // directional transmittance at the camera's focus (0..1)
  overcast: number; // overcastWeight of the layer
  sinElevation: number; // of the light source
  weight: number; // 0..1, the light source's own weight (twilight crossfade; 0 = no light)
}

// EV the exposure target is raised by (darker) for the cloud light at the focus: `keep` of the drop
// in illuminance from the clear-sky light (sky + full direct light) to the light here (sky + the
// directional light left by the cloud and the overcast flattening).
export function cloudDimmingEv(inputs: CloudDimmingInputs, keep = CLOUD_DIM_KEEP): number {
  const weight = clamp01(inputs.weight);
  if (weight <= 0 || inputs.sinElevation <= 0) return 0;
  const sky = skyToDirectRatio(inputs.sinElevation);
  const here = weight * (1 - clamp01(inputs.overcast)) * clamp01(inputs.transmittance);
  return keep * Math.log2((sky + weight) / (sky + here));
}

// Low-sun fade of the shadow pattern, 0..1 from the light's elevation (sine). Near the horizon the
// shadow rays graze the layer for tens of kilometres: a heap's shadow stretches into a long streak
// that swings with every small change of the sun, the sun's disk widens the penumbrae to hundreds of
// metres and the direct light itself is weak beside the sky. Below SHADOW_FADE_START the light takes
// the cloud field's mean transmittance instead (a uniform dimming), fully local by SHADOW_FADE_FULL.
const SHADOW_FADE_START = Math.sin(2 * (Math.PI / 180));
const SHADOW_FADE_FULL = Math.sin(9 * (Math.PI / 180));
export const lowSunShadowFade = (sinElevation: number): number =>
  smoothstep(SHADOW_FADE_START, SHADOW_FADE_FULL, sinElevation);

// Steps of the shadow march for a base count and the light's elevation (sine): the ray through the
// layer lengthens as 1 / sin(elevation), so a low sun gets more samples (up to 1.75×).
export const shadowMarchSteps = (base: number, sinElevation: number): number =>
  Math.round(base * Math.min(1.75, Math.max(1, Math.sqrt(0.3 / Math.max(sinElevation, 1e-3)))));

// Share of the previous result a texel keeps each time it is re-marched (a jittered march blends
// into the history: ~1 / (1 − w) marches averaged).
export const SHADOW_HISTORY = 0.85;
