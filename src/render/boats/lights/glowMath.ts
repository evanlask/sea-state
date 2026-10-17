// Apparent size and brightness of a light seen by the camera, pure TS (lightNodes.ts runs the same
// maths per instance on the GPU). A distant lantern is a point source: its illuminance at the camera,
// E = I·τ/d², is spread over a pixel-sized point-spread function, so a 12 cd sidelight at 2 nm lands
// on a couple of pixels with the right total energy instead of growing into a disc. Close up the
// lens itself is drawn (LampField's lens mesh) and the PSF core fades out. Around both sits a glare
// halo, L = k·E/(θ² + θ₀²) (a camera-strength version of the Stiles–Holladay veiling glare), windowed
// where it drops below what the display can show, so at noon (tiny pre-exposure) it vanishes.

import { EARTH_ATMOSPHERE } from '../../sky/atmosphereParams';

export const PSF_SIGMA_PX = 0.75; // gaussian core, pixels
export const GLARE_K = 1e-3; // sr; the human eye's disability glare is ~3e-3
export const GLARE_CORE_PX = 2; // θ₀, pixels
export const GLARE_FLOOR = 0.01; // pre-exposed luminance where the halo window ends
export const QUAD_MIN_PX = 3;
export const QUAD_MAX_PX = 48;
export const MAX_PRE_EXPOSED = 5000; // caps lamp pixels so bloom stays a glow, and HDR inside fp16

// Radians per pixel at the image centre for a vertical field of view.
export const pixelAngle = (fovY: number, heightPx: number): number => (2 * Math.tan(fovY / 2)) / heightPx;

export interface GlowInputs {
  illuminance: number; // lux at the camera (after sector visibility and transmittance)
  lensAngle: number; // rad, angular radius of the lens
  pixelAngle: number; // rad per pixel
  preExposure: number;
  lensDrawn: boolean; // the lens mesh renders the resolved lamp
}

export interface GlowProfile {
  coreSigma: number; // rad
  coreWeight: number; // share of E in the PSF core (fades as the lens mesh takes over)
  quadRadius: number; // rad, half size of the sprite
  corePeak: number; // pre-exposed luminance at the centre from the core
  haloAt: (theta: number) => number; // pre-exposed halo luminance at θ rad from the centre
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function glowProfile(g: GlowInputs): GlowProfile {
  const px = g.pixelAngle;
  const lensPx = (2 * g.lensAngle) / px; // lens diameter in pixels
  const coreSigma = g.lensDrawn ? PSF_SIGMA_PX * px : Math.max(PSF_SIGMA_PX * px, g.lensAngle / 2);
  const coreWeight = g.lensDrawn ? 1 - smoothstep(1, 3, lensPx) : 1;
  const e = g.illuminance * g.preExposure;
  const glareRadius = Math.sqrt((GLARE_K * e) / GLARE_FLOOR);
  const quadRadius = Math.min(QUAD_MAX_PX * px, Math.max(QUAD_MIN_PX * px, 3 * coreSigma, glareRadius));
  const theta0 = GLARE_CORE_PX * px;
  return {
    coreSigma,
    coreWeight,
    quadRadius,
    corePeak: Math.min(MAX_PRE_EXPOSED, (e * coreWeight) / (2 * Math.PI * coreSigma * coreSigma)),
    haloAt: (theta: number) => {
      const w = Math.max(0, 1 - (theta / quadRadius) ** 2) ** 2;
      return Math.min(MAX_PRE_EXPOSED, ((GLARE_K * e) / (theta * theta + theta0 * theta0)) * w);
    },
  };
}

// Scintillation: a faint flicker that only shows at range (heave and air turbulence).
export const TWINKLE_AMOUNT = 0.15;
export const TWINKLE_NEAR = 400; // m
export const TWINKLE_FAR = 4000; // m

// Sea-level extinction (1/m per channel) along a near-horizontal path: Rayleigh plus aerosol scaled by
// the sky's haze density, or Koschmieder's 3.912/V when fog or rain set a shorter visibility V (m).
export function lightExtinction(
  hazeDensity = 1,
  visibility = Number.POSITIVE_INFINITY,
): [number, number, number] {
  const a = EARTH_ATMOSPHERE;
  const fog = 3.912 / Math.max(visibility, 1);
  const channel = (i: 0 | 1 | 2): number =>
    Math.max((a.rayleighScattering[i] + a.mieExtinction[i] * Math.max(0, hazeDensity)) / 1000, fog);
  return [channel(0), channel(1), channel(2)];
}
