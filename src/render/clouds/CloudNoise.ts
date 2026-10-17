// The clouds' static noise, built once by compute at startup (deterministic):
//   base    128³ rgba8  r: Perlin-Worley eroded by Worley FBM (the cloud shape), g: Perlin-Worley,
//                       b: Worley FBM, a: Perlin FBM — tiles every BASE_TILE km
//   detail   32³ rgba8  r: Worley FBM for edge erosion — tiles every DETAIL_TILE km
//   curl    128² rgba8  rg: curl of a Perlin potential (−1..1 → 0..1), turbulence for the erosion
//   cirrus  256² rgba8  r: wind-streaked Perlin FBM, g: Worley patches for the 2D cirrus layer
// Following Schneider (Nubis, 2015/2017) and Hillaire's TileableVolumeNoise via takram three-clouds.

import {
  type ComputeNode,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  Storage3DTexture,
  StorageTexture,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu';

import { type N, tsl } from '../tsl';
import { perlin3, perlinFbm, worleyCells, worleyFbm } from './noiseNodes';

const { Fn, float, instanceIndex, saturate, textureStore, uint, uvec2, uvec3, vec2, vec3, vec4 } = tsl;

const BASE_SIZE = 128;
const DETAIL_SIZE = 32;
const CURL_SIZE = 128;
const CIRRUS_SIZE = 256;
export const BASE_TILE = 7; // km
export const DETAIL_TILE = 0.8; // km
export const CURL_TILE = 14; // km
export const CIRRUS_TILE = 60; // km

function volume(size: number, name: string): Storage3DTexture {
  const t = new Storage3DTexture(size, size, size);
  t.type = UnsignedByteType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

function plane(size: number, name: string): StorageTexture {
  const t = new StorageTexture(size, size);
  t.type = UnsignedByteType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.generateMipmaps = false;
  t.name = name;
  return t;
}

const remap = (x: N, a: N, b: N): N => x.sub(a).div(b.sub(a));

export class CloudNoise {
  readonly base = volume(BASE_SIZE, 'clouds-base-noise');
  readonly detail = volume(DETAIL_SIZE, 'clouds-detail-noise');
  readonly curl = plane(CURL_SIZE, 'clouds-curl-noise');
  readonly cirrus = plane(CIRRUS_SIZE, 'clouds-cirrus-noise');
  private kernels: ComputeNode[];
  private built = false;

  constructor() {
    this.kernels = [this.buildBase(), this.buildDetail(), this.buildCurl(), this.buildCirrus()];
  }

  get ready(): boolean {
    return this.built;
  }

  // Dispatches the generators once; later calls do nothing.
  generate(renderer: WebGPURenderer): void {
    if (this.built) return;
    for (const kernel of this.kernels) void renderer.compute(kernel);
    this.built = true;
  }

  dispose(): void {
    for (const kernel of this.kernels) kernel.dispose();
    this.base.dispose();
    this.detail.dispose();
    this.curl.dispose();
    this.cirrus.dispose();
  }

  private buildBase(): ComputeNode {
    const n = BASE_SIZE;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n)).mod(uint(n));
      const z = instanceIndex.div(uint(n * n));
      const p = vec3(float(x), float(y), float(z)).add(0.5).div(n).toVar();
      // Perlin FBM, sharpened, then "billowed" by low-frequency Worley (Perlin-Worley).
      const perlin = saturate(remap(perlinFbm(p, vec3(4), 3, 3), float(0.25), float(0.8))).toVar();
      const cells = worleyFbm(p, 4, 11).toVar();
      const perlinWorley = cells.add(perlin.mul(cells.oneMinus())).toVar();
      const fbm = worleyFbm(p, 8, 21).toVar();
      // Erode the Perlin-Worley by the Worley FBM (Nubis 2017 remap).
      const shape = saturate(perlinWorley.sub(fbm.sub(1)).div(float(2).sub(fbm)));
      textureStore(this.base, uvec3(x, y, z), vec4(shape, perlinWorley, fbm, perlin)).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(n * n * n, [64]);
    node.setName('clouds-base-noise');
    return node;
  }

  private buildDetail(): ComputeNode {
    const n = DETAIL_SIZE;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n)).mod(uint(n));
      const z = instanceIndex.div(uint(n * n));
      const p = vec3(float(x), float(y), float(z)).add(0.5).div(n).toVar();
      const fine = worleyFbm(p, 2, 31).toVar();
      const finer = worleyFbm(p, 4, 41).toVar();
      textureStore(
        this.detail,
        uvec3(x, y, z),
        vec4(fine.mul(0.75).add(finer.mul(0.25)), fine, finer, 1),
      ).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(n * n * n, [64]);
    node.setName('clouds-detail-noise');
    return node;
  }

  private buildCurl(): ComputeNode {
    const n = CURL_SIZE;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const uv = vec2(float(x), float(y)).add(0.5).div(n).toVar();
      const potential = (q: N): N => {
        const p = vec3(q, 0.5);
        return perlin3(p.mul(vec3(6, 6, 1)), vec3(6, 6, 64), 51).add(
          perlin3(p.mul(vec3(12, 12, 1)), vec3(12, 12, 64), 52).mul(0.5),
        );
      };
      const e = 1 / n;
      const dx = potential(uv.add(vec2(e, 0))).sub(potential(uv.sub(vec2(e, 0))));
      const dy = potential(uv.add(vec2(0, e))).sub(potential(uv.sub(vec2(0, e))));
      // Curl of a scalar potential: (∂ψ/∂y, −∂ψ/∂x), normalised to about −1..1.
      const curl = vec2(dy, dx.negate()).mul(n / 2 / 12);
      textureStore(this.curl, uvec2(x, y), vec4(saturate(curl.mul(0.5).add(0.5)), 0, 1)).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(n * n, [64]);
    node.setName('clouds-curl-noise');
    return node;
  }

  private buildCirrus(): ComputeNode {
    const n = CIRRUS_SIZE;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(n));
      const y = instanceIndex.div(uint(n));
      const uv = vec2(float(x), float(y)).add(0.5).div(n).toVar();
      const p = vec3(uv, 0.5);
      // Streaks: frequencies 4× higher across the wind (y) than along it (x).
      const streaks = perlinFbm(p, vec3(4, 16, 1), 5, 61).toVar();
      const patches = worleyCells(p, 6, 71).toVar();
      textureStore(this.cirrus, uvec2(x, y), vec4(streaks, patches, 0, 1)).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(n * n, [64]);
    node.setName('clouds-cirrus-noise');
    return node;
  }
}
