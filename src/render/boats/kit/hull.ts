// Hull assembly from HullLines into a PartBuilder: shell, transom, deck,
// visual bulb nose, rubbing/sheer rails, raised decks (forecastle, whaleback)
// and conformal decals. Resolution per LOD comes from HULL_LOD.

import {
  BufferAttribute,
  BufferGeometry,
  type ColorRepresentation,
  Mesh,
  MeshStandardNodeMaterial,
  type Texture,
  Vector3,
} from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import { normalizeGeometry, type PartBuilder, toGeometry, tube } from './geometry';
import type { HullLines } from './hullLines';
import {
  computeNormals,
  deckSurface,
  hullPatch,
  hullShell,
  type MeshData,
  type PatchOptions,
  stationParameters,
  transomCap,
} from './loft';
import { aoNode, type AoVolume, bodyNormal, bodyPosition } from './materials';
import { SLOTS } from './props';

const { float, mix, texture, uv, vec3 } = tsl;

interface HullResolution {
  stations: number;
  below: number;
  above: number;
  deckAcross: number;
}

const HULL_LOD: readonly HullResolution[] = [
  { stations: 150, below: 22, above: 10, deckAcross: 9 },
  { stations: 56, below: 9, above: 4, deckAcross: 5 },
  { stations: 24, below: 5, above: 3, deckAcross: 3 },
];

interface BulbSpec {
  tipZ: number; // body z of the nose
  length: number; // nose to where it disappears into the hull
  halfWidth: number;
  halfHeight: number;
  centreY: number; // body y of the axis
}

export interface HullAssemblyOptions {
  lod: number;
  resolution?: Partial<HullResolution>;
  deck?: boolean | { camber?: number; sFrom?: number; sTo?: number; slot?: string };
  bulb?: BulbSpec;
  sheerRail?: { radius: number; slot?: string; drop?: number };
  rubbing?: { y: number; radius: number; sFrom?: number; sTo?: number; slot?: string }[]; // rub rails (fishing boats)
  transom?: boolean;
  smoothAlong?: number; // see ShellOptions.smoothAlong
}

export function addHull(b: PartBuilder, lines: HullLines, o: HullAssemblyOptions): void {
  const res = { ...HULL_LOD[Math.min(o.lod, HULL_LOD.length - 1)]!, ...o.resolution };
  b.addData(
    SLOTS.hull,
    hullShell(lines, {
      stations: res.stations,
      below: res.below,
      above: res.above,
      smoothAlong: o.smoothAlong,
    }),
  );
  if (o.transom ?? true) {
    const cap = transomCap(lines, res.below, res.above);
    if (cap.indices.length > 0) b.addData(SLOTS.hull, cap);
  }
  if (o.deck ?? true) {
    const d = typeof o.deck === 'object' ? o.deck : {};
    b.addData(
      d.slot ?? SLOTS.deck,
      deckSurface(lines, {
        stations: Math.max(12, Math.round(res.stations * 0.6)),
        across: res.deckAcross,
        camber: d.camber ?? 0,
        sFrom: d.sFrom,
        sTo: d.sTo,
      }),
    );
  }
  if (o.bulb)
    b.addData(SLOTS.hull, bulbNose(o.bulb, o.lod === 0 ? 28 : o.lod === 1 ? 12 : 6, o.lod === 0 ? 20 : 8));
  if (o.sheerRail && o.lod < 2) {
    const r = o.sheerRail;
    for (const side of [-1, 1]) {
      const pts = stationParameters(o.lod === 0 ? 60 : 20, 0.004, 0.996).map((s) => {
        const z = lines.zAt(s);
        return new Vector3(side * (lines.deckHalf(z) + r.radius * 0.3), lines.deckY(z) - (r.drop ?? 0), z);
      });
      b.add(r.slot ?? SLOTS.hull, tube(pts, r.radius, { radial: 6, segments: pts.length * 2 }));
    }
  }
  for (const rub of o.rubbing ?? []) {
    if (o.lod >= 2) continue;
    for (const side of [-1, 1]) {
      const pts: Vector3[] = [];
      for (const s of stationParameters(o.lod === 0 ? 50 : 16, rub.sFrom ?? 0.02, rub.sTo ?? 0.995)) {
        const z = lines.zAt(s);
        const x = lines.halfBreadthAt(z, rub.y);
        if (x > 0.05) pts.push(new Vector3(side * (x + rub.radius * 0.4), rub.y, z));
      }
      if (pts.length > 2)
        b.add(rub.slot ?? SLOTS.black, tube(pts, rub.radius, { radial: 6, segments: pts.length * 2 }));
    }
  }
}

// Ellipsoidal bulb nose (axis along z) that merges into the forefoot.
function bulbNose(spec: BulbSpec, along = 24, around = 16): MeshData {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= along; i++) {
    const t = i / along;
    // Round nose (quarter ellipse) over the first 40%, then constant section.
    const k = Math.min(1, t / 0.4);
    const scale = Math.sqrt(Math.max(0, 1 - (1 - k) * (1 - k)));
    const z = spec.tipZ + t * spec.length;
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      // Flattened bottom so it reads as a ship bulb rather than a torpedo.
      const sy = Math.sin(a);
      const ys = sy < 0 ? sy * 0.85 : sy;
      positions.push(Math.cos(a) * spec.halfWidth * scale, spec.centreY + ys * spec.halfHeight * scale, z);
      uvs.push(z, j / around);
    }
  }
  const cols = around + 1;
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * cols + j;
      const b2 = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b2, b2, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: computeNormals(positions, indices),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

// Raised deck (forecastle, whaleback, upper hull): the shell carried up by `height` between two
// stations, with its own deck on top and an aft bulkhead. `rake` (m forward per m up) continues a
// raked stem upward by shifting the plan forward with height (bow flare); `crown` rounds the top.
export function raisedDeck(
  lines: HullLines,
  o: {
    sFrom: number;
    sTo: number;
    height: (z: number) => number;
    stations: number;
    crown?: number;
    flare?: number;
    across?: number;
    rake?: number;
    rows?: number;
  },
): { sides: MeshData; top: MeshData; bulkhead: MeshData } {
  const across = o.across ?? 9;
  const flare = o.flare ?? 0.06;
  const rake = o.rake ?? 0;
  const rows = o.rows ?? (rake > 0 ? 6 : 1);
  const zs = stationParameters(o.stations, o.sFrom, o.sTo).map((s) => lines.zAt(s));
  if (rake > 0 && o.sFrom <= 0) {
    const ahead = rake * o.height(lines.zBow);
    const n = Math.max(2, Math.round(rows * 1.5));
    for (let k = 1; k <= n; k++) zs.unshift(lines.zBow - (ahead * k) / n);
  }
  const clampZ = (z: number): number => Math.min(lines.zStern, Math.max(lines.zBow, z));
  const halfAt = (z: number, dy: number): number => {
    const zz = z + rake * dy;
    return zz < lines.zBow ? 0 : lines.deckHalf(clampZ(zz)) + flare * dy;
  };
  const sidesPos: number[] = [];
  const sidesUv: number[] = [];
  const sidesIdx: number[] = [];
  const topPos: number[] = [];
  const topUv: number[] = [];
  const topIdx: number[] = [];
  const R = 2 * (rows + 1);
  zs.forEach((z, i) => {
    const zc = clampZ(z);
    const y0 = lines.deckY(zc);
    const h = o.height(zc);
    for (const side of [-1, 1]) {
      for (let k = 0; k <= rows; k++) {
        const dy = (h * k) / rows;
        sidesPos.push(side * halfAt(z, dy), y0 + dy, z);
        sidesUv.push(z, y0 + dy);
      }
    }
    const xt = halfAt(z, h);
    for (let k = 0; k < across; k++) {
      const u = -1 + (2 * k) / (across - 1);
      topPos.push(u * xt, y0 + h + (o.crown ?? 0) * (1 - u * u) * Math.min(1, xt), z);
      topUv.push(u * xt, z);
    }
    if (i + 1 < zs.length) {
      for (const [side, base] of [
        [-1, 0],
        [1, rows + 1],
      ] as const) {
        for (let k = 0; k < rows; k++) {
          const a = i * R + base + k;
          const b2 = a + 1;
          const c = a + R;
          const d = c + 1;
          if (side > 0) sidesIdx.push(a, b2, c, b2, d, c);
          else sidesIdx.push(a, c, b2, b2, c, d);
        }
      }
      for (let k = 0; k + 1 < across; k++) {
        const a = i * across + k;
        const b2 = a + 1;
        const c = a + across;
        const d = c + 1;
        topIdx.push(a, c, b2, b2, c, d);
      }
    }
  });
  // Aft bulkhead: a vertical face at sTo following the crowned top.
  const zA = lines.zAt(o.sTo);
  const hA = o.height(zA);
  const yA = lines.deckY(zA);
  const xTop = halfAt(zA, hA);
  const bhPos: number[] = [];
  const bhUv: number[] = [];
  const bhIdx: number[] = [];
  for (let k = 0; k < across; k++) {
    const u = -1 + (2 * k) / (across - 1);
    const x = u * xTop;
    const xFoot = u * lines.deckHalf(zA);
    bhPos.push(xFoot, yA, zA, x, yA + hA + (o.crown ?? 0) * (1 - u * u) * Math.min(1, xTop), zA);
    bhUv.push(x, yA, x, yA + hA);
    if (k + 1 < across) {
      const a = k * 2;
      bhIdx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const pack = (p: number[], u: number[], i: number[]): MeshData => ({
    positions: new Float32Array(p),
    normals: computeNormals(p, i),
    uvs: new Float32Array(u),
    indices: new Uint32Array(i),
  });
  return {
    sides: pack(sidesPos, sidesUv, sidesIdx),
    top: pack(topPos, topUv, topIdx),
    bulkhead: pack(bhPos, bhUv, bhIdx),
  };
}

// Decal materials by texture and AO volume, so the decals sharing a texture (port and starboard)
// share a material and merge into one mesh (assemble.ts, mergeDecals).
const decalMaterials = new WeakMap<Texture, Map<AoVolume | null, MeshStandardNodeMaterial>>();

function sharedDecalMaterial(map: Texture, ao: AoVolume | null | undefined): MeshStandardNodeMaterial {
  let byAo = decalMaterials.get(map);
  if (!byAo) {
    byAo = new Map();
    decalMaterials.set(map, byAo);
  }
  let material = byAo.get(ao ?? null);
  if (!material) {
    material = decalMaterial(map, { ao });
    byAo.set(ao ?? null, material);
  }
  return material;
}

// Painted lettering / marks that hug the hull (alpha-tested, AO-shaded).
export function decalMaterial(
  map: Texture,
  o: { ao?: AoVolume | null; roughness?: number; tint?: ColorRepresentation } = {},
): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'decal';
  const tex = texture(map, uv());
  const ao: N = aoNode(o.ao, bodyPosition(), bodyNormal());
  m.colorNode = tex.rgb.mul(mix(float(0.82), float(1), ao)).mul(vec3(0.92));
  m.opacityNode = tex.a;
  m.alphaTest = 0.45;
  m.roughness = o.roughness ?? 0.5;
  m.aoNode = ao;
  return m;
}

export function hullDecal(lines: HullLines, map: Texture, patch: PatchOptions, ao?: AoVolume | null): Mesh {
  const mesh = new Mesh(toGeometry(hullPatch(lines, patch)), sharedDecalMaterial(map, ao));
  mesh.receiveShadow = true;
  mesh.name = 'decal';
  return mesh;
}

// Flat decal quad (transoms, house fronts): centre, size, facing +normal axis.
export function flatDecal(map: Texture, w: number, h: number, ao?: AoVolume | null): Mesh {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0, -w / 2, h / 2, 0]),
      3,
    ),
  );
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const mesh = new Mesh(normalizeGeometry(g), sharedDecalMaterial(map, ao));
  mesh.receiveShadow = true;
  mesh.name = 'decal';
  return mesh;
}

// Triangle soup (9 floats per triangle) from a geometry, for AO voxelisation.
export function triangleSoup(geometry: BufferGeometry): Float32Array {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const v = index ? index.getX(i) : i;
    out[i * 3] = pos.getX(v);
    out[i * 3 + 1] = pos.getY(v);
    out[i * 3 + 2] = pos.getZ(v);
  }
  return out;
}
