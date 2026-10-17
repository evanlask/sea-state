// Layout of the top-down cloud-shadow map: a square of texels that rides with the clouds (its
// centre is a point in cloud space, snapped to a coarse grid, plus the wind's drift so far), re-
// centred only when the camera wanders off the middle, and refreshed a few rows per frame. Each
// texel holds the cloud transmittance toward the light along the ray that leaves the sea surface at
// the texel centre. Because the texels move with the clouds, a texel's content only changes as the
// clouds evolve, never as they drift, so rows refreshed on different frames always agree. Pure TS.

export interface ShadowMapLayout {
  size: number; // texels per side
  extent: number; // m per side
  centerX: number; // m, cloud space (world minus the drift)
  centerZ: number;
}

export const SHADOW_EXTENT = 32_000; // m: the visible sea's cloud shadows out to ~16 km
export const SHADOW_SNAP = 1000; // m
const SHADOW_RECENTRE = 4000; // m from the centre before the map moves

export const texelSize = (layout: ShadowMapLayout): number => layout.extent / layout.size;

// World xz (m) of a texel centre.
export function shadowTexelToWorld(
  layout: ShadowMapLayout,
  ix: number,
  iz: number,
): { x: number; z: number } {
  const s = texelSize(layout);
  return {
    x: layout.centerX + (ix + 0.5) * s - layout.extent / 2,
    z: layout.centerZ + (iz + 0.5) * s - layout.extent / 2,
  };
}

// Normalised map coordinates of a world xz (texel centres at (i + 0.5) / size).
export function worldToShadowUv(layout: ShadowMapLayout, x: number, z: number): { u: number; v: number } {
  return {
    u: (x - layout.centerX) / layout.extent + 0.5,
    v: (z - layout.centerZ) / layout.extent + 0.5,
  };
}

// Where the ray toward the light from a point `height` m above the sea leaves the sea surface
// (traced backwards): the xz to look up for points that aren't at sea level.
export function seaLevelFootprint(
  x: number,
  height: number,
  z: number,
  light: { x: number; y: number; z: number },
): { x: number; z: number } {
  const k = height / Math.max(light.y, 0.05);
  return { x: x - light.x * k, z: z - light.z * k };
}

// New centre if the focus has moved too far from the current one (snapped to SHADOW_SNAP), else null.
export function recentre(
  layout: ShadowMapLayout,
  focusX: number,
  focusZ: number,
  threshold = SHADOW_RECENTRE,
  snap = SHADOW_SNAP,
): { centerX: number; centerZ: number } | null {
  const dx = focusX - layout.centerX;
  const dz = focusZ - layout.centerZ;
  if (Math.abs(dx) <= threshold && Math.abs(dz) <= threshold && Number.isFinite(layout.centerX)) return null;
  return { centerX: Math.round(focusX / snap) * snap, centerZ: Math.round(focusZ / snap) * snap };
}

// Rows refreshed on a frame are those with row % slices === phase (interleaved, so the whole map
// ages evenly).
export const shadowSlicePhase = (frame: number, slices: number): number =>
  ((frame % slices) + slices) % slices;

export function rowsForFrame(size: number, frame: number, slices: number): number[] {
  const phase = shadowSlicePhase(frame, slices);
  const rows: number[] = [];
  for (let r = phase; r < size; r += slices) rows.push(r);
  return rows;
}

// Texels the map's content moves by when its centre moves from `from` to `to` (m, both on the snap
// grid, so whole texels): the history is read this far over and nothing is recomputed from scratch.
export function historyShift(
  layout: Pick<ShadowMapLayout, 'size' | 'extent'>,
  from: { x: number; z: number },
  to: { x: number; z: number },
): { x: number; z: number } {
  const s = layout.extent / layout.size;
  return { x: Math.round((to.x - from.x) / s), z: Math.round((to.z - from.z) / s) };
}

// The j-th row not refreshed on a frame with this phase (the shadow kernel's copy threads), in
// increasing order: the rows with row % slices !== phase.
export function copiedRow(j: number, slices: number, phase: number): number {
  const block = Math.floor(j / (slices - 1));
  const r = j % (slices - 1);
  return block * slices + r + (r >= phase ? 1 : 0);
}
