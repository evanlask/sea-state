// Procedural canoe-body generator: lofts parametric cross-sections into a
// closed, outward-wound, watertight triangle mesh (200–800 triangles). The
// mesh is the buoyant hull only; keels, rudders and skegs are foils.
//
// Each station is a closed ring: keel → starboard side → deck edge → straight
// deck → port deck edge → port side → keel. Rings are lofted with quads, the
// stem station collapses onto the centreline, and the transom is fanned shut.
// Coincident vertices are welded and the resulting degenerate triangles
// dropped, so collapsed sections stay manifold.

import { Hydrostatics } from '../hydrostatics';
import type { TriMesh } from '../mesh';
import { hydroplaneHull } from './hydroplane';
import type { DisplacementHullParams, HullParams, PlaningHullParams } from './types';

export interface HullBuild {
  params: HullParams; // with the solved fullness exponent
  mesh: TriMesh;
  zBow: number; // stem top (most forward point), body z
  zStern: number; // transom, body z
  // Deck-edge height above the design waterline and deck half-breadth at body z.
  deckHeightAt(z: number): number;
  deckHalfBreadthAt(z: number): number;
}

export interface Section {
  z: number;
  xs: Float64Array;
  ys: Float64Array; // body y (design waterline = 0)
  deckY: number;
  deckHalf: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Superellipse exponent whose quarter area fraction equals c (e.g. Cm):
// Γ(1 + 1/p)² / Γ(1 + 2/p) = c.
export function superellipseExponent(c: number): number {
  let lo = 0.5;
  let hi = 200;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    if (superellipseArea(mid) < c) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

export const superellipseArea = (p: number): number =>
  Math.exp(2 * logGamma(1 + 1 / p) - logGamma(1 + 2 / p));

// Lanczos approximation (g = 7), adequate for x > 0.5.
function logGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  const z = x - 1;
  let a = c[0]!;
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function stationParameter(i: number, n: number): number {
  const s = i / (n - 1);
  // Half linear, half cosine: denser near the stem and the transom.
  return 0.5 * s + 0.5 * (0.5 - 0.5 * Math.cos(Math.PI * s));
}

// ---------------------------------------------------------------- displacement

function displacementShape(p: DisplacementHullParams, e: number) {
  const half = p.lwl / 2;
  const zeta0 = -1 - p.bowOverhang / half;
  const zetaS = 1 + p.sternOverhang / half;
  const pf = p.parallelMidbodyForward;
  const pa = p.parallelMidbodyAft;
  const bw = p.beamWaterline / 2;
  const bd = p.beamDeck / 2;
  const tr = p.transomBeamRatio;
  const eRun = e * p.runExponentRatio;
  const T = p.draft;

  const deckY = (zeta: number): number => {
    const s = zeta < 0 ? clamp01(zeta / zeta0) : clamp01(zeta / zetaS);
    return p.depth + (zeta < 0 ? p.sheerBow : p.sheerStern) * s * s;
  };
  const aftU = (zeta: number): number => clamp01((zeta - pa) / (zetaS - pa));
  const knuckleHalf = (zeta: number): number => {
    if (zeta < -pf) {
      const u = (-zeta - pf) / (1 - pf);
      return u >= 1 ? 0 : bw * (1 - u ** e);
    }
    if (zeta > pa) return bw * (1 - (1 - tr) * aftU(zeta) ** eRun);
    return bw;
  };
  const deckHalf = (zeta: number): number => {
    if (zeta < -pf) return bd * (1 - clamp01((-zeta - pf) / (-zeta0 - pf)) ** (e * p.deckFullness));
    if (zeta > pa) return bd * (1 - (1 - tr) * aftU(zeta) ** (eRun * p.deckFullness));
    return bd;
  };
  const keelY = (zeta: number): number => {
    const base = (-p.keelDrag * zeta) / 2;
    const yd = deckY(zeta);
    if (zeta < -1) {
      const w = zeta0 < -1 ? (-1 - zeta) / (-1 - zeta0) : 0;
      return T + (yd - T) * 0.96 * w;
    }
    const zf = -1 + 2 * p.forefootLength;
    if (zeta < zf) {
      const v = clamp01((zf - zeta) / (zf + 1));
      return base + (T - base) * v * v;
    }
    const zr = 1 - 2 * p.runLength;
    if (zeta > zr) {
      const w = clamp01((zeta - zr) / (zetaS - zr));
      return base + (p.transomKeelHeight - base) * w * w;
    }
    return base;
  };
  return { half, zeta0, zetaS, deckY, knuckleHalf, deckHalf, keelY };
}

function displacementSections(p: DisplacementHullParams, e: number): Section[] {
  const n = p.stations ?? 20;
  const nb = p.girthBelow ?? 5;
  const na = p.girthAbove ?? 4;
  const m = nb + na;
  const shape = displacementShape(p, e);
  const pMid = superellipseExponent(p.midshipCoefficient);
  const bw = p.beamWaterline / 2;
  const T = p.draft;
  const sections: Section[] = [];
  for (let i = 0; i < n; i++) {
    const zeta = shape.zeta0 + (shape.zetaS - shape.zeta0) * stationParameter(i, n);
    const yd = shape.deckY(zeta);
    const yk = shape.keelY(zeta);
    const bm = shape.knuckleHalf(zeta);
    const bdk = shape.deckHalf(zeta);
    const ym = Math.max(T, yk);
    const fill = bw > 0 ? bm / bw : 0;
    const pe = p.endSectionExponent + (pMid - p.endSectionExponent) * fill * fill;
    const xs = new Float64Array(m + 1);
    const ys = new Float64Array(m + 1);
    for (let j = 0; j <= nb; j++) {
      const theta = (Math.PI / 2) * (j / nb);
      let x = bm * Math.sin(theta) ** (2 / pe);
      const y = ym - (ym - yk) * Math.cos(theta) ** (2 / pe);
      if (p.bulbRadius && zeta < -0.85 && yk < T && j > 0 && j < nb) {
        // Bulbous forefoot: widen the low sections near the stem.
        const r = p.bulbRadius;
        const g = clamp01((-0.85 - zeta) / 0.15);
        x += r * g * Math.exp(-(((y - 1.1 * r) / r) ** 2));
      }
      xs[j] = x;
      ys[j] = y;
    }
    for (let j = nb + 1; j <= m; j++) {
      const t = (j - nb) / na;
      xs[j] = bm + (bdk - bm) * t ** p.flareExponent;
      ys[j] = ym + (yd - ym) * t;
    }
    if (i === 0) xs.fill(0); // stem line
    else keepOffCentreline(xs, ys);
    for (let j = 0; j <= m; j++) ys[j]! -= T;
    sections.push({ z: zeta * shape.half, xs, ys, deckY: yd - T, deckHalf: bdk });
  }
  return sections;
}

// --------------------------------------------------------------------- planing

function planingShape(p: PlaningHullParams, e: number) {
  const L = p.length;
  const sm = 1 - p.maxChineStation;
  const bc = p.chineBeam / 2;
  const bd = p.beamDeck / 2;
  const deckY = (s: number): number => {
    const u = Math.max(0, 1 - s / 0.6);
    return p.depth + p.sheerBow * u * u;
  };
  const keelY = (s: number): number => {
    if (s >= p.keelRiseStart) return 0;
    const v = 1 - s / p.keelRiseStart;
    return 0.92 * deckY(s) * v ** 1.8;
  };
  const chineHalf = (s: number): number => {
    if (s < sm) return bc * (1 - ((sm - s) / sm) ** e);
    const u = (s - sm) / (1 - sm);
    return bc * (1 - (1 - p.transomChineRatio) * u * u);
  };
  const deckHalf = (s: number): number => {
    if (s < sm) return bd * (1 - ((sm - s) / sm) ** (e * p.deckFullness));
    const u = (s - sm) / (1 - sm);
    return bd * (1 - (1 - p.transomDeckRatio) * u * u);
  };
  const deadrise = (s: number): number => p.deadrise + (p.deadriseBow - p.deadrise) * (1 - s) ** 1.5;
  return { L, deckY, keelY, chineHalf, deckHalf, deadrise };
}

function planingSections(p: PlaningHullParams, e: number): Section[] {
  const n = p.stations ?? 16;
  const nb = p.girthBottom ?? 3;
  const na = p.girthTopsides ?? 4;
  const m = nb + na;
  const shape = planingShape(p, e);
  const T = p.draft;
  const sections: Section[] = [];
  for (let i = 0; i < n; i++) {
    const s = stationParameter(i, n);
    const yd = shape.deckY(s);
    const yk = shape.keelY(s);
    let bc = shape.chineHalf(s);
    const bdk = shape.deckHalf(s);
    const tanB = Math.tan(Math.min(1.4, shape.deadrise(s)));
    // Keep the chine below the sheer.
    const maxRise = 0.8 * (yd - yk);
    if (bc * tanB > maxRise) bc = maxRise / tanB;
    const yc = yk + bc * tanB;
    const xs = new Float64Array(m + 1);
    const ys = new Float64Array(m + 1);
    for (let j = 0; j <= nb; j++) {
      const x = (bc * j) / nb;
      xs[j] = x;
      ys[j] = yk + x * tanB;
    }
    for (let j = nb + 1; j <= m; j++) {
      const t = (j - nb) / na;
      xs[j] = bc + (Math.max(bdk, bc) - bc) * t ** p.flareExponent;
      ys[j] = yc + (yd - yc) * t;
    }
    if (i === 0) xs.fill(0);
    else keepOffCentreline(xs, ys);
    for (let j = 0; j <= m; j++) ys[j]! -= T;
    sections.push({ z: -shape.L / 2 + s * shape.L, xs, ys, deckY: yd - T, deckHalf: bdk });
  }
  return sections;
}

// ------------------------------------------------------------------------ loft

// Points may collapse onto the centreline only as a prefix from the keel (they
// then weld into the keel vertex). A centreline point above an off-centre one
// would weld with its port twin and pinch the ring into a non-manifold edge.
function keepOffCentreline(xs: Float64Array, ys: Float64Array): void {
  let offCentre = false;
  for (let j = 1; j < xs.length; j++) {
    if (xs[j]! > 1e-5) offCentre = true;
    else if (offCentre) xs[j] = 1e-5;
    else {
      xs[j] = 0;
      ys[j] = ys[0]!;
    }
  }
}

export function loft(sections: Section[]): TriMesh {
  const positions: number[] = [];
  const weld = new Map<string, number>();
  const vertex = (x: number, y: number, z: number): number => {
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    const found = weld.get(key);
    if (found !== undefined) return found;
    const index = positions.length / 3;
    positions.push(x === 0 ? 0 : x, y, z);
    weld.set(key, index);
    return index;
  };
  const rings: number[][] = [];
  for (const section of sections) {
    const m = section.xs.length - 1;
    const ring: number[] = [];
    for (let j = 0; j <= m; j++) ring.push(vertex(j === 0 ? 0 : section.xs[j]!, section.ys[j]!, section.z));
    for (let j = m; j >= 1; j--) ring.push(vertex(-section.xs[j]!, section.ys[j]!, section.z));
    rings.push(ring);
  }
  const indices: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    if (a === b || b === c || a === c) return;
    indices.push(a, b, c);
  };
  for (let i = 0; i + 1 < rings.length; i++) {
    const r0 = rings[i]!;
    const r1 = rings[i + 1]!;
    const k = r0.length;
    const m = (k - 1) / 2;
    for (let j = 0; j < k; j++) {
      const a = r0[j]!;
      const b = r0[(j + 1) % k]!;
      const c = r1[(j + 1) % k]!;
      const d = r1[j]!;
      // Mirror the quad diagonal on the port side so the mesh is exactly
      // symmetric (otherwise B sits off the centreline when upright).
      if (j <= m) {
        tri(a, b, c);
        tri(a, c, d);
      } else {
        tri(a, b, d);
        tri(b, c, d);
      }
    }
  }
  const cap = (ring: number[], facingAft: boolean): void => {
    const unique = new Set(ring);
    if (unique.size < 3) return;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const index of unique) {
      cx += positions[index * 3]!;
      cy += positions[index * 3 + 1]!;
      cz += positions[index * 3 + 2]!;
    }
    const centre = vertex(cx / unique.size, cy / unique.size, cz / unique.size);
    for (let j = 0; j < ring.length; j++) {
      const a = ring[j]!;
      const b = ring[(j + 1) % ring.length]!;
      if (facingAft) tri(centre, a, b);
      else tri(centre, b, a);
    }
  };
  // The stem ring is folded onto the centreline (no area); the transom needs a cap.
  if (sections[0]!.xs.some((x) => x > 1e-9)) cap(rings[0]!, false);
  cap(rings[rings.length - 1]!, true);
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

// ------------------------------------------------------------------------- API

function sectionsFor(params: DisplacementHullParams | PlaningHullParams, e: number): Section[] {
  return params.family === 'planing' ? planingSections(params, e) : displacementSections(params, e);
}

function designVolume(params: DisplacementHullParams | PlaningHullParams, e: number): number {
  return new Hydrostatics(loft(sectionsFor(params, e))).upright(0).volume;
}

// Displacement hulls: solves the planform exponent so the canoe body
// displaces targetVolume at the design draft (volume grows with the exponent).
function solveFullness(params: DisplacementHullParams | PlaningHullParams, target: number): number {
  let lo = Math.log(0.4);
  let hi = Math.log(16);
  if (designVolume(params, Math.exp(hi)) < target || designVolume(params, Math.exp(lo)) > target) {
    throw new Error(
      `hull: target volume ${target.toFixed(3)} m³ unreachable for ${params.family} hull; adjust beam/draft`,
    );
  }
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (designVolume(params, Math.exp(mid)) < target) lo = mid;
    else hi = mid;
  }
  return Math.exp(0.5 * (lo + hi));
}

// Planing hulls: the shape is fixed and the draft is what floats the mass, so
// solve the waterline height instead of the planform.
function solvePlaningDraft(params: PlaningHullParams, target: number): number {
  const hs = new Hydrostatics(loft(planingSections(params, params.entranceExponent)));
  let lo = -params.draft; // waterline at the keel
  let hi = params.depth - params.draft; // waterline at the transom sheer
  if (hs.upright(hi).volume < target) {
    throw new Error(`hull: target volume ${target.toFixed(3)} m³ exceeds the planing hull's volume`);
  }
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (hs.upright(mid).volume < target) lo = mid;
    else hi = mid;
  }
  return params.draft + 0.5 * (lo + hi);
}

export function generateHull(input: HullParams): HullBuild {
  if (input.family === 'hydroplane') return hydroplaneHull(input);
  let params: DisplacementHullParams | PlaningHullParams;
  let e = input.entranceExponent;
  if (input.targetVolume === undefined) params = input;
  else if (input.family === 'planing') {
    params = { ...input, draft: solvePlaningDraft(input, input.targetVolume) };
  } else {
    e = solveFullness(input, input.targetVolume);
    params = { ...input, entranceExponent: e };
  }
  return buildFromSections(params, sectionsFor(params, e));
}

// The HullBuild for lofted sections (the deck line interpolated between them).
export function buildFromSections(params: HullParams, sections: Section[]): HullBuild {
  const mesh = loft(sections);
  const zs = sections.map((s) => s.z);
  const interpolate = (z: number, pick: (s: Section) => number): number => {
    if (z <= zs[0]!) return pick(sections[0]!);
    for (let i = 1; i < sections.length; i++) {
      if (z <= zs[i]!) {
        const t = (z - zs[i - 1]!) / (zs[i]! - zs[i - 1]!);
        return pick(sections[i - 1]!) + (pick(sections[i]!) - pick(sections[i - 1]!)) * t;
      }
    }
    return pick(sections[sections.length - 1]!);
  };
  return {
    params,
    mesh,
    zBow: zs[0]!,
    zStern: zs[zs.length - 1]!,
    deckHeightAt: (z) => interpolate(z, (s) => s.deckY),
    deckHalfBreadthAt: (z) => interpolate(z, (s) => s.deckHalf),
  };
}
