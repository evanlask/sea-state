// SkySystem: the physically based sky (Hillaire 2020 LUTs), sun/moon/stars, and the CPU-side
// illuminance that drives the scene's directional light. All GPU outputs are pre-exposed: multiply
// physical luminance by `preExposure` (set each frame from Exposure) so HDR values stay in fp16 range.
//
// Per frame: setSun/setMoon (from sim/astro), setPreExposure, then update(renderer, camera) before
// rendering. The transmittance and multi-scattering LUTs rebuild only when the atmosphere changes;
// the sky-view LUT when the sun, moon or camera height move; the aerial-perspective froxels every
// frame (they follow the camera).

import {
  Color,
  Matrix3,
  type Node,
  type PerspectiveCamera,
  type Scene,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../../app/Scenario';
import { type N, tsl } from '../tsl';
import { type MutableRgb, moonIlluminanceAt, sunIlluminanceAt, transmittanceToTop } from './atmosphereCpu';
import { AtmosphereLuts, AtmosphereUniforms, LUT_QUALITY, PLANET_RADIUS } from './AtmosphereLuts';
import {
  type AtmosphereConditions,
  type AtmosphereParams,
  atmosphereWithHaze,
  DEFAULT_CONDITIONS,
  EARTH_ATMOSPHERE,
  lommelSeeligerPhase,
  MOON_ANGULAR_RADIUS,
  MOON_TINT,
  moonIlluminanceToa,
  solidAngle,
  SUN_ILLUMINANCE_TOA,
} from './atmosphereParams';
import { type AerialPerspectiveNodes, SkyShading } from './skyNodes';
import { buildStarGrid, DEFAULT_STAR_GRID, equatorialToWorld, generateProceduralStars } from './stars';

const { normalize, output, positionLocal, positionWorld, uniform, vec4 } = tsl;

export interface SkySystemOptions {
  quality?: QualityPreset;
}

export interface SkyNodeOptions {
  sun?: boolean; // default true
  moon?: boolean; // default true
  moonMask?: boolean; // hide the stars behind the moon even without its disk (default false)
  stars?: boolean; // default true
  exposure?: Node; // default: the system's preExposure uniform
}

// Mean albedo of the procedural maria pattern, used to normalise the disk to the phase law.
const MOON_MEAN_ALBEDO = 0.86;
// Earthshine on the dark limb near new moon, relative to the full-moon disk (≈ −3 mag vs −12.7).
const EARTHSHINE_RATIO = 1.3e-4;
const SKY_VIEW_ANGLE_EPSILON = 0.01 * (Math.PI / 180);
const DEG = Math.PI / 180;

const elevationOf = (direction: Vector3): number => Math.asin(Math.max(-1, Math.min(1, direction.y)));

export class SkySystem {
  readonly backgroundNode: Node;
  // Pre-exposure multiplier (see Exposure); every pre-exposed node reads it.
  readonly preExposure: N = uniform(1);
  private uniforms = new AtmosphereUniforms();
  private luts: AtmosphereLuts;
  private shading: SkyShading;
  private sun = new Vector3(0, 1, 0);
  private moon = new Vector3(0, -1, 0);
  private moonPhase = Math.PI;
  private moonFraction = 0;
  private conditions: AtmosphereConditions = { ...DEFAULT_CONDITIONS };
  private params: AtmosphereParams = EARTH_ATMOSPHERE;
  private atmosphereDirty = true;
  private skyViewDirty = true;
  private skyViewSun = new Vector3();
  private skyViewMoon = new Vector3();
  private skyViewRadius = 0;
  private sunLux: MutableRgb = [0, 0, 0];
  private moonLux: MutableRgb = [0, 0, 0];
  private version = 0;
  private cameraAltitude = 0.002; // km

  constructor(renderer: WebGPURenderer, options: SkySystemOptions = {}) {
    const quality = LUT_QUALITY[options.quality ?? 'high'];
    this.luts = new AtmosphereLuts(this.uniforms, quality);
    this.shading = new SkyShading(this.luts, this.uniforms);
    this.backgroundNode = this.createSkyNode(normalize(positionLocal));
    // Procedural stars until SeaScene loads the Bright Star Catalogue and sets the sidereal rotation.
    // fromArray() reads column-major; equatorialToWorld() is row-major, hence the transpose.
    const rotation = new Matrix3().fromArray(equatorialToWorld(35 * DEG, 0)).transpose();
    this.setStars(generateProceduralStars(6000, 1), rotation);
    this.applyConditions();
    this.luts.updateAtmosphere(renderer);
    this.atmosphereDirty = false;
  }

  // Sets scene.backgroundNode (not in three's Scene typings).
  applyTo(scene: Scene): void {
    (scene as Scene & { backgroundNode: Node | null }).backgroundNode = this.backgroundNode;
  }

  get sunDirection(): Readonly<Vector3> {
    return this.sun;
  }

  get moonDirection(): Readonly<Vector3> {
    return this.moon;
  }

  get sunElevation(): number {
    return elevationOf(this.sun);
  }

  get moonElevation(): number {
    return elevationOf(this.moon);
  }

  get moonIlluminatedFraction(): number {
    return this.moonFraction;
  }

  get overcast(): number {
    return this.conditions.overcast;
  }

  // The atmosphere LUTs and their uniforms, for systems that light by the same atmosphere (clouds).
  get atmosphere(): { luts: AtmosphereLuts; uniforms: AtmosphereUniforms } {
    return { luts: this.luts, uniforms: this.uniforms };
  }

  // Scales the aerial-perspective inscatter of surfaces (fog node): volumetric clouds dim it under
  // an overcast deck, where the haze between the camera and the sea is in shadow.
  setInscatterScale(scale: number): void {
    this.shading.inscatterScale.value = Math.max(0, scale);
  }

  // The air under a cloud deck for the aerial perspective of surfaces: its radiance (physical cd/m²)
  // and the share of the haze it lights instead of the sun and clear sky (CloudSystem.overcastAir).
  // Under overcast the far sea and boats then fade into grey murk rather than clear-sky haze, and
  // the murk under the deck (extinction `murk`, 1/km) thickens with distance. Call before
  // createFogNode / aerialPerspective: the nodes are built into those.
  setOvercastAir(radiance: Node, weight: Node, murk: Node): void {
    this.shading.overcastAir = radiance as N;
    this.shading.overcastWeight = weight as N;
    this.shading.murk = murk as N;
  }

  // Bumps whenever the sky's appearance changes other than by sun/moon motion (probe refreshes).
  get contentVersion(): number {
    return this.version;
  }

  // Unit vector toward the sun, world frame (+Y up, −Z north).
  setSun(direction: Vector3): void {
    this.sun.copy(direction).normalize();
    this.uniforms.sunDirection.value.copy(this.sun);
    this.updateIlluminance();
  }

  // Unit vector toward the moon, its illuminated fraction (0..1) and phase angle (rad, 0 = full).
  setMoon(direction: Vector3, illuminatedFraction: number, phaseAngle: number): void {
    this.moon.copy(direction).normalize();
    this.moonFraction = Math.min(1, Math.max(0, illuminatedFraction));
    this.moonPhase = Math.min(Math.PI, Math.max(0, phaseAngle));
    this.uniforms.moonDirection.value.copy(this.moon);
    const s = this.shading;
    s.moonPhaseAngle.value = this.moonPhase;
    const toa = moonIlluminanceToa(this.moonPhase);
    const omega = solidAngle(MOON_ANGULAR_RADIUS);
    s.moonRadianceScale.value =
      toa / (omega * 0.5 * Math.max(lommelSeeligerPhase(this.moonPhase), 1e-4) * MOON_MEAN_ALBEDO);
    const fullDisk = moonIlluminanceToa(0) / omega;
    s.earthshine.value = fullDisk * EARTHSHINE_RATIO * 0.5 * (1 - Math.cos(this.moonPhase));
    const tintLuma = 0.2126 * MOON_TINT[0] + 0.7152 * MOON_TINT[1] + 0.0722 * MOON_TINT[2];
    this.uniforms.moonIlluminance.value
      .set(MOON_TINT[0], MOON_TINT[1], MOON_TINT[2])
      .multiplyScalar(toa / tintLuma);
    this.updateIlluminance();
  }

  // Star records [RA, Dec, Vmag, B−V] (see stars.ts) and the equatorial → world rotation.
  setStars(records: Float32Array, celestialToWorld: Matrix3): void {
    const { gridSize, maxEntries } = this.shading.starGridOptions;
    this.shading.setStarGrid(buildStarGrid(records, { ...DEFAULT_STAR_GRID, gridSize, maxEntries }));
    this.setCelestialRotation(celestialToWorld);
  }

  // Equatorial → world rotation (sidereal time and latitude); call as time passes.
  setCelestialRotation(celestialToWorld: Matrix3): void {
    this.shading.worldToCelestial.value.copy(celestialToWorld).transpose();
  }

  setAtmosphere(conditions: Partial<AtmosphereConditions>): void {
    // Called every frame: nothing is built unless a value changed.
    const current = this.conditions;
    const haze = Math.min(20, Math.max(0, conditions.hazeDensity ?? current.hazeDensity));
    const overcast = Math.min(1, Math.max(0, conditions.overcast ?? current.overcast));
    if (haze === current.hazeDensity && overcast === current.overcast) return;
    const next = { ...current, ...conditions };
    next.hazeDensity = haze;
    next.overcast = overcast;
    if (next.hazeDensity !== this.conditions.hazeDensity) this.atmosphereDirty = true;
    this.conditions = next;
    this.applyConditions();
    this.version++;
  }

  // Multiplier applied to all pre-exposed sky output; Exposure.preExposure each frame.
  setPreExposure(value: number): void {
    this.preExposure.value = value;
  }

  // Sea-level direct sun illuminance in lux, linear RGB (after the atmosphere and overcast).
  sunIlluminance(out: Color = new Color()): Color {
    return out.setRGB(this.sunLux[0], this.sunLux[1], this.sunLux[2]);
  }

  // Direct sun illuminance (lux, linear RGB) high in the air, at `altitude` km for the sun's cosine of
  // zenith there: aircraft at cruise height stay sunlit for a while after sunset at sea level.
  sunIlluminanceAloft(altitude: number, cosZenith: number, out: MutableRgb = [0, 0, 0]): MutableRgb {
    transmittanceToTop(this.params, altitude, cosZenith, out);
    const scale = SUN_ILLUMINANCE_TOA * (1 - this.conditions.overcast) ** 2;
    out[0] *= scale;
    out[1] *= scale;
    out[2] *= scale;
    return out;
  }

  // Sea-level direct moon illuminance in lux, linear RGB.
  moonIlluminance(out: Color = new Color()): Color {
    return out.setRGB(this.moonLux[0], this.moonLux[1], this.moonLux[2]);
  }

  // A sky radiance node along an arbitrary direction (e.g. for reflections or the env probe).
  createSkyNode(direction: Node, options: SkyNodeOptions = {}): Node {
    return this.shading.radiance(direction, {
      sun: options.sun ?? true,
      moon: options.moon ?? true,
      moonMask: options.moonMask ?? false,
      stars: options.stars ?? true,
      exposure: options.exposure ?? this.preExposure,
    }) as Node;
  }

  // The sun and moon disks alone along a direction (pre-exposed), to composite behind clouds with
  // their own occlusion; pair with createSkyNode({ sun: false, moon: false, moonMask: true }).
  createDiskNode(direction: Node, exposure: Node = this.preExposure as Node): Node {
    return this.shading.diskRadiance(direction, exposure) as Node;
  }

  // Sun + moon illuminance per steradian of a Gaussian lobe of width sigma (rad) around each, for
  // the aureole of thin cloud in front of them (pre-exposed).
  createAureoleNode(direction: Node, sigma: number, exposure: Node = this.preExposure as Node): Node {
    return this.shading.aureole(direction, exposure, sigma) as Node;
  }

  // Aerial perspective toward a world position (metres): surface × transmittance + inscatter.
  // Uses the main camera's froxel volume, so it is exact for that camera only.
  aerialPerspective(worldPosition: Node): { transmittance: Node; inscatter: Node } {
    const nodes: AerialPerspectiveNodes = this.shading.aerialPerspective(
      worldPosition,
      this.preExposure,
      this.luts.quality.aerialDistancePerSlice,
    );
    return { transmittance: nodes.transmittance as Node, inscatter: nodes.inscatter as Node };
  }

  applyAerialPerspective(color: Node, worldPosition: Node): Node {
    const { transmittance, inscatter } = this.shading.aerialPerspective(
      worldPosition,
      this.preExposure,
      this.luts.quality.aerialDistancePerSlice,
    );
    return (color as N).mul(transmittance).add(inscatter) as Node;
  }

  // Aerial perspective for every fog-enabled material: assign to scene.fogNode. (three applies the
  // fog node to the lit output, which is exactly where aerial perspective belongs.)
  createFogNode(): Node {
    const { transmittance, inscatter } = this.shading.aerialPerspective(
      positionWorld,
      this.preExposure,
      this.luts.quality.aerialDistancePerSlice,
    );
    return vec4(output.rgb.mul(transmittance).add(inscatter), output.a) as Node;
  }

  update(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    const altitudeKm = Math.max(e[13] ?? 0, 0.5) / 1000;
    this.cameraAltitude = altitudeKm;
    const radius = PLANET_RADIUS + altitudeKm;
    this.uniforms.viewRadius.value = radius;

    if (this.atmosphereDirty) {
      this.applyConditions();
      this.luts.updateAtmosphere(renderer);
      this.atmosphereDirty = false;
      this.skyViewDirty = true;
      this.updateIlluminance();
    }
    const moved =
      this.sun.angleTo(this.skyViewSun) > SKY_VIEW_ANGLE_EPSILON ||
      this.moon.angleTo(this.skyViewMoon) > SKY_VIEW_ANGLE_EPSILON ||
      Math.abs(radius - this.skyViewRadius) > Math.max(0.005, altitudeKm * 0.05);
    if (this.skyViewDirty || moved) {
      this.luts.updateSkyView(renderer);
      this.skyViewSun.copy(this.sun);
      this.skyViewMoon.copy(this.moon);
      this.skyViewRadius = radius;
      this.skyViewDirty = false;
    }

    // Froxel frustum of the main camera (symmetric perspective).
    const u = this.uniforms;
    u.apRight.value.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0).normalize();
    u.apUp.value.set(e[4] ?? 0, e[5] ?? 1, e[6] ?? 0).normalize();
    u.apForward.value.set(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1)).normalize();
    const tanY = Math.tan((camera.fov * DEG) / 2) / camera.zoom;
    const tanX = tanY * camera.aspect;
    u.apTanHalf.value.set(tanX, tanY);
    const s = this.shading;
    s.apViewMatrix.value.copy(camera.matrixWorldInverse);
    s.apProjection.value.set(1 / tanX, 1 / tanY);
    s.apCameraPosition.value.set(e[12] ?? 0, e[13] ?? 0, e[14] ?? 0);
    this.luts.updateAerial(renderer);
  }

  dispose(): void {
    this.shading.dispose();
    this.luts.dispose();
  }

  private applyConditions(): void {
    this.params = atmosphereWithHaze(EARTH_ATMOSPHERE, this.conditions.hazeDensity);
    this.uniforms.setParams(this.params);
    this.uniforms.sunIlluminance.value.setScalar(SUN_ILLUMINANCE_TOA);
    this.shading.overcast.value = this.conditions.overcast;
    this.updateIlluminance();
  }

  private updateIlluminance(): void {
    // Thick overcast blocks the direct beam; the env map carries the diffuse light.
    const direct = (1 - this.conditions.overcast) ** 2;
    sunIlluminanceAt(this.params, this.sunElevation, this.cameraAltitude, this.sunLux);
    moonIlluminanceAt(this.params, this.moonElevation, this.moonPhase, this.cameraAltitude, this.moonLux);
    for (let c = 0; c < 3; c++) {
      this.sunLux[c] = (this.sunLux[c] ?? 0) * direct;
      this.moonLux[c] = (this.moonLux[c] ?? 0) * direct;
    }
  }
}
