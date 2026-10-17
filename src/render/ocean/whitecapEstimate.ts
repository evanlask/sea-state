// Offline whitecap coverage (Node, for tests and tuning): the GPU foam pipeline replayed on the CPU.
// The physics cascades are synthesised exactly as GpuOcean's evolve pass does (same h0, quantised
// dispersion, spectral derivatives), the foam accumulates per texel as in its assemble pass, and the
// ocean shader's foam (OceanMaterial.buildSurface / buildFoam, with the foam detail texture of
// FoamDetail) is evaluated at random points of the sea for a given pixel footprint. The result is
// the mean whiteness of the sea, the rendered counterpart of the observed whitecap coverage.

import { PHYSICS_CASCADES, signedMode } from '../../sim/ocean/cascades';
import { Fft2d } from '../../sim/ocean/fft';
import { type CascadeSpectrum, OceanSpectrumBuilder } from '../../sim/ocean/h0';
import { hash32 } from '../../sim/ocean/hash';
import { quantizedDispersion, resolveSpectrum, spectrumParamsFromSeaState } from '../../sim/ocean/spectrum';
import type { WeatherPreset } from '../../sim/weather/presets';
import { DEFAULT_FETCH, resolveSeaState } from '../../sim/weather/seaState';
import {
  FOAM_ACCUMULATED_GAIN,
  FOAM_DRIFT_ACROSS,
  FOAM_DRIFT_ALONG,
  FOAM_MASK_RMS,
  FOAM_PATCH_ANGLE,
  FOAM_PATCH_TILE,
  FOAM_REGION_ANGLE,
  FOAM_REGION_THRESHOLD,
  FOAM_REGION_TILE,
  FOAM_STRAIN_MASK,
  FOAM_THICK_LACE,
  foamCascadeWeight,
  foamMask,
  foamBrightness,
  foamShown,
  GROUP_MAX,
  GROUP_OFFSET,
  GROUP_SCALE,
  LACE_COARSE_TILE,
  LACE_FINE_ANGLE,
  LACE_FINE_TILE,
  LACE_WARP,
  MASK_PATCH_DRIFT,
  MASK_SHORT_DRIFT,
  MASK_SHORT_PATCHES,
  STREAK_BAND,
  STREAK_BAND_REGION,
  STREAK_BASE,
  STREAK_FRAY,
  STREAK_GAIN,
  STREAK_LEE,
  STREAK_OCTAVES,
  STREAK_REGION_WARP,
  STREAK_SPUME_GAIN,
  STREAK_TRAIL,
  STREAK_WARP,
  STREAK_WINDWARD,
  streakOctave,
} from './foamPattern';
import {
  FOAM_MIN_PATCH,
  foamForWind,
  jacobianStd,
  smoothstep,
  spectrumStatistics,
  type WindFoam,
} from './oceanOptics';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

// A periodic, mipmapped float texture (channels interleaved), sampled like the GPU's trilinear filter.
export class MipTexture {
  readonly size: number;
  readonly channels: number;
  readonly levels: Float32Array[] = [];

  constructor(size: number, channels: number, data: Float32Array) {
    this.size = size;
    this.channels = channels;
    this.levels.push(data);
    for (let s = size >> 1; s >= 1; s >>= 1) {
      const parent = this.levels[this.levels.length - 1] as Float32Array;
      const p = s * 2;
      const out = new Float32Array(s * s * channels);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          for (let c = 0; c < channels; c++) {
            const at = (yy: number, xx: number): number => parent[(yy * p + xx) * channels + c] as number;
            out[(y * s + x) * channels + c] =
              0.25 *
              (at(2 * y, 2 * x) + at(2 * y, 2 * x + 1) + at(2 * y + 1, 2 * x) + at(2 * y + 1, 2 * x + 1));
          }
        }
      }
      this.levels.push(out);
    }
  }

  private bilinear(level: number, u: number, v: number, out: number[]): void {
    const s = this.size >> level;
    const data = this.levels[level] as Float32Array;
    const c = this.channels;
    const x = u * s - 0.5;
    const y = v * s - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const m = s - 1;
    const xa = x0 & m;
    const xb = (x0 + 1) & m;
    const ya = y0 & m;
    const yb = (y0 + 1) & m;
    for (let k = 0; k < c; k++) {
      const a = data[(ya * s + xa) * c + k] as number;
      const b = data[(ya * s + xb) * c + k] as number;
      const d = data[(yb * s + xa) * c + k] as number;
      const e = data[(yb * s + xb) * c + k] as number;
      out[k] = mix(mix(a, b, fx), mix(d, e, fx), fy);
    }
  }

  // uv in texture units (repeating); footprint in texels of level 0.
  sample(u: number, v: number, footprint: number, out: number[]): number[] {
    const lod = Math.min(this.levels.length - 1, Math.max(0, Math.log2(Math.max(footprint, 1))));
    const l0 = Math.floor(lod);
    const t = lod - l0;
    this.bilinear(l0, u, v, out);
    if (t > 0 && l0 + 1 < this.levels.length) {
      const hi: number[] = [];
      this.bilinear(l0 + 1, u, v, hi);
      for (let k = 0; k < this.channels; k++) out[k] = mix(out[k] as number, hi[k] as number, t);
    }
    return out;
  }
}

// --- FoamDetail, on the CPU (same hashes, cells and shaping) ---

function hash2(x: number, y: number, seed: number): [number, number] {
  let h = (Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801 | 0) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  const a = (h ^ (h >>> 16)) >>> 0;
  const b = (Math.imul(a, 0x9e3779b9 | 0) ^ (a >>> 13)) >>> 0;
  return [(a & 0xffffff) / 16777216, (b & 0xffffff) / 16777216];
}

function worley(u: number, v: number, cells: number, seed: number): [number, number] {
  const px = u * cells;
  const py = v * cells;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const lx = px - cx;
  const ly = py - cy;
  let f1 = 8;
  let f2 = 8;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const [hx, hy] = hash2((cx + i + cells) % cells, (cy + j + cells) % cells, seed);
      const d = Math.hypot(i + hx * 0.85 + 0.075 - lx, j + hy * 0.85 + 0.075 - ly);
      f2 = Math.min(Math.max(f1, d), f2);
      f1 = Math.min(f1, d);
    }
  }
  return [f1, f2];
}

function valueNoise(u: number, v: number, cells: number, seed: number): number {
  const px = u * cells;
  const py = v * cells;
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  const fx = px - cx;
  const fy = py - cy;
  const wx = fx * fx * (3 - 2 * fx);
  const wy = fy * fy * (3 - 2 * fy);
  const corner = (i: number, j: number): number => hash2((cx + i) % cells, (cy + j) % cells, seed)[0];
  return mix(mix(corner(0, 0), corner(1, 0), wx), mix(corner(0, 1), corner(1, 1), wx), wy);
}

let detailTexture: MipTexture | null = null;

// The foam detail texture (lace, density, bubbles), 512² like FoamDetail's.
export function foamDetailTexture(size = 512): MipTexture {
  if (detailTexture && detailTexture.size === size) return detailTexture;
  const data = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const walls = (cells: number, seed: number, width: number): number => {
        const [f1, f2] = worley(u, v, cells, seed);
        return (1 - smoothstep(0, width, f2 - f1)) * smoothstep(1.4, 0.4, f2);
      };
      const lace = Math.max(walls(7, 11, 0.32), walls(15, 23, 0.26) * 0.85, walls(31, 37, 0.22) * 0.7);
      const holes = smoothstep(0.05, 0.45, worley(u, v, 23, 53)[0]);
      const density =
        valueNoise(u, v, 4, 71) * 0.55 + valueNoise(u, v, 9, 83) * 0.3 + valueNoise(u, v, 19, 97) * 0.15;
      const bubbles = smoothstep(0.35, 0.1, worley(u, v, 48, 109)[0]);
      const i = (y * size + x) * 3;
      data[i] = Math.sqrt(lace * (holes * 0.4 + 0.6));
      data[i + 1] = density;
      data[i + 2] = bubbles;
    }
  }
  detailTexture = new MipTexture(size, 3, data);
  return detailTexture;
}

// --- GPU ocean replay ---

interface SeaSpectra {
  wind: number; // m/s
  windDirection: [number, number]; // unit, toward
  physics: CascadeSpectrum[];
}

function presetSpectra(preset: WeatherPreset, seed = 1): SeaSpectra {
  const sea = resolveSeaState(preset.seaState, preset.windSpeed, preset.windFrom);
  const fetch = preset.seaState.mode === 'auto' ? preset.seaState.fetch : DEFAULT_FETCH;
  const spectrum = resolveSpectrum(spectrumParamsFromSeaState(sea, preset.windSpeed, preset.windFrom, fetch));
  const physics = new OceanSpectrumBuilder(PHYSICS_CASCADES, [], seed).build(spectrum).physics;
  return {
    wind: preset.windSpeed,
    windDirection: [-Math.sin(preset.windFrom), Math.cos(preset.windFrom)],
    physics,
  };
}

// Per foam-making layer: its Jacobian deviation (as GpuOceanSimulation / OceanMesh compute it).
function layerJacobianStds(physics: readonly CascadeSpectrum[]): number[] {
  return physics.map((c) => {
    const s = spectrumStatistics(c.h0, c.cascade.resolution, c.cascade.size);
    return jacobianStd(c.choppiness, s.slopeVarianceX + s.slopeVarianceZ);
  });
}

// One cascade's fields at time t (GpuOcean evolve + inverse FFT): per texel the height slopes and the
// strain ∂Dx/∂x, ∂Dz/∂z; and its accumulated foam.
class CascadeReplay {
  readonly spectrum: CascadeSpectrum;
  readonly n: number;
  readonly patch: number;
  readonly foam: Float32Array;
  private readonly fft: Fft2d;
  private readonly a: Float64Array; // (∂Dy/∂x + i∂Dy/∂z)
  private readonly b: Float64Array; // (∂Dx/∂x + i∂Dz/∂z)
  private readonly modes: { texel: number; kx: number; kz: number; k: number; omega: number }[] = [];

  constructor(spectrum: CascadeSpectrum) {
    this.spectrum = spectrum;
    const n = spectrum.cascade.resolution;
    this.n = n;
    this.patch = spectrum.cascade.size;
    this.fft = new Fft2d(n);
    this.a = new Float64Array(2 * n * n);
    this.b = new Float64Array(2 * n * n);
    this.foam = new Float32Array(n * n);
    const dk = (2 * Math.PI) / this.patch;
    for (let texel = 0; texel < n * n; texel++) {
      const h = spectrum.h0;
      if (h[4 * texel] === 0 && h[4 * texel + 1] === 0 && h[4 * texel + 2] === 0 && h[4 * texel + 3] === 0)
        continue;
      const kx = signedMode(texel % n, n) * dk;
      const kz = signedMode(Math.floor(texel / n), n) * dk;
      const k = Math.hypot(kx, kz);
      this.modes.push({ texel, kx, kz, k, omega: quantizedDispersion(k) });
    }
  }

  synthesise(t: number): void {
    const { a, b } = this;
    a.fill(0);
    b.fill(0);
    const h0 = this.spectrum.h0;
    const lambda = this.spectrum.choppiness;
    for (const m of this.modes) {
      const q = 4 * m.texel;
      const cs = Math.cos(m.omega * t);
      const sn = Math.sin(m.omega * t);
      const r0 = h0[q] as number;
      const i0 = h0[q + 1] as number;
      const r1 = h0[q + 2] as number;
      const i1 = h0[q + 3] as number;
      // h0·e^{−iωt} + conj(h0(−k))·e^{+iωt}
      const hr = r0 * cs + i0 * sn + r1 * cs - i1 * sn;
      const hi = i0 * cs - r0 * sn + r1 * sn + i1 * cs;
      // i·k·h → (−k·hi, k·hr); packed field1 + i·field2 = (f1r − f2i, f1i + f2r).
      const sxr = -m.kx * hi;
      const sxi = m.kx * hr;
      const szr = -m.kz * hi;
      const szi = m.kz * hr;
      a[2 * m.texel] = sxr - szi;
      a[2 * m.texel + 1] = sxi + szr;
      const fx = (-lambda * m.kx * m.kx) / m.k;
      const fz = (-lambda * m.kz * m.kz) / m.k;
      b[2 * m.texel] = fx * hr - fz * hi;
      b[2 * m.texel + 1] = fx * hi + fz * hr;
    }
    this.fft.inverse(a);
    this.fft.inverse(b);
  }

  // The linearised Jacobian 1 + ∂Dx/∂x + ∂Dz/∂z, which the GPU's breaking test reads.
  linearJacobian(texel: number): number {
    return 1 + (this.b[2 * texel] as number) + (this.b[2 * texel + 1] as number);
  }

  // Derivatives texture (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z) and foam, as the shader samples them.
  textures(): { derivatives: MipTexture; foam: MipTexture } {
    const n = this.n;
    const d = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      d[4 * i] = this.a[2 * i] as number;
      d[4 * i + 1] = this.a[2 * i + 1] as number;
      d[4 * i + 2] = this.b[2 * i] as number;
      d[4 * i + 3] = this.b[2 * i + 1] as number;
    }
    return { derivatives: new MipTexture(n, 4, d), foam: new MipTexture(n, 1, Float32Array.from(this.foam)) };
  }
}

// The per-layer GPU foam accumulation (GpuOcean assemble): what to add this step, from the Jacobian.
interface FoamAccumulation {
  // breaking intensity 0..1 of layer `layer` at Jacobian j
  breaking(layer: number, j: number): number;
  buildRate: number;
  decayRate: number;
}

function windFoamAccumulation(foam: WindFoam): FoamAccumulation {
  return {
    breaking: (layer, j) => clamp01(((foam.thresholds[layer] ?? -10) - j) * (foam.gains[layer] ?? 0)),
    buildRate: foam.buildRate,
    decayRate: foam.decayRate,
  };
}

interface FoamSnapshot {
  patches: number[];
  stds: number[];
  derivatives: MipTexture[];
  foam: MipTexture[];
}

// Runs the accumulation from a calm start for `duration` seconds at time step dt; returns snapshots
// of the fields at the given times (each within the run).
function replayFoam(
  sea: SeaSpectra,
  accumulation: FoamAccumulation,
  options: { dt: number; times: readonly number[]; start?: number },
): FoamSnapshot[] {
  const layers = sea.physics.map((s) => new CascadeReplay(s));
  const stds = layerJacobianStds(sea.physics);
  const start = options.start ?? 100;
  const end = Math.max(...options.times);
  const snapshots: FoamSnapshot[] = [];
  const decay = Math.exp(-accumulation.decayRate * options.dt);
  let next = 0;
  const sorted = [...options.times].sort((x, y) => x - y);
  for (let step = 0; ; step++) {
    const t = step * options.dt;
    if (t > end + 1e-9) break;
    layers.forEach((layer, l) => {
      layer.synthesise(start + t);
      const n2 = layer.n * layer.n;
      for (let i = 0; i < n2; i++) {
        const breaking = accumulation.breaking(l, layer.linearJacobian(i));
        layer.foam[i] = Math.min(
          (layer.foam[i] as number) * decay + breaking * accumulation.buildRate * options.dt,
          1.5,
        );
      }
    });
    if (next < sorted.length && t >= (sorted[next] as number) - 1e-9) {
      const textures = layers.map((layer) => layer.textures());
      snapshots.push({
        patches: layers.map((layer) => layer.patch),
        stds,
        derivatives: textures.map((x) => x.derivatives),
        foam: textures.map((x) => x.foam),
      });
      next++;
    }
  }
  return snapshots;
}

// --- The ocean shader's foam ---

interface ShaderFoamParams {
  crestThreshold: number;
  streaks: number;
  spume: number;
  windDirection: [number, number];
  foamOctaves: 1 | 2;
}

const scratch: number[] = [0, 0, 0, 0];

// Final foam (0..1) at world point (x, z) for a pixel footprint (m), as OceanMaterial computes it.
function shaderFoam(
  snapshot: FoamSnapshot,
  p: ShaderFoamParams,
  x: number,
  z: number,
  footprint: number,
): number {
  const detail = foamDetailTexture();
  const [wx, wz] = p.windDirection;
  const density = (u: number, v: number, tile: number): number =>
    (detail.sample(u, v, (footprint / tile) * detail.size, scratch)[1] as number) - 0.5;
  const turned = (angle: number, tile: number, offset: number): [number, number] => [
    (x * Math.cos(angle) - z * Math.sin(angle)) / tile + offset,
    (x * Math.sin(angle) + z * Math.cos(angle)) / tile + offset,
  ];
  const along = x * wx + z * wz;
  const across = -x * wz + z * wx;
  const r = turned(FOAM_REGION_ANGLE, FOAM_REGION_TILE, 0.13);
  const region = density(r[0], r[1], FOAM_REGION_TILE);
  const pt = turned(FOAM_PATCH_ANGLE, FOAM_PATCH_TILE, 0.71);
  const patches = density(pt[0], pt[1], FOAM_PATCH_TILE);
  const drift = density(
    along / FOAM_DRIFT_ALONG + 0.29,
    across / FOAM_DRIFT_ACROSS + 0.29,
    FOAM_DRIFT_ACROSS,
  );

  // buildSurface: per foam-making layer
  const layers: { patch: number; foam: number; strain: [number, number]; std: number }[] = [];
  let slopeX = 0;
  let slopeZ = 0;
  snapshot.patches.forEach((patch, l) => {
    if (patch < FOAM_MIN_PATCH) return;
    const weight = 1 - smoothstep(patch * 0.12, patch * 0.5, footprint);
    const n = (snapshot.derivatives[l] as MipTexture).size;
    const u = x / patch + 0.5 / n;
    const v = z / patch + 0.5 / n;
    const d = (snapshot.derivatives[l] as MipTexture).sample(u, v, (footprint / patch) * n, [0, 0, 0, 0]);
    const f = (snapshot.foam[l] as MipTexture).sample(u, v, (footprint / patch) * n, [0]);
    slopeX += (d[0] as number) * weight;
    slopeZ += (d[1] as number) * weight;
    layers.push({
      patch,
      foam: Math.max(f[0] as number, 0) * weight,
      strain: [(d[2] as number) * weight, (d[3] as number) * weight],
      std: snapshot.stds[l] as number,
    });
  });
  const masks = [
    1,
    foamMask(region),
    foamMask(patches + drift * MASK_PATCH_DRIFT),
    foamMask(drift * MASK_SHORT_DRIFT + patches * MASK_SHORT_PATCHES),
  ];
  layers.sort((a, b) => b.patch - a.patch);
  let accumulated = 0;
  let strainX = 0;
  let strainZ = 0;
  layers.forEach((layer, rank) => {
    const mask = masks[Math.min(rank, masks.length - 1)] as number;
    const weight = foamCascadeWeight(layer.patch);
    const longer = layers[rank - 1];
    let group = 1;
    if (longer) {
      const zz = (longer.strain[0] + longer.strain[1]) / Math.max(longer.std, 1e-3);
      group = Math.min(Math.max(GROUP_OFFSET - zz, 0), GROUP_MAX) * GROUP_SCALE;
    }
    accumulated += layer.foam * mask * group * weight * FOAM_ACCUMULATED_GAIN;
    const strainMask = mix(1, mask / FOAM_MASK_RMS, FOAM_STRAIN_MASK);
    strainX += layer.strain[0] * strainMask * weight;
    strainZ += layer.strain[1] * strainMask * weight;
  });

  // buildFoam
  const stretch = p.streaks * 2.5 + 1;
  const warp = drift * LACE_WARP;
  const wu = along / stretch + warp;
  const wv = across - warp;
  const laceFootprint = (footprint / LACE_COARSE_TILE) * detail.size;
  const coarse = detail.sample(wu / LACE_COARSE_TILE, wv / LACE_COARSE_TILE, laceFootprint, [0, 0, 0]);
  let lace = coarse[0] as number;
  if (p.foamOctaves > 1) {
    const c = Math.cos(LACE_FINE_ANGLE);
    const s = Math.sin(LACE_FINE_ANGLE);
    const fine = detail.sample(
      (wu * c - wv * s) / LACE_FINE_TILE + 0.37,
      (wu * s + wv * c) / LACE_FINE_TILE + 0.37,
      (footprint / LACE_FINE_TILE) * detail.size,
      [0, 0, 0],
    );
    lace = mix(lace, fine[0] as number, 0.45);
  }
  const jac = (strainX + 1) * (strainZ + 1);
  const reach = 1 - p.crestThreshold;
  const threshold = p.crestThreshold + reach * region * FOAM_REGION_THRESHOLD;
  const crest = smoothstep(threshold + 0.1, threshold - 0.15, jac);
  const amount = clamp01(accumulated * 0.8 + crest);
  const thick = smoothstep(0.55, 1, amount);
  const by = coarse[1] as number;
  const pattern = mix(lace * (by * 0.6 + 0.55), by * 0.3 + 0.75, thick);
  const shown = foamShown(amount, pattern, footprint);
  const whitecap = shown * foamBrightness(amount, footprint) * (1 - thick * FOAM_THICK_LACE * (1 - lace));
  let streaks = 0;
  if (p.streaks > 0) {
    const bend = drift * STREAK_WARP + region * STREAK_REGION_WARP;
    let lines = 0;
    STREAK_OCTAVES.forEach((octave, i) => {
      const c = Math.cos(octave.angle);
      const s = Math.sin(octave.angle);
      const dx = wx * c - wz * s;
      const dz = wx * s + wz * c;
      lines += streakOctave(x * dx + z * dz, -x * dz + z * dx + bend, footprint, i);
    });
    const lee = smoothstep(STREAK_LEE[0], STREAK_LEE[1], slopeX * wx + slopeZ * wz);
    const trail = smoothstep(STREAK_TRAIL[0], STREAK_TRAIL[1], accumulated) * mix(STREAK_WINDWARD, 1, lee);
    const band = smoothstep(STREAK_BAND[0], STREAK_BAND[1], drift + region * STREAK_BAND_REGION);
    const base = p.spume * p.spume * STREAK_BASE * band;
    const fray = smoothstep(STREAK_FRAY[0], STREAK_FRAY[1], lace * 0.7 + (coarse[2] as number) * 0.5);
    const gain = (p.spume * STREAK_SPUME_GAIN + 1) * STREAK_GAIN;
    streaks = clamp01(lines * gain) * Math.max(trail, base) * p.streaks * fray;
  }
  return clamp01(Math.max(whitecap, streaks));
}

export interface CoverageEstimate {
  coverage: number; // mean whiteness
  whitecaps: number; // share of the sea at least half white
}

// Mean shader foam over `samples` random points of a 4 km square, at each snapshot.
function shaderCoverage(
  snapshots: readonly FoamSnapshot[],
  params: ShaderFoamParams,
  footprint: number,
  samples = 40_000,
): CoverageEstimate {
  let sum = 0;
  let white = 0;
  let count = 0;
  snapshots.forEach((snapshot, s) => {
    for (let i = 0; i < samples; i++) {
      const x = (hash32(i * 2 + s * 7919 + 1) / 4294967296) * 4000;
      const z = (hash32(i * 2 + s * 7919 + 2) / 4294967296) * 4000;
      const f = shaderFoam(snapshot, params, x, z, footprint);
      sum += f;
      if (f >= 0.5) white++;
      count++;
    }
  });
  return { coverage: sum / count, whitecaps: white / count };
}

// The whole pipeline for a preset with the app's wind → foam mapping: the mean whiteness at each
// footprint, over the given snapshot times of a run from a foam-free sea.
export function presetCoverage(
  preset: WeatherPreset,
  options: {
    footprints: readonly number[];
    dt?: number;
    times?: readonly number[];
    samples?: number;
    seed?: number;
    foamOctaves?: 1 | 2;
  },
): { foam: WindFoam; coverage: CoverageEstimate[] } {
  const sea = presetSpectra(preset, options.seed ?? 1);
  const stds = layerJacobianStds(sea.physics);
  const foam = foamForWind(
    sea.wind,
    sea.physics.map((s, i) => ({ patch: s.cascade.size, std: stds[i] ?? 0 })),
  );
  const snapshots = replayFoam(sea, windFoamAccumulation(foam), {
    dt: options.dt ?? 1 / 20,
    times: options.times ?? [12, 16],
  });
  const params: ShaderFoamParams = {
    crestThreshold: foam.crestThreshold,
    streaks: foam.streaks,
    spume: foam.spume,
    windDirection: sea.windDirection,
    foamOctaves: options.foamOctaves ?? 2,
  };
  return {
    foam,
    coverage: options.footprints.map((f) => shaderCoverage(snapshots, params, f, options.samples)),
  };
}
