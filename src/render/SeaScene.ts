// The rendered world: physically based sky and lighting, the FFT ocean,
// spray/rain/lightning and the boats, rendered through a pipeline whose output
// stage applies auto-exposure and tone mapping. Astronomy drives the sun, moon
// and stars from the scenario's region, date and time.

import {
  Box3,
  Color,
  Frustum,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  SphereGeometry,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import { BOAT_LENGTH, type QualityPreset } from '../app/Scenario';
import { BOAT_CAMERA_INFO } from '../camera/boatCameraInfo';
import type { SimClock } from '../sim/astro/clock';
import { moonIllumination, moonPosition } from '../sim/astro/lunar';
import { getRegion, type WaterOptics } from '../sim/astro/regions';
import { horizontalToDirection, starFieldToWorldMatrix } from '../sim/astro/sidereal';
import { solarPosition } from '../sim/astro/solar';
import { decodeStarCatalog } from '../sim/astro/stars';
import { BOAT_SPECS } from '../sim/boats/specs/index';
import { DEG, vectorToHeading, velocityToFromDirection } from '../sim/core/conventions';
import { vec3 } from '../sim/core/math';
import { T_REPEAT } from '../sim/ocean/spectrum';
import { CC115_RIG, type RigSpec } from '../sim/sail/rig';
import type { CloudType } from '../sim/weather/presets';
import type { BoatSnapshot, SimEvent, SpectrumMessage, WakeGrid } from '../sim/world/protocol';
import { clothBudget, FULL_CLOTH } from './boats/clothBudget';
import type { CollisionOverlay } from './boats/collisionOverlay';
import {
  createBoatVisual,
  hasBoatTemplate,
  hasProceduralModel,
  loadBoatTemplate,
  variantFromTelemetry,
} from './boats/createBoatVisual';
import { BoatVisual, type BoatTemplate } from './boats/kit/BoatVisual';
import { nightFactor, setBoatEnvironment } from './boats/kit/environment';
import { stepWetness, wetnessTarget } from './boats/kit/wetness';
import { type BoatLightState, BoatLights } from './boats/lights/BoatLights';
import { FLEET_LIGHTS, LIGHT_BUDGET } from './boats/lights/lightBudget';
import { FleetLightPool, type FleetLightSource, SceneLightPool } from './boats/lights/LightPool';
import { markersFromModel, mountsFromMarkers } from './boats/lights/modelMounts';
import { SailView } from './boats/SailView';
import { cloudDimmingEv } from './clouds/cloudLight';
import type { CloudSettingsOverride } from './clouds/cloudQuality';
import { CloudReadout } from './clouds/cloudReadout';
import { CloudSystem } from './clouds/CloudSystem';
import { ContrailSystem } from './contrails/ContrailSystem';
import { installStorageRelease, releaseSceneObjects } from './gpuResources';
import { EnvironmentProbe } from './lighting/EnvironmentProbe';
import { Exposure } from './lighting/Exposure';
import type { ShadowCaster } from './lighting/shadowFit';
import { SunMoonLight, type ShadowQuality } from './lighting/SunMoonLight';
import { OCEAN_WAKE_TEXTURE_LIMIT, OceanSurface } from './ocean/OceanSurface';
import { gpuCascadesFromSpectrum } from './ocean/spectrumUpload';
import { occluderBounds } from './ocean/ssrOccluders';
import { BoatSpray, slamSides, wipersWanted } from './particles/boatSpray';
import { FxSystem } from './particles/FxSystem';
import { hullSprayScale } from './particles/sprayMath';
import { createLensDrops, stepLensDrops } from './post/lensDrops';
import {
  greenWaterSplash,
  lensSpray,
  type LensSpray,
  lensViewFor,
  rainExposure,
  type SprayHit,
} from './post/lensWetness';
import { PostPipeline } from './post/PostPipeline';
import type { DofSettings, PostPlan, PostSettings } from './post/postSettings';
import { moonIlluminanceToa } from './sky/atmosphereParams';
import { SkySystem } from './sky/SkySystem';
import { rainFallSpeed } from './weather/rainMath';

export interface SeaSceneOptions {
  spectrum: SpectrumMessage;
  quality: QualityPreset;
  shadows: ShadowQuality;
  seed: number;
  latitudeDeg: number;
  longitudeDeg: number;
  // Ocean shading and post (render/ocean, render/post).
  water?: WaterOptics; // region optics; default North Atlantic
  post?: PostSettings; // anti-aliasing and bloom; default from the quality preset's TRAA + bloom
  clouds?: CloudSettingsOverride; // graphics.clouds when the preset is custom
  // Performance knobs (graphics.*; the presets pass their table values).
  clipmapRings?: number; // ocean CDLOD levels; default 11
  particleBudget?: number; // spray/rain particle pool; default the quality preset's
  sailCloth?: readonly [number, number]; // cloth grid [cols, rows]; default the quality preset's
}

// Weather the renderer reacts to.
export interface SceneWeather {
  windVelocity: { x: number; y: number; z: number }; // m/s toward
  precipitation: number; // 0..1
  lightningPerMinute: number;
  overcast: number; // 0..1 (sky dimming used only when volumetric clouds are off)
  hazeDensity: number;
  visibility: number; // m, meteorological visibility (restricted visibility switches nav lights on)
  clouds: SceneClouds;
}

// Light switches for the fleet; the helm boat also gets real scene lights, and the nearest few
// fleet boats with their deck lights on a beam each.
interface SceneLights {
  helmId: string | null;
  state: Partial<Omit<BoatLightState, 'makingWay' | 'signals'>>;
  signals?: (boat: BoatSnapshot) => BoatLightState['signals'];
}

export interface SceneClouds {
  type: CloudType;
  coverage: number; // 0..1
  base: number; // m above sea level
  // Part-way through a weather change the clouds morph from morphFrom (morph 0) into type (1).
  morphFrom?: CloudType;
  morph?: number;
}

export interface SceneFrame {
  camera: PerspectiveCamera;
  boats: readonly BoatSnapshot[];
  time: number; // simulation seconds (ocean, spray)
  dt: number; // real seconds since the last frame
  clock: SimClock;
  weather: SceneWeather;
  // The wind the sea is built for, following its crossfade in simulation time (app/seaReadout):
  // whitecaps, streaks, spume and spray use it so foam never leads the waves. Default: the weather's.
  seaWind?: { x: number; y: number; z: number };
  focus: Vector3; // where the shadow cascades centre (the player boat)
  cameraWaterHeight?: number; // sea surface height under the camera (sim probe), for underwater
  lights?: SceneLights;
  seaHs?: number; // significant wave height, m (bow spray); default 0
  cameraMode?: string; // CameraRig mode: lens droplets on external cameras, bridge windows at the helm
}

const sampledTextureLimit = (renderer: WebGPURenderer): number =>
  (renderer.backend as { device?: GPUDevice }).device?.limits.maxSampledTexturesPerShaderStage ?? 16;

const sunDirection = new Vector3();
const bow = new Vector3();
const boatQuaternion = new Quaternion();
const moonDirection = new Vector3();
const scratch = vec3();
const celestial = new Matrix3();
const cloudLight = new Vector3();
const frustum = new Frustum();
const viewProjection = new Matrix4();
const sailBounds = new Sphere();
const cameraForward = new Vector3();
const scratchVector = new Vector3();

// Body-frame box swept by a rig's boom, mainsail and genoa: a column about the mast, as far out as
// the boom reaches (the genoa's clew stays inside it), up to the masthead.
function rigSwingBounds(rig: RigSpec): Box3 {
  const reach = rig.boomLength + 1.5;
  return new Box3(
    new Vector3(-reach, 0, rig.mastZ - reach),
    new Vector3(reach, rig.mastheadY + 1, rig.mastZ + reach),
  );
}
const boatLightState: Pick<BoatLightState, 'signals' | 'makingWay'> = { signals: {}, makingWay: false };
const cloudWeather: Parameters<CloudSystem['setWeather']>[0] = {
  type: 'cumulus',
  coverage: 0,
  base: 0,
  precipitation: 0,
};
const sunLight = new Color();
const moonLight = new Color();
const directLight = new Color();
const NO_SIGNALS: BoatLightState['signals'] = {};
// Joining boats of a new kind: frames drawn out of sight, and how far behind the camera.
const STAGE_FRAMES = 2;
const STAGE_DISTANCE = 100_000; // m

export interface WarmupView {
  ocean: boolean;
  effects: boolean;
  boats: number; // the first this many boats, in arrival order
}

export class SeaScene {
  readonly scene = new Scene();
  readonly sky: SkySystem;
  readonly exposure = new Exposure();
  readonly clouds: CloudSystem;
  readonly contrails: ContrailSystem; // the rare jet and its trail, above the clouds
  private light: SunMoonLight;
  private probe: EnvironmentProbe;
  private ocean: OceanSurface;
  private water: WaterOptics;
  private postSettings: PostSettings;
  private fx: FxSystem;
  private spray = new BoatSpray();
  private sprayHeadings: number[] = [];
  private pipeline: PostPipeline | null = null;
  private quality: QualityPreset;

  // The tier the scene was built at (graphics changes mid-voyage don't change it).
  get qualityTier(): QualityPreset {
    return this.quality;
  }
  private renderer: WebGPURenderer;
  private boats = new Map<string, Object3D>(); // BoatVisual.root or a placeholder box
  private boatVisuals = new Map<string, BoatVisual>();
  private boatLights = new Map<string, BoatLights>();
  // The helm boat's scene lights: one fixed set per session, lent to whichever boat has the helm.
  private lightPool: SceneLightPool;
  private poolHolder: BoatLights | null = null;
  // The fleet's few scene lights (one beam each for the nearest lit fleet boats), also fixed.
  private fleetLights: FleetLightPool;
  private fleetSources: FleetLightSource[] = [];
  // Boats joining mid-voyage whose kind hasn't been drawn yet: frames left drawing every LOD out of
  // sight before they appear (see stageBoat).
  private staged = new Map<string, number>();
  private drawnTemplates = new Set<BoatTemplate>();
  private wetness = 0;
  private sails = new Map<string, SailView>();
  private sailCloth: readonly [number, number] | undefined;
  private warmup = false;
  private warmupView: WarmupView | null = null;
  private parityMarkers: Mesh[] = [];
  private collisionOverlay: CollisionOverlay | null = null; // ?debug only, built on demand
  private collisionDebug = false;
  private spectrumVersion: number;
  private latitude: number;
  private longitude: number;
  private sunElevation = 0;
  private moonElevation = 0;
  private moonPhaseAngle = 0;
  private overcast = 0;
  private cloudReadout = new CloudReadout(); // the clouds' 4 Hz readbacks, eased
  // Lens droplets: water on the lens / bridge windows, spray from slams near the camera.
  private lensDrops = createLensDrops();
  private sprayHits: SprayHit[] = [];
  private lensSpray: LensSpray = { spume: 0, wash: 0, splashes: [] };
  private lastCamera = new Vector3();
  // Green water: the helm's deck reservoir last frame, and how much has come aboard lately.
  private deckWater = { boatId: '', level: 0, rise: 0 };
  private casters: ShadowCaster[] = []; // reused each frame (shadowCasters)
  // Where the ocean's SSR can hit: a box around each boat, measured once per root.
  private occluderBoxes = new WeakMap<Object3D, Box3>();
  private occluders: { root: Object3D; bounds: Box3 }[] = []; // reused each frame
  private disposed = false;

  constructor(renderer: WebGPURenderer, options: SeaSceneOptions) {
    this.renderer = renderer;
    installStorageRelease(renderer); // dispose() frees the systems' storage buffers through it
    this.latitude = options.latitudeDeg * DEG;
    this.longitude = options.longitudeDeg * DEG;

    this.scene.name = 'sea';
    this.scene.matrixWorldAutoUpdate = false; // updated once per frame in render()
    this.sky = new SkySystem(renderer, { quality: options.quality });
    this.sky.applyTo(this.scene);
    this.exposure.applyToneMapping(renderer);
    renderer.shadowMap.enabled = options.shadows.enabled;

    this.light = new SunMoonLight(this.scene, options.shadows);
    // Both pools are added right after the sun so the scene's light list (and its order) never changes.
    this.lightPool = new SceneLightPool(LIGHT_BUDGET[options.quality]);
    this.scene.add(this.lightPool.object);
    this.fleetLights = new FleetLightPool(FLEET_LIGHTS[options.quality]);
    this.scene.add(this.fleetLights.object);
    this.clouds = new CloudSystem(renderer, this.sky, { quality: options.quality, settings: options.clouds });
    this.contrails = new ContrailSystem(this.sky, options.seed);
    this.clouds.applyTo(this.scene, (direction, sky) => this.contrails.composite(direction, sky));
    this.clouds.attachLight(this.light.light);
    // Aerial perspective on surfaces, fading into the deck's grey murk under overcast.
    const air = this.clouds.overcastAir;
    this.sky.setOvercastAir(air.radiance, air.weight, air.murk);
    this.scene.fogNode = this.sky.createFogNode();
    this.probe = new EnvironmentProbe(renderer, this.sky, {
      background: (direction, exposure) => this.clouds.createEnvironmentBackground(direction, exposure),
    });
    this.probe.attach(this.scene);

    this.quality = options.quality;
    this.spectrumVersion = options.spectrum.version;
    this.ocean = new OceanSurface({
      cascades: gpuCascadesFromSpectrum(options.spectrum),
      repeatPeriod: T_REPEAT,
      quality: options.quality,
      wakes: sampledTextureLimit(renderer) >= OCEAN_WAKE_TEXTURE_LIMIT,
      clipmapRings: options.clipmapRings,
      glint: (position) => this.clouds.glintNode(position),
    });
    this.water = options.water ?? getRegion('north-atlantic').water;
    this.ocean.setWaterOptics(this.water);
    this.postSettings = options.post ?? { aa: options.quality === 'low' ? 'fxaa' : 'traa', bloom: true };
    this.scene.add(this.ocean.object);

    this.sailCloth = options.sailCloth;
    this.fx = new FxSystem({
      quality: options.quality,
      particleBudget: options.particleBudget,
      ocean: this.ocean.groups,
      seed: options.seed,
    });
    this.fx.lighting.setSeaTint(this.water.subsurfaceTint);
    this.scene.add(this.fx.group);
  }

  // Loads the Bright Star Catalogue; the sky shows a procedural field until it arrives.
  async loadStars(url: string): Promise<void> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Star catalogue: HTTP ${response.status}`);
    let bytes = await response.arrayBuffer();
    // Some servers send .gz with Content-Encoding: gzip, so the browser has already inflated it.
    const header = new Uint8Array(bytes, 0, 2);
    if (header[0] === 0x1f && header[1] === 0x8b) {
      const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = await new Response(inflated).arrayBuffer();
    }
    if (this.disposed) return; // the session ended while the catalogue downloaded
    const catalog = decodeStarCatalog(bytes);
    this.sky.setStars(catalog.data, celestial);
  }

  // Builds the post pipeline on first use (it needs the camera).
  private ensurePipeline(camera: PerspectiveCamera): PostPipeline {
    if (this.pipeline) return this.pipeline;
    const pipeline = new PostPipeline(this.renderer, this.scene, camera, this.exposure, {
      quality: this.quality,
      settings: this.postSettings,
    });
    this.ocean.setMotionVectors(pipeline.plan.motionVectors);
    this.ocean.setReflections(pipeline.plan.ssr !== null);
    pipeline.setReflectionSource(this.ocean.reflectionSource);
    this.pipeline = pipeline;
    return pipeline;
  }

  // Graphics settings → post pipeline (AA mode, bloom). Safe to call before the first render.
  applyPostSettings(settings: Partial<PostSettings>): PostPlan | null {
    this.postSettings = { ...this.postSettings, ...settings };
    const plan = this.pipeline?.apply(settings) ?? null;
    // A rebuilt graph can change the scene pass's outputs, so every boat kind needs drawing again
    // (the next warm-up redraws the boats on the water; a kind that rejoins later is staged).
    if (this.pipeline?.needsBuild) this.drawnTemplates.clear();
    if (plan) {
      this.ocean.setMotionVectors(plan.motionVectors);
      this.ocean.setReflections(plan.ssr !== null);
      this.pipeline?.setReflectionSource(this.ocean.reflectionSource);
    }
    return plan;
  }

  // Depth of field for the photo camera (focus distance in m, aperture 0..1); off by default.
  setDof(settings: Partial<DofSettings>): void {
    this.pipeline?.setDof(settings);
  }

  update(input: SceneFrame): void {
    // A non-finite step would poison state that integrates it for good (the GPU foam and the
    // exposure's adapted EV live in buffers no later frame rewrites): a frame that lasted no time.
    const frame = Number.isFinite(input.dt) ? input : { ...input, dt: 0 };
    this.updateCelestial(frame.clock);
    const { weather } = frame;
    // With volumetric clouds on, they replace the sky's overcast placeholder.
    const clouds = this.clouds;
    const w = cloudWeather; // copied by setWeather
    w.type = weather.clouds.type;
    w.coverage = weather.clouds.coverage;
    w.base = weather.clouds.base;
    w.morphFrom = weather.clouds.morphFrom;
    w.morph = weather.clouds.morph;
    w.precipitation = weather.precipitation;
    w.wind = weather.windVelocity;
    w.visibility = weather.visibility;
    clouds.setWeather(w);
    const cloudy = clouds.enabled;
    const readout = this.cloudReadout.update(
      { through: clouds.focusTransmittance, direct: clouds.focusDirect, air: clouds.airLight },
      frame.dt,
    );
    this.overcast = cloudy ? 1 - readout.through : weather.overcast;
    this.sky.setAtmosphere({ overcast: cloudy ? 0 : weather.overcast, hazeDensity: weather.hazeDensity });
    this.sky.setInscatterScale(readout.air);

    // Under a cloud (or a deck) the scene dims a little: the auto-exposure keeps part of the drop in
    // the light at the focus.
    const lightElevation = this.light.source === 'moon' ? this.moonElevation : this.sunElevation;
    const dimming = cloudy
      ? cloudDimmingEv({
          transmittance: readout.direct,
          overcast: clouds.overcast,
          sinElevation: Math.sin(lightElevation),
          weight: this.light.sourceWeight,
        })
      : 0;
    this.exposure.update(this.renderer, {
      dt: frame.dt,
      sunElevation: this.sunElevation,
      moonElevation: this.moonElevation,
      moonIlluminance: moonIlluminanceToa(this.moonPhaseAngle),
      overcast: this.overcast,
      dimming,
    });
    const preExposure = this.exposure.preExposure;
    this.sky.setPreExposure(preExposure);
    this.sky.update(this.renderer, frame.camera);
    // A closed overcast flattens the sun/moon to no directional light at all (clouds.overcast).
    // The cascades stretch over the boats' shadows (a container ship's run hundreds of metres).
    this.light.update(this.sky, preExposure, frame.focus, 1 - clouds.overcast, {
      camera: frame.camera,
      casters: this.shadowCasters(frame),
    });
    // After the light, whose colour and direction the clouds mirror.
    this.fx.lightning.cloudBase = weather.clouds.base;
    clouds.update(this.renderer, frame.camera, frame.dt, {
      time: frame.time,
      focus: frame.focus,
      shadowLight: cloudLight.subVectors(this.light.light.position, this.light.light.target.position),
      flash: this.fx.flash,
      groundIlluminance: this.light.illuminanceLux,
    });
    this.contrails.update(frame.time, frame.camera, weather);

    const seaWind = frame.seaWind ?? weather.windVelocity;
    this.ocean.setWind(seaWind);
    this.ocean.setRain(weather.precipitation);
    this.ocean.update(this.renderer, frame.camera, frame.time, frame.dt, frame.boats);
    this.updateBoats(frame.boats, frame, preExposure);

    const sun = this.sky.sunIlluminance(sunLight);
    const moon = this.sky.moonIlluminance(moonLight);
    this.updateUnderwater(frame, sun.r + moon.r, sun.g + moon.g, sun.b + moon.b);
    this.pipeline?.setSun(sunDirection, this.sunElevation > -0.01);
    this.updateLens(frame);
    // Clouds: spray and rain under the deck see the shadowed light, its directional part as the
    // scene light has it and the rest of what comes through the cloud as flat, sky-like light.
    const body = this.sunElevation > -0.01 ? sun : moon;
    const through = readout.through;
    const direct = Math.min(through, readout.direct * (1 - clouds.overcast));
    const light = directLight.copy(body).multiplyScalar(direct);
    const diffused = (through - direct) * preExposure;
    // The sky light under the clouds (spray, smoke and rain are lit by the dim, flat light of an
    // overcast rather than the clear sky's).
    const skyLight = preExposure * (cloudy ? readout.air : 1 - 0.7 * this.overcast);
    // Per-boat spray queues its spawns before the particle system consumes them.
    this.sprayHeadings.length = frame.boats.length;
    for (let i = 0; i < frame.boats.length; i++) {
      const o = frame.boats[i]!.orientation;
      bow.set(0, 0, -1).applyQuaternion(boatQuaternion.set(o.x, o.y, o.z, o.w));
      this.sprayHeadings[i] = vectorToHeading(bow.x, bow.z);
    }
    this.spray.update(
      this.fx.particles,
      frame.boats,
      this.sprayHeadings,
      {
        hs: frame.seaHs ?? 0,
        waveFrom: velocityToFromDirection(seaWind.x, seaWind.z),
        wind: weather.windVelocity,
      },
      frame.dt,
      this.fx.activeBudget,
      this.fx.emitScale(),
      this.fx.roosterSheets,
    );
    this.fx.update(this.renderer, frame.camera, frame.dt, {
      time: frame.time,
      wind: weather.windVelocity,
      seaWind,
      sunDirection: this.sunElevation > -0.01 ? sunDirection : moonDirection,
      sunColor: { r: light.r * preExposure, g: light.g * preExposure, b: light.b * preExposure },
      ambientColor: {
        r: (sun.r + moon.r) * skyLight * 0.12 + body.r * diffused,
        g: (sun.g + moon.g) * skyLight * 0.12 + body.g * diffused,
        b: (sun.b + moon.b) * skyLight * 0.14 + body.b * diffused,
      },
      rainIntensity: weather.precipitation,
      lightningRate: weather.lightningPerMinute,
      boats: frame.boats,
    });
  }

  private updateUnderwater(frame: SceneFrame, r: number, g: number, b: number): void {
    const pipeline = this.ensurePipeline(frame.camera);
    const surface = frame.cameraWaterHeight;
    if (surface === undefined) {
      pipeline.setUnderwater(null);
      return;
    }
    const depth = surface - frame.camera.position.y;
    const w = this.water;
    // Direct light plus roughly as much again from the sky, pre-exposed.
    const k = this.exposure.preExposure * 1.6;
    pipeline.setUnderwater({
      amount: Math.min(1, Math.max(0, (depth + 0.05) / 0.1)),
      depth,
      extinction: [
        w.absorption[0] + w.scattering[0],
        w.absorption[1] + w.scattering[1],
        w.absorption[2] + w.scattering[2],
      ],
      absorption: w.absorption,
      light: { r: r * k, g: g * k, b: b * k },
      scatterColor: w.deepColor,
    });
  }

  private updateLens(frame: SceneFrame): void {
    const pipeline = this.pipeline;
    const camera = frame.camera;
    this.lastCamera.copy(camera.position);
    if (!pipeline?.plan.droplets) {
      this.sprayHits.length = 0;
      pipeline?.setLens(null, { mode: 'none', windowDistance: 0 });
      return;
    }
    const helm = frame.boats.find((boat) => boat.id === frame.lights?.helmId) ?? frame.boats[0];
    const view = lensViewFor(frame.cameraMode ?? 'chase', helm?.kind);
    // Rain flies at the glass along wind + fall − the camera's (boat's) own motion.
    const { windVelocity: wind, precipitation } = frame.weather;
    const v = helm?.velocity ?? { x: 0, y: 0, z: 0 };
    const drop = scratchVector
      .set(wind.x - v.x, -rainFallSpeed(precipitation) - v.y, wind.z - v.z)
      .normalize();
    camera.getWorldDirection(cameraForward);
    const facing = -cameraForward.dot(drop);
    // World down on the glass in screen units (x right, y down), from the camera's right and up.
    const m = camera.matrixWorld.elements;
    const surface = frame.cameraWaterHeight;
    const height = surface === undefined ? 10 : camera.position.y - surface;
    let toBow = Infinity;
    let green = 0;
    if (helm) {
      // Bow spray over a camera at the bow, and green water coming aboard near one on deck.
      const length = BOAT_LENGTH[helm.kind];
      const p = helm.position;
      const o = helm.orientation;
      bow.set(0, 0, -1).applyQuaternion(boatQuaternion.set(o.x, o.y, o.z, o.w));
      toBow = scratchVector
        .set(p.x, p.y, p.z)
        .addScaledVector(bow, length / 2)
        .distanceTo(camera.position);
      const deck = this.deckWater;
      const level = helm.telemetry['deckWater'] ?? 0;
      if (deck.boatId !== helm.id) {
        deck.boatId = helm.id;
        deck.level = level;
        deck.rise = 0;
      }
      deck.rise = deck.rise * Math.exp(-frame.dt / 0.3) + Math.max(0, level - deck.level);
      deck.level = level;
      const toBoat = scratchVector.set(p.x, p.y, p.z).distanceTo(camera.position);
      green = greenWaterSplash(deck.rise, toBoat, length, height);
      if (green > 0) deck.rise = 0;
    }
    const spray = lensSpray(
      {
        mode: view.mode,
        heightAboveWater: height,
        windSpeed: Math.hypot(wind.x, wind.z),
        slams: this.sprayHits,
        bowSpray: helm ? this.spray.bowSpray(helm.id) : 0,
        distanceToBow: toBow,
        greenWater: green,
      },
      this.lensSpray,
    );
    this.sprayHits.length = 0;
    stepLensDrops(this.lensDrops, {
      dt: frame.dt,
      mode: view.mode,
      aspect: camera.aspect,
      rain: precipitation,
      exposure: rainExposure(view.mode, facing),
      gravity: { x: -m[1]!, y: m[5]! },
      spume: spray.spume,
      wash: spray.wash,
      splashes: spray.splashes,
      underwater: view.mode === 'lens' && height < -0.02,
    });
    pipeline.setLens(this.lensDrops, view);
  }

  setWakeGrids(grids: readonly WakeGrid[]): void {
    this.ocean.setWakeGrids(grids);
  }

  // A newer ocean spectrum from the simulation (a weather change): the GPU blends to it over the
  // message's transition, in simulation time, exactly as the physics ocean does.
  setSpectrum(spectrum: SpectrumMessage): void {
    if (spectrum.version <= this.spectrumVersion) return;
    this.spectrumVersion = spectrum.version;
    this.ocean.setSpectrum(
      gpuCascadesFromSpectrum(spectrum),
      spectrum.activationTime,
      spectrum.transitionDuration,
    );
  }

  render(camera: PerspectiveCamera, time: number): void {
    // World matrices once per frame: three would otherwise update the whole scene graph again for
    // the main pass and for every shadow pass (each sun cascade and shadowed deck light).
    this.scene.updateMatrixWorld();
    // Boats' water-exclusion volumes first: the ocean skips cockpits and deck wells.
    this.ocean.renderWaterMask(this.renderer, camera, this.boatVisuals.values());
    const pipeline = this.ensurePipeline(camera);
    if (pipeline.plan.ssr) this.updateReflectionOccluders(camera);
    pipeline.render();
    // The shadow cascades bind to the first camera rendered, so the probe's cube camera goes after.
    this.probe.update(this.renderer, time, this.exposure.preExposure);
  }

  // The boats (all the opaque geometry there is) for the ocean's SSR trace; the debug overlays,
  // which are not under a boat, turn the culling off.
  private updateReflectionOccluders(camera: PerspectiveCamera): void {
    let n = 0;
    for (const [id, root] of this.boats) {
      let bounds = this.occluderBoxes.get(root);
      if (!bounds) {
        bounds = occluderBounds(root);
        // The cloth and boom swing about the mast, far out of the box they were measured in.
        if (this.sails.has(id)) bounds.union(rigSwingBounds(CC115_RIG));
        this.occluderBoxes.set(root, bounds);
      }
      const slot = (this.occluders[n++] ??= { root, bounds });
      slot.root = root;
      slot.bounds = bounds;
    }
    this.occluders.length = n;
    const debug = this.collisionOverlay !== null || this.parityMarkers.length > 0;
    this.ocean.updateReflectionOccluders(camera, this.occluders, debug);
  }

  // Warm-up (behind the loading screen): every boat draws all its LODs, unculled, so the frames
  // rendered meanwhile compile every pipeline a voyage can need (main and shadow passes). The sun
  // and the pooled deck lights render their shadow maps even if dark, and the rain and the lightning
  // bolt are drawn (empty), so moonrise, the first shower and the first strike compile nothing.
  setWarmup(on: boolean): void {
    this.warmup = on;
    for (const visual of this.boatVisuals.values()) {
      visual.setWarmup(on);
      if (on) this.drawnTemplates.add(visual.template);
    }
    for (const [id, lights] of this.boatLights) lights.setWarmup(on || this.staged.has(id));
    this.light.setWarmup(on);
    this.lightPool.setWarmup(on);
    this.fx.setWarmup(on);
    if (!on) this.setWarmupView(null);
  }

  // What the warm-up frames draw, so their pipelines build a part at a time (app/warmup.ts): the
  // ocean, the particles and weather effects, and the first `boats` boats in arrival order. null
  // draws everything. Lights never change (that would rebuild every lit pipeline).
  setWarmupView(view: WarmupView | null): void {
    this.warmupView = view;
    this.applyWarmupView();
  }

  private applyWarmupView(): void {
    const view = this.warmupView;
    this.ocean.object.visible = view?.ocean ?? true;
    this.fx.group.visible = view?.effects ?? true;
    let index = 0;
    for (const root of this.boats.values()) root.visible = view ? index++ < view.boats : true;
  }

  // Boats on the water (a boat whose model is still building joins a few frames later).
  get boatCount(): number {
    return this.boats.size;
  }

  private updateCelestial(clock: SimClock): void {
    const jd = clock.julianDay;
    const sun = solarPosition(jd, this.latitude, this.longitude);
    horizontalToDirection(sun.azimuth, sun.elevation, scratch);
    sunDirection.set(scratch.x, scratch.y, scratch.z);
    this.sunElevation = sun.elevation;
    this.sky.setSun(sunDirection);

    const moon = moonPosition(jd, this.latitude, this.longitude);
    horizontalToDirection(moon.azimuth, moon.elevation, scratch);
    moonDirection.set(scratch.x, scratch.y, scratch.z);
    this.moonElevation = moon.elevation;
    const illumination = moonIllumination(jd);
    this.moonPhaseAngle = illumination.phaseAngle;
    this.sky.setMoon(moonDirection, illumination.fraction, illumination.phaseAngle);

    celestial.fromArray(starFieldToWorldMatrix(jd, this.latitude, this.longitude));
    this.sky.setCelestialRotation(celestial);
  }

  // Simulation events with a visual side: slams throw spray off the hull (and over the deck, which
  // the wipers notice); a collision throws it up between the two hulls; a capsize throws the jet ski's
  // rider overboard, and a recovery seats him again.
  handleEvents(events: readonly SimEvent[], boats: readonly BoatSnapshot[]): void {
    for (const event of events) {
      if (event.type === 'capsized' || event.type === 'sunk' || event.type === 'recovered') {
        this.boatVisuals.get(event.boatId)?.simEvent(event.type);
        continue;
      }
      if (event.type === 'collision') {
        const a = boats.find((b) => b.id === event.boatId);
        const b = boats.find((boat) => boat.id === event.otherId);
        if (!a || !b) continue;
        // Thrown along the lighter (shorter) boat, which moves most.
        const small = BOAT_LENGTH[a.kind] <= BOAT_LENGTH[b.kind] ? a : b;
        this.fx.slam(
          { x: event.x, y: event.y, z: event.z, strength: Math.min(10, 1.5 * event.speed) },
          small.velocity,
          {
            hullLength: Math.min(BOAT_LENGTH[a.kind], BOAT_LENGTH[b.kind]),
          },
        );
        continue;
      }
      if (event.type !== 'slam') continue;
      const distance = Math.hypot(
        event.x - this.lastCamera.x,
        event.y - this.lastCamera.y,
        event.z - this.lastCamera.z,
      );
      if (this.sprayHits.length < 16) this.sprayHits.push({ distance, strength: event.strength });
      const boat = boats.find((b) => b.id === event.boatId);
      if (!boat) continue;
      this.spray.slam(event.boatId, event.strength);
      bow
        .set(0, 0, -1)
        .applyQuaternion(
          boatQuaternion.set(boat.orientation.x, boat.orientation.y, boat.orientation.z, boat.orientation.w),
        );
      this.fx.slam(event, boat.velocity, {
        heading: bow,
        hullLength: BOAT_LENGTH[boat.kind],
        spray: hullSprayScale(BOAT_SPECS[boat.kind].dimensions.lwl),
        sides: slamSides(boat, event),
      });
    }
  }

  onThunder(listener: Parameters<FxSystem['onThunder']>[0]): () => void {
    return this.fx.onThunder(listener);
  }

  // The boats as shadow casters (camera/boatCameraInfo sizes); the helm boat (or, without one, the
  // boat nearest the focus) is always fitted.
  private shadowCasters(frame: SceneFrame): readonly ShadowCaster[] {
    const casters = this.casters;
    casters.length = frame.boats.length;
    let helm = frame.lights?.helmId ?? null;
    if (helm === null) {
      let best = Infinity;
      for (const boat of frame.boats) {
        const d = Math.hypot(boat.position.x - frame.focus.x, boat.position.z - frame.focus.z);
        if (d < best) [best, helm] = [d, boat.id];
      }
    }
    frame.boats.forEach((boat, i) => {
      const info = BOAT_CAMERA_INFO[boat.kind];
      const caster = (casters[i] ??= { x: 0, y: 0, z: 0, radius: 0, height: 0 });
      caster.x = boat.position.x;
      caster.y = boat.position.y;
      caster.z = boat.position.z;
      caster.radius = Math.hypot(info.length, info.beam) / 2;
      caster.height = info.height;
      caster.helm = boat.id === helm;
    });
    return casters;
  }

  private updateBoats(boats: readonly BoatSnapshot[], frame: SceneFrame, preExposure: number): void {
    const helmId = frame.lights?.helmId ?? null;
    const state = frame.lights?.state ?? {};
    frustum.setFromProjectionMatrix(
      viewProjection.multiplyMatrices(frame.camera.projectionMatrix, frame.camera.matrixWorldInverse),
    );
    // The pooled scene lights follow the helm (bound once its lights exist).
    const holder = (helmId ? this.boatLights.get(helmId) : undefined) ?? null;
    if (holder !== this.poolHolder) {
      this.poolHolder?.bindPool(null);
      if (holder) holder.bindPool(this.lightPool);
      else this.lightPool.idle();
      this.poolHolder = holder;
    }
    for (const boat of boats) {
      let root = this.boats.get(boat.id);
      if (!root) {
        // A boat whose model isn't built yet (one joining mid-voyage) appears once it is, rather
        // than building it inside this frame.
        const variant = variantFromTelemetry(boat.kind, boat.telemetry);
        if (hasProceduralModel(boat.kind) && !hasBoatTemplate(boat.kind, variant)) {
          void loadBoatTemplate(boat.kind, variant);
          continue;
        }
        const visual = createBoatVisual(boat.kind, variant);
        root = visual instanceof BoatVisual ? visual.root : visual;
        if (visual instanceof BoatVisual) {
          this.boatVisuals.set(boat.id, visual);
          visual.setWarmup(this.warmup);
          if (this.warmup) this.drawnTemplates.add(visual.template);
        }
        this.boats.set(boat.id, root);
        this.scene.add(root);
        // The sailboat's cloth sails; its procedural model draws the spars and rigging.
        if (boat.kind === 'sail') {
          const showRig = !(visual instanceof BoatVisual);
          this.sails.set(
            boat.id,
            new SailView({ parent: root, quality: this.sailCloth ?? this.quality, showRig }),
          );
        }
        if (visual instanceof BoatVisual && !this.warmup && !this.drawnTemplates.has(visual.template)) {
          this.stageBoat(boat.id, visual);
        }
      }
      // The snapshot position is the body origin (centreline, design waterline), as the models are built.
      root.position.set(boat.position.x, boat.position.y, boat.position.z);
      root.quaternion.set(boat.orientation.x, boat.orientation.y, boat.orientation.z, boat.orientation.w);
      this.updateStaged(boat.id, root, frame.camera);
      const lights = this.lightsFor(boat, root);
      const v = boat.velocity;
      lights.setState(state);
      boatLightState.signals = frame.lights?.signals?.(boat) ?? NO_SIGNALS;
      boatLightState.makingWay = Math.hypot(v.x, v.z) > 0.15;
      lights.setState(boatLightState);
      lights.update(frame.camera, frame.dt, preExposure, this.sunElevation, {
        hazeDensity: frame.weather.hazeDensity,
        visibility: frame.weather.visibility,
      });
      // Telemetry drives the animated parts (rudders, wheels, outboards, nozzles, booms). Wipers run in
      // rain or heavy spray (on the boats that have them).
      const visual = this.boatVisuals.get(boat.id);
      if (visual) {
        visual.wipersOn = wipersWanted(
          visual.wipersOn,
          frame.weather.precipitation,
          this.spray.sprayLevel(boat.id),
        );
      }
      visual?.update(frame.dt, frame.camera, this.renderer.domElement.height, boat.telemetry);
      const sail = this.sails.get(boat.id);
      if (sail) {
        const visible = frustum.intersectsSphere(sailBounds.set(root.position, 25));
        const budget = this.warmup
          ? FULL_CLOTH
          : clothBudget({ helm: boat.id === helmId, visible, lod: visual?.lod ?? 0 });
        sail.update(frame.dt, boat.telemetry, root.quaternion, frame.time, budget);
      }
    }
    // Boats that left the fleet.
    for (const id of this.boats.keys()) {
      if (!boats.some((boat) => boat.id === id)) this.removeBoat(id);
    }
    this.collisionOverlay?.update(boats);
    this.lightPool.follow(helmId ? this.boats.get(helmId) : undefined);
    if (this.warmup) this.lightPool.applyWarmup();
    this.updateFleetLights(boats, helmId, frame, preExposure);
    if (this.warmupView) this.applyWarmupView();
    // Model lamp lenses and windows follow the helm boat's (resolved) switches.
    const helm = helmId ? this.boatLights.get(helmId) : undefined;
    const night = nightFactor(this.sunElevation);
    const cabin = state.cabin;
    setBoatEnvironment({
      preExposure,
      night,
      deck: helm ? (helm.deckLightsOn ? 1 : 0) : night,
      interior: typeof cabin === 'number' ? cabin : cabin === false ? 0.15 : 1,
      wetness: this.updateWetness(frame, helmId),
    });
  }

  // Fleet boats (not the helm, nor one staged out of sight) bid for the fleet's scene lights.
  private updateFleetLights(
    boats: readonly BoatSnapshot[],
    helmId: string | null,
    frame: SceneFrame,
    preExposure: number,
  ): void {
    const sources = this.fleetSources;
    sources.length = 0;
    for (const boat of boats) {
      if (boat.id === helmId || this.staged.has(boat.id)) continue;
      const root = this.boats.get(boat.id);
      const lights = this.boatLights.get(boat.id);
      if (!root || !lights) continue;
      const beam = lights.litFleetBeam;
      sources.push({ id: boat.id, root, beam, on: beam !== null });
    }
    this.fleetLights.update(sources, frame.camera, preExposure, frame.dt);
  }

  // Rain and the spray over the helm boat wet every boat's decks (Low quality: always dry).
  private updateWetness(frame: SceneFrame, helmId: string | null): number {
    if (this.quality === 'low') return 0;
    const spray = helmId ? this.spray.sprayLevel(helmId) : 0;
    const target = wetnessTarget(frame.weather.precipitation, spray);
    // A voyage that starts in the rain starts wet.
    this.wetness = this.warmup ? target : stepWetness(this.wetness, target, Math.min(frame.dt, 0.25));
    return this.wetness;
  }

  // A boat of a kind not drawn yet this session, joining mid-voyage: for a couple of frames it draws
  // every LOD, unculled, far behind the camera (clipped, and beyond every shadow frustum), so its
  // pipelines (all LODs, main and shadow passes, lamps) are built while it is out of sight, in one
  // go rather than again at each later LOD switch.
  private stageBoat(id: string, visual: BoatVisual): void {
    visual.setWarmup(true);
    this.boatLights.get(id)?.setWarmup(true); // (built on its first update, staged already)
    this.staged.set(id, STAGE_FRAMES);
  }

  private updateStaged(id: string, root: Object3D, camera: PerspectiveCamera): void {
    const frames = this.staged.get(id);
    if (frames === undefined) return;
    const visual = this.boatVisuals.get(id);
    if (frames > 0 && visual) {
      this.staged.set(id, frames - 1);
      camera.getWorldDirection(scratchVector);
      root.position.copy(camera.position).addScaledVector(scratchVector, -STAGE_DISTANCE);
      return;
    }
    this.staged.delete(id);
    if (!this.warmup) this.boatLights.get(id)?.setWarmup(false);
    if (!visual) return;
    visual.setWarmup(false);
    this.drawnTemplates.add(visual.template);
  }

  // One light set per boat, built once: lamps and glows only. The helm boat also borrows the
  // session's pooled scene lights (bindPool), so a helm switch never changes the scene's lights.
  private lightsFor(boat: BoatSnapshot, root: Object3D): BoatLights {
    const existing = this.boatLights.get(boat.id);
    if (existing) return existing;
    const visual = this.boatVisuals.get(boat.id);
    const fromModel = visual ? mountsFromMarkers(boat.kind, markersFromModel(visual.lights)) : undefined;
    const lights = new BoatLights(root, {
      kind: boat.kind,
      quality: this.quality,
      local: false,
      mounts: fromModel?.mounts,
      deckMounts: fromModel?.deckMounts,
      replaceFloods: fromModel?.replaceFloods,
    });
    lights.setWarmup(this.warmup || this.staged.has(boat.id));
    this.boatLights.set(boat.id, lights);
    return lights;
  }

  // Disposes a boat's model, sails and lights (its wake grid is freed by the simulation's clear).
  private removeBoat(id: string): void {
    const lights = this.boatLights.get(id);
    if (lights && lights === this.poolHolder) {
      lights.bindPool(null);
      this.lightPool.idle();
      this.poolHolder = null;
    }
    lights?.dispose();
    this.boatLights.delete(id);
    this.staged.delete(id);
    this.sails.get(id)?.dispose();
    this.sails.delete(id);
    const visual = this.boatVisuals.get(id);
    const root = this.boats.get(id);
    if (visual) {
      visual.dispose(); // geometry and materials belong to the shared per-kind template
    } else if (root) {
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        (object.material as MeshStandardNodeMaterial).dispose();
      });
    }
    root?.removeFromParent();
    this.boatVisuals.delete(id);
    this.boats.delete(id);
  }

  // Debug: wireframes of the boats' collision prisms (loaded and built on first use, freed when off).
  async setCollisionDebug(on: boolean): Promise<void> {
    this.collisionDebug = on;
    if (!on) {
      this.collisionOverlay?.dispose();
      this.collisionOverlay = null;
      return;
    }
    if (this.collisionOverlay) return;
    const { CollisionOverlay } = await import('./boats/collisionOverlay');
    if (!this.collisionDebug || this.collisionOverlay) return;
    this.collisionOverlay = new CollisionOverlay();
    this.scene.add(this.collisionOverlay.group);
  }

  // Small markers at CPU-sampled water heights; they should sit exactly on the GPU surface.
  showParity(points: readonly { x: number; y: number; z: number }[]): void {
    while (this.parityMarkers.length < points.length) {
      const marker = new Mesh(
        new SphereGeometry(0.25, 12, 8),
        new MeshStandardNodeMaterial({ color: 0xff3b30, emissive: 0x551010, roughness: 0.4 }),
      );
      this.parityMarkers.push(marker);
      this.scene.add(marker);
    }
    points.forEach((point, i) => this.parityMarkers[i]?.position.set(point.x, point.y, point.z));
  }

  // Gives back everything the session built on the GPU (render/gpuResources.ts): every system's
  // textures, render targets, kernels and storage buffers, and the render objects (bind groups,
  // pipelines, cached node graphs) of everything in the scene.
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Collected first: the systems below take their objects out of the scene.
    const objects: Object3D[] = [];
    this.scene.traverse((object) => void objects.push(object));
    for (const id of this.boats.keys()) this.removeBoat(id); // deleting while iterating is safe
    this.occluders.length = 0;
    this.drawnTemplates.clear();
    for (const marker of this.parityMarkers) {
      marker.geometry.dispose();
      (marker.material as MeshStandardNodeMaterial).dispose();
    }
    this.parityMarkers = [];
    this.collisionOverlay?.dispose();
    this.collisionOverlay = null;
    this.lightPool.dispose();
    this.fleetLights.dispose();
    this.pipeline?.dispose();
    this.pipeline = null;
    this.fx.dispose();
    this.ocean.dispose();
    this.probe.dispose();
    this.clouds.dispose();
    this.light.dispose();
    this.sky.dispose();
    this.exposure.dispose();
    for (const object of objects) object.dispose();
    releaseSceneObjects(this.scene); // what is left, and the sky's background mesh
  }
}
