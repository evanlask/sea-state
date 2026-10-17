// Bookkeeping for the environment panorama's rolling refresh (CloudSystem): each frame marches one
// slice of its columns, column x belonging to slice x mod slices, at that frame's pre-exposure.
// Readers divide each column by the exposure it was marched at, so slices marched a few frames
// apart match while the exposure adapts (one global exposure would leave bright and dark vertical
// bands that the environment probe reflects in every glossy surface).
// A full refresh marches every column at once (the first frame, a regenerated weather map), so the
// probe never captures columns that are empty or show the old clouds. Pure TS.

export interface PanoramaSlice {
  phase: number; // first column marched this frame
  stride: number; // columns between marched ones (1 = all)
  columns: number; // columns marched this frame
}

export function panoramaSlice(frame: number, width: number, slices: number, full: boolean): PanoramaSlice {
  const n = Math.max(1, Math.floor(slices));
  if (full || n === 1) return { phase: 0, stride: 1, columns: width };
  return { phase: ((frame % n) + n) % n, stride: n, columns: Math.ceil(width / n) };
}

// The pre-exposure each slice of the panorama was last marched at (`values` backs a GPU uniform
// array, so it is updated in place).
export class PanoramaExposures {
  readonly values: number[];

  constructor(slices: number, exposure = 1) {
    this.values = Array.from({ length: Math.max(1, Math.floor(slices)) }, () => exposure);
  }

  record(slice: Readonly<PanoramaSlice>, exposure: number): void {
    if (slice.stride === 1) this.values.fill(exposure);
    else this.values[slice.phase] = exposure;
  }

  // Exposure column x was last marched at.
  at(column: number): number {
    const n = this.values.length;
    return this.values[((Math.floor(column) % n) + n) % n] ?? 1;
  }
}
