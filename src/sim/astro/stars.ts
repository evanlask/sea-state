// Bright-star catalogue: binary format, decoder, and photometric helpers.
//
// Source: Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991,
// public domain, via the Harvard/CDS distribution) as converted to JSON by
// github.com/brettonw/YaleBrightStarCatalog (MIT), file bsc5.json at commit
// abffb3b7223ae37e879b0a3ff5b49ad06aed5576. See public/data/stars.LICENSE.txt.
// Converted once into public/data/stars.bin.gz.
//
// stars.bin layout, little-endian, 4-byte aligned:
//   header  u32 magic 'STR1' (0x31525453), u32 record count, u32 floats per record (4), u32 reserved
//   records float32 [RA (rad, J2000), Dec (rad, J2000), V magnitude, B−V], brightest first
// The file is served gzip-compressed; the loader inflates it with
//   new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
// before calling decodeStarCatalog. (Don't rely on Content-Encoding: static hosts
// serve .gz files as opaque binaries.)
//
// This module has no imports so the Node build script can load it directly.

const STAR_MAGIC = 0x31525453; // 'STR1' read as a little-endian u32
const STAR_HEADER_BYTES = 16;
const STAR_FLOATS_PER_RECORD = 4;
const STAR_RECORD_BYTES = STAR_FLOATS_PER_RECORD * 4;

export interface StarRecord {
  rightAscension: number; // radians, J2000
  declination: number; // radians, J2000
  magnitude: number; // Johnson V
  colorIndex: number; // Johnson B−V
}

export interface StarCatalog {
  count: number;
  // Interleaved records, STAR_FLOATS_PER_RECORD floats each, ready for a GPU buffer.
  data: Float32Array;
}

export function encodeStarCatalog(stars: readonly StarRecord[]): ArrayBuffer {
  const buffer = new ArrayBuffer(STAR_HEADER_BYTES + stars.length * STAR_RECORD_BYTES);
  const view = new DataView(buffer);
  view.setUint32(0, STAR_MAGIC, true);
  view.setUint32(4, stars.length, true);
  view.setUint32(8, STAR_FLOATS_PER_RECORD, true);
  view.setUint32(12, 0, true);
  stars.forEach((star, i) => {
    const offset = STAR_HEADER_BYTES + i * STAR_RECORD_BYTES;
    view.setFloat32(offset, star.rightAscension, true);
    view.setFloat32(offset + 4, star.declination, true);
    view.setFloat32(offset + 8, star.magnitude, true);
    view.setFloat32(offset + 12, star.colorIndex, true);
  });
  return buffer;
}

// Validates the header and copies records out with explicit little-endian
// reads, so the result is correct on any host byte order.
export function decodeStarCatalog(buffer: ArrayBuffer): StarCatalog {
  if (buffer.byteLength < STAR_HEADER_BYTES) throw new Error('Star catalogue is truncated');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== STAR_MAGIC) throw new Error('Not a star catalogue (bad magic)');
  const count = view.getUint32(4, true);
  const floats = view.getUint32(8, true);
  if (floats !== STAR_FLOATS_PER_RECORD) throw new Error(`Unsupported star record size ${floats}`);
  if (buffer.byteLength < STAR_HEADER_BYTES + count * STAR_RECORD_BYTES) {
    throw new Error('Star catalogue is truncated');
  }
  const data = new Float32Array(count * STAR_FLOATS_PER_RECORD);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(STAR_HEADER_BYTES + i * 4, true);
  return { count, data };
}

export function starAt(catalog: StarCatalog, index: number): StarRecord {
  const o = index * STAR_FLOATS_PER_RECORD;
  const { data } = catalog;
  return {
    rightAscension: data[o],
    declination: data[o + 1],
    magnitude: data[o + 2],
    colorIndex: data[o + 3],
  };
}

// Brightness relative to a V = 0 star (Pogson: 5 magnitudes = 100×).
export const magnitudeToIntensity = (magnitude: number): number => 10 ** (-0.4 * magnitude);

// Effective temperature from B−V (Ballesteros 2012, a blackbody fit good for
// main-sequence and giant stars to a few percent), kelvin.
export function colorIndexToTemperature(bv: number): number {
  const clamped = Math.min(2, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * clamped + 1.7) + 1 / (0.92 * clamped + 0.62));
}

// Inverse of colorIndexToTemperature, for catalogue rows that only give a
// temperature. Solves the quadratic in x = 0.92·(B−V).
export function temperatureToColorIndex(kelvin: number): number {
  // 4600 (2x + 2.32) = T (x + 1.7)(x + 0.62)  →  T x² + (2.32 T − 9200) x + (1.054 T − 10672) = 0
  const t = kelvin;
  const b = 2.32 * t - 9200;
  const c = 1.054 * t - 10672;
  const x = (-b + Math.sqrt(b * b - 4 * t * c)) / (2 * t);
  return x / 0.92;
}

// Linear sRGB (D65) colour of a blackbody, normalised to unit luminance so
// intensity comes only from the magnitude. Planckian locus chromaticity from
// Kim et al. (2002), valid 1667–25000 K (clamped).
function temperatureToRgb(kelvin: number, out: number[] = [0, 0, 0]): number[] {
  const t = Math.min(25000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  let y: number;
  if (t <= 2222) y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  else if (t <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  else y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  // xyY with Y = 1 → XYZ → linear sRGB.
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  const r = Math.max(0, 3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ);
  const g = Math.max(0, -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ);
  const b = Math.max(0, 0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ);
  // Re-normalise after clipping out-of-gamut negatives.
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out[0] = r / luminance;
  out[1] = g / luminance;
  out[2] = b / luminance;
  return out;
}

// B−V → unit-luminance linear sRGB. Hot stars (B−V < 0) come out blue-white,
// the Sun (0.65) faintly yellow, and M giants (B−V > 1.5) orange-red.
export const colorIndexToRgb = (bv: number, out?: number[]): number[] =>
  temperatureToRgb(colorIndexToTemperature(bv), out);
