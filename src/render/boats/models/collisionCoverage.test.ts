// The collision prisms (sim/world/collisionShapes.ts) against the procedural models: in plan view,
// at the heights where boats meet, the compound shape should hug the visible hull — little gap
// (shape standing outside the model, so boats stop short of touching) and little overhang (model
// outside the shape, so hulls visibly overlap) — both measured per station as a share of the beam,
// and at the stem and the stern as a share of the length.

import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../../sim/boats/specs/index';
import {
  type CollisionPiece,
  type CollisionShape,
  collisionShapeFor,
  FLARE_SPLIT,
} from '../../../sim/world/collisionShapes';
import type { BoatKind } from '../../../sim/world/protocol';
import type { ModelDraft } from '../kit/assemble';
import { cargoDraft } from './cargo';
import { crabDraft } from './crab';
import { cruiseDraft } from './cruise';
import { hydroDraft } from './hydro';
import { powerboatDraft } from './powerboat';
import { pwcDraft } from './pwc';
import { sailDraft } from './sail';

// The ship models paint liveries on canvases: a do-nothing 2D context is enough for the geometry.
function stubDocument(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const ctx: unknown = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'getImageData')
          return (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
          });
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern')
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    },
  );
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

// Height bands (body y, m) where boats meet, per boat: the low band (small craft, waterline to the
// flare split, or to the gunwale for small boats) and, for the big hulls, the high band up to the
// top of the visible hull (not the superstructure, which sits inside the hull outline).
const BANDS: Record<BoatKind, [number, number][]> = {
  pwc: [[0, 0.75]], // below the mirrors and grips, which stand 0.1 m outside the hull at the bars
  hydro: [[0, 0.58]], // the sponsons' and after-body's sides up to the deck
  powerboat: [[0, 1.5]],
  sail: [[0, 1.5]],
  crab: [
    [0, FLARE_SPLIT],
    [FLARE_SPLIT, 4.9],
  ],
  cargo: [
    [0, FLARE_SPLIT],
    [FLARE_SPLIT, 14.1],
  ],
  cruise: [
    [0, FLARE_SPLIT],
    [FLARE_SPLIT, 15.8],
  ],
};

// Parts that don't count: rigging and spars, rudders, propellers and lamps (and the hydroplane's
// running gear under its transom).
const SKIP = new Set([
  'gearcase',
  'spar',
  'wire',
  'rudder',
  'bronze',
  'lampWhite',
  'lampRed',
  'lampGreen',
  'flood',
  'red',
]);
// The hull proper (shell, decks, rails, raised decks): the gap is measured only at stations where
// the hull reaches into the band, so a deckhouse standing above the bulwarks, inside the outline,
// isn't counted as a gap.
const HULL = new Set(['hull', 'bottom', 'deck', 'deckPaint', 'rubRail', 'whaleTop', 'stripe']);
const DRAFTS: Record<BoatKind, () => ModelDraft> = {
  pwc: pwcDraft,
  hydro: hydroDraft,
  powerboat: powerboatDraft,
  sail: sailDraft,
  crab: () => crabDraft(),
  cargo: () => cargoDraft(),
  cruise: cruiseDraft,
};

function pieceHalfBreadth(p: CollisionPiece, z: number): number {
  // Convex and symmetric: the largest x where the outline crosses z.
  let best = -1;
  const n = p.xs.length;
  for (let i = 0; i < n; i++) {
    const x0 = p.xs[i]!;
    const z0 = p.zs[i]!;
    const x1 = p.xs[(i + 1) % n]!;
    const z1 = p.zs[(i + 1) % n]!;
    if ((z - z0) * (z - z1) > 0) continue;
    const x = Math.abs(z1 - z0) < 1e-9 ? Math.max(x0, x1) : x0 + ((x1 - x0) * (z - z0)) / (z1 - z0);
    best = Math.max(best, x);
  }
  return best;
}

// Shape half-breadth at z over the band (largest over the prisms reaching into it); −1 outside.
function shapeHalfBreadth(shape: CollisionShape, z: number, y0: number, y1: number): number {
  let best = -1;
  for (const p of shape.pieces) {
    if (p.y1 <= y0 || p.y0 >= y1) continue;
    best = Math.max(best, pieceHalfBreadth(p, z));
  }
  return best;
}

interface Coverage {
  gap: number; // largest share of the beam the shape stands outside the model
  gapZ: number;
  overhangZ: number;
  overhang: number; // largest share of the beam the model stands outside the shape
  bowGap: number; // stem: shape ahead of the model (+) or behind it (−), share of the length
  sternGap: number;
}

function coverage(kind: BoatKind): Coverage[] {
  const draft = DRAFTS[kind]();
  const builder = draft.lods[0]!.builder;
  const points: number[] = []; // x, y, z, hull (1/0)
  for (const slot of builder.slots()) {
    if (SKIP.has(slot)) continue;
    const pos = builder.merged(slot)!.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = Math.abs(pos.getX(i));
      const z = pos.getZ(i);
      points.push(x, pos.getY(i), z, HULL.has(slot) ? 1 : 0);
    }
  }
  const shape = collisionShapeFor(kind);
  const beam = BOAT_SPECS[kind].dimensions.beam;
  const loa = BOAT_SPECS[kind].dimensions.loa;
  return BANDS[kind].map(([y0, y1]) => {
    const bins = 120;
    const z0 = shape.zBow - 0.05 * loa;
    const dz = (1.1 * loa) / bins;
    const all = new Float64Array(bins).fill(-1);
    const hull = new Float64Array(bins).fill(-1);
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < points.length; i += 4) {
      const y = points[i + 1]!;
      if (y < y0 || y > y1) continue;
      const z = points[i + 2]!;
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
      const k = Math.floor((z - z0) / dz);
      if (k < 0 || k >= bins) continue;
      all[k] = Math.max(all[k]!, points[i]!);
      if (points[i + 3]) hull[k] = Math.max(hull[k]!, points[i]!);
    }
    let gap = 0;
    let overhang = 0;
    let gapZ = 0;
    let overhangZ = 0;
    let sMin = Infinity;
    let sMax = -Infinity;
    const shapeBins = new Float64Array(bins).fill(-1);
    for (let k = 0; k < bins; k++) {
      // The shape's widest over the bin, like the model's.
      for (let t = 0; t <= 4; t++) {
        const z = z0 + (k + t / 4) * dz;
        const h = shapeHalfBreadth(shape, z, y0, y1);
        if (h >= 0) {
          shapeBins[k] = Math.max(shapeBins[k]!, h);
          sMin = Math.min(sMin, z);
          sMax = Math.max(sMax, z);
        }
      }
    }
    // Some bins only catch deck fittings rather than a hull station: the gap compares the widest
    // over three neighbouring bins.
    const widest = (a: Float64Array, k: number): number =>
      Math.max(a[Math.max(0, k - 1)]!, a[k]!, a[Math.min(bins - 1, k + 1)]!);
    for (let k = 0; k < bins; k++) {
      const s = shapeBins[k]!;
      if (s < 0) continue;
      const zk = z0 + (k + 0.5) * dz;
      const h = widest(all, k);
      const sw = widest(shapeBins, k);
      if (hull[k]! >= 0 && sw - h > gap) {
        gap = sw - h;
        gapZ = zk;
      }
      if (all[k]! >= 0 && all[k]! - s > overhang) {
        overhang = all[k]! - s;
        overhangZ = zk;
      }
    }
    return {
      gapZ,
      overhangZ,
      gap: gap / beam,
      overhang: overhang / beam,
      bowGap: (zMin - sMin) / loa,
      sternGap: (sMax - zMax) / loa,
    };
  });
}

describe('collision shapes against the models', () => {
  stubDocument();
  const kinds: BoatKind[] = ['pwc', 'hydro', 'powerboat', 'sail', 'crab', 'cargo', 'cruise'];
  for (const kind of kinds) {
    it(`${kind}: the prisms hug the hull in plan view`, () => {
      const result = coverage(kind);
      console.log(
        `${kind}: ${result
          .map(
            (c, i) =>
              `band ${BANDS[kind][i]!.join('–')} m: gap ${(c.gap * 100).toFixed(1)}% overhang ${(c.overhang * 100).toFixed(1)}% of beam (at z ${c.gapZ.toFixed(1)} / ${c.overhangZ.toFixed(1)}), stem ${(c.bowGap * 100).toFixed(2)}% stern ${(c.sternGap * 100).toFixed(2)}% of length`,
          )
          .join('; ')}`,
      );
      for (const c of result) {
        expect(c.gap).toBeLessThan(0.06);
        expect(c.overhang).toBeLessThan(0.06);
        expect(Math.abs(c.bowGap)).toBeLessThan(0.015);
        expect(Math.abs(c.sternGap)).toBeLessThan(0.015);
      }
    });
  }
});
