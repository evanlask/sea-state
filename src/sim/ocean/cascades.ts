// Ocean cascade layout. Each cascade is a periodic N×N FFT patch of side L that owns one radial annulus
// of wavenumbers [kMin, kMax); the annuli tile k-space without gaps or overlaps, so summing cascades
// sums one spectrum exactly once.
//
// Four PHYSICS cascades are evaluated on both CPU and GPU and never change with graphics quality. They
// are band-limited to modes with |m|, |n| < 32 on a 128 grid (≥ 4 samples per wavelength) so bilinear
// sampling of the CPU copy is accurate. VISUAL cascades continue from the last physics cut-off down to
// centimetre ripples; they are GPU-only and depend on the quality level.

export type CascadeKind = 'physics' | 'visual';

export interface CascadeConfig {
  index: number; // global index: 0–3 physics, 4+ visual; part of each mode's random hash
  kind: CascadeKind;
  size: number; // patch side L, m
  resolution: number; // N (power of two)
  kMin: number; // rad/m, inclusive
  kMax: number; // rad/m, exclusive
  bandRadius: number; // kMax in units of the fundamental 2π/L
}

const PHYSICS_RESOLUTION = 128;
export const PHYSICS_BAND_RADIUS = 32;
export const PHYSICS_SIZES: readonly number[] = [4096, 800, 128, 20];

// Ships skip the 20 m cascade: those waves are far shorter than the hull and only add noise.
export const CASCADE_MASK_ALL = 0b1111;
export const CASCADE_MASK_SHIPS = 0b0111;
// The seas that break heavily enough to knock a boat down: waves at least 25 m long (the 4096 m and
// 800 m cascades), whose crest steepness and speed the breaking-wave model reads (OceanSurface).
export const CASCADE_MASK_SEAS = 0b0011;
export const SEAS_MIN_WAVELENGTH = 25; // m, 2π / (the 800 m cascade's kMax)

function fundamental(size: number): number {
  return (2 * Math.PI) / size;
}

function buildPhysics(): CascadeConfig[] {
  const cascades: CascadeConfig[] = [];
  let kMin = fundamental(PHYSICS_SIZES[0] as number);
  PHYSICS_SIZES.forEach((size, index) => {
    const kMax = PHYSICS_BAND_RADIUS * fundamental(size);
    cascades.push({
      index,
      kind: 'physics',
      size,
      resolution: PHYSICS_RESOLUTION,
      kMin,
      kMax,
      bandRadius: PHYSICS_BAND_RADIUS,
    });
    kMin = kMax;
  });
  return cascades;
}

export const PHYSICS_CASCADES: readonly CascadeConfig[] = buildPhysics();
export const PHYSICS_K_MAX = (PHYSICS_CASCADES[PHYSICS_CASCADES.length - 1] as CascadeConfig).kMax;

export type OceanQuality = 'low' | 'medium' | 'high' | 'ultra';

export interface VisualQuality {
  count: number;
  resolution: number;
  endWavelength: number; // m, shortest wave rendered
}

// Each visual cascade spans an equal ratio of k and uses its full Nyquist band (|m|, |n| < N/2). With
// one cascade, low and medium share L ≈ 3.2 m, so their common modes are identical.
export const VISUAL_QUALITY: Readonly<Record<OceanQuality, VisualQuality>> = {
  low: { count: 1, resolution: 128, endWavelength: 0.05 },
  medium: { count: 1, resolution: 256, endWavelength: 0.025 },
  high: { count: 2, resolution: 256, endWavelength: 0.015 },
  ultra: { count: 2, resolution: 512, endWavelength: 0.01 },
};

// graphics.visualDetailCascades: any layer count and FFT size, not just the four tiers above.
export interface VisualDetail {
  count: number; // 1 or 2
  resolution: number; // power of two, at most 512 (GpuFft's limit)
}

// The tier's layout, or for any other detail layout the shortest wave that keeps the tiers' spacing:
// one layer keeps low/medium's patch (≈ 3.2 m, so the shortest wave scales with 1/N), two layers go
// 1.5× shorter per doubling of N as high → ultra do.
function visualQualityFor(detail: OceanQuality | VisualDetail): VisualQuality {
  if (typeof detail === 'string') return VISUAL_QUALITY[detail];
  const count = Math.min(2, Math.max(1, Math.round(detail.count)));
  const resolution = 2 ** Math.round(Math.log2(Math.min(512, Math.max(16, detail.resolution))));
  const tier = Object.values(VISUAL_QUALITY).find((q) => q.count === count && q.resolution === resolution);
  if (tier) return tier;
  const endWavelength = count === 1 ? (0.05 * 128) / resolution : 0.015 * 1.5 ** Math.log2(256 / resolution);
  return { count, resolution, endWavelength };
}

export function visualCascades(detail: OceanQuality | VisualDetail): CascadeConfig[] {
  const { count, resolution, endWavelength } = visualQualityFor(detail);
  const kStart = PHYSICS_K_MAX;
  const ratio = Math.pow((2 * Math.PI) / endWavelength / kStart, 1 / count);
  const bandRadius = resolution / 2;
  const cascades: CascadeConfig[] = [];
  let kMin = kStart;
  for (let i = 0; i < count; i++) {
    const kMax = kStart * Math.pow(ratio, i + 1);
    cascades.push({
      index: PHYSICS_CASCADES.length + i,
      kind: 'visual',
      size: (bandRadius * 2 * Math.PI) / kMax,
      resolution,
      kMin,
      kMax,
      bandRadius,
    });
    kMin = kMax;
  }
  return cascades;
}

// Storage index of signed mode m on an N grid: (m + N) mod N, the natural FFT order (DC at 0, negative
// frequencies in the upper half). Mode (m, n) with kx = 2πm/L, kz = 2πn/L lives in texel
// modeIndex(n) · N + modeIndex(m): rows are z, columns are x.
export function modeIndex(m: number, resolution: number): number {
  return (m + resolution) & (resolution - 1);
}

// Signed mode number of storage index i: i for i < N/2, else i − N.
export function signedMode(i: number, resolution: number): number {
  return i < resolution / 2 ? i : i - resolution;
}

// |k| of mode (m, n). h0 generation and membership tests share this exact expression, so a mode on an
// annulus boundary is classified identically everywhere.
export function modeWaveNumber(cascade: CascadeConfig, m: number, n: number): number {
  return Math.hypot(m, n) * fundamental(cascade.size);
}

export function modeInCascade(cascade: CascadeConfig, m: number, n: number): boolean {
  const k = modeWaveNumber(cascade, m, n);
  return k >= cascade.kMin && k < cascade.kMax;
}
