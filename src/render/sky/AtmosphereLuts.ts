// Hillaire 2020 atmosphere LUTs ("A Scalable and Production Ready Sky and Atmosphere Rendering
// Technique", EGSR 2020) as TSL compute kernels.
//
// Structure ported from Sébastien Hillaire's UnrealEngineSkyAtmosphere demo (MIT, © 2020 Epic
// Games) and Lukas Herzberger's JolifantoBambla/webgpu-sky-atmosphere (MIT, © 2024). Changes:
// Y-up, kilometres, an ocean-dark ground albedo, quadratic sample spacing in the transmittance
// LUT (to match the CPU light), a uniform-longitude sky-view LUT (so the moon's sky glow can share
// it with the sun's), HG Mie phase, and a per-column aerial-perspective march.
//
//   transmittance     256×64   rgba16f  recomputed when the atmosphere changes
//   multi-scattering  32×32    rgba16f  recomputed when the atmosphere changes (Ψms, §5.5)
//   sky-view          W×H      rgba16f  physical luminance (cd/m²), sun + moon, when they move
//   aerial perspective 32³     rgba16f  froxels of the main camera: inscatter rgb, 1 − T in alpha; every frame
//
// The atmosphere is a sphere of radius R centred below the camera; the world is treated as
// locally flat, so only the camera's height matters.

import {
  type ComputeNode,
  HalfFloatType,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  Storage3DTexture,
  StorageTexture,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import { type N, tsl } from '../tsl';
import { TRANSMITTANCE_SAMPLES } from './atmosphereCpu';
import { type AtmosphereParams, EARTH_ATMOSPHERE, SUN_ANGULAR_RADIUS } from './atmosphereParams';

const {
  Fn,
  Loop,
  If,
  abs,
  acos,
  clamp,
  cos,
  dot,
  exp,
  float,
  instanceIndex,
  invocationLocalIndex,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  textureStore,
  uint,
  uniform,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} = tsl;

const P = EARTH_ATMOSPHERE;
export const PLANET_RADIUS = P.bottomRadius; // km
const ATMOSPHERE_TOP = P.topRadius; // km
const H_LUT = Math.sqrt(ATMOSPHERE_TOP ** 2 - PLANET_RADIUS ** 2);
const TRANSMITTANCE_SIZE: readonly [number, number] = [256, 64];
const MULTI_SCATTERING_SIZE = 32;
const MULTI_SCATTERING_DIRECTIONS = 64;
const MULTI_SCATTERING_STEPS = 20;
export const AERIAL_SIZE = 32;
const FP16_MAX = 65000;

export interface LutQuality {
  skyView: readonly [number, number];
  skyViewSamples: number;
  aerialStepsPerSlice: number;
  aerialDistancePerSlice: number; // km; the volume reaches 32 × this
}

export const LUT_QUALITY: Readonly<Record<'low' | 'medium' | 'high' | 'ultra', LutQuality>> = {
  low: { skyView: [128, 72], skyViewSamples: 16, aerialStepsPerSlice: 1, aerialDistancePerSlice: 4 },
  medium: { skyView: [192, 108], skyViewSamples: 24, aerialStepsPerSlice: 2, aerialDistancePerSlice: 4 },
  high: { skyView: [256, 128], skyViewSamples: 30, aerialStepsPerSlice: 2, aerialDistancePerSlice: 4 },
  ultra: { skyView: [320, 160], skyViewSamples: 40, aerialStepsPerSlice: 3, aerialDistancePerSlice: 4 },
};

function createLut(width: number, height: number, name: string): StorageTexture {
  const lut = new StorageTexture(width, height);
  lut.type = HalfFloatType;
  lut.format = RGBAFormat;
  lut.magFilter = LinearFilter;
  lut.minFilter = LinearFilter;
  lut.generateMipmaps = false;
  lut.name = name;
  return lut;
}

const setVector = (target: Vector3, rgb: readonly [number, number, number]): Vector3 =>
  target.set(rgb[0], rgb[1], rgb[2]);

// Uniforms shared by the LUT kernels and the sky/aerial-perspective lookups.
export class AtmosphereUniforms {
  readonly rayleighScattering: N = uniform(new Vector3());
  readonly mieScattering: N = uniform(new Vector3());
  readonly mieExtinction: N = uniform(new Vector3());
  readonly mieG: N = uniform(0.8);
  readonly ozoneAbsorption: N = uniform(new Vector3());
  readonly groundAlbedo: N = uniform(new Vector3());
  readonly sunDirection: N = uniform(new Vector3(0, 1, 0));
  readonly moonDirection: N = uniform(new Vector3(0, -1, 0));
  readonly sunIlluminance: N = uniform(new Vector3()); // lux RGB outside the atmosphere
  readonly moonIlluminance: N = uniform(new Vector3());
  readonly viewRadius: N = uniform(PLANET_RADIUS + 0.002); // km from the planet centre
  // Main camera basis for the aerial-perspective froxels.
  readonly apRight: N = uniform(new Vector3(1, 0, 0));
  readonly apUp: N = uniform(new Vector3(0, 1, 0));
  readonly apForward: N = uniform(new Vector3(0, 0, -1));
  readonly apTanHalf: N = uniform(new Vector2(1, 1));

  setParams(params: AtmosphereParams): void {
    setVector(this.rayleighScattering.value, params.rayleighScattering);
    setVector(this.mieScattering.value, params.mieScattering);
    setVector(this.mieExtinction.value, params.mieExtinction);
    setVector(this.ozoneAbsorption.value, params.ozoneAbsorption);
    setVector(this.groundAlbedo.value, params.groundAlbedo);
    this.mieG.value = params.mieG;
  }
}

// --- Shared shader helpers (inlined into each kernel) ---------------------------------------------

interface Medium {
  rayleighScattering: N;
  mieScattering: N;
  scattering: N;
  extinction: N;
}

function sampleMedium(u: AtmosphereUniforms, altitude: N): Medium {
  const h = max(altitude, 0);
  const rayleighDensity = exp(h.mul(-1 / P.rayleighScaleHeight));
  const mieDensity = exp(h.mul(-1 / P.mieScaleHeight));
  const ozoneDensity = max(float(1).sub(abs(h.sub(P.ozoneCenter)).div(P.ozoneHalfWidth)), 0);
  const rayleighScattering = u.rayleighScattering.mul(rayleighDensity).toVar();
  const mieScattering = u.mieScattering.mul(mieDensity).toVar();
  const extinction = rayleighScattering
    .add(u.mieExtinction.mul(mieDensity))
    .add(u.ozoneAbsorption.mul(ozoneDensity))
    .toVar();
  return { rayleighScattering, mieScattering, scattering: rayleighScattering.add(mieScattering), extinction };
}

// Distance from radius r (inside the atmosphere) to the top boundary along cos-zenith mu.
const distanceToTop = (r: N, mu: N): N => {
  const disc = r
    .mul(r)
    .mul(mu.mul(mu).sub(1))
    .add(ATMOSPHERE_TOP * ATMOSPHERE_TOP);
  return max(
    r
      .negate()
      .mul(mu)
      .add(sqrt(max(disc, 0))),
    0,
  );
};

// Cosine of the zenith angle of the geometric horizon seen from radius r (≤ 0).
const horizonMu = (r: N): N =>
  sqrt(max(r.sub(PLANET_RADIUS).mul(r.add(PLANET_RADIUS)), 0))
    .div(r)
    .negate();

// Distance to the ground along a ray that hits it (stable root).
const distanceToGround = (r: N, mu: N): N => {
  const c = r.sub(PLANET_RADIUS).mul(r.add(PLANET_RADIUS));
  const b = r.mul(mu);
  const disc = max(b.mul(b).sub(c), 0);
  return c.div(max(b.negate().add(sqrt(disc)), 1e-6));
};

// Smooth Earth shadow: 0 below the horizon, 1 above, blended over the sun's disk.
const planetShadow = (r: N, mu: N): N =>
  smoothstep(-SUN_ANGULAR_RADIUS, SUN_ANGULAR_RADIUS, mu.sub(horizonMu(r)));

const transmittanceUv = (r: N, mu: N): N => {
  const rho = sqrt(max(r.sub(PLANET_RADIUS).mul(r.add(PLANET_RADIUS)), 0));
  const d = distanceToTop(r, mu);
  const dMin = float(ATMOSPHERE_TOP).sub(r);
  const dMax = rho.add(H_LUT);
  return vec2(saturate(d.sub(dMin).div(max(dMax.sub(dMin), 1e-6))), saturate(rho.div(H_LUT)));
};

const toSubUv = (u: N, resolution: number): N => u.add(0.5 / resolution).mul(resolution / (resolution + 1));
const fromSubUv = (u: N, resolution: number): N => u.sub(0.5 / resolution).mul(resolution / (resolution - 1));

const rayleighPhase = (c: N): N =>
  c
    .mul(c)
    .add(1)
    .mul(3 / (16 * Math.PI));
const hgPhase = (c: N, g: N): N => {
  const g2 = g.mul(g);
  const denom = pow(max(g2.add(1).sub(g.mul(c).mul(2)), 1e-4), 1.5);
  return float(1)
    .sub(g2)
    .div(denom.mul(4 * Math.PI));
};

// Zenith angle of the horizon from radius r (slightly beyond π/2 above sea level).
export const zenithHorizonAngle = (r: N): N => {
  const vHorizon = sqrt(max(r.sub(PLANET_RADIUS).mul(r.add(PLANET_RADIUS)), 0));
  return float(Math.PI).sub(acos(clamp(vHorizon.div(r), 0, 1)));
};

export interface LightTerm {
  direction: N;
  illuminance: N;
}

export class AtmosphereLuts {
  readonly uniforms: AtmosphereUniforms;
  readonly quality: LutQuality;
  readonly transmittance: StorageTexture;
  readonly multiScattering: StorageTexture;
  readonly skyView: StorageTexture;
  readonly aerial: Storage3DTexture;
  private transmittanceKernel: ComputeNode;
  private multiScatteringKernel: ComputeNode;
  private skyViewKernel: ComputeNode;
  private aerialKernel: ComputeNode;

  constructor(uniforms: AtmosphereUniforms, quality: LutQuality) {
    this.uniforms = uniforms;
    this.quality = quality;
    this.transmittance = createLut(TRANSMITTANCE_SIZE[0], TRANSMITTANCE_SIZE[1], 'sky-transmittance');
    this.multiScattering = createLut(MULTI_SCATTERING_SIZE, MULTI_SCATTERING_SIZE, 'sky-multi-scattering');
    this.skyView = createLut(quality.skyView[0], quality.skyView[1], 'sky-view');
    // Azimuth wraps; zenith clamps.
    this.skyView.wrapS = RepeatWrapping;
    const aerial = new Storage3DTexture(AERIAL_SIZE, AERIAL_SIZE, AERIAL_SIZE);
    aerial.type = HalfFloatType;
    aerial.format = RGBAFormat;
    aerial.magFilter = LinearFilter;
    aerial.minFilter = LinearFilter;
    aerial.generateMipmaps = false;
    aerial.name = 'sky-aerial-perspective';
    this.aerial = aerial;

    this.transmittanceKernel = this.buildTransmittance();
    this.multiScatteringKernel = this.buildMultiScattering();
    this.skyViewKernel = this.buildSkyView();
    this.aerialKernel = this.buildAerial();
  }

  // Transmittance from radius r toward cos-zenith mu (to the top of the atmosphere).
  sampleTransmittance(r: N, mu: N): N {
    return texture(this.transmittance, transmittanceUv(r, mu)).level(0).rgb;
  }

  private sampleMultiScattering(r: N, mu: N): N {
    const uv = saturate(vec2(mu.mul(0.5).add(0.5), r.sub(PLANET_RADIUS).div(ATMOSPHERE_TOP - PLANET_RADIUS)));
    const sub = vec2(toSubUv(uv.x, MULTI_SCATTERING_SIZE), toSubUv(uv.y, MULTI_SCATTERING_SIZE));
    return texture(this.multiScattering, sub).level(0).rgb;
  }

  // Luminance scattered toward the viewer per unit length at point p (km, planet-centred), from
  // each light: single scattering (shadowed by the planet) plus the multiple-scattering LUT.
  private inscatterAt(p: N, medium: Medium, lights: { light: LightTerm; mie: N; rayleigh: N }[]): N {
    const r = length(p).toVar();
    const zenith = p.div(r);
    let total: N = vec3(0);
    for (const { light, mie, rayleigh } of lights) {
      const mu = dot(zenith, light.direction).toVar();
      const transmittance = this.sampleTransmittance(r, mu);
      const shadow = planetShadow(r, mu);
      const multi = this.sampleMultiScattering(r, mu);
      const single = medium.mieScattering.mul(mie).add(medium.rayleighScattering.mul(rayleigh));
      total = total.add(
        light.illuminance.mul(shadow.mul(transmittance).mul(single).add(multi.mul(medium.scattering))),
      );
    }
    return total;
  }

  private lightTerms(direction: N): { light: LightTerm; mie: N; rayleigh: N }[] {
    const u = this.uniforms;
    return [
      { direction: u.sunDirection, illuminance: u.sunIlluminance },
      { direction: u.moonDirection, illuminance: u.moonIlluminance },
    ].map((light) => {
      const c = dot(direction, light.direction).toVar();
      return { light, mie: hgPhase(c, u.mieG).toVar(), rayleigh: rayleighPhase(c).toVar() };
    });
  }

  private buildTransmittance(): ComputeNode {
    const [w, h] = TRANSMITTANCE_SIZE;
    const u = this.uniforms;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(w));
      const y = instanceIndex.div(uint(w));
      const xMu = float(x).add(0.5).div(w);
      const xR = float(y).add(0.5).div(h);
      const rho = xR.mul(H_LUT);
      const r = sqrt(rho.mul(rho).add(PLANET_RADIUS * PLANET_RADIUS)).toVar();
      const dMin = float(ATMOSPHERE_TOP).sub(r);
      const dMax = rho.add(H_LUT);
      const d = max(dMin.add(xMu.mul(dMax.sub(dMin))), 1e-4).toVar();
      const mu = clamp(
        float(H_LUT * H_LUT)
          .sub(rho.mul(rho))
          .sub(d.mul(d))
          .div(r.mul(d).mul(2)),
        -1,
        1,
      ).toVar();
      const sinZenith = sqrt(max(mu.mul(mu).oneMinus(), 0));
      const depth = vec3(0).toVar();
      const n = TRANSMITTANCE_SAMPLES;
      Loop(n, ({ i }: { i: N }) => {
        const t0 = pow(float(i).div(n), 2).mul(d);
        const t1 = pow(float(i).add(1).div(n), 2).mul(d);
        const t = t0.add(t1).mul(0.5);
        const px = t.mul(sinZenith);
        const py = r.add(t.mul(mu));
        const altitude = sqrt(px.mul(px).add(py.mul(py))).sub(PLANET_RADIUS);
        depth.addAssign(sampleMedium(u, altitude).extinction.mul(t1.sub(t0)));
      });
      textureStore(this.transmittance, uvec2(x, y), vec4(exp(depth.negate()), 1)).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(w * h, [64]);
    node.setName('sky-transmittance');
    return node;
  }

  // One workgroup per texel; 64 threads integrate 64 sphere directions and reduce in shared memory.
  private buildMultiScattering(): ComputeNode {
    const size = MULTI_SCATTERING_SIZE;
    const count = MULTI_SCATTERING_DIRECTIONS;
    const u = this.uniforms;
    const kernel = Fn(() => {
      const sharedMs = workgroupArray('vec4', count);
      const sharedL = workgroupArray('vec4', count);
      const texel = workgroupId.x;
      const index = invocationLocalIndex;
      const x = texel.mod(uint(size));
      const y = texel.div(uint(size));
      const uvx = fromSubUv(float(x).add(0.5).div(size), size);
      const uvy = fromSubUv(float(y).add(0.5).div(size), size);
      const cosSun = uvx.mul(2).sub(1);
      const sunDir = vec3(sqrt(saturate(cosSun.mul(cosSun).oneMinus())), cosSun, 0).toVar();
      const r0 = float(PLANET_RADIUS).add(saturate(uvy.add(0.01)).mul(ATMOSPHERE_TOP - PLANET_RADIUS - 0.01));
      const origin = vec3(0, r0, 0).toVar();

      // Golden-spiral sphere direction for this thread.
      const sample = float(index);
      const theta = sample.mul((2 * Math.PI) / ((1 + Math.sqrt(5)) / 2));
      const phi = acos(float(1).sub(sample.add(0.5).mul(2 / count)));
      const dir = vec3(cos(theta).mul(sin(phi)), cos(phi), sin(theta).mul(sin(phi))).toVar();

      const mu0 = dir.y;
      const hitsGround = mu0.lessThan(horizonMu(r0));
      const tMax = select(hitsGround, distanceToGround(r0, mu0), distanceToTop(r0, mu0)).toVar();
      const dt = tMax.div(MULTI_SCATTERING_STEPS).toVar();
      const throughput = vec3(1).toVar();
      const luminance = vec3(0).toVar();
      const multi = vec3(0).toVar();
      const isotropic = 1 / (4 * Math.PI);
      Loop(MULTI_SCATTERING_STEPS, ({ i }: { i: N }) => {
        const t = float(i).add(0.5).mul(dt);
        const p = origin.add(dir.mul(t));
        const r = length(p).toVar();
        const mu = dot(p.div(r), sunDir).toVar();
        const medium = sampleMedium(u, r.sub(PLANET_RADIUS));
        const stepT = exp(medium.extinction.negate().mul(dt)).toVar();
        const lit = planetShadow(r, mu)
          .mul(this.sampleTransmittance(r, mu))
          .mul(medium.scattering.mul(isotropic));
        multi.addAssign(
          throughput.mul(medium.scattering.sub(medium.scattering.mul(stepT))).div(medium.extinction),
        );
        luminance.addAssign(throughput.mul(lit.sub(lit.mul(stepT))).div(medium.extinction));
        throughput.mulAssign(stepT);
      });
      // Light bounced off the (ocean) ground.
      If(hitsGround, () => {
        const p = origin.add(dir.mul(tMax));
        const r = length(p);
        const mu = dot(p.div(r), sunDir);
        luminance.addAssign(
          this.sampleTransmittance(r, mu).mul(throughput).mul(saturate(mu)).mul(u.groundAlbedo).div(Math.PI),
        );
      });

      sharedMs.element(index).assign(vec4(multi.div(count), 0));
      sharedL.element(index).assign(vec4(luminance.div(count), 0));
      workgroupBarrier();
      for (let stride = count / 2; stride >= 1; stride /= 2) {
        If(index.lessThan(uint(stride)), () => {
          sharedMs.element(index).addAssign(sharedMs.element(index.add(uint(stride))));
          sharedL.element(index).addAssign(sharedL.element(index.add(uint(stride))));
        });
        workgroupBarrier();
      }
      If(index.equal(uint(0)), () => {
        const fms = sharedMs.element(uint(0)).xyz;
        // Infinite series of isotropic bounces: L₂ / (1 − f_ms).
        const psi = sharedL.element(uint(0)).xyz.div(max(vec3(1).sub(fms), 1e-4));
        textureStore(this.multiScattering, uvec2(x, y), vec4(psi, 1)).toWriteOnly();
      });
    });
    // An explicit workgroup grid avoids the bounds-check return TSL adds before the barriers.
    const node: ComputeNode = kernel().compute([size * size, 1, 1], [count]);
    node.setName('sky-multi-scattering');
    return node;
  }

  private buildSkyView(): ComputeNode {
    const [w, h] = this.quality.skyView;
    const steps = this.quality.skyViewSamples;
    const u = this.uniforms;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(w));
      const y = instanceIndex.div(uint(w));
      const azimuth = float(x)
        .add(0.5)
        .mul((2 * Math.PI) / w);
      const v = saturate(fromSubUv(float(y).add(0.5).div(h), h));
      const r0 = u.viewRadius;
      const zha = zenithHorizonAngle(r0);
      const coord = v.oneMinus();
      const zenithAngle = zha.mul(coord.mul(coord).oneMinus());
      const sz = sin(zenithAngle);
      const dir = vec3(sz.mul(sin(azimuth)), cos(zenithAngle), sz.mul(cos(azimuth)).negate()).toVar();
      const origin = vec3(0, r0, 0);
      const tMax = distanceToTop(r0, dir.y).toVar();
      const lights = this.lightTerms(dir);
      const luminance = vec3(0).toVar();
      const throughput = vec3(1).toVar();
      Loop(steps, ({ i }: { i: N }) => {
        // Quadratic spacing: dense near the viewer where the air is thick.
        const t0 = pow(float(i).div(steps), 2).mul(tMax);
        const t1 = pow(float(i).add(1).div(steps), 2).mul(tMax);
        const dt = t1.sub(t0);
        const t = t0.add(dt.mul(0.3));
        const p = origin.add(dir.mul(t)).toVar();
        const medium = sampleMedium(u, length(p).sub(PLANET_RADIUS));
        const stepT = exp(medium.extinction.negate().mul(dt)).toVar();
        const scattered = this.inscatterAt(p, medium, lights).toVar();
        luminance.addAssign(throughput.mul(scattered.sub(scattered.mul(stepT))).div(medium.extinction));
        throughput.mulAssign(stepT);
      });
      const meanT = dot(throughput, vec3(1 / 3));
      textureStore(this.skyView, uvec2(x, y), vec4(min(luminance, FP16_MAX), meanT.oneMinus())).toWriteOnly();
    });
    const node: ComputeNode = kernel().compute(w * h, [64]);
    node.setName('sky-view');
    return node;
  }

  // One thread per froxel column marches all 32 slices, writing the running integral as it goes.
  private buildAerial(): ComputeNode {
    const size = AERIAL_SIZE;
    const sub = this.quality.aerialStepsPerSlice;
    const perSlice = this.quality.aerialDistancePerSlice;
    const u = this.uniforms;
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(size));
      const y = instanceIndex.div(uint(size));
      const ndcX = float(x)
        .add(0.5)
        .mul(2 / size)
        .sub(1);
      const ndcY = float(y)
        .add(0.5)
        .mul(2 / size)
        .sub(1);
      const dir = normalize(
        u.apForward.add(u.apRight.mul(ndcX.mul(u.apTanHalf.x))).add(u.apUp.mul(ndcY.mul(u.apTanHalf.y))),
      ).toVar();
      const origin = vec3(0, u.viewRadius, 0).toVar();
      const lights = this.lightTerms(dir);
      const luminance = vec3(0).toVar();
      const throughput = vec3(1).toVar();
      const tPrev = float(0).toVar();
      Loop(size, ({ i }: { i: N }) => {
        const slice = float(i).add(0.5).div(size);
        const tEnd = slice
          .mul(slice)
          .mul(size * perSlice)
          .toVar();
        for (let k = 0; k < sub; k++) {
          const ta = mix(tPrev, tEnd, k / sub);
          const tb = mix(tPrev, tEnd, (k + 1) / sub);
          const dt = tb.sub(ta);
          let p: N = origin.add(dir.mul(ta.add(tb).mul(0.5)));
          // Below sea level (looking down at the ocean): keep sampling sea-level air.
          p = normalize(p)
            .mul(max(length(p), PLANET_RADIUS + 0.0005))
            .toVar();
          const medium = sampleMedium(u, length(p).sub(PLANET_RADIUS));
          const stepT = exp(medium.extinction.negate().mul(dt)).toVar();
          const scattered = this.inscatterAt(p, medium, lights).toVar();
          luminance.addAssign(throughput.mul(scattered.sub(scattered.mul(stepT))).div(medium.extinction));
          throughput.mulAssign(stepT);
        }
        const meanT = dot(throughput, vec3(1 / 3));
        textureStore(
          this.aerial,
          uvec3(x, y, uint(i)),
          vec4(min(luminance, FP16_MAX), meanT.oneMinus()),
        ).toWriteOnly();
        tPrev.assign(tEnd);
      });
    });
    const node: ComputeNode = kernel().compute(size * size, [64]);
    node.setName('sky-aerial-perspective');
    return node;
  }

  updateAtmosphere(renderer: WebGPURenderer): void {
    void renderer.compute(this.transmittanceKernel);
    void renderer.compute(this.multiScatteringKernel);
  }

  updateSkyView(renderer: WebGPURenderer): void {
    void renderer.compute(this.skyViewKernel);
  }

  updateAerial(renderer: WebGPURenderer): void {
    void renderer.compute(this.aerialKernel);
  }

  dispose(): void {
    this.transmittance.dispose();
    this.multiScattering.dispose();
    this.skyView.dispose();
    this.aerial.dispose();
    this.transmittanceKernel.dispose();
    this.multiScatteringKernel.dispose();
    this.skyViewKernel.dispose();
    this.aerialKernel.dispose();
  }
}
