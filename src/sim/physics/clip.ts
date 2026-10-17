// Clips one triangle against the local waterline, where the waterline is the
// zero set of a per-vertex scalar (pressure head, > 0 under water) that varies
// linearly along each edge. Shared by hydrostatics and the Kerner forces.

// Vertex layout in the input and output buffers: x, y, z, head, vx, vy, vz.
export const CLIP_STRIDE = 7;
const TRI = CLIP_STRIDE * 3;

// Output holds up to two submerged triangles (offsets 0 and TRI) and up to two
// emerged triangles (offsets 2·TRI and 3·TRI).
export const CLIP_OUT_SIZE = TRI * 4;
export const CLIP_EMERGED_OFFSET = TRI * 2;

const wet = new Float64Array(CLIP_STRIDE * 4);
const dry = new Float64Array(CLIP_STRIDE * 4);

function copyVertex(dst: Float64Array, d: number, src: Float64Array, s: number): void {
  for (let i = 0; i < CLIP_STRIDE; i++) dst[d + i] = src[s + i]!;
}

function lerpVertex(dst: Float64Array, d: number, src: Float64Array, a: number, b: number, t: number): void {
  for (let i = 0; i < CLIP_STRIDE; i++) dst[d + i] = src[a + i]! + (src[b + i]! - src[a + i]!) * t;
  dst[d + 3] = 0; // exactly on the waterline
}

// Fan-triangulates a convex polygon (3 or 4 vertices) into out at offset.
function emitPolygon(poly: Float64Array, count: number, out: Float64Array, offset: number): number {
  if (count < 3) return 0;
  copyVertex(out, offset, poly, 0);
  copyVertex(out, offset + CLIP_STRIDE, poly, CLIP_STRIDE);
  copyVertex(out, offset + 2 * CLIP_STRIDE, poly, 2 * CLIP_STRIDE);
  if (count === 3) return 1;
  copyVertex(out, offset + TRI, poly, 0);
  copyVertex(out, offset + TRI + CLIP_STRIDE, poly, 2 * CLIP_STRIDE);
  copyVertex(out, offset + TRI + 2 * CLIP_STRIDE, poly, 3 * CLIP_STRIDE);
  return 2;
}

// Returns submergedCount | (emergedCount << 2). Winding is preserved.
export function clipTriangle(src: Float64Array, out: Float64Array): number {
  let nWet = 0;
  let nDry = 0;
  for (let e = 0; e < 3; e++) {
    const a = e * CLIP_STRIDE;
    const b = ((e + 1) % 3) * CLIP_STRIDE;
    const ha = src[a + 3]!;
    const hb = src[b + 3]!;
    if (ha >= 0) copyVertex(wet, CLIP_STRIDE * nWet++, src, a);
    else copyVertex(dry, CLIP_STRIDE * nDry++, src, a);
    if (ha >= 0 !== hb >= 0) {
      const t = ha / (ha - hb);
      lerpVertex(wet, CLIP_STRIDE * nWet++, src, a, b, t);
      lerpVertex(dry, CLIP_STRIDE * nDry++, src, a, b, t);
    }
  }
  const submerged = emitPolygon(wet, nWet, out, 0);
  const emerged = emitPolygon(dry, nDry, out, CLIP_EMERGED_OFFSET);
  return submerged | (emerged << 2);
}
