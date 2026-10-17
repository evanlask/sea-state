// GPU side of the FFT ocean: per-frame spectrum evolution, inverse FFT, and
// assembly into sampled array textures (one layer per cascade).
//
// Cascades of the same size share one set of array textures:
//   displacement  rgba16f  (dx, dy, dz, ∂Dx/∂z)
//   derivatives   rgba16f  (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z)
//   foam          rgba16f  (foam, Jacobian, (∂Dy/∂x)², (∂Dy/∂z)²)
// The CPU physics copy (sim/ocean) evolves the same h0 with the same
// quantized dispersion and sign conventions, so these textures and the
// physics agree. Sample texel i at x = i·L/N, i.e. uv = x/L + 0.5/N.
//
// Derivatives and foam carry full mip chains, built by compute right after
// assembly from a storage-buffer pyramid (sampling the texture being written
// would be a usage conflict). Slopes and squared slopes are filtered alike, so
// any filtered sample yields the slope variance it averaged away (LEAN
// mapping), which the shader turns into roughness instead of aliasing.
// `previousDisplacement` holds the previous update's displacement (motion vectors).

import {
  type ComputeNode,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  StorageArrayTexture,
  type WebGPURenderer,
} from 'three/webgpu';

import { GpuResources } from '../gpuResources';
import { type N, tsl } from '../tsl';
import { createInverseFft2D } from './GpuFft';
import {
  FOAM_MIN_PATCH,
  FOAM_OFF_THRESHOLD,
  type FoamLayer,
  jacobianStd,
  mipLevelCount,
  pyramidOffsets,
  type SpectrumStatistics,
  spectrumStatistics,
} from './oceanOptics';
import { SpectrumBlend } from './spectrumUpload';

const {
  Fn,
  cos,
  exp,
  float,
  fract,
  instanceIndex,
  instancedArray,
  max,
  min,
  mix,
  saturate,
  select,
  sin,
  storageTexture,
  textureStore,
  uint,
  uniform,
  uniformArray,
  uvec2,
  vec2,
  vec4,
} = tsl;

export interface GpuCascade {
  size: number; // N, power of two ≤ 512
  patchLength: number; // metres
  // N×N texels × 4 floats: h0(k).re, h0(k).im, conj(h0(−k)).re, conj(h0(−k)).im,
  // in natural FFT order (index x ↔ m = x < N/2 ? x : x − N).
  h0: Float32Array;
  omega: Float32Array; // N×N angular frequencies, multiples of 2π / repeatPeriod
  choppiness: number;
}

export interface FoamParams {
  // Per cascade (in the order given to the simulation): linearised Jacobian below which its crests
  // break, and the gain of the breaking ramp below it (oceanOptics.foamForWind).
  thresholds: readonly number[];
  gains: readonly number[];
  buildRate: number; // foam added per second at full breaking
  decayRate: number; // e-folding rate per second
}

export interface CascadeGroup {
  size: number;
  cascadeIndices: number[]; // indices into the original cascade list, one per layer
  patchLengths: number[];
  choppiness: number[];
  displacement: StorageArrayTexture;
  derivatives: StorageArrayTexture; // mipmapped
  foam: StorageArrayTexture; // mipmapped
  previousDisplacement: StorageArrayTexture;
  // Per layer: time-averaged spectrum statistics, refreshed with every spectrum upload.
  statistics: SpectrumStatistics[];
}

const createLayerTexture = (
  size: number,
  layers: number,
  name: string,
  mips = false,
): StorageArrayTexture => {
  const texture = new StorageArrayTexture(size, size, layers);
  texture.type = HalfFloatType;
  texture.format = RGBAFormat;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = mips ? LinearMipmapLinearFilter : LinearFilter;
  // Allocates the chain; the compute below fills it, so three's blit generator stays off.
  texture.generateMipmaps = mips;
  (texture as StorageArrayTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  texture.name = name;
  return texture;
};

export { FOAM_MIN_PATCH };

const cmul = (a: N, b: N): N => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));
// a + i·b for complex a, b.
const plusI = (a: N, b: N): N => vec2(a.x.sub(b.y), a.y.add(b.x));
// +i·a
const timesI = (a: N): N => vec2(a.y.negate(), a.x);

interface OceanUniforms {
  tau: N;
  tau64: N;
  dt: N;
  foamBuild: N;
  foamDecay: N;
  blend: N; // weather transition weight, 0 = h0From, 1 = h0To
}

const ZERO_STATISTICS: SpectrumStatistics = { heightVariance: 0, slopeVarianceX: 0, slopeVarianceZ: 0 };

// Statistics part-way through a transition. Every mode keeps its phase and scales its amplitude, so
// for a uniform rescale the standard deviations blend linearly; that's close enough for shading.
const blendStatistics = (a: SpectrumStatistics, b: SpectrumStatistics, w: number): SpectrumStatistics => {
  const mixStd = (x: number, y: number): number => (Math.sqrt(x) + (Math.sqrt(y) - Math.sqrt(x)) * w) ** 2;
  return {
    heightVariance: mixStd(a.heightVariance, b.heightVariance),
    slopeVarianceX: mixStd(a.slopeVarianceX, b.slopeVarianceX),
    slopeVarianceZ: mixStd(a.slopeVarianceZ, b.slopeVarianceZ),
  };
};

class GroupPipeline {
  readonly group: CascadeGroup;
  private h0: N; // h0 the current transition starts from
  private h0To: N; // and ends at
  private chops: N;
  private omegaIndex: N;
  private foamState: N;
  private foamBreaking: N; // per layer: (threshold, gain) of the breaking ramp
  private passes: ComputeNode[];
  private statisticsFrom: SpectrumStatistics[] = [];
  private statisticsTo: SpectrumStatistics[] = [];
  private gpu = new GpuResources(); // the buffers and kernels (the group's textures are the simulation's)

  constructor(group: CascadeGroup, uniforms: OceanUniforms) {
    this.group = group;
    const n = group.size;
    const layers = group.cascadeIndices.length;
    const texels = n * n;
    const gpu = this.gpu;
    this.h0 = gpu.storage(instancedArray(texels * layers, 'vec4'));
    this.h0To = gpu.storage(instancedArray(texels * layers, 'vec4'));
    this.chops = gpu.storage(instancedArray(layers, 'vec2')); // choppiness at the blend's start and end
    // (high, low) parts of the dispersion index
    this.omegaIndex = gpu.storage(instancedArray(texels * layers, 'vec2'));
    this.foamState = gpu.storage(instancedArray(texels * layers, 'float'));
    this.foamBreaking = gpu.storage(instancedArray(layers, 'vec2'));
    this.setFoam([], []);
    // Two sub-layers per cascade: (Dx + iDy, Dz + i∂Dx/∂z) and (∂Dy/∂x + i∂Dy/∂z, ∂Dx/∂x + i∂Dz/∂z).
    const spectrum = gpu.storage(instancedArray(texels * layers * 2, 'vec4'));

    const lengths = uniformArray(group.patchLengths, 'float');

    const evolve: ComputeNode = Fn(() => {
      const index = instanceIndex;
      const layer = index.div(uint(texels));
      const texel = index.mod(uint(texels));
      const x = texel.mod(uint(n));
      const y = texel.div(uint(n));
      const mx = select(x.lessThan(uint(n / 2)), float(x), float(x).sub(n));
      const my = select(y.lessThan(uint(n / 2)), float(y), float(y).sub(n));
      const length = lengths.element(layer);
      const kx = mx.mul(2 * Math.PI).div(length);
      const kz = my.mul(2 * Math.PI).div(length);
      const kLength = max(vec2(kx, kz).length(), 1e-6);
      // Weather transitions blend h0 and λ linearly, with the weight the CPU uses (SpectrumBlend).
      const chop = this.chops.element(layer);
      const lambda = mix(chop.x, chop.y, uniforms.blend);

      // phase / 2π = fract(n·τ), split as n = 64·hi + lo so float32 stays exact.
      const parts = this.omegaIndex.element(index);
      const phase = fract(parts.x.mul(uniforms.tau64).add(parts.y.mul(uniforms.tau))).mul(2 * Math.PI);
      // h = h0·e^{−iωt} + conj(h0(−k))·e^{+iωt}: modes travel along +k (matches sim/ocean/CpuOcean).
      const rotation = vec2(cos(phase), sin(phase));
      const amplitudes = mix(this.h0.element(index), this.h0To.element(index), uniforms.blend);
      const h = cmul(amplitudes.xy, vec2(rotation.x, rotation.y.negate())).add(cmul(amplitudes.zw, rotation));

      // D = +i·λ·k̂·h pulls particles toward crests (Gerstner); slopes are i·k·h.
      const dx = timesI(h).mul(kx.div(kLength).mul(lambda));
      const dz = timesI(h).mul(kz.div(kLength).mul(lambda));
      const dydx = timesI(h).mul(kx);
      const dydz = timesI(h).mul(kz);
      const dxdx = h.mul(kx.mul(kx).div(kLength).mul(lambda).negate());
      const dzdz = h.mul(kz.mul(kz).div(kLength).mul(lambda).negate());
      const dxdz = h.mul(kx.mul(kz).div(kLength).mul(lambda).negate());

      const base = layer.mul(uint(texels * 2)).add(texel);
      spectrum.element(base).assign(vec4(plusI(dx, h), plusI(dz, dxdz)));
      spectrum.element(base.add(uint(texels))).assign(vec4(plusI(dydx, dydz), plusI(dxdx, dzdz)));
    })().compute(texels * layers, [64]);
    evolve.setName(`ocean-evolve-${n}`);

    const fft = createInverseFft2D(spectrum, n, layers * 2);

    const displacementStore = storageTexture(group.displacement);
    const previousStore = storageTexture(group.previousDisplacement);
    const derivativesStore = storageTexture(group.derivatives);
    const foamStore = storageTexture(group.foam);
    const offsets = pyramidOffsets(n, layers);
    const total = offsets[offsets.length - 1] ?? 0;
    const pyramidDerivatives = gpu.storage(instancedArray(total, 'vec4'));
    const pyramidFoam = gpu.storage(instancedArray(total, 'vec4'));
    const lastDisplacement = gpu.storage(instancedArray(texels * layers, 'vec4'));

    const assemble: ComputeNode = Fn(() => {
      const index = instanceIndex;
      const layer = index.div(uint(texels));
      const texel = index.mod(uint(texels));
      const coord = uvec2(texel.mod(uint(n)), texel.div(uint(n)));
      const base = layer.mul(uint(texels * 2)).add(texel);
      const a = spectrum.element(base);
      const b = spectrum.element(base.add(uint(texels)));

      const jacobian = float(1).add(b.z).mul(float(1).add(b.w)).sub(a.w.mul(a.w));
      // Crests break where the linearised Jacobian (Gaussian, so its thresholds are exact quantiles)
      // falls below the layer's threshold, fully a fraction of a deviation further down.
      const ramp = this.foamBreaking.element(layer);
      const breaking = saturate(ramp.x.sub(float(1).add(b.z).add(b.w)).mul(ramp.y));
      const previous = this.foamState.element(index);
      const foam = min(
        previous
          .mul(exp(uniforms.foamDecay.negate().mul(uniforms.dt)))
          .add(breaking.mul(uniforms.foamBuild).mul(uniforms.dt)),
        1.5,
      );
      this.foamState.element(index).assign(foam);

      const layerIndex = layer.toInt();
      const displacement = vec4(a.x, a.y, a.z, a.w);
      const derivatives = vec4(b.x, b.y, b.z, b.w);
      // LEAN second moments of the height slopes, filtered alongside the slopes themselves.
      const foamTexel = vec4(foam, jacobian, b.x.mul(b.x), b.y.mul(b.y));
      textureStore(previousStore.depth(layerIndex), coord, lastDisplacement.element(index)).toWriteOnly();
      lastDisplacement.element(index).assign(displacement);
      textureStore(displacementStore.depth(layerIndex), coord, displacement).toWriteOnly();
      textureStore(derivativesStore.depth(layerIndex), coord, derivatives).toWriteOnly();
      textureStore(foamStore.depth(layerIndex), coord, foamTexel).toWriteOnly();
      pyramidDerivatives.element(index).assign(derivatives);
      pyramidFoam.element(index).assign(foamTexel);
    })().compute(texels * layers, [64]);
    assemble.setName(`ocean-assemble-${n}`);

    this.passes = [evolve, fft.rows, fft.columns, assemble];

    // 2×2 box downsample, one dispatch per level (each reads the level the previous one wrote).
    for (let level = 1; level < mipLevelCount(n); level++) {
      const size = n >> level;
      const parent = size * 2;
      const levelTexels = size * size;
      const source = offsets[level - 1] ?? 0;
      const target = offsets[level] ?? 0;
      const derivativesMip = storageTexture(group.derivatives).setMipLevel(level);
      const foamMip = storageTexture(group.foam).setMipLevel(level);
      const kernel: ComputeNode = Fn(() => {
        const index = instanceIndex;
        const layer = index.div(uint(levelTexels));
        const texel = index.mod(uint(levelTexels));
        const x = texel.mod(uint(size));
        const y = texel.div(uint(size));
        const first = layer
          .mul(uint(parent * parent))
          .add(y.mul(uint(2 * parent)))
          .add(x.mul(uint(2)))
          .add(uint(source));
        const average = (buffer: N): N =>
          buffer
            .element(first)
            .add(buffer.element(first.add(uint(1))))
            .add(buffer.element(first.add(uint(parent))))
            .add(buffer.element(first.add(uint(parent + 1))))
            .mul(0.25)
            .toVar();
        const d = average(pyramidDerivatives);
        const f = average(pyramidFoam);
        const out = index.add(uint(target));
        pyramidDerivatives.element(out).assign(d);
        pyramidFoam.element(out).assign(f);
        const coord = uvec2(x, y);
        textureStore(derivativesMip.depth(layer.toInt()), coord, d).toWriteOnly();
        textureStore(foamMip.depth(layer.toInt()), coord, f).toWriteOnly();
      })().compute(levelTexels * layers, [Math.min(64, levelTexels * layers)]);
      kernel.setName(`ocean-mip-${n}-${level}`);
      this.passes.push(kernel);
    }
  }

  // Dispersion indices; the cascade layout (and so ω) never changes.
  uploadOmega(cascades: readonly GpuCascade[], repeatPeriod: number): void {
    const texels = this.group.size * this.group.size;
    const omega = this.omegaIndex.value.array as Float32Array;
    const omega0 = (2 * Math.PI) / repeatPeriod;
    this.group.cascadeIndices.forEach((cascadeIndex, layer) => {
      const cascade = cascades[cascadeIndex];
      if (!cascade) return;
      for (let i = 0; i < texels; i++) {
        const index = Math.round((cascade.omega[i] ?? 0) / omega0);
        omega[(layer * texels + i) * 2] = Math.floor(index / 64);
        omega[(layer * texels + i) * 2 + 1] = index % 64;
      }
    });
    this.omegaIndex.value.needsUpdate = true;
  }

  // Breaking thresholds and gains, per cascade index; layers without one never break.
  setFoam(thresholds: readonly number[], gains: readonly number[]): void {
    const values = this.foamBreaking.value.array as Float32Array;
    this.group.cascadeIndices.forEach((cascadeIndex, layer) => {
      const on = (this.group.patchLengths[layer] ?? 0) >= FOAM_MIN_PATCH;
      values[2 * layer] = on ? (thresholds[cascadeIndex] ?? FOAM_OFF_THRESHOLD) : FOAM_OFF_THRESHOLD;
      values[2 * layer + 1] = on ? (gains[cascadeIndex] ?? 0) : 0;
    });
    this.foamBreaking.value.needsUpdate = true;
  }

  // Both ends of the current transition.
  upload(blend: SpectrumBlend): void {
    const n = this.group.size;
    const texels = n * n;
    const from = this.h0.value.array as Float32Array;
    const to = this.h0To.value.array as Float32Array;
    const chops = this.chops.value.array as Float32Array;
    this.group.cascadeIndices.forEach((cascadeIndex, layer) => {
      const a = blend.from[cascadeIndex];
      const b = blend.to[cascadeIndex];
      if (!a || !b) return;
      from.set(a, layer * texels * 4);
      to.set(b, layer * texels * 4);
      chops[2 * layer] = blend.chopFrom[cascadeIndex] ?? 1;
      chops[2 * layer + 1] = blend.chopTo[cascadeIndex] ?? 1;
    });
    this.h0.value.needsUpdate = true;
    this.h0To.value.needsUpdate = true;
    this.chops.value.needsUpdate = true;
    const statistics = (arrays: Float32Array[]): SpectrumStatistics[] =>
      this.group.cascadeIndices.map((cascadeIndex, layer) => {
        const h0 = arrays[cascadeIndex];
        return h0 ? spectrumStatistics(h0, n, this.group.patchLengths[layer] ?? 1) : ZERO_STATISTICS;
      });
    this.statisticsFrom = statistics(blend.from);
    this.statisticsTo = statistics(blend.to);
  }

  // The group's statistics and choppiness at transition weight w (shading and foam read them).
  setWeight(blend: SpectrumBlend, w: number): void {
    const group = this.group;
    group.statistics = group.cascadeIndices.map((_, layer) =>
      blendStatistics(
        this.statisticsFrom[layer] ?? ZERO_STATISTICS,
        this.statisticsTo[layer] ?? ZERO_STATISTICS,
        w,
      ),
    );
    group.choppiness = group.cascadeIndices.map((cascadeIndex) => {
      const a = blend.chopFrom[cascadeIndex] ?? 1;
      return a + ((blend.chopTo[cascadeIndex] ?? 1) - a) * w;
    });
  }

  run(renderer: WebGPURenderer): void {
    // One compute pass; WebGPU makes each dispatch's storage writes visible to the next.
    void renderer.compute(this.passes);
  }

  dispose(): void {
    for (const pass of this.passes) this.gpu.track(pass);
    this.passes = [];
    this.gpu.dispose();
  }
}

// Statistics refresh when the transition weight has moved this far (or reached either end).
const STATISTICS_STEP = 0.01;

export class GpuOceanSimulation {
  readonly groups: CascadeGroup[] = [];
  private pipelines: GroupPipeline[] = [];
  private repeatPeriod: number;
  private listeners = new Set<() => void>();
  private blend: SpectrumBlend;
  private statisticsWeight = 1;
  private uniforms: OceanUniforms = {
    tau: uniform(0),
    tau64: uniform(0),
    dt: uniform(0),
    foamBuild: uniform(2.5),
    foamDecay: uniform(0.35),
    blend: uniform(1),
  };

  constructor(cascades: readonly GpuCascade[], repeatPeriod: number) {
    this.repeatPeriod = repeatPeriod;
    this.blend = new SpectrumBlend(cascades);
    const bySize = new Map<number, number[]>();
    cascades.forEach((cascade, index) => {
      const list = bySize.get(cascade.size) ?? [];
      list.push(index);
      bySize.set(cascade.size, list);
    });
    for (const [size, indices] of bySize) {
      const layers = indices.length;
      const group: CascadeGroup = {
        size,
        cascadeIndices: indices,
        patchLengths: indices.map((i) => cascades[i]?.patchLength ?? 1),
        choppiness: indices.map((i) => cascades[i]?.choppiness ?? 1),
        displacement: createLayerTexture(size, layers, `ocean-displacement-${size}`),
        derivatives: createLayerTexture(size, layers, `ocean-derivatives-${size}`, true),
        foam: createLayerTexture(size, layers, `ocean-foam-${size}`, true),
        previousDisplacement: createLayerTexture(size, layers, `ocean-displacement-previous-${size}`),
        statistics: [],
      };
      const pipeline = new GroupPipeline(group, this.uniforms);
      pipeline.uploadOmega(cascades, repeatPeriod);
      pipeline.upload(this.blend);
      pipeline.setWeight(this.blend, 1);
      this.groups.push(group);
      this.pipelines.push(pipeline);
    }
  }

  // Sum over all cascades of the time-averaged height variance (m²); Hs ≈ 4·√variance.
  get heightVariance(): number {
    let total = 0;
    for (const group of this.groups) for (const s of group.statistics) total += s.heightVariance;
    return total;
  }

  // Every cascade's patch and Jacobian deviation, in the order given (sets the breaking thresholds).
  get foamLayers(): FoamLayer[] {
    const layers: FoamLayer[] = [];
    for (const group of this.groups) {
      group.statistics.forEach((s, layer) => {
        const index = group.cascadeIndices[layer] ?? 0;
        layers[index] = {
          patch: group.patchLengths[layer] ?? 0,
          std: jacobianStd(group.choppiness[layer] ?? 1, s.slopeVarianceX + s.slopeVarianceZ),
        };
      });
    }
    return layers;
  }

  // Called after every spectrum upload (renderers refresh their statistics uniforms).
  onSpectrumChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Anisotropic filtering of the mipmapped slope textures (grazing views of distant water).
  setAnisotropy(anisotropy: number): void {
    for (const group of this.groups) {
      for (const texture of [group.derivatives, group.foam]) {
        if (texture.anisotropy === anisotropy) continue;
        texture.anisotropy = anisotropy;
        texture.needsUpdate = true;
      }
    }
  }

  setFoam(params: FoamParams): void {
    for (const pipeline of this.pipelines) pipeline.setFoam(params.thresholds, params.gains);
    this.uniforms.foamBuild.value = params.buildRate;
    this.uniforms.foamDecay.value = params.decayRate;
  }

  // Replaces the spectra (same cascade layout), e.g. after a weather change: blends from the current
  // state to these over [activationTime, activationTime + duration] of simulation time, exactly as
  // the CPU physics ocean does. Without a transition the new spectrum applies at once.
  setSpectrum(cascades: readonly GpuCascade[], activationTime = -Infinity, duration = 0): void {
    this.blend.install(cascades, activationTime, duration);
    for (const pipeline of this.pipelines) pipeline.upload(this.blend);
    this.statisticsWeight = Number.NaN; // refresh on the next update
    if (duration <= 0 && activationTime === -Infinity) this.applyWeight(1);
  }

  private applyWeight(w: number): void {
    this.uniforms.blend.value = w;
    if (w === this.statisticsWeight) return;
    const ends = w === 0 || w === 1;
    if (!ends && Math.abs(w - this.statisticsWeight) < STATISTICS_STEP) return;
    this.statisticsWeight = w;
    for (const pipeline of this.pipelines) pipeline.setWeight(this.blend, w);
    for (const listener of this.listeners) listener();
  }

  // time: simulation seconds (float64 on the CPU); dt: seconds since the last update.
  update(renderer: WebGPURenderer, time: number, dt: number): void {
    const tau = (((time / this.repeatPeriod) % 1) + 1) % 1;
    this.uniforms.tau.value = tau;
    this.uniforms.tau64.value = (tau * 64) % 1;
    this.uniforms.dt.value = Math.min(Math.max(dt, 0), 0.1);
    this.applyWeight(this.blend.weight(time));
    for (const pipeline of this.pipelines) pipeline.run(renderer);
  }

  // Frees the kernels, storage buffers and array textures (the meshes sampling them go first).
  dispose(): void {
    for (const pipeline of this.pipelines) pipeline.dispose();
    for (const group of this.groups) {
      group.displacement.dispose();
      group.derivatives.dispose();
      group.foam.dispose();
      group.previousDisplacement.dispose();
    }
    this.pipelines = [];
    this.listeners.clear();
  }
}
