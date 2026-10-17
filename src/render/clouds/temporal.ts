// Temporal sampling for the cloud buffers: the per-frame ray-offset jitter, the k×k upscale pattern
// (which output pixel of each block is marched this frame), and the reprojection of a cloud sample
// into the previous frame's view. Pure TS; the GPU kernels use the same formulas.

// R1 (golden ratio) additive sequence: low-discrepancy per-frame offset added to the per-pixel
// interleaved gradient noise, so each pixel's ray start sweeps the step evenly over frames.
export const GOLDEN = 0.6180339887498949;

export function frameJitter(frame: number): number {
  const x = (frame % 4096) * GOLDEN;
  return x - Math.floor(x);
}

// Interleaved gradient noise (Jimenez 2014) at an integer pixel, as the shaders compute it.
export function interleavedGradientNoise(x: number, y: number): number {
  const f = (v: number): number => v - Math.floor(v);
  return f(52.9829189 * f(0.06711056 * x + 0.00583715 * y));
}

// Per-pixel, per-frame jitter in [0, 1).
export function pixelJitter(x: number, y: number, frame: number): number {
  const v = interleavedGradientNoise(x, y) + frameJitter(frame);
  return v - Math.floor(v);
}

// Which pixel of each k×k block is marched on a frame. For k = 2 the order (0,0) (1,1) (1,0) (0,1)
// spreads consecutive frames diagonally, so a moving camera never leaves a row stale for long.
const ORDER_2: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 1],
  [1, 0],
  [0, 1],
];

export function upscaleOffset(frame: number, k: 1 | 2): readonly [number, number] {
  if (k === 1) return [0, 0];
  return ORDER_2[((frame % 4) + 4) % 4] as readonly [number, number];
}

// Number of frames until every output pixel has been marched at least once.
export const upscaleCycle = (k: 1 | 2): number => k * k;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// Column-major 4×4 (three.js Matrix4.elements) applied to a point; returns clip xy/w and w.
function project(m: ArrayLike<number>, p: Vec3): { x: number; y: number; w: number } {
  const e = (i: number): number => m[i] ?? 0;
  const x = e(0) * p.x + e(4) * p.y + e(8) * p.z + e(12);
  const y = e(1) * p.x + e(5) * p.y + e(9) * p.z + e(13);
  const w = e(3) * p.x + e(7) * p.y + e(11) * p.z + e(15);
  return { x, y, w };
}

// Previous-frame buffer uv (origin top-left, as the cloud buffers are laid out) of a sample at
// `distance` along `direction` from the current camera. `prevViewProjection` is the previous
// projection × view with its translation removed (camera-relative), `cameraDelta` the camera's
// movement since then (current − previous). Null when the point was behind the previous camera.
export function reprojectToPreviousUv(
  direction: Vec3,
  distance: number,
  cameraDelta: Vec3,
  prevViewProjection: ArrayLike<number>,
): { u: number; v: number } | null {
  const p = {
    x: direction.x * distance + cameraDelta.x,
    y: direction.y * distance + cameraDelta.y,
    z: direction.z * distance + cameraDelta.z,
  };
  const clip = project(prevViewProjection, p);
  if (clip.w <= 1e-6) return null;
  return { u: (clip.x / clip.w) * 0.5 + 0.5, v: 0.5 - (clip.y / clip.w) * 0.5 };
}

// History blend for one pixel: freshly marched pixels mix toward the new sample, the others take
// the clipped history unchanged; a rejected history (off-screen) takes the current sample.
export function historyWeightFor(marchedThisFrame: boolean, historyValid: boolean, weight: number): number {
  if (!historyValid) return 0;
  return marchedThisFrame ? weight : 1;
}
