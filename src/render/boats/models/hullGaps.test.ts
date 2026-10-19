// No see-through gaps in the procedural jet ski, center console and hydroplane hulls, and a water mask
// that keeps the sea out of their open wells (the hydroplane's: the cockpit tub under its canopy) and
// off the crab boat's deck.
//
// The see-through check is a small software rasteriser over each LOD's static structure (the
// PartBuilder geometry: hull, decks, liners, fittings): a pixel where some surface is hit but every
// hit is a back face of a single-sided material shows whatever is behind the boat — the sea — through
// a gap (a slot between parts, an open end, an inverted face). The parts are sampled separately and
// meet at T-junctions, so this looks for gaps rather than for open edges in a welded mesh. Pixels on
// the silhouette and lone pixels are skipped (the rasteriser isn't watertight at shared edges).

import { type BufferGeometry, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { crabSpec } from '../../../sim/boats/specs/crab';
import { powerboatSpec } from '../../../sim/boats/specs/powerboat';
import { pwcSpec } from '../../../sim/boats/specs/pwc';
import { RHO_SEAWATER } from '../../../sim/core/units';
import type { ModelDraft } from '../kit/assemble';
import { createHullLines } from '../kit/hullLines';
import { BULWARK_FROM, BULWARK_H, deckWellMask } from './crab';
import { CAPSULE, capsuleSill, hydroDraft } from './hydro';
import { BOW_SOLE_Y, CASTING_AFT, GUNWALE, powerboatDraft, SOLE_Y, STEP_Z, TRANSOM_IN } from './powerboat';
import { pwcDraft } from './pwc';
import { FOOT_AFT, FOOT_FRONT, FOOT_Y, SEAT_HW } from './pwcLayout';

const DOUBLE_SIDED = new Set(['glass']);

interface Soup {
  tris: Float32Array; // 9 floats per triangle
  double: Uint8Array;
}

function soup(draft: ModelDraft, lod: number): Soup {
  const builder = draft.lods[lod]!.builder;
  const tris: number[] = [];
  const double: number[] = [];
  for (const slot of builder.slots()) {
    const g = builder.merged(slot)!;
    const p = g.getAttribute('position');
    const index = g.index!;
    for (let t = 0; t < index.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = index.getX(t + k);
        tris.push(p.getX(i), p.getY(i), p.getZ(i));
      }
      double.push(DOUBLE_SIDED.has(slot) ? 1 : 0);
    }
  }
  return { tris: new Float32Array(tris), double: new Uint8Array(double) };
}

// See-through pixels (off the silhouette) in an orthographic view along dir of a square window.
function seeThrough(s: Soup, dir: Vector3, center: Vector3, extent: number, size: number): number {
  const d = dir.clone().normalize();
  const upRef = Math.abs(d.y) > 0.95 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const right = d.clone().cross(upRef).normalize();
  const up = right.clone().cross(d);
  const all = new Float32Array(size * size).fill(Infinity);
  const shown = new Float32Array(size * size).fill(Infinity);
  const q = new Vector3();
  const sx = new Float64Array(3);
  const sy = new Float64Array(3);
  const sz = new Float64Array(3);
  for (let t = 0; t < s.double.length; t++) {
    const o = t * 9;
    for (let k = 0; k < 3; k++) {
      q.set(s.tris[o + k * 3]!, s.tris[o + k * 3 + 1]!, s.tris[o + k * 3 + 2]!).sub(center);
      sx[k] = (0.5 + q.dot(right) / extent) * size;
      sy[k] = (0.5 - q.dot(up) / extent) * size;
      sz[k] = q.dot(d);
    }
    const area = (sx[1]! - sx[0]!) * (sy[2]! - sy[0]!) - (sx[2]! - sx[0]!) * (sy[1]! - sy[0]!);
    if (Math.abs(area) < 1e-12) continue;
    // Counter-clockwise in body space seen from the camera is clockwise on this y-down raster.
    const front = s.double[t] === 1 || area < 0;
    const x0 = Math.max(0, Math.floor(Math.min(sx[0]!, sx[1]!, sx[2]!)));
    const x1 = Math.min(size - 1, Math.ceil(Math.max(sx[0]!, sx[1]!, sx[2]!)));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0]!, sy[1]!, sy[2]!)));
    const y1 = Math.min(size - 1, Math.ceil(Math.max(sy[0]!, sy[1]!, sy[2]!)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w0 = ((sx[1]! - px) * (sy[2]! - py) - (sx[2]! - px) * (sy[1]! - py)) / area;
        const w1 = ((sx[2]! - px) * (sy[0]! - py) - (sx[0]! - px) * (sy[2]! - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
        const z = w0 * sz[0]! + w1 * sz[1]! + w2 * sz[2]!;
        const i = y * size + x;
        if (z < all[i]!) all[i] = z;
        if (front && z < shown[i]!) shown[i] = z;
      }
    }
  }
  const gap = (i: number): boolean => all[i] !== Infinity && shown[i] === Infinity;
  let n = 0;
  for (let y = 2; y + 2 < size; y++) {
    for (let x = 2; x + 2 < size; x++) {
      const i = y * size + x;
      if (!gap(i)) continue;
      const enclosed = [i - 1, i + 1, i - size, i + size].every((j) => all[j] !== Infinity);
      // A lone pixel is a crack in this rasteriser, not in the model; a gap runs on.
      const runs = [
        i - 1,
        i + 1,
        i - size,
        i + size,
        i - size - 1,
        i - size + 1,
        i + size - 1,
        i + size + 1,
      ].some(gap);
      if (enclosed && runs) n++;
    }
  }
  return n;
}

// Directions spread over the sphere (Fibonacci), optionally only those with a component along `toward`.
function directions(n: number, toward?: Vector3): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const v = new Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
    if (!toward || v.dot(toward) > 0.2) out.push(v);
  }
  return out;
}

const MODELS = [
  {
    kind: 'pwc',
    draft: pwcDraft(),
    center: new Vector3(0, 0.2, 0),
    extent: 3.8,
    // The stern: transom, platform, pump exit, sponsons and strake ends, seen from aft.
    zoom: { center: new Vector3(0, 0.2, 1.4), extent: 1.4, toward: new Vector3(0, 0, -1) },
  },
  {
    kind: 'powerboat',
    draft: powerboatDraft(),
    center: new Vector3(0, 0.8, 0),
    extent: 11.6,
    // The bow: stem, casting deck and its front, bow well and seats, seen from forward and from aft.
    zoom: { center: new Vector3(0, 1.0, -3.6), extent: 3.2 },
  },
  {
    kind: 'hydro',
    draft: hydroDraft(),
    center: new Vector3(0, 0.6, 0.2),
    extent: 10.8,
    // The capsule: through the canopy into the cockpit tub, the intake scoop's mouth behind it.
    zoom: { center: new Vector3(0, 0.9, -2.2), extent: 3.0 },
  },
] as const;

describe('hull see-through gaps', () => {
  for (const m of MODELS) {
    for (const lod of [0, 1, 2]) {
      it(`${m.kind} LOD${lod} shows no sea through its structure`, () => {
        const s = soup(m.draft, lod);
        let n = 0;
        for (const dir of directions(40)) n += seeThrough(s, dir, m.center, m.extent, 320);
        const z = m.zoom;
        for (const dir of directions(60, 'toward' in z ? z.toward : undefined))
          n += seeThrough(s, dir, z.center, z.extent, 320);
        expect(n).toBe(0);
      });
    }
  }
});

// ------------------------------------------------------------------- water mask

// The mask's separate volumes (the physics hull, the wells), as triangle soups with welded topology.
function volumes(g: BufferGeometry): { tris: number[][]; ids: number[][] }[] {
  const p = g.getAttribute('position');
  const index = g.index!;
  const weld = new Map<string, number>();
  const vid = (i: number): number => {
    const key = `${Math.round(p.getX(i) * 1e5)},${Math.round(p.getY(i) * 1e5)},${Math.round(p.getZ(i) * 1e5)}`;
    let id = weld.get(key);
    if (id === undefined) weld.set(key, (id = weld.size));
    return id;
  };
  const tris: { ids: number[]; pos: number[] }[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const ids = [0, 1, 2].map((k) => vid(index.getX(t + k)));
    const pos = [0, 1, 2].flatMap((k) => {
      const i = index.getX(t + k);
      return [p.getX(i), p.getY(i), p.getZ(i)];
    });
    if (new Set(ids).size === 3) tris.push({ ids, pos });
  }
  const parent = Array.from({ length: weld.size }, (_, i) => i);
  const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
  for (const t of tris) for (const id of t.ids) parent[find(id)] = find(t.ids[0]!);
  const groups = new Map<number, { tris: number[][]; ids: number[][] }>();
  for (const t of tris) {
    const root = find(t.ids[0]!);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = { tris: [], ids: [] }));
    group.tris.push(t.pos);
    group.ids.push(t.ids);
  }
  return [...groups.values()];
}

// Ray parity along a slightly tilted +y.
function inside(tris: number[][], x: number, y: number, z: number): boolean {
  const dir = [0.0123, 1, 0.0071] as const;
  let n = 0;
  for (const t of tris) {
    const e1 = [t[3]! - t[0]!, t[4]! - t[1]!, t[5]! - t[2]!];
    const e2 = [t[6]! - t[0]!, t[7]! - t[1]!, t[8]! - t[2]!];
    const h = [
      dir[1] * e2[2]! - dir[2] * e2[1]!,
      dir[2] * e2[0]! - dir[0] * e2[2]!,
      dir[0] * e2[1]! - dir[1] * e2[0]!,
    ];
    const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
    if (Math.abs(det) < 1e-12) continue;
    const s = [x - t[0]!, y - t[1]!, z - t[2]!];
    const u = (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!) / det;
    if (u < 0 || u > 1) continue;
    const q = [
      s[1]! * e1[2]! - s[2]! * e1[1]!,
      s[2]! * e1[0]! - s[0]! * e1[2]!,
      s[0]! * e1[1]! - s[1]! * e1[0]!,
    ];
    const v = (dir[0] * q[0]! + dir[1] * q[1]! + dir[2] * q[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det > 0) n++;
  }
  return n % 2 === 1;
}

// Each separate volume of a water mask is closed, consistently wound and faces outward.
function expectClosedOutward(mask: BufferGeometry): void {
  for (const v of volumes(mask)) {
    const edges = new Map<string, number>();
    for (const [a, b, c] of v.ids) {
      for (const [u, w] of [
        [a!, b!],
        [b!, c!],
        [c!, a!],
      ]) {
        const key = `${u},${w}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    // Each directed edge once and its reverse once: closed and consistently wound.
    for (const [key, count] of edges) {
      const [u, w] = key.split(',');
      expect(count).toBe(1);
      expect(edges.get(`${w},${u}`)).toBe(1);
    }
    let volume = 0;
    for (const t of v.tris) {
      volume +=
        (t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) -
          t[1]! * (t[3]! * t[8]! - t[5]! * t[6]!) +
          t[2]! * (t[3]! * t[7]! - t[4]! * t[6]!)) /
        6;
    }
    expect(volume).toBeGreaterThan(0);
  }
}

const DEG = Math.PI / 180;

interface Well {
  z0: number;
  z1: number;
  x0: (z: number) => number;
  x1: (z: number) => number;
  floor: number;
  rim: (z: number) => number; // top of the well's sides (gunwale, footwell lip)
}

describe('water mask', () => {
  const pwcLines = createHullLines(pwcSpec.hull, pwcSpec.mass / RHO_SEAWATER);
  const pbLines = createHullLines(powerboatSpec.hull, powerboatSpec.mass / RHO_SEAWATER);
  const xin = (z: number): number => pbLines.deckHalf(z) - GUNWALE;
  const wells: Record<(typeof MODELS)[number]['kind'], Well[]> = {
    // The footwells, from beside the seat pedestal out to the raised lip, up to the lip's top.
    pwc: [
      {
        z0: FOOT_FRONT,
        z1: FOOT_AFT,
        x0: () => SEAT_HW + 0.04,
        x1: (z) => pwcLines.deckHalf(z) - 0.07,
        floor: FOOT_Y,
        rim: (z) => pwcLines.deckY(z) + 0.085,
      },
    ],
    // The bow well and the main cockpit, inside the covering boards, up to the gunwale.
    powerboat: [
      { z0: CASTING_AFT, z1: STEP_Z, x0: () => 0, x1: xin, floor: BOW_SOLE_Y, rim: (z) => pbLines.deckY(z) },
      { z0: STEP_Z, z1: TRANSOM_IN, x0: () => 0, x1: xin, floor: SOLE_Y, rim: (z) => pbLines.deckY(z) },
    ],
    // The cockpit tub, from its floor in the hull up to the canopy's sill.
    hydro: [
      {
        z0: CAPSULE.front + 0.1,
        z1: CAPSULE.aft - 0.1,
        x0: () => 0,
        x1: () => 0.36,
        floor: CAPSULE.floor + 0.08,
        rim: (z) => capsuleSill(z) - 0.04,
      },
    ],
  };

  for (const m of MODELS) {
    it(`${m.kind}: every volume is closed and wound outward`, () => {
      expectClosedOutward(m.draft.waterMask);
    });

    // The mask is in the body frame; the sea is level. Bow up (planing) to bow down (into a wave), at
    // heights from the well's floor to its rim: wherever the sea surface would cross a well below its
    // rim, it must be inside the mask (so the ocean isn't drawn there).
    it(`${m.kind}: keeps the sea out of the open wells up to their rims at any trim`, () => {
      const vs = volumes(m.draft.waterMask);
      const misses: string[] = [];
      for (const well of wells[m.kind]) {
        for (const trim of [-6, 0, 6, 10]) {
          const sin = Math.sin(trim * DEG);
          const cos = Math.cos(trim * DEG);
          for (let k = 0; k <= 6; k++) {
            // A sea level (body-frame height at the well's middle) from the floor to the rim.
            const zm = (well.z0 + well.z1) / 2;
            const h = (well.floor + ((well.rim(zm) - well.floor) * k) / 6) * cos - zm * sin;
            for (let i = 0; i <= 12; i++) {
              const z = well.z0 + 0.02 + ((well.z1 - well.z0 - 0.04) * i) / 12;
              const y = (h + z * sin) / cos;
              if (y < well.floor + 0.01 || y > well.rim(z) - 0.01) continue;
              for (let j = 0; j <= 4; j++) {
                const x = well.x0(z) + ((well.x1(z) - 0.01 - well.x0(z)) * j) / 4;
                for (const side of [-1, 1]) {
                  if (!vs.some((v) => inside(v.tris, side * x, y, z)))
                    misses.push(`${trim}° (${(side * x).toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
                }
              }
            }
          }
        }
      }
      expect(misses.slice(0, 10)).toEqual([]);
    });
  }
});

// The crab boat's open deck: inside the bulwarks, from the deck up to the capping rail (and out
// through the freeing ports into the plating), from beside the house to the transom bulwark. The
// sea must not be drawn anywhere in it, whichever way the boat heels or trims.
describe('crab boat water mask', () => {
  const lines = createHullLines(crabSpec.hull, crabSpec.mass / RHO_SEAWATER);
  const well = deckWellMask(lines);

  it('every volume is closed and wound outward', () => {
    expectClosedOutward(well);
  });

  it('covers the whole deck inside the bulwarks', () => {
    const vs = volumes(well);
    const misses: string[] = [];
    const z0 = BULWARK_FROM + 0.05;
    const z1 = lines.zStern - 0.2;
    for (let i = 0; i <= 40; i++) {
      const z = z0 + ((z1 - z0) * i) / 40;
      const yd = lines.deckY(z);
      const out = lines.deckHalf(z) - 0.04;
      for (let k = 0; k <= 5; k++) {
        const y = yd + 0.01 + ((BULWARK_H - 0.02) * k) / 5;
        for (let j = 0; j <= 8; j++) {
          const x = (out * j) / 8;
          for (const side of [-1, 1]) {
            if (!vs.some((v) => inside(v.tris, side * x, y, z)))
              misses.push(`(${(side * x).toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
          }
        }
      }
    }
    expect(misses.slice(0, 10)).toEqual([]);
  });

  it('stays inside the hull and its bulwarks', () => {
    const p = well.getAttribute('position');
    const wide: string[] = [];
    for (let i = 0; i < p.count; i++) {
      const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
      const yd = lines.deckY(z);
      // The hull below the deck edge, the bulwarks' outer face (flared) above it.
      const limit = y <= yd ? lines.halfBreadthAt(z, y) : lines.deckHalf(z) + 0.08 * (y - yd);
      if (Math.abs(x) > limit + 1e-3) wide.push(`(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
    }
    expect(wide.slice(0, 10)).toEqual([]);
  });
});
