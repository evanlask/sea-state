// Pure mesh builders for hull surfaces lofted from HullLines: the shell (keel to
// deck edge, both sides), deck, transom, bulwarks with freeing ports and
// conformal hull patches (decals, window strips). Output is plain typed arrays
// (MeshData) so the maths is testable without three.js.
//
// UV conventions: the shell's uv is metric (u = metres aft of the stem, v =
// signed girth from the keel, port negative); decks use (x, z) in metres.

import type { HullLines, HullSection } from './hullLines';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export const triangleCountOf = (data: MeshData): number => data.indices.length / 3;

// Area-weighted vertex normals for an indexed mesh.
export function computeNormals(positions: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) {
      normals[i] += nx;
      normals[i + 1] += ny;
      normals[i + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (l > 1e-12) {
      normals[i] /= l;
      normals[i + 1] /= l;
      normals[i + 2] /= l;
    } else normals[i + 1] = 1;
  }
  return normals;
}

// Grid of rows × cols vertices (row-major), quads split consistently; flip reverses the winding.
function gridIndices(
  rows: number,
  cols: number,
  flip = false,
  skipColumn?: (c: number) => boolean,
): number[] {
  const out: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      if (skipColumn?.(c)) continue;
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      if (flip) out.push(a, d, b, b, d, e);
      else out.push(a, b, d, b, e, d);
    }
  }
  return out;
}

function pack(positions: number[], uvs: number[], indices: number[], normals?: Float32Array): MeshData {
  return {
    positions: new Float32Array(positions),
    normals: normals ?? computeNormals(positions, indices),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

export function mergeMeshData(parts: readonly MeshData[]): MeshData {
  let v = 0;
  let i = 0;
  for (const p of parts) {
    v += p.positions.length;
    i += p.indices.length;
  }
  const out: MeshData = {
    positions: new Float32Array(v),
    normals: new Float32Array(v),
    uvs: new Float32Array((v / 3) * 2),
    indices: new Uint32Array(i),
  };
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    out.positions.set(p.positions, vo);
    out.normals.set(p.normals, vo);
    out.uvs.set(p.uvs, (vo / 3) * 2);
    for (let k = 0; k < p.indices.length; k++) out.indices[io + k] = p.indices[k]! + vo / 3;
    vo += p.positions.length;
    io += p.indices.length;
  }
  return out;
}

// Station parameters from sFrom to sTo, denser toward the stem and the transom.
export function stationParameters(n: number, sFrom = 0, sTo = 1): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const eased = 0.45 * t + 0.55 * (0.5 - 0.5 * Math.cos(Math.PI * t));
    out.push(sFrom + (sTo - sFrom) * eased);
  }
  return out;
}

export interface ShellOptions {
  stations: number;
  below: number; // girth samples keel → knuckle/chine
  above: number; // girth samples knuckle/chine → deck edge
  sFrom?: number;
  sTo?: number;
  // Split normals at the chine and keel (hard-chine planing hulls). Default: planing only.
  creases?: boolean;
  // Only the bottom (keel to chine) or the topsides (chine to deck edge), so each can take its own
  // material (a coloured hull side above a white bottom). Default: the whole girth.
  girth?: 'all' | 'bottom' | 'topsides';
  // Passes of a [¼ ½ ¼] filter on the normals along the length: hides the plan-view cusp where the
  // entrance and run meet on hulls without parallel midbody (shading only; the shape is unchanged).
  smoothAlong?: number;
}

// The hull shell from the port deck edge round the keel to the starboard deck edge, outward wound.
export function hullShell(lines: HullLines, options: ShellOptions): MeshData {
  const ss = stationParameters(options.stations, options.sFrom, options.sTo);
  const creases = options.creases ?? lines.family === 'planing';
  const sections = ss.map((s) => lines.section(s, options.below, options.above));
  const m = options.below + options.above;
  // Column order: port m..1, keel, starboard 1..m; duplicated at creases.
  const all: { j: number; side: number }[] = [];
  for (let j = m; j >= 1; j--) {
    all.push({ j, side: -1 });
    if (creases && j === sections[0]!.chine) all.push({ j, side: -1 });
  }
  all.push({ j: 0, side: -1 });
  if (creases) all.push({ j: 0, side: 1 });
  for (let j = 1; j <= m; j++) {
    all.push({ j, side: 1 });
    if (creases && j === sections[0]!.chine) all.push({ j, side: 1 });
  }
  const chine = sections[0]!.chine;
  const girth = options.girth ?? 'all';
  // With creases the chine column is duplicated: the bottom keeps the inner copy, the topsides the outer.
  const columns = all.filter((c, i) => {
    if (girth === 'all') return true;
    const dupInner = creases && c.j === chine && all[i + c.side]?.j === chine;
    if (girth === 'bottom') return c.j < chine || (c.j === chine && (!creases || dupInner));
    return c.j > chine || (c.j === chine && (!creases || !dupInner));
  });
  const cols = columns.length;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const sec of sections) {
    const girth = girthOf(sec);
    for (const { j, side } of columns) {
      positions.push(side * sec.xs[j]!, sec.ys[j]!, sec.z);
      uvs.push(sec.z - lines.zBow, side * girth[j]!);
    }
  }
  // Skip the zero-width quads between duplicated crease columns (and the gap across the bottom
  // between the two topsides strips).
  const dup = new Set<number>();
  for (let c = 0; c + 1 < cols; c++) {
    if (columns[c]!.j === columns[c + 1]!.j) dup.add(c);
    if (girth === 'topsides' && columns[c]!.side !== columns[c + 1]!.side) dup.add(c);
  }
  const indices = gridIndices(sections.length, cols, false, (c) => dup.has(c));
  const data = pack(positions, uvs, indices);
  if (options.smoothAlong) smoothNormalsAlong(data.normals, sections.length, cols, options.smoothAlong);
  return data;
}

// Low-pass the normals of a row-major grid along its rows (stations), renormalising.
export function smoothNormalsAlong(normals: Float32Array, rows: number, cols: number, passes: number): void {
  const tmp = new Float32Array(normals.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(normals);
    for (let r = 1; r + 1 < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        let l = 0;
        for (let k = 0; k < 3; k++) {
          const v = 0.25 * tmp[i - cols * 3 + k]! + 0.5 * tmp[i + k]! + 0.25 * tmp[i + cols * 3 + k]!;
          normals[i + k] = v;
          l += v * v;
        }
        l = Math.sqrt(l) || 1;
        for (let k = 0; k < 3; k++) normals[i + k] = normals[i + k]! / l;
      }
    }
  }
}

function girthOf(sec: HullSection): Float64Array {
  const g = new Float64Array(sec.xs.length);
  for (let j = 1; j < g.length; j++) {
    g[j] = g[j - 1]! + Math.hypot(sec.xs[j]! - sec.xs[j - 1]!, sec.ys[j]! - sec.ys[j - 1]!);
  }
  return g;
}

// Closes the stern section (body +Z face). Strips pair port and starboard points per girth index.
export function transomCap(lines: HullLines, below: number, above: number): MeshData {
  const sec = lines.section(1, below, above);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const m = sec.xs.length - 1;
  for (let j = 0; j <= m; j++) {
    for (const side of [-1, 1]) {
      positions.push(side * sec.xs[j]!, sec.ys[j]!, sec.z);
      uvs.push(side * sec.xs[j]!, sec.ys[j]!);
    }
  }
  for (let j = 0; j < m; j++) {
    const p0 = j * 2;
    const s0 = p0 + 1;
    const p1 = p0 + 2;
    const s1 = p0 + 3;
    indices.push(p0, s0, s1, p0, s1, p1);
  }
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return pack(positions, uvs, indices, normals);
}

export interface DeckOptions {
  stations: number;
  across: number; // samples across the beam (odd keeps a centreline)
  camber?: number; // rise at the centreline, m
  sFrom?: number;
  sTo?: number;
  inset?: number; // pull the deck edge in from the shell, m
  lift?: number; // raise the whole deck, m
}

export function deckSurface(lines: HullLines, options: DeckOptions): MeshData {
  const ss = stationParameters(options.stations, options.sFrom, options.sTo);
  const n = Math.max(2, options.across);
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const s of ss) {
    const z = lines.zAt(s);
    const half = Math.max(0, lines.deckHalf(z) - (options.inset ?? 0));
    const y0 = lines.deckY(z) + (options.lift ?? 0);
    for (let k = 0; k < n; k++) {
      const u = -1 + (2 * k) / (n - 1);
      const x = u * half;
      positions.push(x, y0 + (options.camber ?? 0) * (1 - u * u), z);
      uvs.push(x, z);
    }
  }
  const indices = gridIndices(ss.length, n, true);
  return pack(positions, uvs, indices);
}

export interface DeckRegionOptions {
  // How many stations from sFrom to sTo, or their parameters (e.g. the hull shell's, so the deck edge
  // lies on its top edge; the list should run from sFrom to sTo).
  stations: number | readonly number[];
  across: number;
  sFrom: number;
  sTo: number;
  // Signed x of the region's port and starboard edges at body z (e.g. a side deck from the cockpit
  // coaming out to the deck edge).
  x0: (z: number) => number;
  x1: (z: number) => number;
  camber?: number; // rise at the centreline for the full deck width, m
  // The camber develops fully only where the deck is at least this half-breadth (m), and fades out
  // toward a pointed bow, so the crown doesn't stand up off the stem.
  camberHalf?: number;
  lift?: number;
}

// A part of the deck between two athwartships edges, on the same cambered surface as deckSurface, so
// decks with openings (cockpits, footwells) can be pieced together without seams.
export function deckRegion(lines: HullLines, o: DeckRegionOptions): MeshData {
  const ss = typeof o.stations === 'number' ? stationParameters(o.stations, o.sFrom, o.sTo) : o.stations;
  const n = Math.max(2, o.across);
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const s of ss) {
    const z = lines.zAt(s);
    const half = Math.max(1e-3, lines.deckHalf(z));
    const y0 = lines.deckY(z) + (o.lift ?? 0);
    const a = o.x0(z);
    const b = o.x1(z);
    const camber = (o.camber ?? 0) * (o.camberHalf ? Math.min(1, half / o.camberHalf) : 1);
    for (let k = 0; k < n; k++) {
      const x = a + ((b - a) * k) / (n - 1);
      const u = Math.min(1, Math.abs(x) / half);
      positions.push(x, y0 + camber * (1 - u * u), z);
      uvs.push(x, z);
    }
  }
  return pack(positions, uvs, gridIndices(ss.length, n, true));
}

export interface BulwarkOptions {
  sFrom: number;
  sTo: number;
  stations: number;
  height: number;
  thickness?: number;
  flare?: number; // outward lean per metre of height
  // Freeing ports: openings at the foot, as body-z intervals.
  ports?: { z0: number; z1: number }[];
  portHeight?: number;
  // Per-z extra height (e.g. higher at the bow).
  extraHeight?: (z: number) => number;
  // Stand on a raised deck (forecastle/whaleback) this high above the main deck edge.
  lift?: (z: number) => number;
  liftFlare?: number; // the raised deck's side flare per metre (matches raisedDeck), default 0.06
}

// Bulwark plating standing on the deck edge (both sides): outer, inner and capping rail.
export function bulwarks(lines: HullLines, options: BulwarkOptions): MeshData {
  const t = options.thickness ?? 0.12;
  const flare = options.flare ?? 0.05;
  const portH = options.portHeight ?? 0.35;
  const zs = new Set<number>();
  for (const s of stationParameters(options.stations, options.sFrom, options.sTo)) zs.add(lines.zAt(s));
  const z0 = lines.zAt(options.sFrom);
  const z1 = lines.zAt(options.sTo);
  for (const p of options.ports ?? []) {
    if (p.z0 > z0 && p.z0 < z1) zs.add(p.z0);
    if (p.z1 > z0 && p.z1 < z1) zs.add(p.z1);
  }
  const zList = [...zs].sort((a, b) => a - b);
  const inPort = (za: number, zb: number): boolean =>
    (options.ports ?? []).some((p) => za >= p.z0 - 1e-6 && zb <= p.z1 + 1e-6);
  const parts: MeshData[] = [];
  for (const side of [-1, 1]) {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    // Per station: outer foot, outer port-top, outer top, inner top, inner port-top, inner foot.
    const ring = 6;
    for (const z of zList) {
      const lift = options.lift?.(z) ?? 0;
      const half = lines.deckHalf(z) + lift * (options.liftFlare ?? 0.06);
      const yd = lines.deckY(z) + lift;
      const h = options.height + (options.extraHeight?.(z) ?? 0);
      const xo = (y: number): number => half + flare * (y - yd);
      const pts: [number, number][] = [
        [xo(yd), yd],
        [xo(yd + portH), yd + portH],
        [xo(yd + h), yd + h],
        [xo(yd + h) - t, yd + h],
        [xo(yd + portH) - t, yd + portH],
        [xo(yd) - t, yd],
      ];
      for (const [x, y] of pts) {
        positions.push(side * x, y, z);
        uvs.push(z - lines.zBow, y);
      }
    }
    for (let i = 0; i + 1 < zList.length; i++) {
      const open = inPort(zList[i]!, zList[i + 1]!);
      for (let k = 0; k < ring - 1; k++) {
        if (open && (k === 0 || k === 4)) continue;
        const a = i * ring + k;
        const b = a + 1;
        const c = a + ring;
        const d = c + 1;
        if (side > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
    parts.push(pack(positions, uvs, indices));
  }
  return mergeMeshData(parts);
}

export interface PatchOptions {
  zFrom: number;
  zTo: number;
  yFrom: number;
  yTo: number;
  side: 1 | -1; // starboard / port
  offset?: number; // off the surface, m
  nz?: number;
  ny?: number;
  // 'unit': 0..1 across the patch, oriented to read left-to-right from outside; 'metric': metres.
  uv?: 'unit' | 'metric';
  // Heights that vary along the hull (a sheer stripe parallel to the deck edge); override yFrom/yTo.
  yFromAt?: (z: number) => number;
  yToAt?: (z: number) => number;
}

// A patch of the hull side that hugs the shell (decals, name boards, window strips).
export function hullPatch(lines: HullLines, options: PatchOptions): MeshData {
  const nz = options.nz ?? 24;
  const ny = options.ny ?? 4;
  const off = options.offset ?? 0.03;
  const positions: number[] = [];
  const uvs: number[] = [];
  const side = options.side;
  for (let i = 0; i <= nz; i++) {
    const z = options.zFrom + ((options.zTo - options.zFrom) * i) / nz;
    const y0 = options.yFromAt?.(z) ?? options.yFrom;
    const y1 = options.yToAt?.(z) ?? options.yTo;
    for (let k = 0; k <= ny; k++) {
      const y = y0 + ((y1 - y0) * k) / ny;
      const x = lines.halfBreadthAt(z, y);
      positions.push(side * (x + off), y, z);
      // Seen from starboard the bow is on the right; from port it is on the left.
      const along = side > 0 ? options.zTo - z : z - options.zFrom;
      if (options.uv === 'metric') uvs.push(along, y - y0);
      else uvs.push(along / (options.zTo - options.zFrom), k / ny);
    }
  }
  const indices = gridIndices(nz + 1, ny + 1, side < 0);
  return pack(positions, uvs, indices);
}
