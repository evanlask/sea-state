// Level-of-detail selection by projected size, with hysteresis so boats near a
// threshold don't flicker between levels. Pure.

export interface LodThresholds {
  // Projected length in pixels above which each level is used: [LOD0, LOD1]; below LOD1 → LOD2.
  pixels: readonly [number, number];
  hysteresis?: number; // fraction, default 0.15
}

export const DEFAULT_LOD_THRESHOLDS: LodThresholds = { pixels: [260, 70] };

// Pixels covered by an object of `length` metres at `distance` metres.
export function projectedPixels(
  length: number,
  distance: number,
  fovY: number,
  viewportHeight: number,
): number {
  const d = Math.max(1e-3, distance);
  return (length / (2 * d * Math.tan(fovY / 2))) * viewportHeight;
}

export function selectLod(
  pixels: number,
  current: number,
  thresholds: LodThresholds = DEFAULT_LOD_THRESHOLDS,
): number {
  const h = thresholds.hysteresis ?? 0.15;
  const [t0, t1] = thresholds.pixels;
  const target = pixels >= t0 ? 0 : pixels >= t1 ? 1 : 2;
  if (target === current) return current;
  if (target < current) {
    // Finer: only once clearly past the boundary (possibly stopping one level short).
    if (pixels >= (target === 0 ? t0 : t1) * (1 + h)) return target;
    if (current === 2 && pixels >= t1 * (1 + h)) return 1;
    return current;
  }
  // Coarser: only once clearly below the current level's threshold.
  if (pixels >= (current === 0 ? t0 : t1) * (1 - h)) return current;
  if (target === 2 && current === 0 && pixels >= t1 * (1 - h)) return 1;
  return target;
}
