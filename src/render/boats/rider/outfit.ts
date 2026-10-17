// The rider's outfit, laid out on the character's bind pose (standing, facing +Z, arms out along ±X,
// metres, left side +X; the shapes are mirrored so |x| is used throughout):
//
//  - wetsuit: the body material paints it over everything but the head and neck (above the collar)
//    and the hands (past the cuffs), with neoprene booties, a coloured stripe along the top of each
//    arm and down the outside of each leg, and knee pads. The shaders (materials.ts) compute the same
//    regions from the bind-pose position per fragment, so the edges stay crisp at any distance.
//  - life vest: a padded shell grown off the torso (buildVestShell), skinned with the body's own
//    weights so it bends with the spine; its outline (vestDistance) is cut per fragment.
//
// Pure TS and three geometry, no shaders: the vest is built on the CPU and the regions are tested.

import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { BufferAttribute, BufferGeometry } from 'three/webgpu';

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export const SUIT = {
  collarBack: 1.548, // collar height at the nape…
  collarFront: 1.512, // …and at the throat
  cuffX: 0.685, // |x| of the sleeve cuffs (the wrists are at 0.706)
  bootieY: 0.15, // bootie tops, just above the ankle bones
  soleY: 0.022,
  arm: { y: 1.44, z: -0.068, cos: 0.85 }, // arm axis (bind) and the stripe's half-angle (cos) up top
  // Leg axis: |x|, and depth easing from the shins (z0 below y0) to the thighs (z1 above y1); the
  // stripe's half-angle (cos) and extent.
  leg: { x: 0.108, z0: -0.09, z1: -0.035, y0: 0.35, y1: 0.8, cos: 0.9, top: 1.05, bottom: 0.17 },
  knee: { y0: 0.47, y1: 0.63, cos: 0.5 }, // knee pads: band and frontal half-angle
};

// Leg axis depth (bind z) at a height: the shins sit further back than the thighs.
const legAxisZ = (y: number): number =>
  SUIT.leg.z0 + (SUIT.leg.z1 - SUIT.leg.z0) * smoothstep(SUIT.leg.y0, SUIT.leg.y1, y);

export interface SuitRegion {
  skin: boolean;
  bootie: boolean;
  sole: boolean;
  stripe: boolean;
  knee: boolean;
}

// What the body shader paints at a bind-pose point (hard edges; the shader antialiases them).
export function suitRegion(x: number, y: number, z: number): SuitRegion {
  const ax = Math.abs(x);
  const collar = SUIT.collarBack + (SUIT.collarFront - SUIT.collarBack) * smoothstep(-0.04, 0.06, z);
  const skin = y > collar || (ax > SUIT.cuffX && y > 1.2);
  const bootie = y < SUIT.bootieY;
  // Arm stripe: the top of the sleeve.
  const ay = y - SUIT.arm.y;
  const az = z - SUIT.arm.z;
  const armTop =
    ay / Math.max(1e-6, Math.hypot(ay, az)) > SUIT.arm.cos && ax > 0.19 && ax < SUIT.cuffX && y > 1.3;
  // Leg stripe: the outside of the leg.
  const lx = ax - SUIT.leg.x;
  const lz = z - legAxisZ(y);
  const radial = Math.max(1e-6, Math.hypot(lx, lz));
  const legSide = lx / radial > SUIT.leg.cos && y > SUIT.leg.bottom && y < SUIT.leg.top;
  const knee = !legSide && lz / radial > SUIT.knee.cos && y > SUIT.knee.y0 && y < SUIT.knee.y1;
  return {
    skin,
    bootie: !skin && bootie,
    sole: !skin && y < SUIT.soleY,
    stripe: !skin && !bootie && (armTop || legSide),
    knee: !skin && !bootie && knee,
  };
}

export const VEST = {
  hem: 1.05, // bottom edge, just above the hips
  top: 1.585, // over the shoulders
  neck: { y: 1.565, drop: 0.012, rx: 0.078, ry: 0.085 }, // neck opening (front lower by `drop`)
  armhole: { x: 0.235, y: 1.43, rx: 0.06, ry: 0.14 },
  side: 0.27, // |x| limit: nothing of the arms past the armholes
  thickness: { base: 0.024, front: 0.014, back: 0.006, edge: 0.004 }, // foam, by facing; at the edge
  taper: 0.03, // the padding rounds down to the edge over this width
  binding: 0.008, // edge tape width
  straps: [1.13, 1.245], // webbing strap heights
  strapWidth: 0.032,
};

const ellipseDistance = (dx: number, dy: number, rx: number, ry: number): number =>
  (Math.hypot(dx / rx, dy / ry) - 1) * Math.min(rx, ry);

// Signed distance (m, approximate) to the vest's outline at a bind-pose point: positive on the vest.
export function vestDistance(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const n = VEST.neck;
  const neck = ellipseDistance(x, y - (n.y - n.drop * smoothstep(-0.03, 0.05, z)), n.rx, n.ry);
  const a = VEST.armhole;
  const armhole = ellipseDistance(ax - a.x, y - a.y, a.rx, a.ry);
  return Math.min(y - VEST.hem, VEST.top - y, neck, armhole, VEST.side - ax);
}

// Foam thickness at a point with this bind-pose normal z and outline distance.
export function vestThickness(normalZ: number, distance: number): number {
  const t = VEST.thickness;
  const full = t.base + t.front * Math.max(0, normalZ) + t.back * Math.max(0, -normalZ);
  return t.edge + (full - t.edge) * smoothstep(0, VEST.taper, distance);
}

// The vest shell from the body's bind-pose geometry (position, skinIndex, skinWeight; index): the
// torso triangles near and on the vest, welded across UV seams, pushed out along their normals by
// the foam thickness, smoothed so the muscles underneath don't show through, and kept skinned with
// the body's weights. Returns null if the geometry has no torso.
export function buildVestShell(body: BufferGeometry, smoothing = 10): BufferGeometry | null {
  const source = new BufferGeometry();
  for (const name of ['position', 'skinIndex', 'skinWeight']) {
    const attribute = body.getAttribute(name);
    if (!attribute) return null;
    const array = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++)
      for (let k = 0; k < attribute.itemSize; k++)
        array[i * attribute.itemSize + k] = attribute.getComponent(i, k);
    source.setAttribute(name, new BufferAttribute(array, attribute.itemSize));
  }
  if (body.index) source.setIndex(body.index.clone());
  const welded = mergeVertices(source, 1e-5);
  const position = welded.getAttribute('position');
  const index = welded.index!;
  const count = position.count;
  const distance = new Float32Array(count);
  for (let i = 0; i < count; i++)
    distance[i] = vestDistance(position.getX(i), position.getY(i), position.getZ(i));
  // Triangles touching the vest (with a margin the fragment cut trims away).
  const used = new Int32Array(count).fill(-1);
  const triangles: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    if (Math.max(distance[a]!, distance[b]!, distance[c]!) < -0.012) continue;
    triangles.push(a, b, c);
  }
  if (triangles.length === 0) return null;
  const order: number[] = [];
  for (const v of triangles) if (used[v] === -1) used[v] = order.push(v) - 1;
  const n = order.length;
  const shell = new BufferGeometry();
  const base = new Float32Array(n * 3);
  order.forEach((v, i) => base.set([position.getX(v), position.getY(v), position.getZ(v)], i * 3));
  shell.setAttribute('position', new BufferAttribute(base.slice(), 3));
  for (const name of ['skinIndex', 'skinWeight']) {
    const attribute = welded.getAttribute(name);
    const array = new Float32Array(n * 4);
    order.forEach((v, i) => {
      for (let k = 0; k < 4; k++) array[i * 4 + k] = attribute.getComponent(v, k);
    });
    shell.setAttribute(name, new BufferAttribute(name === 'skinIndex' ? new Uint16Array(array) : array, 4));
  }
  shell.setIndex(triangles.map((v) => used[v]!));
  shell.computeVertexNormals();
  const normal = shell.getAttribute('normal');
  const p = shell.getAttribute('position').array as Float32Array;
  const push = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    push[i] = vestThickness(normal.getZ(i), distance[order[i]!]!);
    for (let k = 0; k < 3; k++) p[i * 3 + k] = base[i * 3 + k]! + normal.getComponent(i, k) * push[i]!;
  }
  // Taubin smoothing (shrink-free), the open border held.
  const neighbours: Set<number>[] = Array.from({ length: n }, () => new Set());
  const edges = new Map<string, number>();
  const tri = shell.index!.array;
  for (let t = 0; t < tri.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tri[t + k]!;
      const b = tri[t + ((k + 1) % 3)]!;
      neighbours[a]!.add(b);
      neighbours[b]!.add(a);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  const border = new Uint8Array(n);
  for (const [key, uses] of edges) if (uses === 1) for (const v of key.split(',')) border[Number(v)] = 1;
  const next = new Float32Array(p.length);
  for (let pass = 0; pass < smoothing * 2; pass++) {
    const factor = pass % 2 === 0 ? 0.5 : -0.53;
    for (let i = 0; i < n; i++) {
      const ring = neighbours[i]!;
      for (let k = 0; k < 3; k++) {
        if (border[i] || ring.size === 0) {
          next[i * 3 + k] = p[i * 3 + k]!;
          continue;
        }
        let sum = 0;
        for (const j of ring) sum += p[j * 3 + k]!;
        next[i * 3 + k] = p[i * 3 + k]! + factor * (sum / ring.size - p[i * 3 + k]!);
      }
    }
    p.set(next);
  }
  // Never closer to the body than the edge thickness.
  for (let i = 0; i < n; i++) {
    let out = 0;
    for (let k = 0; k < 3; k++) out += (p[i * 3 + k]! - base[i * 3 + k]!) * normal.getComponent(i, k);
    const lack = VEST.thickness.edge - out;
    if (lack > 0) for (let k = 0; k < 3; k++) p[i * 3 + k] = p[i * 3 + k]! + normal.getComponent(i, k) * lack;
  }
  shell.computeVertexNormals();
  shell.computeBoundingSphere();
  return shell;
}
