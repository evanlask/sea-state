// Star catalogue records and the spatial grid the sky shader uses to draw them.
//
// A star record is four floats: [right ascension (rad), declination (rad), V magnitude, B−V colour
// index] in the J2000 equatorial frame (x → RA 0h, z → north celestial pole). generateProceduralStars()
// makes a deterministic stand-in field until the Bright Star Catalogue loads.
//
// The GPU looks stars up by direction: the celestial sphere is split into the cells of a cube map
// (6 × G × G), and each star is listed in every cell its point-spread function can reach, so a
// fragment only scans its own cell. Pure TS (shared with tests).

export const STAR_RECORD_FLOATS = 4;
// Per-star GPU entry: two vec4s, (direction.xyz, illuminance lux) and (linear RGB, 0).
export const STAR_ENTRY_FLOATS = 8;

export interface StarGridOptions {
  gridSize: number; // cells per cube-face edge
  maxPerCell: number; // brightest kept when a cell overflows
  maxEntries: number; // capacity of the GPU star buffer
  radius: number; // rad, reach of a star's point-spread function
}

export const DEFAULT_STAR_GRID: StarGridOptions = {
  gridSize: 64,
  maxPerCell: 12,
  maxEntries: 32_768,
  radius: 0.35 * (Math.PI / 180),
};

export interface StarGrid {
  cells: Uint32Array; // per cell: start entry, count
  entries: Float32Array; // STAR_ENTRY_FLOATS per entry
  entryCount: number;
  starCount: number;
  dropped: number; // cell-overflow or capacity drops
}

export interface DecodedStar {
  x: number;
  y: number;
  z: number;
  illuminance: number; // lux outside the atmosphere
  r: number;
  g: number;
  b: number; // linear Rec.709, luminance 1
}

// Illuminance (lux) of a star of apparent V magnitude, outside the atmosphere [K].
export const starIlluminance = (magnitude: number): number => 10 ** ((-14.18 - magnitude) / 2.5);

// Effective temperature from B−V (Ballesteros 2012).
export function bvToTemperature(bv: number): number {
  const c = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
}

// CIE 1931 2° colour matching functions, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013).
function cie(lambdaNm: number): [number, number, number] {
  const g = (x: number, mu: number, s1: number, s2: number): number => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const x =
    1.056 * g(lambdaNm, 599.8, 37.9, 31.0) +
    0.362 * g(lambdaNm, 442.0, 16.0, 26.7) -
    0.065 * g(lambdaNm, 501.1, 20.4, 26.2);
  const y = 0.821 * g(lambdaNm, 568.8, 46.9, 40.5) + 0.286 * g(lambdaNm, 530.9, 16.3, 31.1);
  const z = 1.217 * g(lambdaNm, 437.0, 11.8, 36.0) + 0.681 * g(lambdaNm, 459.0, 26.0, 13.8);
  return [x, y, z];
}

// Blackbody colour in linear Rec.709, normalised to luminance 1 (negative lobes clamped).
export function temperatureToLinearRgb(kelvin: number): [number, number, number] {
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const lambda = nm * 1e-9;
    const planck = 1 / (lambda ** 5 * (Math.exp(0.014387769 / (lambda * kelvin)) - 1));
    const [cx, cy, cz] = cie(nm);
    X += planck * cx;
    Y += planck * cy;
    Z += planck * cz;
  }
  const r = Math.max(0, 3.2406 * X - 1.5372 * Y - 0.4986 * Z);
  const g = Math.max(0, -0.9689 * X + 1.8758 * Y + 0.0415 * Z);
  const b = Math.max(0, 0.0557 * X - 0.204 * Y + 1.057 * Z);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0 ? [r / lum, g / lum, b / lum] : [1, 1, 1];
}

// Decodes record i of a star array. Returns null for malformed (non-finite) records.
export function decodeStar(records: Float32Array, index: number): DecodedStar | null {
  const o = index * STAR_RECORD_FLOATS;
  const ra = records[o];
  const dec = records[o + 1];
  const mag = records[o + 2];
  const bv = records[o + 3];
  if (
    ra === undefined ||
    dec === undefined ||
    mag === undefined ||
    bv === undefined ||
    !Number.isFinite(ra + dec + mag + bv)
  ) {
    return null;
  }
  const cd = Math.cos(dec);
  const [r, g, b] = temperatureToLinearRgb(bvToTemperature(bv));
  return {
    x: cd * Math.cos(ra),
    y: cd * Math.sin(ra),
    z: Math.sin(dec),
    illuminance: starIlluminance(mag),
    r,
    g,
    b,
  };
}

// Cube-map cell of a direction. The sky shader implements the same mapping.
export function cubeCell(x: number, y: number, z: number, gridSize: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    face = x >= 0 ? 0 : 1;
    u = y / ax;
    v = z / ax;
  } else if (ay >= az) {
    face = y >= 0 ? 2 : 3;
    u = x / ay;
    v = z / ay;
  } else {
    face = z >= 0 ? 4 : 5;
    u = x / az;
    v = y / az;
  }
  const cell = (s: number): number =>
    Math.min(gridSize - 1, Math.max(0, Math.floor((s * 0.5 + 0.5) * gridSize)));
  return face * gridSize * gridSize + cell(v) * gridSize + cell(u);
}

// Bins stars into the cube-cell grid (brightest first, so overflow drops the faintest).
export function buildStarGrid(records: Float32Array, options: StarGridOptions = DEFAULT_STAR_GRID): StarGrid {
  const { gridSize, maxPerCell, maxEntries, radius } = options;
  const cellCount = 6 * gridSize * gridSize;
  const stars: DecodedStar[] = [];
  const total = Math.floor(records.length / STAR_RECORD_FLOATS);
  for (let i = 0; i < total; i++) {
    const star = decodeStar(records, i);
    if (star && star.illuminance > 0) stars.push(star);
  }
  stars.sort((a, b) => b.illuminance - a.illuminance);

  const lists: number[][] = Array.from({ length: cellCount }, () => []);
  let dropped = 0;
  const touched = new Set<number>();
  for (let s = 0; s < stars.length; s++) {
    const star = stars[s];
    if (!star) continue;
    // Tangent basis around the star; probe the PSF footprint's rim and diagonals.
    const [hx, hy, hz] = Math.abs(star.z) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ex = hy * star.z - hz * star.y;
    let ey = hz * star.x - hx * star.z;
    let ez = hx * star.y - hy * star.x;
    const el = Math.hypot(ex, ey, ez);
    ex /= el;
    ey /= el;
    ez /= el;
    const fx = star.y * ez - star.z * ey;
    const fy = star.z * ex - star.x * ez;
    const fz = star.x * ey - star.y * ex;
    touched.clear();
    touched.add(cubeCell(star.x, star.y, star.z, gridSize));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const ca = Math.cos(a) * radius;
      const sa = Math.sin(a) * radius;
      touched.add(
        cubeCell(
          star.x + ex * ca + fx * sa,
          star.y + ey * ca + fy * sa,
          star.z + ez * ca + fz * sa,
          gridSize,
        ),
      );
    }
    for (const cell of touched) {
      const list = lists[cell];
      if (!list) continue;
      if (list.length >= maxPerCell) dropped++;
      else list.push(s);
    }
  }

  const cells = new Uint32Array(cellCount * 2);
  const entries = new Float32Array(maxEntries * STAR_ENTRY_FLOATS);
  let entryCount = 0;
  for (let c = 0; c < cellCount; c++) {
    const list = lists[c] ?? [];
    const start = entryCount;
    for (const s of list) {
      const star = stars[s];
      if (!star) continue;
      if (entryCount >= maxEntries) {
        dropped++;
        continue;
      }
      entries.set([star.x, star.y, star.z, star.illuminance, star.r, star.g, star.b, 0], entryCount * 8);
      entryCount++;
    }
    cells[c * 2] = start;
    cells[c * 2 + 1] = entryCount - start;
  }
  return { cells, entries, entryCount, starCount: stars.length, dropped };
}

// Small deterministic PRNG (mulberry32), local so this module stays dependency-free.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// North galactic pole in J2000 equatorial coordinates (RA 192.86°, Dec 27.13°).
const GALACTIC_POLE: [number, number, number] = (() => {
  const ra = (192.85948 * Math.PI) / 180;
  const dec = (27.12825 * Math.PI) / 180;
  return [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
})();

// A plausible naked-eye sky: counts rise ~×3.3 per magnitude to `faintest`, about 40 % of stars
// crowd toward the galactic plane, and B−V follows a broad distribution around solar colour.
export function generateProceduralStars(count = 6000, seed = 1, faintest = 6.5): Float32Array {
  const random = mulberry32(seed);
  const gauss = (): number => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };
  const out = new Float32Array(count * STAR_RECORD_FLOATS);
  const [px, py, pz] = GALACTIC_POLE;
  // Basis spanning the galactic plane.
  let ax = -py;
  let ay = px;
  let az = 0;
  const al = Math.hypot(ax, ay, az);
  ax /= al;
  ay /= al;
  az /= al;
  const bx = py * az - pz * ay;
  const by = pz * ax - px * az;
  const bz = px * ay - py * ax;
  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let z: number;
    if (random() < 0.4) {
      const longitude = random() * Math.PI * 2;
      const latitude = Math.max(-1.4, Math.min(1.4, gauss() * 0.26));
      const cl = Math.cos(latitude);
      const sl = Math.sin(latitude);
      const c = Math.cos(longitude) * cl;
      const s = Math.sin(longitude) * cl;
      x = ax * c + bx * s + px * sl;
      y = ay * c + by * s + py * sl;
      z = az * c + bz * s + pz * sl;
    } else {
      z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      x = r * Math.cos(phi);
      y = r * Math.sin(phi);
    }
    const ra = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
    const dec = Math.asin(Math.max(-1, Math.min(1, z)));
    const u = (i + random()) / count;
    const magnitude = faintest + Math.log10(Math.max(u, 1e-9)) / 0.52;
    const bv = Math.max(-0.3, Math.min(1.9, 0.62 + gauss() * 0.42));
    out.set([ra, dec, Math.max(-1.5, magnitude), bv], i * STAR_RECORD_FLOATS);
  }
  return out;
}

// Row-major rotation from the equatorial frame to the world frame (+X east, +Y up, −Z north) for
// an observer at `latitude` (rad) and local sidereal time `lst` (rad).
export function equatorialToWorld(latitude: number, lst: number): number[] {
  const cl = Math.cos(latitude);
  const sl = Math.sin(latitude);
  const ct = Math.cos(lst);
  const st = Math.sin(lst);
  // Hour-angle frame: e = Rz(−lst)·c (x_e → meridian on the equator, y_e → east, z_e → pole).
  // world = (e_y, cosφ·e_x + sinφ·e_z, sinφ·e_x − cosφ·e_z).
  const ex = [ct, st, 0];
  const ey = [-st, ct, 0];
  const ez = [0, 0, 1];
  const row = (a: number[], ka: number, b: number[], kb: number): number[] =>
    a.map((value, i) => value * ka + (b[i] ?? 0) * kb);
  return [...ey, ...row(ex, cl, ez, sl), ...row(ex, sl, ez, -cl)];
}
