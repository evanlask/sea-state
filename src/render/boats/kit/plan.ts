// Superstructure helpers that follow the hull's deck plan: blocks extruded from
// the (inset) deck outline between two stations, facade strips along the sides
// with metric UVs for procedural windows, and evenly spaced placements along
// those sides (balconies, lifeboats, stanchions).

import { BufferAttribute, BufferGeometry, Shape } from 'three/webgpu';

import { extrude, toGeometry } from './geometry';
import type { HullLines } from './hullLines';
import { loftRings } from './sculpt';

// Starboard edge points (x, z) from zFront to zAft at the deck half-breadth minus inset.
function planEdge(lines: HullLines, zFront: number, zAft: number, inset: number, n = 24): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    // Denser toward the ends where the plan curves.
    const u = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const z = zFront + (zAft - zFront) * u;
    out.push([Math.max(0.3, lines.deckHalf(z) - inset), z]);
  }
  return out;
}

export interface PlanBlockOptions {
  zFront: number;
  zAft: number;
  inset: number;
  y0: number;
  y1: number;
  bevel?: number;
  n?: number;
  maxHalf?: number; // clamp the half-breadth (narrower houses)
}

// A block whose plan follows the deck outline (flat front and aft ends), extruded from y0 to y1.
export function planBlock(lines: HullLines, o: PlanBlockOptions): BufferGeometry {
  const edge = planEdge(lines, o.zFront, o.zAft, o.inset, o.n ?? 24).map(([x, z]): [number, number] => [
    Math.min(x, o.maxHalf ?? Infinity),
    z,
  ]);
  const shape = new Shape();
  // Plan shape coordinates are (x, −z) for extrude(…, 'y').
  edge.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
  for (let i = edge.length - 1; i >= 0; i--) shape.lineTo(-edge[i]![0], -edge[i]![1]);
  shape.closePath();
  const g = extrude(shape, o.y1 - o.y0, 'y', { bevel: o.bevel ?? 0.15, bevelSegments: 1, curveSegments: 1 });
  g.translate(0, o.y0, 0);
  return g;
}

// A closed volume lofted from zFront to zAft through a convex (x, y) section given per station, for
// water-mask wells whose sides and top follow the hull and deck (a footwell up past its lip).
// Outward wound.
export function wellVolume(
  zFront: number,
  zAft: number,
  section: (z: number) => readonly [number, number][],
  n = 12,
): BufferGeometry {
  const rings = Array.from({ length: n + 1 }, (_, i) => {
    const z = zFront + ((zAft - zFront) * i) / n;
    return section(z).map(([x, y]): [number, number, number] => [x, y, z]);
  });
  return toGeometry(loftRings(rings, { capStart: true, capEnd: true }));
}

export interface FacadeOptions {
  zFront: number;
  zAft: number;
  inset: number;
  y0: number;
  y1: number;
  side: 1 | -1;
  offset?: number; // proud of the wall, m
  n?: number;
  maxHalf?: number;
}

// Vertical strip along one side of a plan block; uv = (metres along, reading left→right from
// outside; metres up from y0). Faces outward.
export function planFacade(lines: HullLines, o: FacadeOptions): BufferGeometry {
  const edge = planEdge(lines, o.zFront, o.zAft, o.inset, o.n ?? 24);
  const off = o.offset ?? 0.04;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const lengths = [0];
  for (let i = 1; i < edge.length; i++) {
    lengths.push(lengths[i - 1]! + Math.hypot(edge[i]![0] - edge[i - 1]![0], edge[i]![1] - edge[i - 1]![1]));
  }
  const total = lengths[lengths.length - 1]!;
  edge.forEach(([x0, z], i) => {
    const x = Math.min(x0, o.maxHalf ?? Infinity) + off;
    const a = edge[Math.max(0, i - 1)]!;
    const b = edge[Math.min(edge.length - 1, i + 1)]!;
    // Outward normal of the starboard edge: perpendicular to the tangent (dx, dz).
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    const nx = dz / l;
    const nz = -dx / l;
    const along = o.side > 0 ? total - lengths[i]! : lengths[i]!;
    for (const y of [o.y0, o.y1]) {
      positions.push(o.side * x, y, z);
      normals.push(o.side * nx, 0, nz);
      uvs.push(along, y - o.y0);
    }
  });
  for (let i = 0; i + 1 < edge.length; i++) {
    const a = i * 2;
    if (o.side > 0) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    else indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  return g;
}

// Points every `spacing` metres along a side of the plan edge: [x, z, yaw] where local +z runs along
// the side (aft on starboard, forward on port) and local +x points outboard.
export function alongPlan(
  lines: HullLines,
  zFront: number,
  zAft: number,
  inset: number,
  spacing: number,
  side: 1 | -1,
): [number, number, number][] {
  const edge = planEdge(lines, zFront, zAft, inset, 48);
  const pts = side > 0 ? edge : [...edge].reverse().map(([x, z]): [number, number] => [-x, z]);
  const out: [number, number, number][] = [];
  let carry = spacing / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i]!;
    const [bx, bz] = pts[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(bx - ax, bz - az);
    let d = carry;
    while (d <= len) {
      out.push([ax + ((bx - ax) * d) / len, az + ((bz - az) * d) / len, yaw]);
      d += spacing;
    }
    carry = d - len;
  }
  return out;
}
