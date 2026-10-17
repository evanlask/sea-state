// three.js geometry helpers for procedural boat parts: MeshData conversion,
// chamfered boxes (no hard CG edges), profile extrusions with bevels, lathes,
// tubes/sweeps, and PartBuilder, which merges parts per material slot so a
// whole vessel draws in a handful of calls.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  Shape,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';

import type { MeshData } from './loft';
import { shadowProxies } from './shadowProxy';
import { planSlotMerges, type SlotGeometry } from './slotMerge';

// Vertical plane with metric UVs (u along x from the left edge, v up), bottom-centre at the origin,
// facing +z. For procedural facades (window strips).
export function metricPlane(w: number, h: number, u0 = 0, v0 = 0): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-w / 2, 0, 0, w / 2, 0, 0, w / 2, h, 0, -w / 2, h, 0]), 3),
  );
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute(
    'uv',
    new BufferAttribute(new Float32Array([u0, v0, u0 + w, v0, u0 + w, v0 + h, u0, v0 + h]), 2),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// Plane mapped to a sub-rectangle of a texture atlas (uv0..uv1), centred, facing +z.
export function atlasPlane(
  w: number,
  h: number,
  uv0: [number, number],
  uv1: [number, number],
): BufferGeometry {
  const g = metricPlane(w, h);
  g.translate(0, -h / 2, 0);
  g.setAttribute(
    'uv',
    new BufferAttribute(
      new Float32Array([uv0[0], uv0[1], uv1[0], uv0[1], uv1[0], uv1[1], uv0[0], uv1[1]]),
      2,
    ),
  );
  return g;
}

export function toGeometry(data: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(data.positions, 3));
  g.setAttribute('normal', new BufferAttribute(data.normals, 3));
  g.setAttribute('uv', new BufferAttribute(data.uvs, 2));
  g.setIndex(new BufferAttribute(data.indices, 1));
  return g;
}

const tmpEuler = new Euler();
const tmpQuat = new Quaternion();
const tmpPos = new Vector3();
const tmpScale = new Vector3();

// Transform from a position and Euler angles (radians, XYZ order) and optional scale.
export function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s = 1): Matrix4 {
  tmpEuler.set(rx, ry, rz, 'YXZ');
  tmpQuat.setFromEuler(tmpEuler);
  return new Matrix4().compose(tmpPos.set(x, y, z), tmpQuat, tmpScale.set(s, s, s));
}

// Indexed geometry with exactly position/normal/uv, as mergeGeometries needs matching attributes.
export function normalizeGeometry(source: BufferGeometry): BufferGeometry {
  let g = source;
  if (!g.index) {
    const count = g.getAttribute('position').count;
    const idx = new Uint32Array(count);
    for (let i = 0; i < count; i++) idx[i] = i;
    g = g.clone();
    g.setIndex(new BufferAttribute(idx, 1));
  }
  // Attributes are copied: callers transform the result, and sources are often reused.
  const out = new BufferGeometry();
  out.setAttribute('position', g.getAttribute('position').clone());
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  out.setAttribute('normal', g.getAttribute('normal').clone());
  const uv = g.getAttribute('uv');
  out.setAttribute(
    'uv',
    uv ? uv.clone() : new BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2),
  );
  const index = g.index!;
  out.setIndex(new BufferAttribute(Uint32Array.from(index.array as ArrayLike<number>), 1));
  return out;
}

// ------------------------------------------------------------------ primitives

// Box with chamfered edges and corners (44 triangles). Bevel normals are the
// average of the adjoining faces, so edges catch a soft highlight. Metric UVs
// (box-projected) for tiling materials. Centred on the origin.
export function bevelBox(w: number, h: number, d: number, bevel = 0.05): BufferGeometry {
  const b = Math.min(bevel, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (pts: Vector3[], n: Vector3[], uv: (p: Vector3) => [number, number]): void => {
    const base = positions.length / 3;
    for (let i = 0; i < pts.length; i++) {
      positions.push(pts[i]!.x, pts[i]!.y, pts[i]!.z);
      const nn = n[i] ?? n[0]!;
      normals.push(nn.x, nn.y, nn.z);
      uvs.push(...uv(pts[i]!));
    }
    for (let i = 1; i + 1 < pts.length; i++) indices.push(base, base + i, base + i + 1);
  };
  const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
  // Main faces (inset by the bevel).
  const faces: [Vector3, (p: Vector3) => [number, number]][] = [
    [v(1, 0, 0), (p) => [-p.z, p.y]],
    [v(-1, 0, 0), (p) => [p.z, p.y]],
    [v(0, 1, 0), (p) => [p.x, -p.z]],
    [v(0, -1, 0), (p) => [p.x, p.z]],
    [v(0, 0, 1), (p) => [p.x, p.y]],
    [v(0, 0, -1), (p) => [-p.x, p.y]],
  ];
  for (const [n, uv] of faces) {
    const ax = n.x !== 0 ? 0 : n.y !== 0 ? 1 : 2;
    const ext = [hx, hy, hz];
    const inner = [hx - b, hy - b, hz - b];
    const u = (ax + 1) % 3;
    const w2 = (ax + 2) % 3;
    const corner = (su: number, sw: number): Vector3 => {
      const c = [0, 0, 0];
      c[ax] = ext[ax]! * (n.x + n.y + n.z);
      c[u] = inner[u]! * su;
      c[w2] = inner[w2]! * sw;
      return v(c[0]!, c[1]!, c[2]!);
    };
    const pts = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    // Wind outward.
    const e1 = pts[1]!.clone().sub(pts[0]!);
    const e2 = pts[2]!.clone().sub(pts[0]!);
    if (e1.cross(e2).dot(n) < 0) pts.reverse();
    quad(pts, [n], uv);
  }
  // Edge bevels: 12 strips between pairs of faces.
  const edgeAxes: [number, number, number][] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) edgeAxes.push([2, sx, sy]); // along z
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) edgeAxes.push([1, sx, sz]); // along y
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) edgeAxes.push([0, sy, sz]); // along x
  const ext = [hx, hy, hz];
  for (const [axis, sa, sb] of edgeAxes) {
    const o = [0, 1, 2].filter((k) => k !== axis) as [number, number];
    const signs = [0, 0, 0];
    signs[o[0]] = sa;
    signs[o[1]] = sb;
    const p = (along: number, which: 0 | 1): Vector3 => {
      const c = [0, 0, 0];
      c[axis] = along * (ext[axis]! - b);
      // which = 0: on face o[0]; 1: on face o[1].
      c[o[0]] = signs[o[0]]! * (which === 0 ? ext[o[0]]! : ext[o[0]]! - b);
      c[o[1]] = signs[o[1]]! * (which === 1 ? ext[o[1]]! : ext[o[1]]! - b);
      return v(c[0]!, c[1]!, c[2]!);
    };
    const n0 = v(0, 0, 0).setComponent(o[0], signs[o[0]]!);
    const n1 = v(0, 0, 0).setComponent(o[1], signs[o[1]]!);
    const pts = [p(-1, 0), p(1, 0), p(1, 1), p(-1, 1)];
    const mid = n0.clone().add(n1).normalize();
    const e1 = pts[1]!.clone().sub(pts[0]!);
    const e2 = pts[2]!.clone().sub(pts[0]!);
    let ns = [n0, n0, n1, n1];
    if (e1.cross(e2).dot(mid) < 0) {
      pts.reverse();
      ns = [n1, n1, n0, n0];
    }
    // Soften: blend face normals toward the bevel normal.
    quad(
      pts,
      ns.map((n) => n.clone().lerp(mid, 0.45).normalize()),
      (q) => [q.getComponent(axis), q.getComponent(o[0]) + q.getComponent(o[1])],
    );
  }
  // Corner triangles.
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const pts = [
          v(sx * hx, sy * (hy - b), sz * (hz - b)),
          v(sx * (hx - b), sy * hy, sz * (hz - b)),
          v(sx * (hx - b), sy * (hy - b), sz * hz),
        ];
        const n = v(sx, sy, sz).normalize();
        const e1 = pts[1]!.clone().sub(pts[0]!);
        const e2 = pts[2]!.clone().sub(pts[0]!);
        if (e1.cross(e2).dot(n) < 0) pts.reverse();
        quad(pts, [n], (q) => [q.x + q.z, q.y]);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  return g;
}

// Rounded-rectangle shape (plan or profile), centred on the origin.
export function roundedRect(w: number, h: number, r: number): Shape {
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2, h / 2);
  const s = new Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  return s;
}

export function shapeFrom(points: readonly [number, number][]): Shape {
  const s = new Shape();
  points.forEach(([x, y], i) => (i === 0 ? s.moveTo(x, y) : s.lineTo(x, y)));
  s.closePath();
  return s;
}

export interface ExtrudeOptions {
  bevel?: number; // bevel size, m
  bevelSegments?: number;
  curveSegments?: number;
}

// Extrudes a 2D shape. axis 'y': shape in plan (x, −z), extruded upward by depth from y = 0.
// axis 'x': shape in profile (z, y), extruded athwartships, centred on x = 0.
// axis 'z': shape in section (x, y), extruded fore-aft, centred on z = 0.
export function extrude(
  shape: Shape,
  depth: number,
  axis: 'x' | 'y' | 'z',
  options: ExtrudeOptions = {},
): BufferGeometry {
  const bevel = Math.min(options.bevel ?? 0, depth / 2 - 1e-4);
  const g = new ExtrudeGeometry(shape, {
    depth: Math.max(1e-4, depth - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: options.bevelSegments ?? 2,
    curveSegments: options.curveSegments ?? 6,
  });
  // ExtrudeGeometry runs from −bevel to depth − bevel along +Z.
  g.translate(0, 0, bevel);
  if (axis === 'y') {
    g.rotateX(-Math.PI / 2); // shape y → −z, extrusion z → y
  } else if (axis === 'x') {
    g.translate(0, 0, -depth / 2);
    g.rotateY(Math.PI / 2); // shape x → −z, y stays; extrusion z → x
    g.scale(1, 1, -1);
    flipWinding(g);
  } else {
    g.translate(0, 0, -depth / 2);
  }
  g.computeVertexNormals();
  return g;
}

// Recomputed normals after a mirror need the triangles reversed.
function flipWinding(g: BufferGeometry): void {
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  if (g.index) {
    const a = g.index.array as Uint32Array | Uint16Array;
    for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2]!, a[i + 1]!];
    g.index.needsUpdate = true;
    return;
  }
  for (let i = 0; i < pos.count; i += 3) {
    for (const attr of [pos, uv]) {
      if (!attr) continue;
      for (let c = 0; c < attr.itemSize; c++) {
        const t = attr.getComponent(i + 1, c);
        attr.setComponent(i + 1, c, attr.getComponent(i + 2, c));
        attr.setComponent(i + 2, c, t);
      }
    }
  }
}

export function lathe(profile: readonly [number, number][], segments = 16): BufferGeometry {
  return new LatheGeometry(
    profile.map(([r, y]) => new Vector2(r, y)),
    segments,
  );
}

export function cylinder(radius: number, height: number, segments = 10, radiusTop = radius): BufferGeometry {
  return new CylinderGeometry(radiusTop, radius, height, segments, 1);
}

// Tube between two points; open-ended unless `capped` (for an end that stands free).
export function rod(
  from: Vector3,
  to: Vector3,
  radius: number,
  segments = 6,
  capped = false,
): BufferGeometry {
  const dir = to.clone().sub(from);
  const len = dir.length();
  const g = new CylinderGeometry(radius, radius, len, segments, 1, !capped);
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  const mid = from.clone().add(to).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

// Tube along a polyline (smoothed with a centripetal Catmull-Rom unless sharp). `caps` closes the two
// ends of an open tube with flat discs, where they can be seen (else you look into a hollow tube).
export function tube(
  points: readonly Vector3[],
  radius: number,
  options: { radial?: number; segments?: number; closed?: boolean; sharp?: boolean; caps?: boolean } = {},
): BufferGeometry {
  if (options.sharp) {
    const parts: BufferGeometry[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      parts.push(
        normalizeGeometry(rod(points[i]!, points[i + 1]!, radius, options.radial ?? 6, options.caps)),
      );
    }
    return mergeGeometries(parts, false)!;
  }
  const curve = new CatmullRomCurve3([...points], options.closed ?? false, 'centripetal');
  const segments = options.segments ?? Math.max(4, points.length * 4);
  const radial = options.radial ?? 6;
  const g = new TubeGeometry(curve, segments, radius, radial, options.closed ?? false);
  if (!options.caps || options.closed) return g;
  return mergeGeometries([normalizeGeometry(g), tubeCaps(g, curve, segments, radial)], false)!;
}

// Flat end discs for an open TubeGeometry: fans from the curve's end points over its first and last
// rings ((radial + 1) vertices each), the first facing back along the curve, the last on along it.
function tubeCaps(
  g: BufferGeometry,
  curve: CatmullRomCurve3,
  segments: number,
  radial: number,
): BufferGeometry {
  const pos = g.getAttribute('position');
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const end of [0, 1]) {
    const n = curve.getTangentAt(end).normalize();
    if (end === 0) n.negate();
    const c = curve.getPointAt(end);
    const base = positions.length / 3;
    positions.push(c.x, c.y, c.z);
    const ring = end * segments * (radial + 1);
    for (let j = 0; j < radial; j++)
      positions.push(pos.getX(ring + j), pos.getY(ring + j), pos.getZ(ring + j));
    for (let j = 0; j <= radial; j++) normals.push(n.x, n.y, n.z);
    const a = new Vector3();
    const b = new Vector3();
    for (let j = 0; j < radial; j++) {
      const i0 = base + 1 + j;
      const i1 = base + 1 + ((j + 1) % radial);
      a.fromArray(positions, i0 * 3).sub(c);
      b.fromArray(positions, i1 * 3).sub(c);
      if (a.cross(b).dot(n) >= 0) indices.push(base, i0, i1);
      else indices.push(base, i1, i0);
    }
  }
  const caps = new BufferGeometry();
  caps.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  caps.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  caps.setAttribute('uv', new BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  caps.setIndex(indices);
  return caps;
}

// --------------------------------------------------------------- PartBuilder

export interface BuiltParts {
  group: Group;
  meshes: Map<string, Mesh>;
  triangles: number;
}

// Collects geometry per material slot (with transforms) and merges each slot into one mesh.
export class PartBuilder {
  private buckets = new Map<string, BufferGeometry[]>();

  add(slot: string, geometry: BufferGeometry, matrix?: Matrix4): this {
    const g = normalizeGeometry(geometry);
    if (matrix) g.applyMatrix4(matrix);
    let list = this.buckets.get(slot);
    if (!list) {
      list = [];
      this.buckets.set(slot, list);
    }
    list.push(g);
    return this;
  }

  addData(slot: string, data: MeshData, matrix?: Matrix4): this {
    return this.add(slot, toGeometry(data), matrix);
  }

  // Appends another builder's parts, transformed.
  addBuilder(other: PartBuilder, matrix?: Matrix4): this {
    for (const [slot, list] of other.buckets) {
      for (const g of list) this.add(slot, g, matrix);
    }
    return this;
  }

  slots(): string[] {
    return [...this.buckets.keys()];
  }

  // Merged geometry per slot (for AO baking, LOD derivation or custom meshes).
  merged(slot: string): BufferGeometry | null {
    const list = this.buckets.get(slot);
    if (!list || list.length === 0) return null;
    return mergeGeometries(list, false);
  }

  // One mesh per slot, except the plain simple and lamp slots, which merge (slotMerge.ts), and a
  // shadow proxy or two for the casters (shadowProxy.ts). `meshes` maps every slot to its mesh.
  build(materials: Readonly<Record<string, Material>>, options: { shadows?: boolean } = {}): BuiltParts {
    const group = new Group();
    const meshes = new Map<string, Mesh>();
    const slots: SlotGeometry[] = [];
    for (const slot of this.buckets.keys()) {
      const material = materials[slot];
      if (!material) throw new Error(`PartBuilder: no material for slot '${slot}'`);
      slots.push({ slot, geometry: this.merged(slot)!, material });
    }
    const { merged, rest } = planSlotMerges(slots, materials);
    const parts = rest.map(({ slot, geometry, material }) => ({
      name: slot,
      slots: [slot],
      geometry,
      material,
    }));
    for (const m of merged) {
      parts.push({
        name: m.name,
        slots: m.slots,
        geometry: mergeGeometries(m.geometries, false),
        material: m.material,
      });
      for (const g of m.geometries) g.dispose();
    }
    let triangles = 0;
    for (const { name, slots: owned, geometry, material } of parts) {
      geometry.computeBoundingSphere();
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      const transparent = material.transparent;
      mesh.castShadow = (options.shadows ?? true) && !transparent;
      mesh.receiveShadow = !transparent;
      mesh.matrixAutoUpdate = false; // the slot's geometry is already in the group's frame
      group.add(mesh);
      for (const slot of owned) meshes.set(slot, mesh);
      triangles += (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    }
    for (const proxy of shadowProxies(new Set(meshes.values()))) group.add(proxy);
    return { group, meshes, triangles };
  }
}
