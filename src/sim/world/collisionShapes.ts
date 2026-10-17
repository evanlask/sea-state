// Collision shapes: each boat is a compound of a few convex prisms (vertical-sided, plan-view convex
// polygons with a body-height range) that follow its hull:
//
//   - 'bow':  the bow taper, from the stem to where the hull reaches its full beam;
//   - 'aft':  from there to the transom (the transom corners included);
//   - each split into a '-low' layer (the outline below FLARE_SPLIT, which small craft touch) and a
//     '-high' one (the outline above) where the topsides flare, rake or overhang well beyond the
//     waterline: the ships' bows and sterns, the crab boat's raked stem and whaleback.
//
// That's two prisms for the small boats, three for the crab boat and four for the ships.
//
// Outlines come from the physics hull (generateHull with the boat's solved parameters, lofted finer:
// the same sections the visual hulls follow, render/boats/kit/hullLines.ts): the plan-view convex
// hull of the mesh sliced to a height band, simplified to a few vertices per side with each edge
// pushed out by half its sag so the polygon straddles the curve (gaps and overhangs a few per cent
// of the beam at most). The EXTRAS table adds what the visual models carry beyond the canoe body
// (the cruise ship's raked upper hull, the crab boat's whaleback, the cargo ship's
// forecastle, the sailboat's swim step); render/boats/models/collisionCoverage.test.ts checks the
// result against the procedural models.
//
// Body frame: x starboard, y up (0 = design waterline), z aft (bow = −Z).

import type { BoatSpec } from '../boats/BoatSpec';
import { BOAT_SPECS } from '../boats/specs/index';
import { RHO_SEAWATER } from '../core/units';
import { generateHull, type HullBuild } from '../physics/hull/generateHull';
import type { HullParams } from '../physics/hull/types';
import type { TriMesh } from '../physics/mesh';
import type { BoatKind } from './protocol';

export interface CollisionPiece {
  name: string;
  // Plan-view polygon, body x/z, convex, counter-clockwise seen from above (x right, −z up).
  xs: Float64Array;
  zs: Float64Array;
  // Outward unit edge normals: edge i runs from vertex i to vertex i + 1.
  nxs: Float64Array;
  nzs: Float64Array;
  zc: number; // body z of the piece's reference point (on the centreline, at the waterline)
  radius: number; // bounding radius about (0, zc) in plan
  y0: number; // body-height range
  y1: number;
}

export interface CollisionShape {
  kind: BoatKind;
  pieces: CollisionPiece[];
  zc: number; // body z of the whole boat's bounding-circle centre
  radius: number;
  // Plan extents (for tests and the debug overlay).
  zBow: number;
  zStern: number;
  halfBeam: number;
}

// Bows with more flare or rake than this (share of the beam) get a low and a high layer.
const FLARE_SPLIT_SHARE = 0.03;
// Height of the split, m above the waterline: above any small craft's gunwale, so a jet ski or a
// center console can sit under a ship's flared bow and touch the hull at the waterline.
export const FLARE_SPLIT = 2.5;
// The low layer's outline starts this far below the waterline: a ship's bulb, deep down, doesn't
// reach out to the small craft at the surface.
const LOW_FROM = -1.5;
// Outline vertices per side (stem and transom corner included): bow taper and aft body.
const BOW_POINTS = 4;
const AFT_POINTS = 3;

// What the procedural models add beyond the physics canoe body (body frame, m). The numbers mirror
// the model builders (render/ can't be imported here); collisionCoverage.test.ts keeps them honest.
interface ModelExtras {
  // A raised deck carried up from the hull's deck edge at the bow (render/boats/kit/hull.ts
  // raisedDeck): `height(z)` above the deck at station z, aft to `zAft`; at dy above the deck its
  // side stands at deckHalf(z + rake·dy) + flare·dy (+ `extra` at the top: a flared bulwark).
  raised?: {
    zAft: number;
    rake: number;
    flare: number;
    extra?: number;
    height: (z: number, deckY: number) => number;
  };
  // A step or platform on the transom: `aft` beyond it, `halfWidth` wide, at the waterline.
  stern?: { aft: number; halfWidth: number };
}
const EXTRAS: Partial<Record<BoatKind, ModelExtras>> = {
  // cruise.ts: the upper hull carried up to deck 4 (UPPER_HULL_TOP 14.6 m), higher at the stem.
  cruise: {
    raised: {
      zAft: Infinity,
      rake: 0.5,
      flare: 0,
      height: (z, deckY) => 14.6 - deckY + (z < -120 ? ((-120 - z) / 38) ** 2 * 1.2 : 0),
    },
  },
  // crab.ts: the whaleback, 1.5–2 m high forward of the house (WHALEBACK_AFT −11.6 m). The
  // deckhouse follows the deck edge, inside the hull outline.
  crab: {
    raised: {
      zAft: -11.6,
      rake: 0.45,
      flare: 0.1,
      height: (z) => 1.5 + 0.5 * Math.min(1, (-11.6 - z) / 6),
    },
  },
  // cargo.ts: the forecastle (2.5 m, aft to −103.5 m) and its 1.4 m bulwark, flared out.
  cargo: { raised: { zAft: -103.5, rake: 0, flare: 0.06, extra: 0.07, height: () => 2.5 } },
  sail: { stern: { aft: 0.37, halfWidth: 0.65 } }, // sail.ts: the swim step
};

interface P2 {
  x: number;
  z: number;
}

// --------------------------------------------------------------------- outline

// Plan-view points of the mesh within the slab yLo ≤ y ≤ yHi: vertices inside it and edge crossings.
function slabPoints(mesh: TriMesh, yLo: number, yHi: number): P2[] {
  const p = mesh.positions;
  const idx = mesh.indices;
  const out: P2[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1]!;
    if (y >= yLo && y <= yHi) out.push({ x: Math.abs(p[i]!), z: p[i + 2]! });
  }
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k]! * 3;
      const b = idx[t + ((k + 1) % 3)]! * 3;
      const ya = p[a + 1]!;
      const yb = p[b + 1]!;
      for (const level of [yLo, yHi]) {
        if ((ya - level) * (yb - level) >= 0) continue;
        const s = (level - ya) / (yb - ya);
        out.push({ x: Math.abs(p[a]! + (p[b]! - p[a]!) * s), z: p[a + 2]! + (p[b + 2]! - p[a + 2]!) * s });
      }
    }
  }
  return out;
}

// Starboard outline: the upper-right chain of the convex hull of the points (and their mirror
// images), from the forward-most point to the aft-most one, as half-breadths along z.
function starboardChain(points: readonly P2[]): P2[] {
  const pts = points.map((q) => ({ x: q.x, z: q.z }));
  for (const q of points) pts.push({ x: 0, z: q.z });
  pts.sort((a, b) => a.z - b.z || a.x - b.x);
  // Monotone chain over z, keeping the side with x ≥ 0 (turning clockwise in (z, x)).
  const chain: P2[] = [];
  for (const q of pts) {
    while (chain.length >= 2) {
      const a = chain[chain.length - 2]!;
      const b = chain[chain.length - 1]!;
      const cross = (b.z - a.z) * (q.x - a.x) - (b.x - a.x) * (q.z - a.z);
      if (cross >= 0) chain.pop();
      else break;
    }
    chain.push(q);
  }
  // A transom closed on the centreline (its cap's centre sits a hair aft of the corners) ends the
  // chain at the corner.
  while (chain.length > 2) {
    const a = chain[chain.length - 2]!;
    const b = chain[chain.length - 1]!;
    if (b.x < a.x && b.z - a.z < 1e-3) chain.pop();
    else break;
  }
  return chain;
}

// Half-breadth of a chain at z (linear between its points, 0 outside).
export function chainHalfBreadth(chain: readonly P2[], z: number): number {
  if (z < chain[0]!.z || z > chain[chain.length - 1]!.z) return 0;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!;
    const b = chain[i]!;
    if (z <= b.z)
      return b.z - a.z < 1e-9 ? Math.max(a.x, b.x) : a.x + ((b.x - a.x) * (z - a.z)) / (b.z - a.z);
  }
  return chain[chain.length - 1]!.x;
}

// Chain of the slice of the mesh in [yLo, yHi], with the model's extras that reach into the slice.
function outline(mesh: TriMesh, yLo: number, yHi: number, hull: HullBuild, extras?: ModelExtras): P2[] {
  const pts = slabPoints(mesh, yLo, yHi);
  const raised = extras?.raised;
  if (raised) {
    const zAft = Math.min(raised.zAft, hull.zStern);
    const ahead = raised.rake * raised.height(hull.zBow, hull.deckHeightAt(hull.zBow));
    const n = 48;
    for (let i = 0; i <= n; i++) {
      const z = hull.zBow - ahead + ((zAft - hull.zBow + ahead) * i) / n;
      const zc = Math.max(hull.zBow, z);
      const deckY = hull.deckHeightAt(zc);
      const height = raised.height(zc, deckY);
      const dy = Math.min(height, yHi - deckY);
      if (dy <= 0 || deckY + height < yLo) continue;
      const zz = z + raised.rake * dy;
      if (zz < hull.zBow) continue;
      const x =
        hull.deckHalfBreadthAt(Math.min(hull.zStern, zz)) +
        raised.flare * dy +
        ((raised.extra ?? 0) * dy) / height;
      pts.push({ x, z });
    }
  }
  const stern = extras?.stern;
  if (stern && yLo <= 0) pts.push({ x: stern.halfWidth, z: hull.zStern + stern.aft });
  return starboardChain(pts);
}

// Highest point of the raised deck (body y).
function raisedTop(hull: HullBuild, extras?: ModelExtras): number {
  const raised = extras?.raised;
  if (!raised) return -Infinity;
  let top = -Infinity;
  const zAft = Math.min(raised.zAft, hull.zStern);
  for (let i = 0; i <= 32; i++) {
    const z = hull.zBow + ((zAft - hull.zBow) * i) / 32;
    const deckY = hull.deckHeightAt(z);
    top = Math.max(top, deckY + raised.height(z, deckY));
  }
  return top;
}

// --------------------------------------------------------------------- fitting

// Picks `count` chain points (ends included) that minimise the largest sag of the chain outside the
// polyline through them (dynamic programming over the chain, which has a few dozen points).
function simplify(chain: readonly P2[], count: number): number[] {
  const n = chain.length;
  const m = Math.min(count, n);
  if (m <= 2 || n <= 2) return n > 1 ? [0, n - 1] : [0];
  const sag = (i: number, j: number): number => {
    let worst = 0;
    for (let k = i + 1; k < j; k++) worst = Math.max(worst, sagOf(chain[i]!, chain[j]!, chain[k]!));
    return worst;
  };
  const segment: number[][] = [];
  for (let i = 0; i < n; i++) {
    segment.push([]);
    for (let j = i + 1; j < n; j++) segment[i]![j] = sag(i, j);
  }
  // best[k][j]: smallest largest sag reaching point j with k segments; from[k][j]: previous point.
  const best: number[][] = [Array.from({ length: n }, (_, j) => (j === 0 ? 0 : Infinity))];
  const from: number[][] = [Array.from({ length: n }, () => -1)];
  for (let k = 1; k < m; k++) {
    const row = Array.from({ length: n }, () => Infinity);
    const prev = Array.from({ length: n }, () => -1);
    for (let j = 1; j < n; j++) {
      for (let i = 0; i < j; i++) {
        const v = Math.max(best[k - 1]![i]!, segment[i]![j]!);
        if (v < row[j]!) {
          row[j] = v;
          prev[j] = i;
        }
      }
    }
    best.push(row);
    from.push(prev);
  }
  const keep = [n - 1];
  for (let k = m - 1, j = n - 1; k > 0; k--) {
    j = from[k]![j]!;
    keep.unshift(j);
  }
  return keep;
}

// The part of a chain between zA and zB, with interpolated end points.
function sliceChain(chain: readonly P2[], zA: number, zB: number): P2[] {
  const a = Math.max(zA, chain[0]!.z);
  const b = Math.min(zB, chain[chain.length - 1]!.z);
  const out: P2[] = [{ z: a, x: chainHalfBreadth(chain, a) }];
  for (const q of chain) if (q.z > a + 1e-6 && q.z < b - 1e-6) out.push(q);
  out.push({ z: b, x: chainHalfBreadth(chain, b) });
  return out;
}

// Outward distance of q from the line a→b (positive to starboard of the chain's direction).
function sagOf(a: P2, b: P2, q: P2): number {
  const dz = b.z - a.z;
  const dx = b.x - a.x;
  const len = Math.hypot(dz, dx) || 1;
  return (dz * (q.x - a.x) - dx * (q.z - a.z)) / len;
}

// The starboard half of a fitted polygon through `points` of the chain, each edge pushed out by
// half of its sag; the ends are clipped to the chain's z range.
function fitSide(sub: readonly P2[], points: number): P2[] {
  const keep = simplify(sub, points);
  // Offset lines: point + direction.
  const lines: { px: number; pz: number; dx: number; dz: number }[] = [];
  for (let k = 0; k + 1 < keep.length; k++) {
    const a = sub[keep[k]!]!;
    const b = sub[keep[k + 1]!]!;
    let sag = 0;
    for (let i = keep[k]! + 1; i < keep[k + 1]!; i++) sag = Math.max(sag, sagOf(a, b, sub[i]!));
    const dz = b.z - a.z;
    const dx = b.x - a.x;
    const len = Math.hypot(dz, dx) || 1;
    // Outward normal of a→b in (z, x): (−dx, dz)/len.
    const off = sag / 2;
    lines.push({ pz: a.z - (dx / len) * off, px: a.x + (dz / len) * off, dz, dx });
  }
  const zMin = sub[0]!.z;
  const zMax = sub[sub.length - 1]!.z;
  const out: P2[] = [];
  const atZ = (l: (typeof lines)[number], z: number): P2 => ({
    z,
    x: Math.abs(l.dz) < 1e-9 ? l.px : l.px + (l.dx * (z - l.pz)) / l.dz,
  });
  out.push(atZ(lines[0]!, zMin));
  for (let k = 0; k + 1 < lines.length; k++) {
    const l0 = lines[k]!;
    const l1 = lines[k + 1]!;
    const det = l0.dz * l1.dx - l0.dx * l1.dz;
    if (Math.abs(det) < 1e-9) {
      out.push({ z: l1.pz, x: l1.px });
      continue;
    }
    const s = ((l1.pz - l0.pz) * l1.dx - (l1.px - l0.px) * l1.dz) / det;
    out.push({ z: l0.pz + l0.dz * s, x: l0.px + l0.dx * s });
  }
  out.push(atZ(lines[lines.length - 1]!, zMax));
  return out.map((q) => ({ z: Math.min(zMax, Math.max(zMin, q.z)), x: Math.max(0, q.x) }));
}

// A symmetric piece from its starboard side (forward to aft).
function piece(name: string, side: readonly P2[], y0: number, y1: number): CollisionPiece {
  // Counter-clockwise seen from above with x right and −z up: stem → port side → aft → starboard.
  const ring: P2[] = [];
  for (const q of side) ring.push({ x: -q.x, z: q.z });
  for (let i = side.length - 1; i >= 0; i--) ring.push({ x: side[i]!.x, z: side[i]!.z });
  // Drop repeated points (a pointed stem or a closed transom collapse onto the centreline).
  const clean: P2[] = [];
  for (const q of ring) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(q.x - last.x, q.z - last.z) > 1e-6) clean.push(q);
  }
  if (clean.length > 1 && Math.hypot(clean[0]!.x - clean.at(-1)!.x, clean[0]!.z - clean.at(-1)!.z) < 1e-6)
    clean.pop();
  return polygonPiece(name, clean, y0, y1);
}

function polygonPiece(name: string, ring: readonly P2[], y0: number, y1: number): CollisionPiece {
  const n = ring.length;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const q of ring) {
    zMin = Math.min(zMin, q.z);
    zMax = Math.max(zMax, q.z);
  }
  const zc = 0.5 * (zMin + zMax);
  let cx = 0;
  let cz = 0;
  for (const q of ring) {
    cx += q.x / n;
    cz += q.z / n;
  }
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const nxs = new Float64Array(n);
  const nzs = new Float64Array(n);
  let radius = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    xs[i] = a.x;
    zs[i] = a.z;
    let nx = b.z - a.z;
    let nz = -(b.x - a.x);
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    // Outward: away from the centroid.
    if (nx * (a.x - cx) + nz * (a.z - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    nxs[i] = nx;
    nzs[i] = nz;
    radius = Math.max(radius, Math.hypot(a.x, a.z - zc));
  }
  return { name, xs, zs, nxs, nzs, zc, radius, y0, y1 };
}

// ------------------------------------------------------------------------ API

// The compound shape for a boat from its spec and its generated hull.
function buildCollisionShape(spec: BoatSpec, hull: HullBuild): CollisionShape {
  // The physics mesh's sections are coarse (a few points up the topsides, a chord across a flared
  // bow); the outline comes from the same lines lofted finely, as the visual hull is.
  const fine: HullParams =
    hull.params.family === 'planing'
      ? { ...hull.params, targetVolume: undefined, stations: 64, girthBottom: 8, girthTopsides: 16 }
      : hull.params.family === 'hydroplane'
        ? { ...hull.params, targetVolume: undefined } // straight-sided: its own sections are exact
        : { ...hull.params, targetVolume: undefined, stations: 64, girthBelow: 12, girthAbove: 16 };
  const mesh = generateHull(fine).mesh;
  const p = mesh.positions;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 1; i < p.length; i += 3) {
    yMin = Math.min(yMin, p[i]!);
    yMax = Math.max(yMax, p[i]!);
  }
  // Top: the deck edge, raised decks and the superstructure (sat on the deck as the physics does).
  const extras = EXTRAS[spec.kind];
  let top = Math.max(yMax, raisedTop(hull, extras));
  for (const s of spec.superstructures) {
    let deck = -Infinity;
    for (let i = 0; i <= 8; i++)
      deck = Math.max(deck, hull.deckHeightAt(s.z - s.length / 2 + (s.length * i) / 8));
    top = Math.max(top, deck + (s.baseOffset ?? 0) + s.height);
  }
  const full = outline(mesh, yMin, Infinity, hull, extras);
  const low = outline(mesh, Math.max(yMin, LOW_FROM), FLARE_SPLIT, hull, extras);
  // Split between the bow taper and the aft body at the forward end of the full-beam station(s).
  const halfBeam = full.reduce((m, q) => Math.max(m, q.x), 0);
  const fullBeamAt = (chain: readonly P2[]): number => {
    const beam = chain.reduce((m, q) => Math.max(m, q.x), 0);
    return (chain.find((q) => q.x >= beam * 0.995) ?? chain[Math.floor(chain.length / 2)]!).z;
  };
  // (Aft of where both the deck and the waterline outlines reach their full beam.)
  const zSplit = Math.max(fullBeamAt(full), fullBeamAt(low));
  const pieces: CollisionPiece[] = [];
  const layered = top > FLARE_SPLIT + 1;
  for (const [name, zA, zB, points] of [
    ['bow', -Infinity, zSplit, BOW_POINTS],
    ['aft', zSplit, Infinity, AFT_POINTS],
  ] as const) {
    const upper = sliceChain(full, zA, zB);
    const lower = sliceChain(low, zA, zB);
    // Two layers where the outline above FLARE_SPLIT stands well outside the one below it (flare,
    // a raked stem or stern overhang, a raised bow), and the boat stands high enough for it to matter.
    let flare = 0;
    for (const q of upper) flare = Math.max(flare, q.x - chainHalfBreadth(lower, q.z));
    flare = Math.max(
      flare,
      lower[0]!.z - upper[0]!.z,
      upper[upper.length - 1]!.z - lower[lower.length - 1]!.z,
    );
    if (layered && flare > FLARE_SPLIT_SHARE * 2 * halfBeam) {
      pieces.push(piece(`${name}-low`, fitSide(lower, points), yMin, FLARE_SPLIT));
      pieces.push(piece(`${name}-high`, fitSide(upper, points), FLARE_SPLIT, top));
    } else {
      pieces.push(piece(name, fitSide(upper, points), yMin, top));
    }
  }
  const zBow = Math.min(...pieces.map((q) => Math.min(...q.zs)));
  const zStern = Math.max(...pieces.map((q) => Math.max(...q.zs)));
  const zc = 0.5 * (zBow + zStern);
  let radius = 0;
  let beam = 0;
  for (const q of pieces) {
    for (let i = 0; i < q.xs.length; i++) {
      radius = Math.max(radius, Math.hypot(q.xs[i]!, q.zs[i]! - zc));
      beam = Math.max(beam, Math.abs(q.xs[i]!));
    }
  }
  return { kind: spec.kind, pieces, zc, radius, zBow, zStern, halfBeam: beam };
}

const cache = new Map<BoatKind, CollisionShape>();

// The shape for a boat kind (cached). Pass the boat's generated hull when it's at hand; otherwise the
// hull is generated as buildBoatModel does (the mass's displaced volume at the design draft).
export function collisionShapeFor(kind: BoatKind, hull?: HullBuild): CollisionShape {
  let shape = cache.get(kind);
  if (!shape) {
    const spec = BOAT_SPECS[kind];
    shape = buildCollisionShape(
      spec,
      hull ?? generateHull({ ...spec.hull, targetVolume: spec.mass / RHO_SEAWATER }),
    );
    cache.set(kind, shape);
  }
  return shape;
}
