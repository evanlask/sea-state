// Visual hull lines: the same parametric sections as the physics canoe body
// (sim/physics/hull/generateHull.ts), evaluated at any station and girth
// resolution so the rendered hull follows the buoyancy mesh exactly.
//
// The physics generator keeps its section functions private, so the maths is
// mirrored here; hullLines.test.ts checks that
// every physics vertex lies on these sections. The planform exponent (or the
// planing draft) is still solved by the physics generator, so both agree on it.
//
// Body frame: x starboard, y up (0 = design waterline), z aft (bow = −Z).

import { generateHull, superellipseExponent } from '../../../sim/physics/hull/generateHull';
import type {
  DisplacementHullParams,
  HullParams,
  HydroplaneHullParams,
  PlaningHullParams,
} from '../../../sim/physics/hull/types';

// One starboard half-section from the keel (index 0) to the deck edge (last).
export interface HullSection {
  z: number;
  xs: Float64Array;
  ys: Float64Array; // body y
  chine: number; // index of the knuckle/chine point (waterline knuckle for displacement hulls)
  deckY: number;
  deckHalf: number;
}

export interface HullLines {
  params: HullParams; // with the solved exponent / draft
  family: HullParams['family'];
  zBow: number; // stem top, body z
  zStern: number; // transom, body z
  // Station parameter s ∈ [0, 1] from the stem (0) to the transom (1).
  zAt(s: number): number;
  sAt(z: number): number;
  section(s: number, below: number, above: number): HullSection;
  deckY(z: number): number;
  deckHalf(z: number): number;
  keelY(z: number): number;
  // Half-breadth at body height y (linear in the girth samples), 0 when y is outside the section.
  halfBreadthAt(z: number, y: number): number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// The physics generator's station spacing: half linear, half cosine.
export function physicsStationParameter(i: number, n: number): number {
  const s = i / (n - 1);
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

function displacementLines(p: DisplacementHullParams): HullLines {
  const e = p.entranceExponent;
  const shape = displacementShape(p, e);
  const pMid = superellipseExponent(p.midshipCoefficient);
  const bw = p.beamWaterline / 2;
  const T = p.draft;
  const zetaOf = (s: number): number => shape.zeta0 + (shape.zetaS - shape.zeta0) * s;
  const zetaOfZ = (z: number): number => z / shape.half;
  const section = (s: number, nb: number, na: number): HullSection => {
    const zeta = zetaOf(s);
    const yd = shape.deckY(zeta);
    const yk = shape.keelY(zeta);
    const bm = shape.knuckleHalf(zeta);
    const bdk = shape.deckHalf(zeta);
    const ym = Math.max(T, yk);
    const fill = bw > 0 ? bm / bw : 0;
    const pe = p.endSectionExponent + (pMid - p.endSectionExponent) * fill * fill;
    const m = nb + na;
    const xs = new Float64Array(m + 1);
    const ys = new Float64Array(m + 1);
    for (let j = 0; j <= nb; j++) {
      const theta = (Math.PI / 2) * (j / nb);
      let x = bm * Math.sin(theta) ** (2 / pe);
      const y = ym - (ym - yk) * Math.cos(theta) ** (2 / pe);
      if (p.bulbRadius && zeta < -0.85 && yk < T && j > 0 && j < nb) {
        const r = p.bulbRadius;
        const g = clamp01((-0.85 - zeta) / 0.15);
        x += r * g * Math.exp(-(((y - 1.1 * r) / r) ** 2));
      }
      xs[j] = x;
      ys[j] = y - T;
    }
    for (let j = nb + 1; j <= m; j++) {
      const t = (j - nb) / na;
      xs[j] = bm + (bdk - bm) * t ** p.flareExponent;
      ys[j] = ym + (yd - ym) * t - T;
    }
    if (s <= 0) xs.fill(0);
    return { z: zeta * shape.half, xs, ys, chine: nb, deckY: yd - T, deckHalf: bdk };
  };
  const zBow = shape.zeta0 * shape.half;
  const zStern = shape.zetaS * shape.half;
  return withSampling({
    params: p,
    family: p.family,
    zBow,
    zStern,
    zAt: (s) => zetaOf(s) * shape.half,
    sAt: (z) => clamp01((zetaOfZ(z) - shape.zeta0) / (shape.zetaS - shape.zeta0)),
    section,
    deckY: (z) => shape.deckY(zetaOfZ(z)) - T,
    deckHalf: (z) => shape.deckHalf(zetaOfZ(z)),
    keelY: (z) => shape.keelY(zetaOfZ(z)) - T,
  });
}

// --------------------------------------------------------------------- planing

function planingLines(p: PlaningHullParams): HullLines {
  const e = p.entranceExponent;
  const L = p.length;
  const sm = 1 - p.maxChineStation;
  const bc0 = p.chineBeam / 2;
  const bd = p.beamDeck / 2;
  const T = p.draft;
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
    if (s < sm) return bc0 * (1 - ((sm - s) / sm) ** e);
    const u = (s - sm) / (1 - sm);
    return bc0 * (1 - (1 - p.transomChineRatio) * u * u);
  };
  const deckHalf = (s: number): number => {
    if (s < sm) return bd * (1 - ((sm - s) / sm) ** (e * p.deckFullness));
    const u = (s - sm) / (1 - sm);
    return bd * (1 - (1 - p.transomDeckRatio) * u * u);
  };
  const deadrise = (s: number): number => p.deadrise + (p.deadriseBow - p.deadrise) * (1 - s) ** 1.5;
  const section = (s: number, nb: number, na: number): HullSection => {
    const yd = deckY(s);
    const yk = keelY(s);
    let bc = chineHalf(s);
    const bdk = deckHalf(s);
    const tanB = Math.tan(Math.min(1.4, deadrise(s)));
    const maxRise = 0.8 * (yd - yk);
    if (bc * tanB > maxRise) bc = maxRise / tanB;
    const yc = yk + bc * tanB;
    const m = nb + na;
    const xs = new Float64Array(m + 1);
    const ys = new Float64Array(m + 1);
    for (let j = 0; j <= nb; j++) {
      const x = (bc * j) / nb;
      xs[j] = x;
      ys[j] = yk + x * tanB - T;
    }
    for (let j = nb + 1; j <= m; j++) {
      const t = (j - nb) / na;
      xs[j] = bc + (Math.max(bdk, bc) - bc) * t ** p.flareExponent;
      ys[j] = yc + (yd - yc) * t - T;
    }
    if (s <= 0) xs.fill(0);
    return { z: -L / 2 + s * L, xs, ys, chine: nb, deckY: yd - T, deckHalf: bdk };
  };
  const sOf = (z: number): number => clamp01((z + L / 2) / L);
  return withSampling({
    params: p,
    family: 'planing',
    zBow: -L / 2,
    zStern: L / 2,
    zAt: (s) => -L / 2 + s * L,
    sAt: sOf,
    section,
    deckY: (z) => deckY(sOf(z)) - T,
    deckHalf: (z) => deckHalf(sOf(z)),
    keelY: (z) => keelY(sOf(z)) - T,
  });
}

function withSampling(lines: Omit<HullLines, 'halfBreadthAt'>): HullLines {
  return {
    ...lines,
    halfBreadthAt(z: number, y: number): number {
      const sec = lines.section(lines.sAt(z), 24, 12);
      const { xs, ys } = sec;
      if (y < ys[0]! || y > ys[ys.length - 1]!) return 0;
      for (let j = 1; j < ys.length; j++) {
        if (y <= ys[j]!) {
          const t = (y - ys[j - 1]!) / Math.max(1e-9, ys[j]! - ys[j - 1]!);
          return xs[j - 1]! + (xs[j]! - xs[j - 1]!) * t;
        }
      }
      return xs[xs.length - 1]!;
    },
  };
}

// Lines for a spec's hull. targetVolume (m³, usually mass / ρ) is solved by the
// physics generator exactly as buildBoatModel does, so both use the same exponent.
export function createHullLines(params: HullParams, targetVolume?: number): HullLines {
  const solved = targetVolume === undefined ? params : generateHull({ ...params, targetVolume }).params;
  if (solved.family === 'hydroplane') return hydroplaneLines(solved);
  return solved.family === 'planing' ? planingLines(solved) : displacementLines(solved);
}

// ------------------------------------------------------------------ hydroplane

// Mirrors physics/hull/hydroplane.ts: the step's two stations, the noses' gap under the deck, and the
// tunnel's fade-out aft of the step.
const HYDRO_STEP = 0.01;
const HYDRO_NOSE_GAP = 0.04;
const HYDRO_TUNNEL_RAMP = 2.2;

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// The five key points of a hydroplane section (body frame, starboard half): the tunnel roof on the
// centreline and at its edge (x `xi`), the foot of the tunnel wall (`xw`, on the running bottom: the
// pads forward of the step, the after-planing bottom aft of it), the outer chine (`xo`, `bottom`)
// and the deck edge above it.
export interface HydroKeys {
  z: number;
  roof: number;
  xi: number;
  xw: number;
  bottom: number;
  xo: number;
  deck: number;
}

// Body z of the step's forward station (the sponsons' transoms) and of its aft one.
export function hydroplaneStep(p: HydroplaneHullParams): { fore: number; aft: number } {
  const aft = -p.length / 2 + p.sponsonLength;
  return { fore: aft - HYDRO_STEP, aft };
}

function hydroForward(p: HydroplaneHullParams, z: number): HydroKeys {
  const zBow = -p.length / 2;
  const half = p.beam / 2;
  const d = Math.max(0, z - zBow);
  const nose = Math.max(0, 1 - d / p.noseLength);
  const curve = 1 - Math.sqrt(1 - nose * nose);
  const yPad = (p.depth - HYDRO_NOSE_GAP) * curve;
  const roof = p.tunnelHeight + (p.depth - HYDRO_NOSE_GAP / 2 - p.tunnelHeight) * curve;
  const xo = half * (p.noseBeamRatio + (1 - p.noseBeamRatio) * smooth01(d / (0.3 * p.sponsonLength)));
  const xi = Math.max(0.05, xo - p.sponsonWidth);
  const T = p.draft;
  return { z, roof: roof - T, xi, xw: xi, bottom: Math.min(yPad, roof - 0.01) - T, xo, deck: p.depth - T };
}

function hydroAft(p: HydroplaneHullParams, z: number): HydroKeys {
  const half = p.beam / 2;
  const zStep = -p.length / 2 + p.sponsonLength;
  const zStern = p.length / 2;
  const along = Math.min(1, Math.max(0, (z - zStep) / (zStern - zStep)));
  const y = p.afterPlaneStep + (p.afterPlaneTransom - p.afterPlaneStep) * along;
  const x = half + (p.transomBeam / 2 - half) * along;
  const fade = 1 - smooth01((z - zStep) / HYDRO_TUNNEL_RAMP);
  const roof = y + (p.tunnelHeight - p.afterPlaneStep) * fade;
  const xiStep = half - p.sponsonWidth;
  const xi = (xiStep / half) * x * fade + 0.35 * x * (1 - fade);
  const xw = Math.min(0.9 * x, xi + 0.05 + 0.3 * (1 - fade));
  const T = p.draft;
  return { z, roof: roof - T, xi, xw, bottom: y - T, xo: x, deck: p.depth - T };
}

// The key points at body z: the physics sections' formulas, linear across the 1 cm step.
export function hydroplaneKeys(p: HydroplaneHullParams, z: number): HydroKeys {
  const step = hydroplaneStep(p);
  if (z <= step.fore) return hydroForward(p, z);
  if (z >= step.aft) return hydroAft(p, z);
  const a = hydroForward(p, step.fore);
  const b = hydroAft(p, step.aft);
  const t = (z - step.fore) / (step.aft - step.fore);
  const lerp = (u: number, v: number): number => u + (v - u) * t;
  return {
    z,
    roof: lerp(a.roof, b.roof),
    xi: lerp(a.xi, b.xi),
    xw: lerp(a.xw, b.xw),
    bottom: lerp(a.bottom, b.bottom),
    xo: lerp(a.xo, b.xo),
    deck: a.deck,
  };
}

// The hydroplane's lines: each section runs from the tunnel roof on the centreline out to the roof's
// edge, down the tunnel wall, across the running bottom to the outer chine (`chine`) and up the
// sponson's (or the after-body's) side to the deck edge: the physics sections' five points, with
// `below` girth samples across the bottom and `above` up the side. The half-breadth at a height is
// the outer side's (the tunnel is a notch inside it).
function hydroplaneLines(p: HydroplaneHullParams): HullLines {
  const zBow = -p.length / 2;
  const zStern = p.length / 2;
  const zAt = (s: number): number => zBow + (zStern - zBow) * s;
  const sAt = (z: number): number => clamp01((z - zBow) / (zStern - zBow));
  const section = (s: number, below: number, above: number): HullSection => {
    const k = hydroplaneKeys(p, zAt(s));
    const nb = Math.max(1, below);
    const na = Math.max(1, above);
    const roofN = Math.max(1, Math.round(nb / 2));
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = 0; j <= roofN; j++) {
      xs.push((k.xi * j) / roofN);
      ys.push(k.roof);
    }
    for (let j = 0; j <= nb; j++) {
      xs.push(k.xw + ((k.xo - k.xw) * j) / nb);
      ys.push(k.bottom);
    }
    const chine = xs.length - 1;
    for (let j = 1; j <= na; j++) {
      xs.push(k.xo);
      ys.push(k.bottom + ((k.deck - k.bottom) * j) / na);
    }
    return {
      z: k.z,
      xs: Float64Array.from(xs),
      ys: Float64Array.from(ys),
      chine,
      deckY: k.deck,
      deckHalf: k.xo,
    };
  };
  return {
    params: p,
    family: p.family,
    zBow,
    zStern,
    zAt,
    sAt,
    section,
    deckY: (z) => hydroplaneKeys(p, z).deck,
    deckHalf: (z) => hydroplaneKeys(p, z).xo,
    keelY: (z) => hydroplaneKeys(p, z).bottom,
    halfBreadthAt(z: number, y: number): number {
      if (z < zBow || z > zStern) return 0;
      const k = hydroplaneKeys(p, z);
      return y < k.bottom - 1e-9 || y > k.deck + 1e-9 ? 0 : k.xo;
    },
  };
}
