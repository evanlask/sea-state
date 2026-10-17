// Where the ocean's screen-space reflections can hit anything (post/OceanReflections.ts).
//
// The SSR trace marches the reflected ray through the copy of the opaque scene's depth, and the only
// opaque things in the sea scene are the boats (with their sails, riders and rigging): the sky,
// clouds, particles, rain and lamps are background or transparent and never in that copy. So most of
// the sea, which reflects only sky, would march every step and miss. Each frame the CPU projects a
// conservative box around every boat to a screen rectangle (uv, y down, as the trace) plus the
// nearest view distance in it; a ray only samples the stretch of its screen segment inside some
// rectangle, and only where it reaches past that rectangle's nearest distance. Outside them the
// depth copy is sky, where no sample can register a hit, so the result is the same as the full march.
//
// Pure geometry (Node-testable); the uniforms live in OceanShadingUniforms (OceanMaterial.ts).

import { Box3, type Camera, Matrix4, type Object3D, Vector3, Vector4 } from 'three/webgpu';

const MAX_SSR_OCCLUDERS = 16;

// Moving parts (rudders, outboards, wheels, riders' limbs, wipers, cloth) stay inside the box
// measured when the boat first appears, padded by this much.
const PAD_METRES = 0.5;
const PAD_FRACTION = 0.05; // of the box's largest dimension
// Screen padding of each rectangle, pixels: the TRAA jitter (≤ ½ px) and texel rounding.
const SSR_RECT_PAD_PX = 3;

export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  near: number; // m, nearest view distance of the box's part in front of the near plane
}

const corners = Array.from({ length: 8 }, () => new Vector4());
const clipped: Vector4[] = Array.from({ length: 20 }, () => new Vector4());
const EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

// The box (in the frame `toClip` maps from) as the camera sees it: the uv bounds of its part in front
// of the near plane, clamped to the screen, or null when none of it is on screen. `toClip` is
// projection × view × model; w is the view distance for a perspective camera.
export function screenRectOfBox(
  box: Box3,
  toClip: Matrix4,
  near: number,
  out: ScreenRect,
): ScreenRect | null {
  for (let i = 0; i < 8; i++) {
    const c = corners[i] as Vector4;
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z, 1);
    c.applyMatrix4(toClip);
  }
  // The box clipped to w ≥ near: the corners in front plus where its edges cross the plane.
  let count = 0;
  for (const c of corners) if (c.w >= near) (clipped[count++] as Vector4).copy(c);
  for (const [a, b] of EDGES) {
    const ca = corners[a] as Vector4;
    const cb = corners[b] as Vector4;
    if (ca.w >= near === cb.w >= near) continue;
    const t = (ca.w - near) / (ca.w - cb.w);
    (clipped[count++] as Vector4).lerpVectors(ca, cb, t);
  }
  if (count === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let nearest = Infinity;
  for (let i = 0; i < count; i++) {
    const c = clipped[i] as Vector4;
    const w = Math.max(c.w, near);
    const u = (c.x / w) * 0.5 + 0.5;
    const v = (c.y / w) * -0.5 + 0.5;
    minX = Math.min(minX, u);
    maxX = Math.max(maxX, u);
    minY = Math.min(minY, v);
    maxY = Math.max(maxY, v);
    nearest = Math.min(nearest, w);
  }
  if (maxX < 0 || maxY < 0 || minX > 1 || minY > 1) return null;
  out.minX = Math.max(0, minX);
  out.minY = Math.max(0, minY);
  out.maxX = Math.min(1, maxX);
  out.maxY = Math.min(1, maxY);
  out.near = nearest;
  return out;
}

// Rectangles → uniform slots, two vec4 each (one uniform buffer: the ocean's fragment stage is
// close to WebGPU's 12): the uv rectangle (min x, min y, max x, max y), then the nearest view
// distance in x. Beyond the slots, the rest merge into the last one. Returns the slots used.
export function packScreenRects(
  rects: readonly ScreenRect[],
  data: Vector4[],
  padX: number,
  padY: number,
): number {
  const slots = data.length >> 1;
  let used = 0;
  for (const r of rects) {
    const merge = used === slots;
    const i = merge ? slots - 1 : used++;
    const b = data[2 * i] as Vector4;
    const n = data[2 * i + 1] as Vector4;
    const minX = Math.max(0, r.minX - padX);
    const minY = Math.max(0, r.minY - padY);
    const maxX = Math.min(1, r.maxX + padX);
    const maxY = Math.min(1, r.maxY + padY);
    if (merge) {
      b.set(Math.min(b.x, minX), Math.min(b.y, minY), Math.max(b.z, maxX), Math.max(b.w, maxY));
      n.x = Math.min(n.x, r.near);
    } else {
      b.set(minX, minY, maxX, maxY);
      n.set(r.near, 0, 0, 0);
    }
  }
  return used;
}

const relative = new Matrix4();
const rootInverse = new Matrix4();
const part = new Box3();

// Box around everything drawn under `root`, in root's frame (world matrices must be current),
// padded for the parts that move. Lines and points count too (rigging); hidden LODs as well.
export function occluderBounds(root: Object3D, target = new Box3()): Box3 {
  target.makeEmpty();
  rootInverse.copy(root.matrixWorld).invert();
  root.traverse((object) => {
    const drawn = object as Object3D & {
      geometry?: { boundingBox: Box3 | null; computeBoundingBox(): void };
      isInstancedMesh?: boolean;
      boundingBox?: Box3 | null;
      computeBoundingBox?: () => void;
    };
    const geometry = drawn.geometry;
    if (!geometry) return;
    let local: Box3 | null;
    if (drawn.isInstancedMesh && drawn.computeBoundingBox) {
      // Every instance. (A skinned mesh keeps its bind-pose box: its bones may not be posed yet.)
      if (!drawn.boundingBox) drawn.computeBoundingBox();
      local = drawn.boundingBox ?? null;
    } else {
      if (geometry.boundingBox === null) geometry.computeBoundingBox();
      local = geometry.boundingBox;
    }
    if (!local || local.isEmpty()) return;
    relative.multiplyMatrices(rootInverse, object.matrixWorld);
    target.union(part.copy(local).applyMatrix4(relative));
  });
  if (target.isEmpty()) return target;
  const size = target.getSize(new Vector3());
  target.expandByScalar(PAD_METRES + PAD_FRACTION * Math.max(size.x, size.y, size.z));
  return target;
}

export interface OccluderSlots {
  data: Vector4[]; // 2 × MAX_SSR_OCCLUDERS (packScreenRects)
  count: { value: number };
}

export const createOccluderSlots = <C extends { value: number }>(count: C): OccluderSlots & { count: C } => {
  const slots = { data: Array.from({ length: 2 * MAX_SSR_OCCLUDERS }, () => new Vector4()), count };
  fullScreen(slots);
  return slots;
};

const toClip = new Matrix4();
const rectPool: ScreenRect[] = [];
const rects: ScreenRect[] = [];

// Projects every occluder for `camera` into the slots. `everything` (debug geometry that is not a
// boat in the scene) puts one full-screen rectangle in instead: the full march.
export function updateOccluderSlots(
  slots: OccluderSlots,
  camera: Camera & { near: number },
  occluders: Iterable<{ root: Object3D; bounds: Box3 }>,
  size: { x: number; y: number },
  everything = false,
): void {
  if (everything) {
    fullScreen(slots);
    return;
  }
  camera.updateMatrixWorld(); // and its matrixWorldInverse
  const view = camera.matrixWorldInverse;
  rects.length = 0;
  for (const { root, bounds } of occluders) {
    if (bounds.isEmpty()) continue;
    toClip.multiplyMatrices(camera.projectionMatrix, view).multiply(root.matrixWorld);
    const rect = (rectPool[rects.length] ??= { minX: 0, minY: 0, maxX: 0, maxY: 0, near: 0 });
    if (screenRectOfBox(bounds, toClip, camera.near, rect)) rects.push(rect);
  }
  const padX = SSR_RECT_PAD_PX / Math.max(1, size.x);
  const padY = SSR_RECT_PAD_PX / Math.max(1, size.y);
  slots.count.value = packScreenRects(rects, slots.data, padX, padY);
}

function fullScreen(slots: OccluderSlots): void {
  (slots.data[0] as Vector4).set(0, 0, 1, 1);
  (slots.data[1] as Vector4).set(0, 0, 0, 0);
  slots.count.value = 1;
}

// The sample indices of the march (t_i = ((i + jitter) / steps)² · span, i = 0 .. steps − 1) that
// fall in [enter, exit]: first and last (last < first when none). post/OceanReflections mirrors this in TSL.
export function marchRange(
  enter: number,
  exit: number,
  span: number,
  steps: number,
  jitter: number,
): [number, number] {
  const s = Math.max(span, 1e-6);
  const first = Math.ceil(steps * Math.sqrt(Math.max(enter, 0) / s) - jitter);
  const last = Math.floor(steps * Math.sqrt(Math.max(exit, 0) / s) - jitter);
  return [Math.min(Math.max(first, 0), steps), Math.min(Math.max(last, -1), steps - 1)];
}
