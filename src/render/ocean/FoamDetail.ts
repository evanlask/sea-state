// Procedural foam detail, generated once on the GPU: a tileable RGBA texture whose channels are
//   r  lace     the bright web of bubble walls between cells (multi-octave cellular noise)
//   g  density  soft low-frequency patchiness that breaks foam into flecks and clumps
//   b  bubbles  fine round bubbles
// The ocean shader thresholds it by foam amount (thin foam shows only the brightest walls; thick
// foam goes solid), stretches it along the wind in streaky seas, and samples the density at a few
// hundred metres for the low-frequency foam fields (foamPattern.ts). Mipmapped (three regenerates
// the chain after the compute write), so distant foam averages instead of shimmering.

import {
  HalfFloatType,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  StorageTexture,
} from 'three/webgpu';
import type { ComputeNode, WebGPURenderer } from 'three/webgpu';

import { type N, tsl } from '../tsl';

const { Fn, float, instanceIndex, max, min, mix, smoothstep, sqrt, textureStore, uint, uvec2, vec2, vec4 } =
  tsl;

// Integer hash (PCG-style) of a 2D cell → two floats in [0, 1).
function hash2(x: N, y: N, seed: number): N {
  let h: N = x
    .mul(uint(1597334677))
    .bitXor(y.mul(uint(3812015801)))
    .bitXor(uint(seed));
  h = h.bitXor(h.shiftRight(uint(16))).mul(uint(0x7feb352d));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(0x846ca68b));
  const a = h.bitXor(h.shiftRight(uint(16)));
  const b = a.mul(uint(0x9e3779b9)).bitXor(a.shiftRight(uint(13)));
  return vec2(float(a.bitAnd(uint(0xffffff))), float(b.bitAnd(uint(0xffffff)))).div(16777216);
}

// Periodic Worley noise on a cells×cells grid over uv ∈ [0,1)²: returns (F1, F2) in cell units.
function worley(uv: N, cells: number, seed: number): N {
  const p = uv.mul(cells);
  const cell = p.floor();
  const local = p.sub(cell);
  let f1: N = float(8);
  let f2: N = float(8);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      // Wrap neighbour ids so the pattern tiles.
      const cx = cell.x
        .add(i + cells)
        .mod(cells)
        .toUint();
      const cy = cell.y
        .add(j + cells)
        .mod(cells)
        .toUint();
      const feature = hash2(cx, cy, seed).mul(0.85).add(0.075);
      const d = vec2(i, j).add(feature).sub(local).length();
      f2 = min(max(f1, d), f2);
      f1 = min(f1, d);
    }
  }
  return vec2(f1, f2);
}

// Periodic value noise (smooth), for the density channel.
function valueNoise(uv: N, cells: number, seed: number): N {
  const p = uv.mul(cells);
  const cell = p.floor();
  const f = p.sub(cell);
  const w = f.mul(f).mul(f.mul(-2).add(3));
  const corner = (i: number, j: number): N =>
    hash2(cell.x.add(i).mod(cells).toUint(), cell.y.add(j).mod(cells).toUint(), seed).x;
  return mix(mix(corner(0, 0), corner(1, 0), w.x), mix(corner(0, 1), corner(1, 1), w.x), w.y);
}

export class FoamDetail {
  readonly texture: StorageTexture;
  private generated = false;
  private size: number;
  private kernel: ComputeNode | null = null;

  constructor(size = 512) {
    this.size = size;
    const texture = new StorageTexture(size, size);
    texture.type = HalfFloatType;
    texture.format = RGBAFormat;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    texture.name = 'ocean-foam-detail';
    this.texture = texture;
  }

  // Generates the texture on first call; cheap to call every frame.
  ensure(renderer: WebGPURenderer): void {
    if (this.generated) return;
    this.generated = true;
    const size = this.size;
    const store = tsl.storageTexture(this.texture);
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(size));
      const y = instanceIndex.div(uint(size));
      const uv = vec2(float(x).add(0.5), float(y).add(0.5)).div(size);
      const walls = (cells: number, seed: number, width: number): N => {
        const f = worley(uv, cells, seed);
        // Thin bright rims where two cells meet, slightly brighter at junctions (small F2).
        return float(1)
          .sub(smoothstep(0, width, f.y.sub(f.x)))
          .mul(smoothstep(1.4, 0.4, f.y));
      };
      const lace = max(max(walls(7, 11, 0.32), walls(15, 23, 0.26).mul(0.85)), walls(31, 37, 0.22).mul(0.7));
      const holes = smoothstep(0.05, 0.45, worley(uv, 23, 53).x);
      const density = valueNoise(uv, 4, 71)
        .mul(0.55)
        .add(valueNoise(uv, 9, 83).mul(0.3))
        .add(valueNoise(uv, 19, 97).mul(0.15));
      const bubbles = smoothstep(0.35, 0.1, worley(uv, 48, 109).x);
      const r = sqrt(lace.mul(holes.mul(0.4).add(0.6)));
      textureStore(store, uvec2(x, y), vec4(r, density, bubbles, 1)).toWriteOnly();
    })().compute(size * size, [64]);
    kernel.setName('ocean-foam-detail');
    this.kernel = kernel;
    void renderer.compute(kernel);
  }

  dispose(): void {
    this.kernel?.dispose();
    this.kernel = null;
    this.texture.dispose();
  }
}
