// Facade over the spray particles, rain and lightning: one object the scene
// adds to its graph and updates once per frame (after the ocean compute, before
// rendering). Everything per frame runs on the GPU; the CPU only packs a few
// spawn requests and uniforms.
import {
  type Camera,
  Color,
  Group,
  type PerspectiveCamera,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../../app/Scenario';
import type { BoatSnapshot } from '../../sim/world/protocol';
import type { CascadeGroup } from '../ocean/GpuOcean';
import { Lightning, type LightningFlash, type ThunderEvent } from '../weather/Lightning';
import { Rain } from '../weather/Rain';
import { type FxBudget, FX_BUDGETS, fxBudgetFor } from './budgets';
import type { SpawnRequest, Vec3Like } from './emissionQueue';
import {
  emitSlamSpray,
  PropWash,
  RainSplashEmitter,
  RoosterTail,
  type SlamEvent,
  type SlamOptions,
  SpumeEmitter,
  viewYaw,
} from './emitters';
import { HullVolumes } from './hullVolumes';
import { type CascadeOffsets, OceanSampler } from './oceanSampler';
import { ParticleSystem } from './ParticleSystem';
import { RoosterSheets } from './roosterSheet';
import { FxLighting } from './shading';

interface ColorLike {
  r: number;
  g: number;
  b: number;
}

export interface FxFrameInputs {
  time: number; // simulation seconds
  wind: Vec3Like; // air velocity at 10 m (towards), m/s: rain
  // The wind the sea is built for (it lags a weather change with the waves): spume and spray.
  // Default `wind`.
  seaWind?: Vec3Like;
  sunDirection: Vec3Like; // unit vector towards the sun
  sunColor: ColorLike; // linear radiance scale reaching the sea (0 at night)
  ambientColor: ColorLike; // sky ambient radiance
  rainIntensity: number; // 0..1
  lightningRate: number; // strikes per minute
  oceanOffsets?: CascadeOffsets; // per-cascade sampling offsets (floating origin)
  // Jacobian below which crests break and shed spume; pass the ocean's foam threshold. Default 0.4.
  breakingThreshold?: number;
  cameraVelocity?: Vec3Like; // derived from camera motion when omitted
  // The boats as drawn this frame: no spray, mist, white water or rain splash lives inside them.
  boats?: readonly BoatSnapshot[];
}

export interface FxSystemOptions {
  quality?: QualityPreset;
  particleBudget?: number; // graphics.particleBudget; default the preset's
  ocean?: readonly CascadeGroup[]; // GpuOceanSimulation.groups; without it spray treats y = 0 as the sea
  seed?: number;
}

const FLASH_REFERENCE_DISTANCE = 3000; // m at which a flash lights the scene at its nominal strength
const FLASH_AMBIENT = 2.5; // radiance of a nominal flash on spray and rain

export class FxSystem {
  readonly group = new Group();
  readonly lighting = new FxLighting();
  readonly rain: Rain;
  readonly lightning: Lightning;
  readonly hulls = new HullVolumes();
  // The hydroplanes' rooster tails as lit sheets of water (fed by particles/boatSpray.ts).
  readonly roosterSheets = new RoosterSheets(this.lighting);
  // Lab-driven (dev/fxLab); the game's boats each get their own (particles/boatSpray.ts).
  readonly roosterTail = new RoosterTail();
  readonly propWash = new PropWash();
  particles: ParticleSystem;
  private spume: SpumeEmitter;
  private rainSplashes: RainSplashEmitter;
  private ocean: OceanSampler | null;
  private quality: QualityPreset;
  private budget: FxBudget;
  private lastCamera = new Vector3();
  private cameraVelocity = new Vector3();
  private hasLastCamera = false;
  private viewDirection = new Vector3();

  constructor(options: FxSystemOptions = {}) {
    this.group.name = 'fx';
    this.quality = options.quality ?? 'high';
    this.budget = fxBudgetFor(this.quality, options.particleBudget);
    this.ocean = options.ocean ? new OceanSampler(options.ocean) : null;
    this.particles = this.createParticles(this.budget);
    this.spume = new SpumeEmitter({ particles: this.particles, maxCandidates: this.budget.spumeCandidates });
    this.rainSplashes = new RainSplashEmitter({
      particles: this.particles,
      maxCandidates: this.budget.rainSplashes,
    });
    this.rain = new Rain({
      maxDrops: FX_BUDGETS.ultra.rainDrops,
      lighting: this.lighting,
      hulls: this.hulls,
    });
    this.rain.setMaxDrops(this.budget.rainDrops);
    this.lightning = new Lightning({ seed: options.seed ?? 1 });
    this.group.add(this.particles.mesh, this.rain.mesh, this.lightning.mesh, this.roosterSheets.group);
  }

  get flash(): LightningFlash {
    return this.lightning.flash;
  }

  onThunder(listener: (event: ThunderEvent) => void): () => void {
    return this.lightning.onThunder(listener);
  }

  // Re-budgets the effects. Growing past the allocated pool rebuilds it (rare: a
  // settings change), since storage buffers are best allocated once.
  setQuality(quality: QualityPreset): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.budget = FX_BUDGETS[quality];
    this.spume.dispose();
    this.rainSplashes.dispose();
    if (this.budget.particles > this.particles.capacity) {
      this.group.remove(this.particles.mesh);
      this.particles.dispose();
      this.particles = this.createParticles(this.budget);
      this.group.add(this.particles.mesh);
    } else {
      this.particles.setActiveCapacity(this.budget.particles);
    }
    this.spume = new SpumeEmitter({ particles: this.particles, maxCandidates: this.budget.spumeCandidates });
    this.rainSplashes = new RainSplashEmitter({
      particles: this.particles,
      maxCandidates: this.budget.rainSplashes,
    });
    this.rain.setMaxDrops(this.budget.rainDrops);
  }

  // Warm-up (loading screen): rain and the lightning bolt draw even when there are none, so their
  // pipelines are built before the first shower or strike.
  setWarmup(on: boolean): void {
    this.rain.warm = on;
    this.lightning.setWarmup(on);
  }

  spawn(request: SpawnRequest): number {
    return this.particles.spawn(request);
  }

  // A SimEvent 'slam' plus the slamming boat's velocity (and optionally its bow direction, size and
  // the hull sides the sheets leave from).
  slam(event: SlamEvent, boatVelocity: Vec3Like, options: Omit<SlamOptions, 'scale'> = {}): void {
    emitSlamSpray(this.particles, event, boatVelocity, { ...options, scale: this.emitScale() });
  }

  update(renderer: WebGPURenderer, camera: PerspectiveCamera, dt: number, inputs: FxFrameInputs): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.trackCamera(camera, step, inputs.cameraVelocity);
    const lighting = this.lighting;
    lighting.sunDirection.value
      .set(inputs.sunDirection.x, inputs.sunDirection.y, inputs.sunDirection.z)
      .normalize();
    setColor(lighting.sunColor.value, inputs.sunColor);
    setColor(lighting.ambientColor.value, inputs.ambientColor);
    if (this.ocean && inputs.oceanOffsets) this.ocean.setOffsets(inputs.oceanOffsets);
    this.hulls.update(inputs.boats ?? []);

    this.lightning.rate = inputs.lightningRate;
    this.lightning.update(renderer, camera, step, inputs.time);
    const flash = this.lightning.flash;
    const distance = flash.position.distanceTo(camera.position);
    const falloff = flash.intensity / (1 + (distance / FLASH_REFERENCE_DISTANCE) ** 2);
    (lighting.flashColor.value as Color).copy(flash.color).multiplyScalar(falloff * FLASH_AMBIENT);

    this.rain.update(renderer, camera, step, inputs.rainIntensity, inputs.wind, this.cameraVelocity);

    const particles = this.particles;
    const seaWind = inputs.seaWind ?? inputs.wind;
    particles.uniforms.wind.value.set(seaWind.x, seaWind.y, seaWind.z);
    const scale = this.emitScale();
    this.roosterTail.update(particles, step, scale);
    this.propWash.update(particles, step, scale);
    this.roosterSheets.update(step);
    particles.update(renderer, camera, step, inputs.time);

    camera.getWorldDirection(this.viewDirection);
    const windSpeed = Math.hypot(seaWind.x, seaWind.z);
    this.spume.update(renderer, windSpeed, viewYaw(this.viewDirection), inputs.breakingThreshold ?? 0.4);
    this.rainSplashes.update(renderer, inputs.rainIntensity);
  }

  dispose(): void {
    this.spume.dispose();
    this.rainSplashes.dispose();
    this.particles.dispose();
    this.roosterSheets.dispose();
    this.rain.dispose();
    this.lightning.dispose();
  }

  private createParticles(budget: FxBudget): ParticleSystem {
    return new ParticleSystem({
      capacity: budget.particles,
      emitPerFrame: budget.emitPerFrame,
      ocean: this.ocean,
      lighting: this.lighting,
      hulls: this.hulls,
    });
  }

  // The active quality's budget (per-boat spray caps itself to a share of it).
  get activeBudget(): Readonly<FxBudget> {
    return this.budget;
  }

  // CPU emitters spawn in proportion to the pool, so Low still reads as spray.
  emitScale(): number {
    return Math.max(0.25, Math.sqrt(this.budget.particles / FX_BUDGETS.ultra.particles));
  }

  private trackCamera(camera: Camera, dt: number, given?: Vec3Like): void {
    if (given) {
      this.cameraVelocity.set(given.x, given.y, given.z);
    } else if (this.hasLastCamera && dt > 0) {
      const moved = camera.position.distanceTo(this.lastCamera);
      // Teleports and origin shifts are not motion.
      if (moved < 50) {
        const velocity = scratch.subVectors(camera.position, this.lastCamera).divideScalar(dt);
        this.cameraVelocity.lerp(velocity, Math.min(1, dt * 8));
      }
    }
    this.lastCamera.copy(camera.position);
    this.hasLastCamera = true;
  }
}

const scratch = new Vector3();

function setColor(target: Color, source: ColorLike): void {
  target.setRGB(source.r, source.g, source.b);
}
