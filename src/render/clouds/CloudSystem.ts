// CloudSystem: Nubis-style volumetric clouds (Schneider 2015/2017) for the sky, the environment
// probe and the sun's cloud shadows.
//
// Per frame (update, after SkySystem.update and before rendering):
//   ambient   1 thread    sky above (hemisphere mean of the sky-view LUT), sea below and the air
//                         under the deck (the grey murk the horizon fades into under overcast)
//   march     ¼ or ½ res  raymarch of the cloud shell + cirrus + aerial perspective → raw buffers;
//                         High marches one pixel of each 2×2 block per frame (temporal upscale)
//   resolve   output res  reprojects last frame's result with the camera motion and the cloud
//                         depth, clips it to the raw neighbourhood (variance clip) and blends
//   copy      output res  resolved → history
//   env       panorama    a slice of the upper-hemisphere panorama the environment probe reads
//   shadow    2D map      a slice of the top-down transmittance toward the sun/moon, jittered and
//                         blended into the history (ping-pong), then a small blur → the map the
//                         materials read (+ focus mean); the map rides with the clouds' drift, and
//                         the scene light takes its directional part (cloudLight.ts)
// The background node composites `sky × T + clouds` from the resolved buffer (bilinear upsample).
// Clouds are always beyond the scene's geometry (the camera is near sea level, below the deck), so
// compositing behind opaque objects is just the background; below the horizon the march clamps
// the ray to the horizon so the buffer stays continuous where the ocean meets the sky.

import {
  Color,
  type ComputeNode,
  type DirectionalLight,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  type Node,
  type PerspectiveCamera,
  RepeatWrapping,
  RGBAFormat,
  type Scene,
  type StorageBufferAttribute,
  StorageTexture,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../../app/Scenario';
import { releaseBuffer } from '../gpuResources';
import { PLANET_RADIUS } from '../sky/AtmosphereLuts';
import type { SkySystem } from '../sky/SkySystem';
import { type N, tsl } from '../tsl';
import {
  DIRECT_EXTINCTION,
  lowSunShadowFade,
  overcastWeight,
  SHADOW_HISTORY,
  shadowMarchSteps,
} from './cloudLight';
import { CloudNoise } from './CloudNoise';
import { BASE_TILE, CIRRUS_TILE, DETAIL_TILE } from './CloudNoise';
import {
  type CloudBufferSizes,
  cloudBufferSizes,
  type CloudQuality,
  cloudQualityFor,
  type CloudSettingsOverride,
} from './cloudQuality';
import { CloudShading, CloudUniforms, ign } from './cloudShading';
import {
  airLightFromCover,
  type CloudLayer,
  cloudLayerFor,
  deckOpticalDepth,
  murkExtinction,
  overcastAirWeight,
  steppedMorph,
  type CloudWeather,
  windAloft,
} from './cloudTypes';
import { AUREOLE_SIGMA, DIFFRACTED, DISK_T_CUTOFF } from './diskOcclusion';
import { PanoramaExposures, type PanoramaSlice, panoramaSlice } from './envPanorama';
import { hash3 } from './noiseNodes';
import {
  historyShift,
  recentre,
  SHADOW_EXTENT,
  type ShadowMapLayout,
  shadowSlicePhase,
} from './shadowLayout';
import { frameJitter, GOLDEN, upscaleOffset } from './temporal';
import { WEATHER_TILE, WeatherMap } from './WeatherMap';

const {
  Fn,
  If,
  Loop,
  attributeArray,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  log,
  globalId,
  int,
  ivec2,
  max,
  min,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  saturate,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  storage,
  texture,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uniformArray,
  uvec2,
  uvec3,
  vec2,
  vec3,
  vec4,
} = tsl;

const R = PLANET_RADIUS;
const FP16_SAFE = 60000;
const MAIN_DISTANCE = 260; // km: beyond the horizon of a 10 km anvil top
const ENV_DISTANCE = 200;
const SUN_LIGHT_LIMIT = -6 * (Math.PI / 180); // below this the moon lights the clouds
const FLASH_CLOUD_RADIANCE = 900; // cd/m² near a nominal flash
const READBACK_INTERVAL = 0.25; // s
const WG = 8;
const UNMARCHED_HISTORY = 0.9; // history weight of pixels not marched this frame (upscale)
const OVERCAST_SMOOTHING = 1.5; // s: the overcast air weight eases through stepped weather changes
const FOCUS_TAP = 125; // m between the focus kernel's 5×5 taps (~600 m footprint)
const SHADOW_RESET_ANGLE = 0.02; // rad: a jump of the light (time skip, sun → moon) restarts the history
const SHADOW_BLUR_TEXEL = 100; // m: finer maps get a 5×5 binomial blur, coarser a 3×3 (σ ≈ 60–120 m)
// Focus buffer: [focus T, mean T, focus directional T, mean directional T, overcast air rgb,
// mean beam e^(−τ)]. The air is copied here from the ambient kernel so materials read it through
// the binding the cloud-shadowed light already gives them.
const FOCUS_ELEMENTS = 8;
const FOCUS_AIR = 4;
const FOCUS_BEAM = 7;

export interface CloudSystemOptions {
  quality?: QualityPreset;
  settings?: CloudSettingsOverride; // graphics.clouds (custom preset)
}

interface CloudFlash {
  intensity: number;
  position: { x: number; y: number; z: number }; // world m
  color: { r: number; g: number; b: number };
}

export interface CloudFrame {
  time: number; // s, monotonic (cloud motion)
  focus: { x: number; y: number; z: number }; // world m, the shadow map centres near it
  shadowLight?: { x: number; y: number; z: number }; // direction of the scene light (default sun/moon)
  flash?: CloudFlash;
  groundIlluminance?: number; // lux of direct light on the sea (clear sky), for bounce light
}

function hdrTarget(width: number, height: number, name: string, repeatS = false): StorageTexture {
  const t = new StorageTexture(width, height);
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  if (repeatS) t.wrapS = RepeatWrapping;
  t.name = name;
  return t;
}

const wrap = (value: number, period: number): number => value - Math.floor(value / period) * period;

export class CloudSystem {
  readonly quality: CloudQuality;
  readonly uniforms = new CloudUniforms();
  readonly noise = new CloudNoise();
  readonly weatherMap = new WeatherMap();
  enabled = true;
  debugSkip = false; // dev: skip every cloud dispatch (for GPU timing comparisons)
  private sky: SkySystem;
  private shading: CloudShading;
  private layer: CloudLayer;
  private weather: CloudWeather | null = null;
  private wind = { x: 0, z: 0 };
  private ambientBuffer: N;
  private focusBuffer: N;
  private focusAttribute: StorageBufferAttribute;
  private focusRead: N; // read-only view for materials
  // Buffers.
  private raw: StorageTexture;
  private rawDepth: StorageTexture;
  private resolved: StorageTexture;
  private history: StorageTexture;
  private env: StorageTexture;
  private shadow: StorageTexture; // blurred, what the materials and the focus kernel read
  private shadowAccum: [StorageTexture, StorageTexture]; // ping-pong history of the jittered march
  private sizes: CloudBufferSizes = { output: [0, 0], march: [0, 0] };
  // Kernels.
  private ambientKernel: ComputeNode;
  private marchKernel: ComputeNode;
  private resolveKernel: ComputeNode;
  private copyKernel: ComputeNode;
  private shadowKernels: [ComputeNode, ComputeNode]; // march + copy, accum[i] → accum[1 − i]
  private blurKernels: [ComputeNode, ComputeNode]; // accum[1 − i] → shadow
  private focusKernel: ComputeNode;
  // Per-kernel uniforms.
  private readonly k = {
    right: uniform(new Vector3(1, 0, 0)),
    up: uniform(new Vector3(0, 1, 0)),
    forward: uniform(new Vector3(0, 0, -1)),
    tanHalf: uniform(new Vector2(1, 1)),
    outputSize: uniform(new Vector2(16, 16)),
    marchSize: uniform(new Vector2(16, 16)),
    marchRows: uniform(16),
    offset: uniform(new Vector2()),
    jitter: uniform(0),
    frameIndex: uniform(0),
    prevViewProjection: uniform(new Matrix4()),
    cameraDelta: uniform(new Vector3()), // m
    exposureRatio: uniform(1),
    historyValid: uniform(0),
    envPhase: uniform(0),
    envStride: uniform(1),
    envExposure: uniform(1),
    shadowPhase: uniform(0),
    shadowOrigin: uniform(new Vector2()), // m, world centre of the map (cloud-space centre + drift)
    shadowShift: uniform(new Vector2()), // texels the history moves by this frame (re-centring)
    shadowHistory: uniform(0), // weight of the history (0 = start afresh)
    shadowSteps: uniform(16), // march steps along the light ray
    shadowFade: uniform(1), // low-sun fade of the local pattern (cloudLight.lowSunShadowFade)
    focusUv: uniform(new Vector2(0.5, 0.5)),
    groundSun: uniform(0),
    preExposure: uniform(1),
    horizonMu: uniform(0), // cos zenith of the march's lowest ray, just above the sea horizon
  };
  private lightColor: N = uniform(new Color());
  private shadowLight: N = uniform(new Vector3(0, 1, 0));
  private shadowLayout: ShadowMapLayout;
  private frame = 0;
  private envFrame = 0;
  private envFull = true; // march every panorama column next frame
  private envExposures: PanoramaExposures;
  private envExposureNode: N; // per slice, for the probe's reads
  private shadowFrame = 0;
  private shadowReset = true;
  private shadowPing = 0;
  private drift = { x: 0, z: 0 }; // m the clouds have drifted with the wind
  private lastShadowLight = new Vector3(Number.NaN, Number.NaN, Number.NaN);
  private lastTime = Number.NaN;
  private prevViewProjection = new Matrix4();
  private prevCamera = new Vector3();
  private prevExposure = 1;
  private hasHistory = false;
  private readbackTimer = 0;
  private readbackPending = false;
  private focusT = 1;
  private meanT = 1;
  private visibility = Number.POSITIVE_INFINITY;
  private overcastWeight = Number.NaN; // smoothed overcastAirWeight (NaN: snap on the next update)
  private focusDirectT = 1;
  private meanDirectT = 1;
  private light: DirectionalLight | null = null;
  private scratch = new Vector2();
  private matrix = new Matrix4();

  constructor(renderer: WebGPURenderer, sky: SkySystem, options: CloudSystemOptions = {}) {
    this.sky = sky;
    this.quality = cloudQualityFor(options.quality ?? 'high', options.settings);
    const q = this.quality;
    this.layer = cloudLayerFor({ type: 'cumulus', coverage: 0, base: 1000, precipitation: 0 });
    this.ambientBuffer = attributeArray(3, 'vec4');
    this.focusBuffer = attributeArray(FOCUS_ELEMENTS, 'float');
    this.focusAttribute = this.focusBuffer.value as StorageBufferAttribute;
    this.focusRead = storage(this.focusAttribute, 'float', FOCUS_ELEMENTS).toReadOnly();
    const atmosphere = sky.atmosphere;
    this.shading = new CloudShading(
      this.uniforms,
      this.noise,
      this.weatherMap.texture,
      atmosphere.luts,
      atmosphere.uniforms,
      this.ambientBuffer,
    );
    this.raw = hdrTarget(16, 16, 'clouds-raw');
    this.rawDepth = hdrTarget(16, 16, 'clouds-raw-depth');
    this.resolved = hdrTarget(16, 16, 'clouds-resolved');
    this.history = hdrTarget(16, 16, 'clouds-history');
    this.env = hdrTarget(q.envSize[0], q.envSize[1], 'clouds-environment', true);
    this.envExposures = new PanoramaExposures(q.envSlices);
    this.envExposureNode = uniformArray(this.envExposures.values, 'float');
    this.shadow = hdrTarget(q.shadowSize, q.shadowSize, 'clouds-shadow');
    this.shadowAccum = [
      hdrTarget(q.shadowSize, q.shadowSize, 'clouds-shadow-accum-0'),
      hdrTarget(q.shadowSize, q.shadowSize, 'clouds-shadow-accum-1'),
    ];
    this.shadowLayout = {
      size: q.shadowSize,
      extent: SHADOW_EXTENT,
      centerX: Number.NaN,
      centerZ: Number.NaN,
    };
    this.ambientKernel = this.buildAmbient();
    this.marchKernel = this.buildMarch();
    this.resolveKernel = this.buildResolve();
    this.copyKernel = this.buildCopy();
    this.shadowKernels = [this.buildShadow(0), this.buildShadow(1)];
    this.blurKernels = [this.buildShadowBlur(this.shadowAccum[1]), this.buildShadowBlur(this.shadowAccum[0])];
    this.focusKernel = this.buildFocus();
    this.noise.generate(renderer);
    if (import.meta.env.DEV) {
      const g = globalThis as { __clouds?: CloudSystem; __cloudRenderer?: WebGPURenderer };
      g.__clouds = this;
      g.__cloudRenderer = renderer;
    }
  }

  // Cloud transmittance toward the scene light at the focus (5×5 taps over ~600 m) and over the
  // whole shadow map, from the last GPU readback (1 before the first one).
  get focusTransmittance(): number {
    return this.enabled && this.layer.enabled ? this.focusT : 1;
  }

  get meanTransmittance(): number {
    return this.enabled && this.layer.enabled ? this.meanT : 1;
  }

  // Directional (shadow-casting) share of the light at the focus itself (one sample of the blurred
  // map, so it follows a shadow's edge as it passes; toward the map mean at low sun, as the
  // materials have it), from the last readback; overcast flattening not applied.
  get focusDirect(): number {
    if (!this.enabled || !this.layer.enabled) return 1;
    const fade = this.k.shadowFade.value as number;
    return this.meanDirectT + (this.focusDirectT - this.meanDirectT) * fade;
  }

  // Overcast flattening of the directional light, 0 (broken cloud) .. 1 (closed deck): the scene
  // light's intensity is scaled by 1 − this (SunMoonLight.update), so a deck gives flat, shadowless
  // light without any moving patches of weak sun through its thin spots.
  get overcast(): number {
    return this.enabled && this.layer.enabled ? overcastWeight(this.layer.coverage) : 0;
  }

  // Fraction of the clear-sky light reaching the haze below the clouds (scales aerial-perspective
  // inscatter): the shadow map where the light is up, the cover itself otherwise (twilight, night).
  get airLight(): number {
    if (!this.enabled || !this.layer.enabled) return 1;
    return Math.min(0.3 + 0.7 * this.meanT, airLightFromCover(this.layer.coverage));
  }

  get cloudLayer(): Readonly<CloudLayer> {
    return this.layer;
  }

  // The air under the deck, for the aerial perspective of surfaces (SkySystem.setOvercastAir):
  // its radiance (physical cd/m², written by the ambient kernel each frame) and the share of the
  // haze it lights instead of the sun and clear sky (cloudTypes overcastAirWeight; 0 without cloud).
  get overcastAir(): { radiance: Node; weight: Node; murk: Node } {
    return {
      radiance: vec3(
        this.focusRead.element(FOCUS_AIR),
        this.focusRead.element(FOCUS_AIR + 1),
        this.focusRead.element(FOCUS_AIR + 2),
      ) as Node,
      weight: this.uniforms.overcast as Node,
      murk: this.uniforms.murk as Node,
    };
  }

  // A morph between two cloud types (weather.morphFrom → type) moves the profiles and the shell every
  // frame; the weather map regenerates, restarting the temporal history, only at MAP_MORPH_STEPS.
  // `visibility` (m) adds murk under the cloud to the overcast air weight.
  setWeather(weather: CloudWeather & { wind?: { x: number; z: number }; visibility?: number }): void {
    if (weather.wind) windAloft(weather.wind, this.wind);
    this.visibility = weather.visibility ?? Number.POSITIVE_INFINITY;
    const w = this.weather;
    const morphFrom = weather.morph === undefined ? undefined : weather.morphFrom;
    const morph = morphFrom === undefined ? undefined : weather.morph;
    const stepped =
      w !== null &&
      w.type === weather.type &&
      w.coverage === weather.coverage &&
      w.base === weather.base &&
      w.precipitation === weather.precipitation &&
      w.morphFrom === morphFrom;
    if (stepped && w.morph === morph) return;
    this.weather = {
      type: weather.type,
      coverage: weather.coverage,
      base: weather.base,
      precipitation: weather.precipitation,
      ...(morphFrom === undefined ? {} : { morphFrom, morph }),
    };
    const layer = cloudLayerFor(this.weather);
    this.layer = layer;
    const u = this.uniforms;
    u.baseKm.value = layer.baseKm;
    u.topKm.value = layer.topKm;
    const a = layer.profileA;
    const b = layer.profileB;
    u.profileA.value.set(a.thickness, a.bottomFade, a.taperStart, a.roundness);
    u.profileA2.value.set(a.density, a.anvil, a.billow);
    u.profileB.value.set(b.thickness, b.bottomFade, b.taperStart, b.roundness);
    u.profileB2.value.set(b.density, b.anvil, b.billow);
    u.extinction.value = layer.extinction;
    u.deckDepth.value = deckOpticalDepth(layer);
    u.cirrus.value = layer.cirrus;
    u.coverage.value = layer.enabled ? 1 : 0;
    u.rain.value = layer.enabled ? this.weather.precipitation : 0; // rain shafts
    const map =
      morph === undefined ? layer.map : cloudLayerFor({ ...this.weather, morph: steppedMorph(morph) }).map;
    // (The shadow map keeps its history: it blends into the new clouds within about a second.)
    if (this.weatherMap.set(map) || !stepped) {
      this.hasHistory = false;
      this.envFull = true;
    }
  }

  // Composites the clouds into the scene's sky background (call once, after SkySystem.applyTo):
  // `sky × T + clouds`, with the sun and moon disks added separately behind their own occlusion
  // (the least T over the upsample footprint, so neither the march's leftover transmittance nor
  // clear sky bilinearly mixed in at a cloud edge lets a crisp disk through thick cloud) and the
  // aureole thin cloud forward-scatters around them (diskOcclusion.ts). `skyOverlay` adds things
  // that sit above the clouds (contrails) to the clear sky behind them.
  applyTo(scene: Scene, skyOverlay?: (direction: Node, sky: Node) => Node): void {
    const direction = normalize(positionLocal);
    const clear: N = this.sky.createSkyNode(direction as Node, { sun: false, moon: false, moonMask: true });
    const sky: N = skyOverlay ? skyOverlay(direction as Node, clear as Node) : clear;
    const disks: N = this.sky.createDiskNode(direction as Node);
    const aureole: N = this.sky.createAureoleNode(direction as Node, AUREOLE_SIGMA);
    const size = this.k.outputSize;
    const node = Fn(() => {
      const clouds = texture(this.resolved, screenUV).toVar();
      const t = clouds.a.toVar();
      const color = sky.mul(t).add(clouds.rgb).toVar();
      const glow = aureole.toVar();
      If(glow.x.add(glow.y).add(glow.z).greaterThan(0), () => {
        const tc = clamp(t, 1e-6, 1);
        color.addAssign(glow.mul(max(log(tc).negate().mul(tc).mul(DIFFRACTED), 0)));
      });
      const disk = disks.toVar();
      If(disk.x.add(disk.y).add(disk.z).greaterThan(0), () => {
        const centre = ivec2(screenUV.mul(size).floor()).toVar();
        const last = ivec2(size.sub(1));
        const least = float(1).toVar();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const c = clamp(centre.add(ivec2(dx, dy)), ivec2(0, 0), last);
            least.assign(min(least, textureLoad(this.resolved, c).a));
          }
        }
        const k = saturate(least.sub(DISK_T_CUTOFF).div(1 - DISK_T_CUTOFF));
        color.addAssign(disk.mul(k.mul(k)));
      });
      // Within fp16, scaling rather than clipping (the sky's own rule).
      const peak = max(max(color.x, color.y), max(color.z, 1e-6));
      return color.mul(min(float(FP16_SAFE).div(peak), 1));
    })();
    (scene as Scene & { backgroundNode: Node | null }).backgroundNode = node as Node;
  }

  // Environment-probe background: the sky without disks behind the cloud panorama. `exposure` is
  // the probe's capture pre-exposure.
  createEnvironmentBackground(direction: Node, exposure: Node): Node {
    const d: N = normalize(direction);
    const sky: N = this.sky.createSkyNode(d as Node, { sun: false, moon: false, stars: false, exposure });
    const azimuth = tsl
      .atan(d.x, d.z.negate())
      .div(2 * Math.PI)
      .add(1)
      .fract();
    const elevation = tsl.asin(clamp(d.y, 0, 1)).div(Math.PI / 2);
    const v = sqrt(elevation);
    // Each column is divided by the pre-exposure it was marched at (envPanorama.ts), so the two
    // columns of the horizontal filter are fetched at their centres and blended here.
    const [width] = this.quality.envSize;
    const slices = this.quality.envSlices;
    const x = azimuth.mul(width).sub(0.5);
    const left = floor(x);
    const f = x.sub(left);
    const column = (offset: number): { rgb: N; a: N } => {
      const c = tsl.mod(left.add(width + offset), width);
      const sample = texture(this.env, vec2(c.add(0.5).div(width), v)).level(0);
      const phase = c.sub(floor(c.div(slices)).mul(slices));
      const marched = this.envExposureNode.element(int(phase.add(0.5)));
      return { rgb: sample.rgb.div(max(marched, 1e-12)), a: sample.a };
    };
    const a = column(0);
    const b = column(1);
    const transmittance = mix(a.a, b.a, f);
    const radiance = mix(a.rgb, b.rgb, f).mul(exposure);
    // Below the horizon the sky node fades toward a dark sea reflection; match it.
    const fade = mix(1, 0.08, smoothstep(0, 0.12, d.y.negate()));
    return vec3(sky.mul(transmittance).add(radiance.mul(fade))) as Node;
  }

  // Directional cloud transmittance toward the scene light at a world position (m), from the
  // cloud-shadow map, fading to the map mean at its edge and toward a low sun. It multiplies the
  // light's colour (attachLight), so everything lit by the sun/moon falls into the clouds' shadows
  // (boats, the ocean's body, crest glow, foam). Only the near-forward light (cloudLight.ts) keeps the light's direction; the
  // light diffused through the cloud reaches the scene through the sky (environment probe).
  shadowNode(worldPosition: Node): N {
    const { value, edge } = this.shadowSample(worldPosition);
    return mix(this.focusRead.element(3), value.b, edge);
  }

  // Share of shadowNode that is the unscattered beam, e^(−τ) / T_direct, at a world position (m): a
  // mirror image of the sun or moon (the ocean's glint) only sees the beam, not the forward-scattered
  // glow around it. Beyond the map, the ratio of the map's means.
  glintNode(worldPosition: Node): N {
    const { value, edge } = this.shadowSample(worldPosition);
    const near = exp(value.g.mul(DIRECT_EXTINCTION - 1));
    const far = this.focusRead.element(FOCUS_BEAM).div(max(this.focusRead.element(3), 1e-3));
    return saturate(mix(far, near, edge));
  }

  private shadowSample(worldPosition: Node): { value: N; edge: N } {
    const p: N = worldPosition;
    const L = this.shadowLight;
    const lift = max(p.y, 0).div(max(L.y, 0.05));
    const xz = p.xz.sub(L.xz.mul(lift));
    const uv = xz.sub(this.k.shadowOrigin).div(SHADOW_EXTENT).add(0.5);
    const value = texture(this.shadow, uv).level(0);
    const edge = smoothstep(0.5, 0.42, max(tsl.abs(uv.x.sub(0.5)), tsl.abs(uv.y.sub(0.5)))).mul(
      this.k.shadowFade,
    );
    return { value, edge };
  }

  // Multiplies a directional light by the cloud shadow at each shaded point. The light's own colour
  // and intensity are mirrored into a uniform each update.
  attachLight(light: DirectionalLight): void {
    this.light = light;
    (light as DirectionalLight & { colorNode?: Node }).colorNode = this.lightColor.mul(
      this.shadowNode(positionWorld as Node),
    ) as Node;
  }

  update(renderer: WebGPURenderer, camera: PerspectiveCamera, dt: number, frame: CloudFrame): void {
    this.noise.generate(renderer);
    this.weatherMap.update(renderer);
    if (this.light) {
      const l = this.light;
      (this.lightColor.value as Color).copy(l.color).multiplyScalar(l.intensity);
    }
    if (!this.enabled) {
      this.uniforms.coverage.value = 0;
      this.uniforms.cirrus.value = 0;
      this.uniforms.rain.value = 0;
    } else {
      this.uniforms.coverage.value = this.layer.enabled ? 1 : 0;
      this.uniforms.cirrus.value = this.layer.cirrus;
      this.uniforms.rain.value = this.layer.enabled ? (this.weather?.precipitation ?? 0) : 0;
    }
    this.advance(frame.time, dt);
    this.updateOvercast(dt);
    this.updateLight(frame);
    this.updateCamera(renderer, camera);
    if (this.debugSkip) return;

    const sizes = this.sizes;
    void renderer.compute(this.ambientKernel);
    // March rows, then the environment-panorama slice in extra workgroup rows below them.
    const slice = this.updateEnvironment();
    const q = this.quality;
    const marchGroups = Math.ceil(sizes.march[1] / WG);
    this.k.marchRows.value = marchGroups * WG;
    void renderer.compute(this.marchKernel, [
      Math.ceil(Math.max(sizes.march[0], slice.columns) / WG),
      marchGroups + Math.ceil(q.envSize[1] / WG),
      1,
    ]);
    const groups = [Math.ceil(sizes.output[0] / WG), Math.ceil(sizes.output[1] / WG), 1];
    void renderer.compute(this.resolveKernel, groups);
    void renderer.compute(this.copyKernel, groups);

    this.updateShadow(renderer, frame);
    this.readback(renderer, dt);

    // Remember this frame's camera for the next reprojection.
    this.prevViewProjection.copy(this.matrix);
    this.prevCamera.copy(camera.position);
    this.prevExposure = this.sky.preExposure.value as number;
    this.hasHistory = true;
    this.frame++;
  }

  dispose(): void {
    if (import.meta.env.DEV) {
      const g = globalThis as { __clouds?: CloudSystem };
      if (g.__clouds === this) delete g.__clouds;
    }
    for (const k of [
      this.ambientKernel,
      this.marchKernel,
      this.resolveKernel,
      this.copyKernel,
      ...this.shadowKernels,
      ...this.blurKernels,
      this.focusKernel,
    ])
      k.dispose();
    for (const t of [
      this.raw,
      this.rawDepth,
      this.resolved,
      this.history,
      this.env,
      this.shadow,
      ...this.shadowAccum,
    ])
      t.dispose();
    this.noise.dispose();
    this.weatherMap.dispose();
    releaseBuffer(this.ambientBuffer.value);
    releaseBuffer(this.focusAttribute);
  }

  // --- Frame state -------------------------------------------------------------------------------

  private advance(time: number, dt: number): void {
    const step = Number.isFinite(this.lastTime) ? Math.min(Math.max(time - this.lastTime, 0), 0.25) : 0;
    this.lastTime = time;
    void dt;
    const u = this.uniforms;
    const wx = (this.wind.x * step) / 1000;
    const wz = (this.wind.z * step) / 1000;
    this.drift.x += this.wind.x * step;
    this.drift.z += this.wind.z * step;
    // Sampling at p + offset: move the offset against the wind so the pattern drifts with it.
    const w = u.weatherOffset.value as Vector2;
    w.set(wrap(w.x - wx, WEATHER_TILE), wrap(w.y - wz, WEATHER_TILE));
    const n = u.noiseOffset.value as Vector3;
    // Slow rise of the noise: the clouds boil a little as they drift.
    n.set(wrap(n.x - wx, BASE_TILE), wrap(n.y - step * 0.0012, BASE_TILE), wrap(n.z - wz, BASE_TILE));
    const d = u.detailOffset.value as Vector3;
    d.set(
      wrap(d.x - wx * 1.2, DETAIL_TILE),
      wrap(d.y - step * 0.004, DETAIL_TILE),
      wrap(d.z - wz * 1.2, DETAIL_TILE),
    );
    const c = u.cirrusOffset.value as Vector2;
    c.set(wrap(c.x - wx * 1.8, CIRRUS_TILE), wrap(c.y - wz * 1.8, CIRRUS_TILE));
    const speed = Math.hypot(this.wind.x, this.wind.z);
    if (speed > 0.01) (u.windDirection.value as Vector2).set(this.wind.x / speed, this.wind.z / speed);
  }

  private updateOvercast(dt: number): void {
    const layer = this.layer;
    const target =
      this.enabled && layer.enabled
        ? overcastAirWeight(layer.coverage, this.weather?.precipitation ?? 0, this.visibility)
        : 0;
    const w = this.overcastWeight;
    this.overcastWeight = Number.isFinite(w)
      ? w + (target - w) * (1 - Math.exp(-Math.max(dt, 0) / OVERCAST_SMOOTHING))
      : target;
    this.uniforms.overcast.value = this.overcastWeight;
    this.uniforms.murk.value = murkExtinction(this.overcastWeight, this.visibility);
  }

  private updateLight(frame: CloudFrame): void {
    const u = this.uniforms;
    const sky = this.sky;
    const atmosphere = sky.atmosphere.uniforms;
    const useSun = sky.sunElevation > SUN_LIGHT_LIMIT;
    (u.lightDirection.value as Vector3).copy(useSun ? sky.sunDirection : sky.moonDirection);
    (u.lightIlluminance.value as Vector3).copy(
      useSun ? atmosphere.sunIlluminance.value : atmosphere.moonIlluminance.value,
    );
    const shadowLight = this.shadowLight.value as Vector3;
    if (frame.shadowLight) shadowLight.set(frame.shadowLight.x, frame.shadowLight.y, frame.shadowLight.z);
    else shadowLight.copy(u.lightDirection.value as Vector3);
    shadowLight.normalize();
    this.k.groundSun.value = (frame.groundIlluminance ?? 0) * Math.max(shadowLight.y, 0) * this.meanT;
    u.airLight.value = this.airLight;

    const flash = frame.flash;
    const radiance = u.flashRadiance.value as Vector3;
    if (flash && flash.intensity > 0 && this.enabled) {
      const k = flash.intensity * FLASH_CLOUD_RADIANCE;
      radiance.set(flash.color.r * k, flash.color.g * k, flash.color.b * k);
      const base = this.layer.baseKm;
      // The flash lights the cloud from inside: at least a few hundred metres above the base.
      const y = Math.max(flash.position.y / 1000, base + 0.4);
      (u.flashPosition.value as Vector3).set(flash.position.x / 1000, R + y, flash.position.z / 1000);
    } else {
      radiance.set(0, 0, 0);
    }
  }

  private updateCamera(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    const size = renderer.getDrawingBufferSize(this.scratch);
    const sizes = cloudBufferSizes(size.x, size.y, this.quality);
    const old = this.sizes;
    if (sizes.output[0] !== old.output[0] || sizes.output[1] !== old.output[1]) {
      this.resize(sizes);
      this.hasHistory = false;
    }
    const k = this.k;
    const e = camera.matrixWorld.elements;
    (k.right.value as Vector3).set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0).normalize();
    (k.up.value as Vector3).set(e[4] ?? 0, e[5] ?? 1, e[6] ?? 0).normalize();
    (k.forward.value as Vector3).set(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1)).normalize();
    const tanY = Math.tan(((camera.fov * Math.PI) / 180) * 0.5) / camera.zoom;
    (k.tanHalf.value as Vector2).set(tanY * camera.aspect, tanY);
    const p = camera.position;
    const cameraUniform = this.uniforms.camera.value as Vector3;
    cameraUniform.set(p.x / 1000, R + Math.max(p.y, 1) / 1000, p.z / 1000);
    // The sea horizon's cos zenith is −√(1 − (R/r)²); march no lower than 90% of that dip.
    const ratio = R / cameraUniform.length();
    k.horizonMu.value = -0.9 * Math.sqrt(Math.max(0, 1 - ratio * ratio));

    // Camera-relative view-projection (translation removed) for the next frame's reprojection.
    this.matrix.copy(camera.matrixWorldInverse).setPosition(0, 0, 0);
    this.matrix.premultiply(camera.projectionMatrix);
    (k.prevViewProjection.value as Matrix4).copy(this.hasHistory ? this.prevViewProjection : this.matrix);
    (k.cameraDelta.value as Vector3).copy(p).sub(this.hasHistory ? this.prevCamera : p);
    const exposure = this.sky.preExposure.value as number;
    k.preExposure.value = exposure;
    k.exposureRatio.value = this.hasHistory ? exposure / Math.max(this.prevExposure, 1e-12) : 1;
    k.historyValid.value = this.hasHistory ? 1 : 0;
    const [ox, oy] = upscaleOffset(this.frame, this.quality.upscale);
    (k.offset.value as Vector2).set(ox, oy);
    k.jitter.value = frameJitter(this.frame);
    k.frameIndex.value = this.frame % 65536;
  }

  private resize(sizes: CloudBufferSizes): void {
    this.sizes = sizes;
    this.raw.setSize(sizes.march[0], sizes.march[1], 1);
    this.rawDepth.setSize(sizes.march[0], sizes.march[1], 1);
    this.resolved.setSize(sizes.output[0], sizes.output[1], 1);
    this.history.setSize(sizes.output[0], sizes.output[1], 1);
    (this.k.outputSize.value as Vector2).set(sizes.output[0], sizes.output[1]);
    (this.k.marchSize.value as Vector2).set(sizes.march[0], sizes.march[1]);
  }

  private updateEnvironment(): PanoramaSlice {
    const q = this.quality;
    const slice = panoramaSlice(this.envFrame, q.envSize[0], q.envSlices, this.envFull);
    const exposure = this.sky.preExposure.value as number;
    this.k.envPhase.value = slice.phase;
    this.k.envStride.value = slice.stride;
    this.k.envExposure.value = exposure;
    this.envExposures.record(slice, exposure);
    this.envFull = false;
    this.envFrame++;
    return slice;
  }

  // The map's texels ride with the clouds: its centre is a point in cloud space (snapped) and the
  // world lookup adds the drift, so the shadows glide continuously and rows refreshed on different
  // frames agree. A refreshed texel blends a jittered march into its history (ping-pong), the rest
  // copy theirs; a re-centre moves the history by whole texels and marches every row once.
  private updateShadow(renderer: WebGPURenderer, frame: CloudFrame): void {
    const q = this.quality;
    const k = this.k;
    const layout = this.shadowLayout;
    const light = this.shadowLight.value as Vector3;
    const jumped =
      !Number.isFinite(this.lastShadowLight.x) || light.angleTo(this.lastShadowLight) > SHADOW_RESET_ANGLE;
    this.lastShadowLight.copy(light);
    if (jumped) this.shadowReset = true;
    const shift = k.shadowShift.value as Vector2;
    shift.set(0, 0);
    const moved = recentre(layout, frame.focus.x - this.drift.x, frame.focus.z - this.drift.z);
    if (moved) {
      if (Number.isFinite(layout.centerX)) {
        const texels = historyShift(
          layout,
          { x: layout.centerX, z: layout.centerZ },
          { x: moved.centerX, z: moved.centerZ },
        );
        shift.set(texels.x, texels.z);
      } else {
        this.shadowReset = true;
      }
      layout.centerX = moved.centerX;
      layout.centerZ = moved.centerZ;
    }
    const originX = layout.centerX + this.drift.x;
    const originZ = layout.centerZ + this.drift.z;
    (k.shadowOrigin.value as Vector2).set(originX, originZ);
    k.shadowHistory.value = this.shadowReset ? 0 : SHADOW_HISTORY;
    k.shadowSteps.value = shadowMarchSteps(q.shadowSteps, light.y);
    k.shadowFade.value = lowSunShadowFade(light.y);
    const full = this.shadowReset || moved !== null;
    k.shadowPhase.value = full ? -1 : shadowSlicePhase(this.shadowFrame, q.shadowSlices);
    const size = q.shadowSize;
    const groups: [number, number, number] = [Math.ceil(size / WG), Math.ceil(size / WG), 1];
    const ping = this.shadowPing;
    void renderer.compute(this.shadowKernels[ping], groups);
    void renderer.compute(this.blurKernels[ping], groups);
    this.shadowPing = 1 - ping;
    this.shadowReset = false;
    this.shadowFrame++;
    (k.focusUv.value as Vector2).set(
      (frame.focus.x - originX) / SHADOW_EXTENT + 0.5,
      (frame.focus.z - originZ) / SHADOW_EXTENT + 0.5,
    );
    void renderer.compute(this.focusKernel);
  }

  private readback(renderer: WebGPURenderer, dt: number): void {
    this.readbackTimer += dt;
    if (this.readbackPending || this.readbackTimer < READBACK_INTERVAL || this.frame < 3) return;
    this.readbackTimer = 0;
    this.readbackPending = true;
    void renderer
      .getArrayBufferAsync(this.focusAttribute)
      .then((buffer) => {
        const data = new Float32Array(buffer as ArrayBuffer);
        const focus = data[0] ?? 1;
        const mean = data[1] ?? 1;
        const direct = data[2] ?? 1;
        const meanDirect = data[3] ?? 1;
        if (Number.isFinite(focus)) this.focusT = Math.min(1, Math.max(0, focus));
        if (Number.isFinite(mean)) this.meanT = Math.min(1, Math.max(0, mean));
        if (Number.isFinite(direct)) this.focusDirectT = Math.min(1, Math.max(0, direct));
        if (Number.isFinite(meanDirect)) this.meanDirectT = Math.min(1, Math.max(0, meanDirect));
      })
      .catch(() => undefined)
      .finally(() => {
        this.readbackPending = false;
      });
  }

  // --- Kernels -----------------------------------------------------------------------------------

  // Hemisphere-mean sky luminance above the clouds, the sea's radiance below them and the air's
  // under the deck.
  private buildAmbient(): ComputeNode {
    const s = this.shading;
    const count = 24;
    const kernel = Fn(() => {
      const sum = vec3(0).toVar();
      Loop(count, ({ i }: { i: N }) => {
        // Golden-spiral directions over the upper hemisphere (uniform in solid angle).
        const fi = float(i).add(0.5);
        const y = fi.div(count);
        const phi = fi.mul(2.399963);
        const ring = sqrt(max(y.mul(y).oneMinus(), 0));
        sum.addAssign(s.skyLuminance(vec3(ring.mul(cos(phi)), y, ring.mul(sin(phi)))));
      });
      const above = sum.div(count).add(1.8e-4).toVar();
      const mean = this.focusBuffer.element(1);
      // Sea: Lambert-ish albedo under the (shadowed) direct light plus the dimmed sky.
      const below = vec3(this.k.groundSun)
        .add(above.mul(Math.PI).mul(mix(0.25, 1, mean)))
        .mul(0.06 / Math.PI);
      this.ambientBuffer.element(0).assign(vec4(above, 1));
      this.ambientBuffer.element(1).assign(vec4(below, 1));
      const air = s.deckAirLight(above).toVar();
      this.ambientBuffer.element(2).assign(vec4(air, 1));
      this.focusBuffer.element(FOCUS_AIR).assign(air.x);
      this.focusBuffer.element(FOCUS_AIR + 1).assign(air.y);
      this.focusBuffer.element(FOCUS_AIR + 2).assign(air.z);
    });
    const node: ComputeNode = kernel().compute(1, [1]);
    node.setName('clouds-ambient');
    return node;
  }

  private viewRay(pixel: N): N {
    const k = this.k;
    const uv = pixel.add(0.5).div(k.outputSize);
    const ndc = vec2(uv.x.mul(2).sub(1), uv.y.mul(2).oneMinus());
    return normalize(
      k.forward.add(k.right.mul(ndc.x.mul(k.tanHalf.x))).add(k.up.mul(ndc.y.mul(k.tanHalf.y))),
    );
  }

  // Rays below the sea horizon march just above it instead (the ocean hides them; keeps edges
  // clean). The clamp sits at the camera's own horizon dip, not at the level: rays between the two
  // must march their own direction, or every distant cloud is smeared down to the sea in a column.
  private skyward(rd: N): N {
    const zenith = normalize(this.uniforms.camera);
    const mu = dot(rd, zenith);
    return normalize(rd.add(zenith.mul(max(this.k.horizonMu.sub(mu), 0))));
  }

  private buildMarch(): ComputeNode {
    const q = this.quality;
    const s = this.shading;
    const k = this.k;
    const kernel = Fn(() => {
      const id = globalId.xy;
      If(float(id.y).greaterThanEqual(k.marchRows), () => {
        this.environmentTexel(uvec2(id.x, id.y.sub(uint(k.marchRows))));
      });
      If(float(id.x).lessThan(k.marchSize.x).and(float(id.y).lessThan(k.marchSize.y)), () => {
        const pixel = vec2(id).mul(q.upscale).add(k.offset).toVar();
        const rd = this.skyward(this.viewRay(pixel)).toVar();
        // Ray offsets: white noise across pixels (PCG; IGN on the strided upscale lattice correlates
        // rows into visible step bands), stratified over each pixel's own marches by the golden
        // ratio sequence, so the temporal resolve's few-frame history averages a well-spread set
        // of offsets.
        const marches = floor(k.frameIndex.div(q.upscale * q.upscale));
        const jitter = fract(hash3(uvec3(uvec2(pixel), uint(0))).x.add(marches.mul(GOLDEN)));
        const result = s.composite(this.uniforms.camera, rd, jitter, {
          steps: q.steps,
          lightSteps: q.lightSteps,
          detail: q.detail,
          maxDistance: MAIN_DISTANCE,
        });
        const color = min(result.color.mul(k.preExposure), FP16_SAFE);
        textureStore(this.raw, uvec2(id), vec4(color, result.transmittance)).toWriteOnly();
        textureStore(this.rawDepth, uvec2(id), vec4(result.depth, 0, 0, 1)).toWriteOnly();
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [WG, WG, 1]);
    node.setName('clouds-march');
    return node;
  }

  private buildResolve(): ComputeNode {
    const q = this.quality;
    const k = this.k;
    const up = q.upscale;
    const kernel = Fn(() => {
      const id = globalId.xy;
      If(float(id.x).lessThan(k.outputSize.x).and(float(id.y).lessThan(k.outputSize.y)), () => {
        const pixel = vec2(id).toVar();
        const cell = ivec2(pixel.div(up).floor()).toVar();
        const maxCell = ivec2(k.marchSize.sub(1));
        const current = textureLoad(this.raw, cell).toVar();
        const depth = textureLoad(this.rawDepth, cell).r;
        // Neighbourhood statistics of the raw samples (variance clipping, Salvi 2016).
        const m1 = vec4(0).toVar();
        const m2 = vec4(0).toVar();
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const c = clamp(cell.add(ivec2(dx, dy)), ivec2(0, 0), maxCell);
            const v = textureLoad(this.raw, c);
            m1.addAssign(v);
            m2.addAssign(v.mul(v));
          }
        }
        const mean = m1.div(9).toVar();
        const sigma = sqrt(max(m2.div(9).sub(mean.mul(mean)), 0));
        const lo = mean.sub(sigma.mul(q.varianceGamma));
        const hi = mean.add(sigma.mul(q.varianceGamma));
        // Reproject: this pixel's ray at the cloud's depth, seen from last frame's camera.
        const rd = this.skyward(this.viewRay(pixel));
        const point = rd.mul(depth.mul(1000)).add(k.cameraDelta);
        const clip = k.prevViewProjection.mul(vec4(point, 1));
        const prevUv = vec2(clip.x.div(clip.w).mul(0.5).add(0.5), clip.y.div(clip.w).mul(-0.5).add(0.5));
        const inside = clip.w
          .greaterThan(1e-6)
          .and(prevUv.x.greaterThanEqual(0))
          .and(prevUv.x.lessThanEqual(1))
          .and(prevUv.y.greaterThanEqual(0))
          .and(prevUv.y.lessThanEqual(1))
          .and(k.historyValid.greaterThan(0.5));
        const history = texture(this.history, prevUv).level(0);
        const scaled = vec4(history.rgb.mul(k.exposureRatio), history.a);
        const clipped = clamp(scaled, lo, hi);
        const marched =
          up === 1
            ? float(1)
            : select(pixel.sub(vec2(cell).mul(up)).sub(k.offset).length().lessThan(0.5), float(1), float(0));
        // Unmarched pixels lean on the history but keep converging to the spatially interpolated
        // raw samples (raw texel X holds output pixel k·X + offset), so the k×k pattern can't freeze.
        const rawUv = pixel.sub(k.offset).div(up).add(0.5).div(k.marchSize);
        const estimate = up === 1 ? current : texture(this.raw, rawUv).level(0);
        const blend = mix(UNMARCHED_HISTORY, q.historyWeight, marched);
        const weight = select(inside, blend, float(0));
        const out = mix(select(marched.greaterThan(0.5), current, estimate), clipped, weight);
        textureStore(this.resolved, uvec2(id), out).toWriteOnly();
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [WG, WG, 1]);
    node.setName('clouds-resolve');
    return node;
  }

  private buildCopy(): ComputeNode {
    const k = this.k;
    const kernel = Fn(() => {
      const id = globalId.xy;
      If(float(id.x).lessThan(k.outputSize.x).and(float(id.y).lessThan(k.outputSize.y)), () => {
        textureStore(this.history, uvec2(id), textureLoad(this.resolved, ivec2(id))).toWriteOnly();
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [WG, WG, 1]);
    node.setName('clouds-history-copy');
    return node;
  }

  // Upper-hemisphere panorama for the environment probe: u = azimuth (clockwise from north),
  // v = √(elevation / 90°) so the horizon, where clouds pile up, gets most rows.
  // Runs inside the march kernel (extra workgroup rows), so its long, latency-bound rays overlap
  // the main march instead of serialising as a tiny dispatch of their own.
  private environmentTexel(id: N): void {
    const q = this.quality;
    const s = this.shading;
    const k = this.k;
    const [w, h] = q.envSize;
    const x = id.x.mul(uint(k.envStride)).add(uint(k.envPhase));
    If(x.lessThan(uint(w)).and(id.y.lessThan(uint(h))), () => {
      const u = float(x).add(0.5).div(w);
      const v = float(id.y).add(0.5).div(h);
      const azimuth = u.mul(2 * Math.PI);
      const elevation = v.mul(v).mul(Math.PI / 2);
      const ce = cos(elevation);
      const rd = this.skyward(vec3(ce.mul(sin(azimuth)), sin(elevation), ce.mul(cos(azimuth)).negate()));
      // A fixed jitter per texel: nothing accumulates the panorama over frames, so a per-frame one
      // would re-roll its noise at every refresh and make the probe's reflections flicker.
      const jitter = ign(vec2(float(x), float(id.y)));
      const result = s.composite(this.uniforms.camera, rd, jitter, {
        steps: q.envSteps,
        lightSteps: q.envLightSteps,
        detail: false,
        maxDistance: ENV_DISTANCE,
      });
      const color = min(result.color.mul(k.envExposure), FP16_SAFE);
      textureStore(this.env, uvec2(x, id.y), vec4(color, result.transmittance)).toWriteOnly();
    });
  }

  // Shadow march + copy, history accum[from] → accum[1 − from], over the whole map. Thread rows
  // below `marched` march the refreshed rows (every row on a full refresh, else every `slices`-th),
  // the rest copy the other rows' history; both counts are whole workgroups, so no workgroup mixes
  // the long march with copies.
  private buildShadow(from: 0 | 1): ComputeNode {
    const q = this.quality;
    const s = this.shading;
    const k = this.k;
    const size = q.shadowSize;
    const slices = q.shadowSlices;
    const texel = SHADOW_EXTENT / size;
    const history = this.shadowAccum[from];
    const target = this.shadowAccum[1 - from] as StorageTexture;
    if (size % (slices * WG) !== 0) throw new Error('cloud shadow map size must be a multiple of 8 × slices');
    const kernel = Fn(() => {
      const id = globalId.xy;
      const full = k.shadowPhase.lessThan(0);
      const phase = uint(max(k.shadowPhase, 0)).toVar();
      const marched = select(full, uint(size), uint(size / slices)).toVar();
      If(id.x.lessThan(uint(size)).and(id.y.lessThan(uint(size))), () => {
        const x = id.x;
        If(id.y.lessThan(marched), () => {
          const row = select(full, id.y, id.y.mul(uint(slices)).add(phase)).toVar();
          const cell = vec2(float(x), float(row)).toVar();
          const world = cell
            .add(0.5)
            .mul(texel)
            .sub(SHADOW_EXTENT / 2)
            .add(k.shadowOrigin);
          const p0 = vec3(world.x.div(1000), R, world.y.div(1000));
          // Jittered along the ray per texel and per refresh; the history blend integrates it.
          const jitter = ign(cell).add(float(k.frameIndex).mul(0.618034)).fract();
          const tau = s.shadowOpticalDepth(p0, k.shadowSteps, this.shadowLight, jitter);
          // r: all the light through (multiple scattering lets light through thick cloud: a long-
          // tail mix, not pure Beer), for the haze and the CPU light model; b: its directional part,
          // the beam and the forward peak (δ-Eddington, cloudLight.ts), for the scene light.
          const transmittance = mix(exp(tau.negate()), float(1).div(tau.mul(0.11).add(1)), 0.35);
          const direct = exp(tau.mul(-DIRECT_EXTINCTION));
          const fresh = vec4(transmittance, tau, direct, 1);
          // History at this texel, moved by a re-centre (where it existed).
          const source = ivec2(cell.add(k.shadowShift)).toVar();
          const inside = source.x
            .greaterThanEqual(int(0))
            .and(source.y.greaterThanEqual(int(0)))
            .and(source.x.lessThan(int(size)))
            .and(source.y.lessThan(int(size)));
          const previous = textureLoad(history, clamp(source, ivec2(0, 0), ivec2(size - 1, size - 1)));
          const weight = select(inside, k.shadowHistory, float(0));
          textureStore(target, uvec2(x, row), mix(fresh, previous, weight)).toWriteOnly();
        }).Else(() => {
          // The j-th row not refreshed this frame (shadowLayout.copiedRow).
          const j = id.y.sub(marched);
          const r = j.mod(uint(slices - 1)).toVar();
          const row = j
            .div(uint(slices - 1))
            .mul(uint(slices))
            .add(r)
            .add(select(r.greaterThanEqual(phase), uint(1), uint(0)))
            .toVar();
          textureStore(target, uvec2(x, row), textureLoad(history, ivec2(uvec2(x, row)))).toWriteOnly();
        });
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [WG, WG, 1]);
    node.setName('clouds-shadow');
    return node;
  }

  // Binomial blur of the accumulated map into the one the materials read: soft, natural penumbrae
  // (σ ≈ 60 m on High and Ultra, ~90–120 m on Medium and Low) instead of hard texel-sized steps, and
  // the last of the march's jitter averaged out.
  private buildShadowBlur(source: StorageTexture): ComputeNode {
    const size = this.quality.shadowSize;
    const radius = SHADOW_EXTENT / size < SHADOW_BLUR_TEXEL ? 2 : 1;
    const weights = radius === 2 ? [1, 4, 6, 4, 1] : [1, 2, 1];
    const total = weights.reduce((a, b) => a + b, 0) ** 2;
    const kernel = Fn(() => {
      const id = globalId.xy;
      If(id.x.lessThan(uint(size)).and(id.y.lessThan(uint(size))), () => {
        const centre = ivec2(id).toVar();
        const sum = vec4(0).toVar();
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const w = (weights[dx + radius] ?? 0) * (weights[dy + radius] ?? 0);
            const c = clamp(centre.add(ivec2(dx, dy)), ivec2(0, 0), ivec2(size - 1, size - 1));
            sum.addAssign(textureLoad(source, c).mul(w / total));
          }
        }
        textureStore(this.shadow, uvec2(id), sum).toWriteOnly();
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [WG, WG, 1]);
    node.setName('clouds-shadow-blur');
    return node;
  }

  // Focus (5×5 taps, ~600 m) and whole-map mean shadow transmittance, the directional share at the
  // focus and its map mean, and the map's mean beam: for the CPU readback, the ambient kernel and
  // the materials beyond the map's edge.
  private buildFocus(): ComputeNode {
    const k = this.k;
    const tap = FOCUS_TAP / SHADOW_EXTENT;
    const kernel = Fn(() => {
      const focus = float(0).toVar();
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const uv = saturate(k.focusUv.add(vec2(dx, dy).mul(tap)));
          focus.addAssign(texture(this.shadow, uv).level(0).r);
        }
      }
      const mean = vec3(0).toVar(); // (T, directional T, beam)
      Loop(64, ({ i }: { i: N }) => {
        const uv = vec2(float(i.mod(8)), float(i.div(8)))
          .add(0.5)
          .div(8);
        const texel = texture(this.shadow, uv).level(0);
        mean.addAssign(vec3(texel.r, texel.b, exp(texel.g.negate())));
      });
      mean.divAssign(64);
      this.focusBuffer.element(0).assign(focus.div(25));
      this.focusBuffer.element(1).assign(mean.x);
      this.focusBuffer.element(2).assign(texture(this.shadow, saturate(k.focusUv)).level(0).b);
      this.focusBuffer.element(3).assign(mean.y);
      this.focusBuffer.element(FOCUS_BEAM).assign(mean.z);
    });
    const node: ComputeNode = kernel().compute(1, [1]);
    node.setName('clouds-shadow-focus');
    return node;
  }
}
