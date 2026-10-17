// How the sun and moon disks show through the clouds in front of them. Pure TS; CloudSystem's
// background node evaluates the same formulas.
//
// The cloud buffer is reduced-resolution and temporally reprojected, and its transmittance T is
// an average over a pixel, its neighbours and recent frames; the march also stops once T < 0.01.
// The disks are ~10⁴ (moon) to 10⁵ (sun) times brighter than the cloud in front of them, so a plain
// `disk × T` would shine through thick cloud wherever T is a little too high (the march's leftover
// ~1%, or clear sky bilinearly mixed in at an edge). Instead the disk takes the least T over its
// upsample footprint, cut off below DISK_T_CUTOFF and squared (fading faster than T); and thin
// cloud scatters part of the light it removes into a narrow forward peak, a soft aureole around
// the disk that fades again as the cloud thickens.

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Clouds at least this opaque hide the disks completely (well above the march's 1% early-out).
export const DISK_T_CUTOFF = 0.03;

// Visibility (0..1) of a sun/moon disk behind cloud of transmittance t (the footprint minimum).
export function diskVisibility(t: number): number {
  const k = clamp01((t - DISK_T_CUTOFF) / (1 - DISK_T_CUTOFF));
  return k * k;
}

// Share of the light diffracted into the forward peak by droplets much larger than the wavelength
// (half the extinction: the extinction paradox).
export const DIFFRACTED = 0.5;
// Angular width (rad, Gaussian σ) of that peak: first diffraction minimum ≈ 0.61 λ / r ≈ 1.9° for
// 10 µm droplets [K]; the clouds' Henyey-Greenstein lobes are far too broad to form it.
export const AUREOLE_SIGMA = 1.2 * (Math.PI / 180);

// Fraction of the light source's illuminance scattered once into the aureole through cloud of
// transmittance t: τ e^(−τ) × DIFFRACTED, zero in clear sky and again in thick cloud (τ ≳ 6),
// where repeated scattering spreads it into the cloud's own glow.
export function aureoleWeight(t: number): number {
  const tc = Math.min(1, Math.max(t, 1e-6));
  return Math.max(-Math.log(tc) * tc * DIFFRACTED, 0);
}

// Normalised small-angle Gaussian lobe (1/sr) at `angle` rad from the source: ∫ lobe dΩ = 1.
export function aureoleLobe(angle: number, sigma = AUREOLE_SIGMA): number {
  return Math.exp(-(angle * angle) / (2 * sigma * sigma)) / (2 * Math.PI * sigma * sigma);
}
