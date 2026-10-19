// Procedural textures generated at load time and cached: a tileable
// multi-octave noise texture that drives all weathering (sampled in body
// space), and small canvas helpers for liveries and decals.

import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
} from 'three/webgpu';

// --------------------------------------------------------------- noise (pure)

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Tileable value noise on a period × periodY lattice, smooth-step interpolated.
function valueNoise(u: number, v: number, period: number, periodY: number, seed: number): number {
  const x = u * period;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const wrap = (a: number, p: number): number => ((a % p) + p) % p;
  const a = hash2(wrap(x0, period), wrap(y0, periodY), seed);
  const b = hash2(wrap(x0 + 1, period), wrap(y0, periodY), seed);
  const c = hash2(wrap(x0, period), wrap(y0 + 1, periodY), seed);
  const d = hash2(wrap(x0 + 1, period), wrap(y0 + 1, periodY), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(
  u: number,
  v: number,
  baseX: number,
  baseY: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = baseX;
  let fy = baseY;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, fx, fy, seed + o * 17);
    norm += amp;
    amp *= gain;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

// RGBA noise tile: R broad blotches, G mid-frequency mottling, B vertical streaks (stretched 1:24
// in v), A fine speckle. Each channel is contrast-stretched to use the 0..1 range.
function generateNoiseData(size: number, seed = 1): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const channels = [
    (u: number, v: number) => fbm(u, v, 4, 4, 5, seed),
    (u: number, v: number) => fbm(u, v, 16, 16, 4, seed + 101),
    (u: number, v: number) => fbm(u, v, 48, 2, 4, seed + 202, 0.55),
    (u: number, v: number) => fbm(u, v, 128, 128, 2, seed + 303),
  ];
  const tmp = new Float32Array(size * size);
  for (let c = 0; c < 4; c++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const value = channels[c]!(x / size, y / size);
        tmp[y * size + x] = value;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    const range = Math.max(1e-6, hi - lo);
    for (let i = 0; i < tmp.length; i++) data[i * 4 + c] = Math.round(((tmp[i]! - lo) / range) * 255);
  }
  return data;
}

// ------------------------------------------------------------- three textures

let noise: DataTexture | null = null;

export function noiseTexture(): DataTexture {
  if (noise) return noise;
  const size = 256;
  const tex = new DataTexture(generateNoiseData(size, 7), size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.name = 'boat-noise';
  tex.needsUpdate = true;
  noise = tex;
  return tex;
}

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return ctx;
}

export interface CanvasTextureOptions {
  srgb?: boolean;
  repeat?: boolean;
  mipmaps?: boolean;
  anisotropy?: number;
}

// Textures made while a template is built (collectTextures), so that disposing the template frees them.
let collecting: Texture[] | null = null;

export function trackTexture<T extends Texture>(texture: T): T {
  collecting?.push(texture);
  return texture;
}

// Runs `build` and returns what it produced with every texture tracked (canvasTexture, trackTexture)
// meanwhile. Nests: an inner call's textures also belong to the outer one.
export function collectTextures<T>(build: () => T): { result: T; textures: Texture[] } {
  const outer = collecting;
  const textures: Texture[] = [];
  collecting = textures;
  try {
    return { result: build(), textures };
  } finally {
    collecting = outer;
    outer?.push(...textures);
  }
}

export function canvasTexture(canvas: HTMLCanvasElement, options: CanvasTextureOptions = {}): Texture {
  const tex = trackTexture(new CanvasTexture(canvas));
  if (options.srgb ?? true) tex.colorSpace = SRGBColorSpace;
  if (options.repeat) {
    tex.wrapS = RepeatWrapping;
    tex.wrapT = RepeatWrapping;
  }
  tex.generateMipmaps = options.mipmaps ?? true;
  tex.minFilter = tex.generateMipmaps ? LinearMipmapLinearFilter : LinearFilter;
  tex.anisotropy = options.anisotropy ?? 8;
  tex.needsUpdate = true;
  return tex;
}

// Draws stencil-style text fitted inside a box (used for hull names, ports, container logos).
export function drawFittedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  height: number,
  options: { font?: string; weight?: string; align?: CanvasTextAlign; spacing?: number } = {},
): void {
  const weight = options.weight ?? '700';
  const family = options.font ?? '"Arial Narrow", "Helvetica Neue", Arial, sans-serif';
  ctx.font = `${weight} ${height}px ${family}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = options.align ?? 'center';
  const spacing = options.spacing ?? 0.08;
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${height * spacing}px`;
  const measured = ctx.measureText(text).width;
  const sx = measured > maxWidth ? maxWidth / measured : 1;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, 1);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}
