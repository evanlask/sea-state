// Pure surface builders for small-craft parts that aren't hull lines: lofts
// through rings of points (superellipse sections for jet-ski decks, outboard
// cowlings, cushions and bulbs; NACA sections for keels and rudders), and
// strakes/spray rails swept along a planing hull's bottom. Output is MeshData
// (typed arrays) so the maths is testable without three.js.

import type { HullLines } from './hullLines';
import { computeNormals, type MeshData, stationParameters } from './loft';

export type V3 = [number, number, number];

export interface LoftOptions {
  closed?: boolean; // each ring is a closed loop (default true)
  capStart?: boolean; // fan-close the first ring (flat cap with its own normals)
  capEnd?: boolean;
  // Ensure the faces point away from the loft's centroid (right for convex-ish solids). Default true.
  outward?: boolean;
  inside?: V3; // reference point the faces point away from (open strips), instead of the centroid
}

// Surface through rings of equal point counts; rows follow the ring order, UVs are metric (u around
// the ring, v along the loft).
export function loftRings(rings: readonly (readonly V3[])[], o: LoftOptions = {}): MeshData {
  const closed = o.closed ?? true;
  const n = rings[0]!.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let along = 0;
  rings.forEach((ring, r) => {
    if (r > 0) along += dist(centroid(ring), centroid(rings[r - 1]!));
    let around = 0;
    ring.forEach((p, k) => {
      if (k > 0) around += dist(p, ring[k - 1]!);
      positions.push(p[0], p[1], p[2]);
      uvs.push(around, along);
    });
  });
  const cols = closed ? n : n - 1;
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < cols; k++) {
      const a = r * n + k;
      const b = r * n + ((k + 1) % n);
      const c = a + n;
      const d = b + n;
      indices.push(a, b, c, b, d, c);
    }
  }
  // The two caps wind opposite ways round the rings, so both face out of the solid.
  const cap = (ring: readonly V3[], flip: boolean): void => {
    const base = positions.length / 3;
    const c = centroid(ring);
    for (const p of ring) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(p[0], p[2]);
    }
    positions.push(c[0], c[1], c[2]);
    uvs.push(c[0], c[2]);
    for (let k = 0; k < n; k++) {
      const a = base + k;
      const b = base + ((k + 1) % n);
      if (flip) indices.push(base + n, b, a);
      else indices.push(base + n, a, b);
    }
  };
  if (o.capStart) cap(rings[0]!, true);
  if (o.capEnd) cap(rings[rings.length - 1]!, false);
  if (o.outward ?? true) orientOutward(positions, indices, o.inside);
  return {
    positions: new Float32Array(positions),
    normals: computeNormals(positions, indices),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

// Flips every triangle if, on balance, they face the centroid (makes winding independent of ring order).
export function orientOutward(
  positions: number[] | Float32Array,
  indices: number[] | Uint32Array,
  inside?: V3,
): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const nv = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) {
    cx += positions[i]!;
    cy += positions[i + 1]!;
    cz += positions[i + 2]!;
  }
  cx /= nv;
  cy /= nv;
  cz /= nv;
  if (inside) [cx, cy, cz] = inside;
  let flux = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    flux += nx * (positions[a]! - cx) + ny * (positions[a + 1]! - cy) + nz * (positions[a + 2]! - cz);
  }
  if (flux >= 0) return;
  for (let t = 0; t < indices.length; t += 3) {
    const tmp = indices[t + 1]!;
    indices[t + 1] = indices[t + 2]!;
    indices[t + 2] = tmp;
  }
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function centroid(ring: readonly V3[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const p of ring) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  return [c[0] / ring.length, c[1] / ring.length, c[2] / ring.length];
}

export interface SuperSection {
  z: number;
  x?: number; // centre
  y: number; // centre
  hw: number; // half width
  top: number; // height above the centre
  bottom: number; // depth below the centre
  n?: number; // superellipse exponent above the centre: 2 ellipse, 4+ rounded box
  nBottom?: number;
}

// Points round a superellipse section in the xy plane at z (starting outboard to starboard, going up).
export function superRing(s: SuperSection, around: number): V3[] {
  const out: V3[] = [];
  const nt = s.n ?? 2.5;
  const nb = s.nBottom ?? nt;
  for (let k = 0; k < around; k++) {
    const t = (k / around) * Math.PI * 2;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const up = sn >= 0;
    const e = 2 / (up ? nt : nb);
    out.push([
      (s.x ?? 0) + s.hw * Math.sign(c) * Math.abs(c) ** e,
      s.y + (up ? s.top : s.bottom) * Math.sign(sn) * Math.abs(sn) ** e,
      s.z,
    ]);
  }
  return out;
}

// Loft through superellipse sections (sections with hw ≈ 0 make pointed ends).
export function sculpt(sections: readonly SuperSection[], around = 24, o: LoftOptions = {}): MeshData {
  return loftRings(
    sections.map((s) => superRing(s, around)),
    o,
  );
}

// NACA 4-digit symmetric half-thickness at chord fraction x (thickness as a fraction of chord).
export function nacaHalfThickness(x: number, thickness: number): number {
  const t = Math.min(1, Math.max(0, x));
  return (
    5 * thickness * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4)
  );
}

export interface FoilSection {
  y: number; // span station (body height)
  chord: number;
  le: number; // body z of the leading edge
  thickness?: number; // fraction of the chord, default 0.12
  x?: number;
}

// Vertical foil (keel fin, spade rudder, skeg) through spanwise sections: chord along +z (aft).
export function foilLoft(sections: readonly FoilSection[], around = 20, o: LoftOptions = {}): MeshData {
  const half = Math.max(3, Math.floor(around / 2));
  const rings = sections.map((s) => {
    const ring: V3[] = [];
    // Cosine spacing round the nose; starboard side from LE to TE, then port back to the LE.
    for (let k = 0; k <= half; k++) {
      const x = 0.5 - 0.5 * Math.cos((Math.PI * k) / half);
      const h = nacaHalfThickness(x, s.thickness ?? 0.12) * s.chord;
      ring.push([(s.x ?? 0) + h, s.y, s.le + x * s.chord]);
    }
    for (let k = half - 1; k >= 1; k--) {
      const x = 0.5 - 0.5 * Math.cos((Math.PI * k) / half);
      const h = nacaHalfThickness(x, s.thickness ?? 0.12) * s.chord;
      ring.push([(s.x ?? 0) - h, s.y, s.le + x * s.chord]);
    }
    return ring;
  });
  return loftRings(rings, { capEnd: true, ...o });
}

export interface StrakeOptions {
  stations: number;
  sFrom: number;
  sTo: number;
  width: number; // m across the running flat
  taper?: number; // fraction of the length over which the forward end fades in
  below?: number; // girth samples for locating points on the section
}

// Lifting strakes on a planing bottom at fractions of the keel→chine girth, both sides: each is a flat
// running surface facing down plus a vertical outer face, closed at both ends. `at = 1` gives the chine
// flat (spray rail).
export function bottomStrakes(lines: HullLines, fractions: readonly number[], o: StrakeOptions): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const nb = o.below ?? 16;
  const ss = stationParameters(o.stations, o.sFrom, o.sTo);
  for (const f of fractions) {
    for (const side of [-1, 1]) {
      const base = positions.length / 3;
      ss.forEach((s, i) => {
        const sec = lines.section(s, nb, 4);
        // The chine flat (f ≥ 1) runs out from the chine and meets the topsides above it.
        const g = f >= 1 ? sec.chine : f * sec.chine;
        const j = f >= 1 ? sec.chine : Math.min(sec.chine - 1, Math.floor(g));
        const t = f >= 1 ? 0 : g - j;
        const ax = sec.xs[j]! + (sec.xs[j + 1]! - sec.xs[j]!) * t;
        const ay = sec.ys[j]! + (sec.ys[j + 1]! - sec.ys[j]!) * t;
        // Along the surface: toward the chine on the bottom, up the topsides for the chine flat.
        let tx = sec.xs[j + 1]! - sec.xs[j]!;
        let ty = sec.ys[j + 1]! - sec.ys[j]!;
        const l = Math.hypot(tx, ty) || 1;
        tx /= l;
        ty /= l;
        const u = (s - o.sFrom) / Math.max(1e-6, o.sTo - o.sFrom);
        const fade = Math.min(1, u / Math.max(1e-6, o.taper ?? 0.15));
        const w = o.width * Math.max(0.05, fade);
        // A: root (inboard), B: outboard corner of the flat at A's height, C: back on the hull. The
        // chine flat sticks straight out and slopes back up onto the near-vertical topsides.
        const chineFlat = f >= 1;
        const cx = ax + tx * w * (chineFlat ? 0.6 : 1);
        const cy = ay + ty * w * (chineFlat ? 0.6 : 1);
        // A and C sit a little inside the shell (along its inward normal), so no crack opens where the
        // strake's root runs across the shell's facets.
        const ex = -ty * 0.002;
        const ey = tx * 0.002;
        const pts: [number, number][] = [
          [ax + ex, ay + ey],
          [chineFlat ? ax + w : cx, ay - 0.002],
          [cx + ex, cy + ey],
        ];
        for (const [x, y] of pts) positions.push(side * x, y, lines.zAt(s));
        if (i + 1 < ss.length) {
          for (let k = 0; k < 2; k++) {
            const a = base + i * 3 + k;
            const b = a + 1;
            const c = a + 3;
            const d = b + 3;
            if (side > 0) indices.push(a, b, c, b, d, c);
            else indices.push(a, c, b, b, c, d);
          }
        }
      });
      // Close the wedge's two ends (own vertices, so the flat end faces don't bend its edge normals).
      for (const [i, facing] of [
        [0, -1],
        [ss.length - 1, 1],
      ] as const) {
        const first = positions.length / 3;
        positions.push(...positions.slice((base + i * 3) * 3, (base + i * 3 + 3) * 3));
        const p = positions.slice(first * 3);
        const nz = (p[3]! - p[0]!) * (p[7]! - p[1]!) - (p[4]! - p[1]!) * (p[6]! - p[0]!);
        if (nz * facing >= 0) indices.push(first, first + 1, first + 2);
        else indices.push(first, first + 2, first + 1);
      }
    }
  }
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let i = 0; i < positions.length / 3; i++) {
    uvs[i * 2] = positions[i * 3 + 2]!;
    uvs[i * 2 + 1] = positions[i * 3 + 1]!;
  }
  return {
    positions: new Float32Array(positions),
    normals: computeNormals(positions, indices),
    uvs,
    indices: new Uint32Array(indices),
  };
}
