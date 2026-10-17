// Pure maths behind the ocean shading (mirrored by the TSL in OceanMaterial and GpuOcean), kept here
// so it can be unit-tested in Node: Fresnel, slope variance → roughness, footprint fades, mip counts,
// spectrum statistics and the wind → foam mapping.

import type { QualityPreset } from '../../app/Scenario';
import { foamCascadeWeight } from './foamPattern';

export const WATER_IOR = 1.333;
// Reflectance at normal incidence for air → water.
export const WATER_F0 = ((WATER_IOR - 1) / (WATER_IOR + 1)) ** 2;
// Angular radii (rad): the sun and the moon subtend ~0.53° and ~0.52°.
export const SUN_ANGULAR_RADIUS = 0.267 * (Math.PI / 180);
// Mean-square slope the rendered spectrum misses (capillaries below the finest cascade, sub-pixel
// ripples): a floor on the GGX α², so near-camera glints are tight but never single-pixel noise.
export const BASE_SLOPE_VARIANCE = 0.012 ** 2;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Exact unpolarised Fresnel reflectance for light arriving at cosI (to the normal) in a medium of
// index n1 and refracting into n2. Returns 1 under total internal reflection.
export function fresnelExact(cosI: number, n1 = 1, n2 = WATER_IOR): number {
  const c = clamp01(Math.abs(cosI));
  const eta = n1 / n2;
  const sinT2 = eta * eta * (1 - c * c);
  if (sinT2 >= 1) return 1;
  const cosT = Math.sqrt(1 - sinT2);
  const rs = (n1 * c - n2 * cosT) / (n1 * c + n2 * cosT);
  const rp = (n1 * cosT - n2 * c) / (n1 * cosT + n2 * c);
  return 0.5 * (rs * rs + rp * rp);
}

export function fresnelSchlick(cosI: number, f0 = WATER_F0): number {
  const m = 1 - clamp01(cosI);
  return f0 + (1 - f0) * m * m * m * m * m;
}

// Critical angle (from the normal) for light leaving water: Snell's window half-angle (~48.6°).
export const snellWindowHalfAngle = (ior = WATER_IOR): number => Math.asin(1 / ior);

// Upwelling light from the water body (OceanMaterial's body and subsurface terms). The sun/moon
// part takes the light's CSM-shadowed colour, so a boat's shadow removes it; the sky part doesn't.
export const BODY_DIRECT_FLAT = 0.6; // share of the sunlit body term that ignores the facet's tilt
export const SUBSURFACE_VIEW = 0.08; // sunlit glow through the surface, × (n·v)²
export const SUBSURFACE_AMBIENT = 0.015; // the same glow from the sky
export const SUBSURFACE_AMBIENT_CREST = 0.04; // more of it through high crests

type Rgb3 = readonly [number, number, number];

export interface UpwellingInput {
  deepColor: Rgb3;
  bodyScale: number;
  subsurfaceTint: Rgb3;
  sun: Rgb3; // the light's illuminance normal to its beam (lux, pre-exposed alike)
  sky: Rgb3; // the sky's radiance onto the sea (its irradiance / π)
  elevation: number; // sine of the light's elevation
  nl: number; // the facet's cosine to the light
  view: number; // the facet's cosine to the viewer
  crest?: number; // 0..1 crest height (crest glow toward the light not included)
}

// Upwelling radiance just above the surface (before the (1 − Fresnel) transmission), per channel:
// what the sun/moon drives and what the sky drives.
export function seaUpwelling(o: UpwellingInput): { sun: Rgb3; sky: Rgb3 } {
  const crest = o.crest ?? 0;
  const facing = o.elevation * (Math.max(0, o.nl) * (1 - BODY_DIRECT_FLAT) + BODY_DIRECT_FLAT);
  const glow = SUBSURFACE_VIEW * Math.max(0, o.view) ** 2;
  const ambientGlow = crest * SUBSURFACE_AMBIENT_CREST + SUBSURFACE_AMBIENT;
  const channel = (f: (c: 0 | 1 | 2) => number): Rgb3 => [f(0), f(1), f(2)];
  return {
    sun: channel(
      (c) => (o.sun[c] * (o.deepColor[c] * o.bodyScale * facing + o.subsurfaceTint[c] * glow)) / Math.PI,
    ),
    sky: channel((c) => o.sky[c] * (o.deepColor[c] * o.bodyScale + o.subsurfaceTint[c] * ambientGlow)),
  };
}

// Mip levels of a full chain for a square power-of-two texture (matches three's getMipLevels).
export const mipLevelCount = (size: number): number => Math.floor(Math.log2(Math.max(1, size))) + 1;

// Element offset of each mip level in a pyramid buffer (all layers of a level contiguous); the
// last entry is the total length.
export function pyramidOffsets(size: number, layers: number): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (let level = 0; level < mipLevelCount(size); level++) {
    offsets.push(offset);
    offset += layers * (size >> level) ** 2;
  }
  offsets.push(offset);
  return offsets;
}

// GGX α from the total mean-square slope (both axes): for Beckmann α² = σx² + σz², which GGX
// approximates well near the peak. Clamped to α ≤ 1.
export function roughnessFromSlopeVariance(variance: number, base = BASE_SLOPE_VARIANCE): number {
  return Math.min(1, Math.sqrt(Math.max(0, variance) + base));
}

// Slope variance from LEAN moments: E[s²] − E[s]² per axis, summed; never negative (fp16 noise).
export function leanVariance(meanX: number, meanZ: number, meanSqX: number, meanSqZ: number): number {
  return Math.max(0, meanSqX - meanX * meanX) + Math.max(0, meanSqZ - meanZ * meanZ);
}

// Mean-square slope added by a light disk of angular radius r: the half vector spreads over a disk
// of radius r/2, whose per-axis variance is (r/2)²/4, so σx² + σz² = r²/8.
export const diskSlopeVariance = (angularRadius: number): number => (angularRadius * angularRadius) / 8;

// GGX α for an analytic disk light: the surface's α widened by the disk (variances add), which keeps
// the lobe normalised so the glint carries exactly the light's energy.
export const lightAlpha = (alpha: number, angularRadius: number): number =>
  Math.sqrt(alpha * alpha + diskSlopeVariance(angularRadius));

// Weight of a cascade at a given pixel footprint (m): 1 while its waves span several pixels, 0 once a
// pixel covers a large part of the patch (its mip chain is then nearly flat, so only its variance
// matters and the shader substitutes the analytic value).
export const cascadeFootprintWeight = (footprint: number, patchLength: number): number =>
  1 - smoothstep(patchLength * 0.12, patchLength * 0.5, footprint);

export interface SpectrumStatistics {
  heightVariance: number; // m²
  slopeVarianceX: number; // mean-square ∂h/∂x
  slopeVarianceZ: number;
}

// Time-averaged statistics of one cascade from its h0 texels (layout of GpuCascade.h0: per texel
// h0(k).re, h0(k).im, conj(h0(−k)).re, conj(h0(−k)).im, natural FFT order). The FFT is unnormalised,
// so by Parseval ⟨h²⟩ = Σ_k ⟨|ĥ(k,t)|²⟩ = Σ_k |h0(k)|² + |h0(−k)|², and slopes weight that by k².
export function spectrumStatistics(h0: Float32Array, size: number, patchLength: number): SpectrumStatistics {
  const dk = (2 * Math.PI) / patchLength;
  let height = 0;
  let sx = 0;
  let sz = 0;
  for (let y = 0; y < size; y++) {
    const kz = (y < size / 2 ? y : y - size) * dk;
    for (let x = 0; x < size; x++) {
      const kx = (x < size / 2 ? x : x - size) * dk;
      const i = (y * size + x) * 4;
      const power = (h0[i] ?? 0) ** 2 + (h0[i + 1] ?? 0) ** 2 + (h0[i + 2] ?? 0) ** 2 + (h0[i + 3] ?? 0) ** 2;
      height += power;
      sx += power * kx * kx;
      sz += power * kz * kz;
    }
  }
  return { heightVariance: height, slopeVarianceX: sx, slopeVarianceZ: sz };
}

// Whitecap coverage fraction from the 10 m wind (Monahan & O'Muircheartaigh 1980): ~1% at 10 m/s,
// ~10% at 20 m/s, saturating in hurricanes.
export const whitecapCoverage = (windSpeed: number): number =>
  Math.min(1, 3.84e-6 * Math.max(0, windSpeed) ** 3.41);

// The rendered sea's whitecap coverage (its mean whiteness): Monahan's, easing towards this ceiling in
// hurricanes (about a third white in a Category 1, two thirds in a 3, three quarters in a 5, before
// the spume streaks), so the waves keep their shape under the foam.
export const WHITECAP_MAX = 0.85;
export function renderedWhitecapCoverage(windSpeed: number): number {
  const monahan = 3.84e-6 * Math.max(0, windSpeed) ** 3.41;
  return (WHITECAP_MAX * monahan) / (WHITECAP_MAX + monahan);
}

// Foam streaks along the wind: from the top of Beaufort 6 (12 m/s), so Force 7 shows the first
// ones, to full strength at Beaufort 10 (24.5 m/s).
const streakFactor = (windSpeed: number): number => smoothstep(12, 24.5, windSpeed);

// Inverse of the upper-tail normal probability: z with P(Z > z) = p, for 0 < p ≤ 0.5
// (Abramowitz & Stegun 26.2.23, |error| < 4.5e-4).
export function normalQuantile(p: number): number {
  const q = Math.min(0.5, Math.max(1e-9, p));
  const t = Math.sqrt(-2 * Math.log(q));
  return (
    t -
    (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t ** 3)
  );
}

// Standard deviation of the Jacobian J ≈ 1 + ∂Dx/∂x + ∂Dz/∂z of one cascade: the displacement is
// D = iλk̂h, so ∂Dx/∂x + ∂Dz/∂z has Fourier coefficients −λ|k|ĥ and variance λ²·(σx² + σz²).
export const jacobianStd = (choppiness: number, slopeVariance: number): number =>
  Math.abs(choppiness) * Math.sqrt(Math.max(0, slopeVariance));

// Only waves at least this long make whitecaps: breaking belongs to the energetic waves, while
// the short visual cascades are steep enough to dominate the Jacobian with centimetre speckle.
export const FOAM_MIN_PATCH = 15; // m

// Which cascades break, by patch length, as a weight on their Jacobian variance: the 800 m (25–128 m
// waves) and 128 m (4–25 m) cascades carry the whitecaps, the 20 m one only adds specks (its foam is
// drawn on the longer waves' crests anyway). The 4096 m cascade holds the swell, which doesn't
// break, and its 32 m texels would draw blobs; its crests still gather the shorter waves' foam
// (breaking groups, foamPattern.ts).
function foamSourceWeight(patch: number): number {
  if (patch < FOAM_MIN_PATCH || patch > 2000) return 0;
  if (patch < 60) return 0.25;
  if (patch < 500) return 0.8;
  return 1;
}

// Share of the sea breaking (summed over the cascades) for a rendered coverage. Each breaking texel
// leaves foam behind that fades over a few seconds, so the sea shows several times more white than
// is breaking; calibrated with the offline replay of the whole pipeline (whitecapEstimate.ts), which
// also captures the overlap of patches at high coverage.
const FOAM_BREAKING_SCALE = 0.387;
const FOAM_BREAKING_EXPONENT = 1.12;
const FOAM_BREAKING_OVERLAP = 2;
export function breakingFraction(coverage: number): number {
  const c = Math.max(0, coverage);
  return FOAM_BREAKING_SCALE * c ** FOAM_BREAKING_EXPONENT * (1 + FOAM_BREAKING_OVERLAP * c * c);
}

// Breaking ramps from nothing at the threshold to full this many Jacobian deviations below it:
// steep, so a crest that breaks turns white at once (its foam then thins as it fades).
const FOAM_RAMP = 0.15;
// Fraction of the rendered coverage the instantaneous crest whitening (combined Jacobian, in the
// ocean shader) is set to: it sharpens the breaking crests close up.
const FOAM_CREST_SHARE = 0.1;
// A layer that never breaks.
export const FOAM_OFF_THRESHOLD = -10;

export interface FoamLayer {
  patch: number; // m
  std: number; // its Jacobian deviation (jacobianStd)
}

export interface WindFoam {
  coverage: number; // rendered whitecap coverage aimed for
  // Per cascade (GPU foam accumulation): linearised Jacobian below which its crests break, and the
  // breaking ramp's gain (per unit of Jacobian below the threshold).
  thresholds: number[];
  gains: number[];
  crestThreshold: number; // combined Jacobian of the foam-making cascades where crests turn white
  buildRate: number; // foam per second at full breaking
  decayRate: number; // e-folding rate per second
  streaks: number; // 0..1, wind-aligned streak strength
  spume: number; // 0..1, old foam and spume streaking the whole sea (Beaufort 9 to a hurricane)
}

// Wind → foam. The breaking share of the sea for the wind's whitecap coverage is split between the
// cascades by foamSourceWeight × their Jacobian variance, and each cascade's threshold set so its
// (Gaussian) linearised Jacobian falls below it on that share of the sea. Foam lives longer in storms.
export function foamForWind(windSpeed: number, layers: readonly FoamLayer[]): WindFoam {
  const u = Math.max(0, windSpeed);
  const coverage = renderedWhitecapCoverage(u);
  const breaking = breakingFraction(coverage);
  const weights = layers.map((l) => foamSourceWeight(l.patch) * l.std * l.std);
  const total = weights.reduce((a, b) => a + b, 0);
  const thresholds: number[] = [];
  const gains: number[] = [];
  layers.forEach((layer, i) => {
    const share = total > 0 ? (breaking * (weights[i] ?? 0)) / total : 0;
    const on = share > 1e-7 && layer.std > 0.005;
    thresholds.push(on ? 1 - normalQuantile(share) * layer.std : FOAM_OFF_THRESHOLD);
    gains.push(on ? 1 / (FOAM_RAMP * layer.std) : 0);
  });
  // The shader's combined strain counts the short cascades at foamCascadeWeight.
  let variance = 0;
  for (const l of layers)
    if (l.patch >= FOAM_MIN_PATCH) variance += (foamCascadeWeight(l.patch) * l.std) ** 2;
  const crest = coverage * FOAM_CREST_SHARE;
  const storm = smoothstep(10, 30, u);
  return {
    coverage,
    thresholds,
    gains,
    crestThreshold:
      crest > 1e-7 ? 1 - normalQuantile(crest) * Math.max(0.02, Math.sqrt(variance)) : FOAM_OFF_THRESHOLD,
    buildRate: 6,
    decayRate: 0.5 - 0.1 * storm,
    streaks: streakFactor(u),
    spume: smoothstep(18, 40, u),
  };
}

export interface OceanShadingQuality {
  refraction: boolean; // screen-space refraction (hulls below the waterline)
  subsurface: boolean; // crest SSS (otherwise only the view-dependent body glow)
  foamOctaves: 1 | 2; // bubble-texture samples
  anisotropy: number; // slope texture filtering
}

// Low drops refraction and crest SSS; ultra adds 16× anisotropy.
export const OCEAN_SHADING_QUALITY: Readonly<Record<QualityPreset, OceanShadingQuality>> = {
  low: { refraction: false, subsurface: false, foamOctaves: 1, anisotropy: 4 },
  medium: { refraction: true, subsurface: true, foamOctaves: 1, anisotropy: 8 },
  high: { refraction: true, subsurface: true, foamOctaves: 2, anisotropy: 8 },
  ultra: { refraction: true, subsurface: true, foamOctaves: 2, anisotropy: 16 },
};
