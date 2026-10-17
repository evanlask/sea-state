// Instancing helpers: pure layout generators (container bays, crab-pot stacks,
// evenly spaced repeats along a path) and a builder that turns a layout into one
// static mesh with per-instance attributes baked per vertex.

import {
  BufferAttribute,
  BufferGeometry,
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three/webgpu';

// Deterministic PRNG (mulberry32) so layouts and liveries are stable per seed.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- containers

export const TEU_LENGTH = 6.058; // 20 ft
export const FEU_LENGTH = 12.192; // 40 ft
export const CONTAINER_WIDTH = 2.438;
export const CONTAINER_HEIGHT = 2.591; // standard; high cubes 2.896
export const HIGH_CUBE_HEIGHT = 2.896;

export interface ContainerBay {
  z: number; // bay centre, body z
  rows: number; // containers across (odd = one on the centreline)
  tiers: number; // max tiers on deck
  baseY: number; // hatch cover top, body y
  twenty?: boolean; // two 20 ft per slot instead of one 40 ft
}

export interface ContainerSlot {
  x: number;
  y: number; // bottom of the box
  z: number;
  length: number;
  height: number;
  livery: number; // index into the livery table
  tint: number; // 0..1 fade/brightness jitter
}

export interface ContainerLayoutOptions {
  seed: number;
  liveries: number;
  fill?: number; // 0..1 share of slots occupied (stacks stop early)
  highCubeShare?: number;
  rowGap?: number; // m between rows
}

// Stacks per bay: tiers taper toward the sides and vary per stack, a few slots stay empty, and
// liveries come in runs (same line, consecutive stacks) the way real stowage looks.
export function layoutContainers(
  bays: readonly ContainerBay[],
  options: ContainerLayoutOptions,
): ContainerSlot[] {
  const random = rng(options.seed);
  const gap = options.rowGap ?? 0.03;
  const fill = options.fill ?? 0.92;
  const out: ContainerSlot[] = [];
  let livery = Math.floor(random() * options.liveries);
  for (const bay of bays) {
    for (let r = 0; r < bay.rows; r++) {
      const x = (r - (bay.rows - 1) / 2) * (CONTAINER_WIDTH + gap);
      const edge = Math.abs(r - (bay.rows - 1) / 2) / Math.max(1, (bay.rows - 1) / 2);
      let tiers = bay.tiers;
      if (edge > 0.8) tiers -= random() < 0.5 ? 1 : 0;
      if (random() > fill) tiers = Math.max(0, tiers - 1 - Math.floor(random() * 3));
      let y = bay.baseY;
      for (let t = 0; t < tiers; t++) {
        if (random() < 0.3) livery = Math.floor(random() * options.liveries);
        const high = random() < (options.highCubeShare ?? 0.35);
        const height = high ? HIGH_CUBE_HEIGHT : CONTAINER_HEIGHT;
        if (bay.twenty) {
          for (const dz of [-1, 1]) {
            out.push({
              x,
              y,
              z: bay.z + (dz * (TEU_LENGTH + 0.076)) / 2,
              length: TEU_LENGTH,
              height,
              livery: random() < 0.5 ? livery : Math.floor(random() * options.liveries),
              tint: random(),
            });
          }
        } else {
          out.push({ x, y, z: bay.z, length: FEU_LENGTH, height, livery, tint: random() });
        }
        y += height;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- crab pots

export const POT_SIZE = 2.134; // 7 ft
export const POT_HEIGHT = 0.914; // 3 ft

export interface PotStackOptions {
  count: number;
  z0: number; // aft-most row centre limit
  z1: number; // forward-most limit (z1 < z0 not required)
  halfWidth: number; // usable half-breadth of the deck
  deckY: number;
  maxTiers: number;
  seed: number;
  gap?: number;
}

export interface PotSlot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

// Pots fill the deck row by row from aft, tier by tier, staying within the deck footprint.
export function layoutPots(options: PotStackOptions): PotSlot[] {
  const gap = options.gap ?? 0.06;
  const pitch = POT_SIZE + gap;
  const zMin = Math.min(options.z0, options.z1);
  const zMax = Math.max(options.z0, options.z1);
  const across = Math.max(1, Math.floor((2 * options.halfWidth + gap) / pitch));
  const along = Math.max(1, Math.floor((zMax - zMin + gap) / pitch));
  const random = rng(options.seed);
  const out: PotSlot[] = [];
  for (let t = 0; t < options.maxTiers && out.length < options.count; t++) {
    for (let a = 0; a < along && out.length < options.count; a++) {
      for (let c = 0; c < across && out.length < options.count; c++) {
        out.push({
          x: (c - (across - 1) / 2) * pitch + (random() - 0.5) * 0.05,
          y: options.deckY + t * (POT_HEIGHT + 0.01),
          z: zMax - POT_SIZE / 2 - a * pitch + (random() - 0.5) * 0.05,
          yaw: (random() - 0.5) * 0.02,
        });
      }
    }
  }
  return out;
}

export const potCapacity = (options: Omit<PotStackOptions, 'count' | 'seed'>): number => {
  const gap = options.gap ?? 0.06;
  const pitch = POT_SIZE + gap;
  const across = Math.max(1, Math.floor((2 * options.halfWidth + gap) / pitch));
  const along = Math.max(1, Math.floor((Math.abs(options.z1 - options.z0) + gap) / pitch));
  return across * along * options.maxTiers;
};

// Evenly spaced positions along a polyline, starting half a spacing in (stanchions, windows, boats).
export function spacedAlong(
  points: readonly [number, number][],
  spacing: number,
  inset = 0,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  let carry = spacing / 2 + inset;
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, az] = points[i]!;
    const [bx, bz] = points[i + 1]!;
    const len = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(bx - ax, bz - az);
    let d = carry;
    while (d <= len) {
      const t = d / len;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t, yaw]);
      d += spacing;
    }
    carry = d - len;
  }
  return out;
}

// ------------------------------------------------------------------ builders

export interface InstanceSpec {
  matrices: Matrix4[];
  attributes?: Record<string, { itemSize: number; data: Float32Array }>;
}

// Static repeats (container stacks, pots, balconies, lifeboats) become one merged mesh rather than
// an InstancedMesh. three r186 keys every InstancedMesh's render object by its uuid and, below 1024
// instances, declares its matrices as a uniform buffer named after a fresh node id, so each clone of
// each LOD in each boat compiled its own shader and pipeline the first time it was drawn: fleet boats
// changing LOD or swinging into view stalled the GPU process for 0.5–1.6 s. A plain mesh shares the
// template's cached pipeline with every clone. Per-instance attributes become per-vertex attributes
// of the same name, so materials reading attribute('aColor') work unchanged.
export function instanced(
  geometry: BufferGeometry,
  material: Material,
  spec: InstanceSpec,
  options: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
): Mesh {
  const mesh = new Mesh(
    spec.matrices.length > 0 ? bakeInstances(geometry, spec) : geometry.clone(),
    material,
  );
  mesh.visible = spec.matrices.length > 0;
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? true;
  mesh.name = options.name ?? material.name;
  mesh.geometry.computeBoundingSphere();
  return mesh;
}

const normalMatrix = new Matrix3();
const scratch = new Vector3();

// One geometry holding every instance: positions and normals (and tangents) transformed by the
// instance matrices, other vertex attributes copied, instance attributes repeated per vertex.
export function bakeInstances(geometry: BufferGeometry, spec: InstanceSpec): BufferGeometry {
  const instances = spec.matrices.length;
  const vertices = geometry.getAttribute('position').count;
  const total = instances * vertices;
  const out = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    const size = attribute.itemSize;
    const data = new Float32Array(total * size);
    spec.matrices.forEach((matrix, k) => {
      normalMatrix.getNormalMatrix(matrix);
      const base = k * vertices;
      for (let i = 0; i < vertices; i++) {
        const o = (base + i) * size;
        if (name === 'position') {
          scratch.fromBufferAttribute(attribute, i).applyMatrix4(matrix);
        } else if (name === 'normal' || name === 'tangent') {
          scratch.fromBufferAttribute(attribute, i).applyMatrix3(normalMatrix).normalize();
        } else {
          for (let c = 0; c < size; c++) data[o + c] = attribute.getComponent(i, c);
          continue;
        }
        data[o] = scratch.x;
        data[o + 1] = scratch.y;
        data[o + 2] = scratch.z;
        if (size === 4) data[o + 3] = attribute.getComponent(i, 3); // tangent handedness
      }
    });
    out.setAttribute(name, new BufferAttribute(data, size, attribute.normalized));
  }
  for (const [name, attribute] of Object.entries(spec.attributes ?? {})) {
    const size = attribute.itemSize;
    const data = new Float32Array(total * size);
    for (let k = 0; k < instances; k++) {
      const value = attribute.data.subarray(k * size, (k + 1) * size);
      for (let i = 0; i < vertices; i++) data.set(value, (k * vertices + i) * size);
    }
    out.setAttribute(name, new BufferAttribute(data, size));
  }
  const index = geometry.getIndex();
  if (index) {
    const n = index.count;
    const indices = total > 65535 ? new Uint32Array(n * instances) : new Uint16Array(n * instances);
    for (let k = 0; k < instances; k++) {
      for (let i = 0; i < n; i++) indices[k * n + i] = index.getX(i) + k * vertices;
    }
    out.setIndex(new BufferAttribute(indices, 1));
  }
  return out;
}

const tq = new Quaternion();
const ts = new Vector3();
const tp = new Vector3();
const Y = new Vector3(0, 1, 0);

export function placement(x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1): Matrix4 {
  return new Matrix4().compose(tp.set(x, y, z), tq.setFromAxisAngle(Y, yaw), ts.set(sx, sy, sz));
}

// Container box (origin at the bottom centre, length along z, doors at +z) with metric face UVs
// and an aFace attribute: 0 long side, 1 door end, 2 front end, 3 roof/floor.
export function containerGeometry(length: number, height: number, width = CONTAINER_WIDTH): BufferGeometry {
  const hx = width / 2;
  const hz = length / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const faces: number[] = [];
  const indices: number[] = [];
  const quad = (p: number[][], n: number[], uv: number[][], face: number): void => {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      positions.push(...p[i]!);
      normals.push(...n);
      uvs.push(...uv[i]!);
      faces.push(face);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const h = height;
  // +x side (u runs aft→fwd as seen from starboard), −x side.
  quad(
    [
      [hx, 0, hz],
      [hx, 0, -hz],
      [hx, h, -hz],
      [hx, h, hz],
    ],
    [1, 0, 0],
    [
      [0, 0],
      [length, 0],
      [length, h],
      [0, h],
    ],
    0,
  );
  quad(
    [
      [-hx, 0, -hz],
      [-hx, 0, hz],
      [-hx, h, hz],
      [-hx, h, -hz],
    ],
    [-1, 0, 0],
    [
      [0, 0],
      [length, 0],
      [length, h],
      [0, h],
    ],
    0,
  );
  quad(
    [
      [-hx, 0, hz],
      [hx, 0, hz],
      [hx, h, hz],
      [-hx, h, hz],
    ],
    [0, 0, 1],
    [
      [0, 0],
      [width, 0],
      [width, h],
      [0, h],
    ],
    1,
  );
  quad(
    [
      [hx, 0, -hz],
      [-hx, 0, -hz],
      [-hx, h, -hz],
      [hx, h, -hz],
    ],
    [0, 0, -1],
    [
      [0, 0],
      [width, 0],
      [width, h],
      [0, h],
    ],
    2,
  );
  quad(
    [
      [-hx, h, hz],
      [hx, h, hz],
      [hx, h, -hz],
      [-hx, h, -hz],
    ],
    [0, 1, 0],
    [
      [0, 0],
      [width, 0],
      [width, length],
      [0, length],
    ],
    3,
  );
  quad(
    [
      [-hx, 0, -hz],
      [hx, 0, -hz],
      [hx, 0, hz],
      [-hx, 0, hz],
    ],
    [0, -1, 0],
    [
      [0, 0],
      [width, 0],
      [width, length],
      [0, length],
    ],
    3,
  );
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setAttribute('aFace', new BufferAttribute(new Float32Array(faces), 1));
  g.setIndex(indices);
  return g;
}
