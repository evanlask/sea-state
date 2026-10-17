// Indexed triangle meshes (float64) for buoyancy: construction helpers and
// closed-manifold / orientation checks.

export interface TriMesh {
  positions: Float64Array; // xyz per vertex, body frame
  indices: Uint32Array; // three per triangle, counter-clockwise seen from outside
}

export const triangleCount = (mesh: TriMesh): number => mesh.indices.length / 3;

export function mergeMeshes(meshes: readonly TriMesh[]): TriMesh {
  let vertices = 0;
  let indices = 0;
  for (const mesh of meshes) {
    vertices += mesh.positions.length;
    indices += mesh.indices.length;
  }
  const positions = new Float64Array(vertices);
  const merged = new Uint32Array(indices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of meshes) {
    positions.set(mesh.positions, vertexOffset);
    const base = vertexOffset / 3;
    for (let i = 0; i < mesh.indices.length; i++) merged[indexOffset + i] = mesh.indices[i]! + base;
    vertexOffset += mesh.positions.length;
    indexOffset += mesh.indices.length;
  }
  return { positions, indices: merged };
}

// Signed enclosed volume (divergence theorem). Positive for outward winding.
export function meshVolume(mesh: TriMesh): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let six = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3;
    const b = idx[t + 1]! * 3;
    const c = idx[t + 2]! * 3;
    six +=
      p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
      p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
      p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return six / 6;
}

export function meshArea(mesh: TriMesh): number {
  const p = mesh.positions;
  const idx = mesh.indices;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) area += triangleArea(p, idx[t]!, idx[t + 1]!, idx[t + 2]!);
  return area;
}

function triangleArea(p: Float64Array, i0: number, i1: number, i2: number): number {
  const a = i0 * 3;
  const b = i1 * 3;
  const c = i2 * 3;
  const ux = p[b]! - p[a]!;
  const uy = p[b + 1]! - p[a + 1]!;
  const uz = p[b + 2]! - p[a + 2]!;
  const vx = p[c]! - p[a]!;
  const vy = p[c + 1]! - p[a + 1]!;
  const vz = p[c + 2]! - p[a + 2]!;
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

export interface MeshBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function meshBounds(mesh: TriMesh): MeshBounds {
  const p = mesh.positions;
  const b: MeshBounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
  for (let i = 0; i < p.length; i += 3) {
    b.minX = Math.min(b.minX, p[i]!);
    b.maxX = Math.max(b.maxX, p[i]!);
    b.minY = Math.min(b.minY, p[i + 1]!);
    b.maxY = Math.max(b.maxY, p[i + 1]!);
    b.minZ = Math.min(b.minZ, p[i + 2]!);
    b.maxZ = Math.max(b.maxZ, p[i + 2]!);
  }
  return b;
}

export interface ManifoldReport {
  // Every directed edge is matched by exactly one opposite directed edge.
  closed: boolean;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number; // edges whose two triangles disagree on orientation
  degenerateTriangles: number;
  vertices: number; // referenced vertices
  edges: number;
  faces: number;
  eulerCharacteristic: number; // V − E + F; 2 per closed genus-0 component
}

export function checkManifold(mesh: TriMesh): ManifoldReport {
  const idx = mesh.indices;
  const directed = new Map<string, number>();
  const used = new Set<number>();
  let degenerate = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t]!, idx[t + 1]!, idx[t + 2]!];
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) degenerate++;
    if (triangleArea(mesh.positions, tri[0]!, tri[1]!, tri[2]!) < 1e-12) degenerate++;
    for (let e = 0; e < 3; e++) {
      const a = tri[e]!;
      const b = tri[(e + 1) % 3]!;
      used.add(a);
      const key = `${a},${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  const undirected = new Map<string, { forward: number; backward: number }>();
  for (const [key, count] of directed) {
    const [a, b] = key.split(',').map(Number) as [number, number];
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const ukey = `${lo},${hi}`;
    const entry = undirected.get(ukey) ?? { forward: 0, backward: 0 };
    if (a === lo) entry.forward += count;
    else entry.backward += count;
    undirected.set(ukey, entry);
  }
  let boundary = 0;
  let nonManifold = 0;
  let inconsistent = 0;
  for (const { forward, backward } of undirected.values()) {
    const total = forward + backward;
    if (total === 1) boundary++;
    else if (total > 2) nonManifold++;
    else if (forward !== 1 || backward !== 1) inconsistent++;
  }
  const faces = idx.length / 3;
  const edges = undirected.size;
  return {
    closed: boundary === 0 && nonManifold === 0 && inconsistent === 0,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    degenerateTriangles: degenerate,
    vertices: used.size,
    edges,
    faces,
    eulerCharacteristic: used.size - edges + faces,
  };
}

// Closed frustum: a rectangle of length × width at the base (y0) and
// topLength × topWidth at y0 + height, centred on (cx, cz), with the top
// optionally shifted along z (raked fronts). Covers boxes and trapezoid prisms.
export interface FrustumParams {
  cx: number;
  cz: number;
  y0: number;
  length: number; // along z
  width: number; // along x
  height: number;
  topLength?: number;
  topWidth?: number;
  topShiftZ?: number;
}

export function frustumMesh(params: FrustumParams): TriMesh {
  const { cx, cz, y0, length, width, height } = params;
  const tl = params.topLength ?? length;
  const tw = params.topWidth ?? width;
  const tz = cz + (params.topShiftZ ?? 0);
  const y1 = y0 + height;
  // prettier-ignore
  const positions = new Float64Array([
    cx - width / 2, y0, cz - length / 2, cx + width / 2, y0, cz - length / 2,
    cx + width / 2, y0, cz + length / 2, cx - width / 2, y0, cz + length / 2,
    cx - tw / 2, y1, tz - tl / 2, cx + tw / 2, y1, tz - tl / 2,
    cx + tw / 2, y1, tz + tl / 2, cx - tw / 2, y1, tz + tl / 2,
  ]);
  // Outward winding: bottom (−y), top (+y), then the four sides.
  // prettier-ignore
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 7, 6, 4, 6, 5,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { positions, indices };
}

export const boxMesh = (cx: number, cy: number, cz: number, lx: number, ly: number, lz: number): TriMesh =>
  frustumMesh({ cx, cz, y0: cy - ly / 2, length: lz, width: lx, height: ly });
