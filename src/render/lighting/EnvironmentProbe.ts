// Dynamic environment map from the sky (and clouds, via the `background` option): a CubeCamera
// renders a sky-only scene into an HDR cube target, amortised over frames by ProbeSchedule, and
// PMREMGenerator convolves it for PBR. The sun and moon disks are left out (the ocean and
// materials render their glints analytically) as are the stars.
//
// Each refresh cycle captures at that moment's pre-exposure. The scene does not sample the fresh
// convolution directly but a display copy that eases toward each new one (ProbeCrossfade: one
// full-texture blend pass and a copy per frame while it moves), so glossy surfaces glide between
// refreshes instead of stepping at every one. The blend rescales the display to the fresh capture's
// exposure, and scene.environmentIntensity rescales by preExposure / that exposure every frame, so
// the IBL stays in step with exposure between refreshes.

import {
  CubeCamera,
  CubeRenderTarget,
  CubeUVReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  NoBlending,
  type Node,
  NodeMaterial,
  type PerspectiveCamera,
  PMREMGenerator,
  QuadMesh,
  RenderTarget,
  RGBAFormat,
  Scene,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

import { releaseSceneObjects } from '../gpuResources';
import type { SkySystem } from '../sky/SkySystem';
import { type N, tsl } from '../tsl';
import {
  type ProbeFramePlan,
  ProbeCrossfade,
  ProbeSchedule,
  type ProbeScheduleOptions,
} from './probeSchedule';

const { ivec2, mix, normalize, positionLocal, screenCoordinate, texture, uniform, vec4 } = tsl;

export interface EnvironmentProbeOptions extends Partial<ProbeScheduleOptions> {
  size?: number; // cube face size in texels
  // Replaces the sky-only background (e.g. sky behind volumetric clouds): radiance along a
  // direction, pre-exposed by the capture exposure node it is given.
  background?: (direction: Node, exposure: Node) => Node;
  blendTime?: number; // s, time constant of the crossfade between refreshes (0 = pop)
}

// A CubeUV (PMREM layout) target like PMREMGenerator's own.
function cubeUvTarget(width: number, height: number, name: string): RenderTarget {
  const target = new RenderTarget(width, height, {
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
    type: HalfFloatType,
    format: RGBAFormat,
    colorSpace: LinearSRGBColorSpace,
    depthBuffer: false,
  });
  const t = target.texture as Texture & { isPMREMTexture?: boolean };
  t.mapping = CubeUVReflectionMapping;
  t.isPMREMTexture = true;
  t.name = name;
  return target;
}

// Display ← mix(display × ratio, fresh, weight), texel for texel: the three targets share one size
// and layout. `ratio` rescales the display to the fresh capture's exposure.
export function probeBlendMaterial(display: Texture, fresh: Texture, ratio: N, weight: N): NodeMaterial {
  const pixel = ivec2(screenCoordinate.xy);
  const previous: N = texture(display).load(pixel);
  const next: N = texture(fresh).load(pixel);
  const material = new NodeMaterial();
  material.name = 'environment-probe-blend';
  material.fragmentNode = vec4(mix(previous.rgb.mul(ratio), next.rgb, weight), next.a) as Node;
  material.depthTest = false;
  material.depthWrite = false;
  material.blending = NoBlending;
  material.toneMapped = false;
  return material;
}

// The display copy and its blend pass, drawn into a scratch target (a pass can't sample the target
// it draws to) and copied back.
class ProbeBlend {
  readonly display: RenderTarget;
  readonly scratch: RenderTarget;
  readonly weight: N = uniform(1);
  readonly ratio: N = uniform(1); // fresh capture exposure / display exposure
  private quad: QuadMesh;
  private material: NodeMaterial;

  constructor(renderer: WebGPURenderer, fresh: RenderTarget) {
    this.display = cubeUvTarget(fresh.width, fresh.height, 'environment-probe-display');
    this.scratch = cubeUvTarget(fresh.width, fresh.height, 'environment-probe-blend');
    renderer.initRenderTarget(this.display);
    renderer.initRenderTarget(this.scratch);
    this.material = probeBlendMaterial(this.display.texture, fresh.texture, this.ratio, this.weight);
    this.quad = new QuadMesh(this.material);
  }

  apply(renderer: WebGPURenderer, weight: number, ratio: number): void {
    this.weight.value = weight;
    this.ratio.value = Number.isFinite(ratio) ? ratio : 1;
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace();
    const previousMip = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(this.scratch);
    this.quad.render(renderer);
    renderer.setRenderTarget(previousTarget, previousFace, previousMip);
    renderer.copyTextureToTexture(this.scratch.texture, this.display.texture);
  }

  dispose(): void {
    this.display.dispose();
    this.scratch.dispose();
    this.material.dispose();
  }
}

export class EnvironmentProbe {
  private sky: SkySystem;
  private scene = new Scene();
  private cubeTarget: CubeRenderTarget;
  private cubeCamera: CubeCamera;
  private pmrem: PMREMGenerator;
  private pmremTarget: RenderTarget | null = null; // the latest convolution
  private blend: ProbeBlend | null = null;
  private crossfade: ProbeCrossfade;
  private schedule: ProbeSchedule;
  private captureExposure: N = uniform(1);
  private freshExposure = 1; // capture exposure of the latest convolution
  private displayExposure = 1; // exposure the display copy is held at
  private lastTime = Number.NaN;
  private targets = new Set<Scene>();
  private lastPlan: ProbeFramePlan = { beginCycle: false, faces: [], convolve: false };
  private extraVersion = 0;

  constructor(renderer: WebGPURenderer, sky: SkySystem, options: EnvironmentProbeOptions = {}) {
    this.scene.name = 'environment-probe';
    this.sky = sky;
    const { size = 128, background, blendTime, ...schedule } = options;
    this.schedule = new ProbeSchedule(schedule);
    this.crossfade = new ProbeCrossfade(blendTime);
    this.cubeTarget = new CubeRenderTarget(size, { type: HalfFloatType, generateMipmaps: false });
    this.cubeTarget.texture.minFilter = LinearFilter;
    this.cubeTarget.texture.magFilter = LinearFilter;
    this.cubeTarget.texture.name = 'environment-probe-cube';
    this.cubeCamera = new CubeCamera(0.1, 10, this.cubeTarget);
    this.pmrem = new PMREMGenerator(renderer);
    const direction = normalize(positionLocal) as Node;
    const skyNode = background
      ? background(direction, this.captureExposure as Node)
      : sky.createSkyNode(direction, {
          sun: false,
          moon: false,
          stars: false,
          exposure: this.captureExposure as Node,
        });
    (this.scene as Scene & { backgroundNode: Node | null }).backgroundNode = skyNode;
  }

  // The convolved environment the scene samples (CubeUV PMREM), or null before the first capture.
  get texture(): Texture | null {
    return this.blend?.display.texture ?? null;
  }

  // The plan executed by the last update (for diagnostics).
  get plan(): Readonly<ProbeFramePlan> {
    return this.lastPlan;
  }

  // Keeps scene.environment / environmentIntensity pointed at this probe.
  attach(scene: Scene): void {
    this.targets.add(scene);
    const texture = this.texture;
    if (texture) scene.environment = texture;
  }

  detach(scene: Scene): void {
    this.targets.delete(scene);
    const texture = this.texture;
    if (texture && scene.environment === texture) scene.environment = null;
  }

  // Forces a full refresh on the next update (e.g. clouds changed, teleport), shown at once.
  invalidate(): void {
    this.extraVersion++;
    this.schedule.invalidate();
  }

  // time: monotonic seconds; preExposure: this frame's multiplier (Exposure.preExposure).
  update(renderer: WebGPURenderer, time: number, preExposure: number): void {
    const dt = Number.isFinite(this.lastTime) ? Math.max(0, time - this.lastTime) : 0;
    this.lastTime = time;
    const plan = this.schedule.plan({
      time,
      sunDirection: this.sky.sunDirection,
      moonDirection: this.sky.moonDirection,
      contentVersion: this.sky.contentVersion * 1024 + this.extraVersion,
    });
    this.lastPlan = plan;
    if (plan.beginCycle) this.captureExposure.value = preExposure;
    if (plan.faces.length > 0) this.renderFaces(renderer, plan.faces);
    if (plan.convolve) {
      this.pmremTarget = this.pmrem.fromCubemap(this.cubeTarget.texture, this.pmremTarget);
      this.pmremTarget.texture.name = 'environment-probe-pmrem';
      this.freshExposure = this.captureExposure.value as number;
      // A whole cube in one frame is a jump (first capture, teleport, time skip): no crossfade.
      this.crossfade.fresh(plan.beginCycle && plan.faces.length === 6);
      if (!this.blend) {
        this.blend = new ProbeBlend(renderer, this.pmremTarget);
        for (const scene of this.targets) scene.environment = this.blend.display.texture;
      }
    }
    const blend = this.blend;
    const weight = blend ? this.crossfade.step(dt) : 0;
    if (blend && weight > 0) {
      blend.apply(renderer, weight, this.freshExposure / Math.max(this.displayExposure, 1e-12));
      this.displayExposure = this.freshExposure;
    }
    const intensity = preExposure / Math.max(this.displayExposure, 1e-12);
    for (const scene of this.targets) scene.environmentIntensity = intensity;
  }

  dispose(): void {
    for (const scene of this.targets) this.detach(scene);
    releaseSceneObjects(this.scene); // the capture scene's background mesh
    this.cubeTarget.dispose();
    this.pmremTarget?.dispose();
    this.blend?.dispose();
    this.pmrem.dispose();
  }

  private renderFaces(renderer: WebGPURenderer, faces: readonly number[]): void {
    const camera = this.cubeCamera;
    if (camera.coordinateSystem !== renderer.coordinateSystem) {
      camera.coordinateSystem = renderer.coordinateSystem;
      camera.updateCoordinateSystem();
    }
    camera.updateMatrixWorld();
    const previousTarget = renderer.getRenderTarget();
    const previousFace = renderer.getActiveCubeFace();
    const previousMip = renderer.getActiveMipmapLevel();
    for (const face of faces) {
      const faceCamera = camera.children[face];
      if (!faceCamera) continue;
      renderer.setRenderTarget(this.cubeTarget, face);
      renderer.render(this.scene, faceCamera as PerspectiveCamera);
    }
    renderer.setRenderTarget(previousTarget, previousFace, previousMip);
  }
}
