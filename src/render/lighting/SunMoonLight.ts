// The scene's directional light, following the sun by day and the moon by night (cross-fading
// through twilight, see lightSource.ts), coloured and scaled from SkySystem's sea-level
// illuminance times the frame's pre-exposure. Cascaded shadows come from CSMShadowNode.
//
// CSMShadowNode (not the SunLight addon, which hard-codes two cascades) takes 1-4 cascades with
// practical splits and fits them to the rendering camera's frustum, so the light itself only needs a
// direction: it sits `distance` metres from the target (the player boat) along it. The cascades'
// reach (distance, light margin, depth range, bias) is fitted to the boats in view each frame
// (shadowFit.ts) so big ships' long shadows aren't cut off.

import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { Color, DirectionalLight, type Object3D, type PerspectiveCamera, Vector3 } from 'three/webgpu';

import { enableShadowLayer } from '../boats/kit/shadowProxy';
import { disposeCascadedShadows } from '../gpuResources';
import type { SkySystem } from '../sky/SkySystem';
import { chooseLightSource, type LightSource } from './lightSource';
import {
  cascadeBias,
  cascadeDepthRange,
  fitShadowFar,
  quantizeShadowFar,
  SHADOW_FIT_DEFAULTS,
  type ShadowCaster,
  shadowLightMargin,
  type ShadowView,
} from './shadowFit';

export interface ShadowQuality {
  enabled: boolean;
  mapSize: number; // per cascade
  cascades: number; // 1–4
  maxFar: number; // m, shadow distance
}

const DEFAULT_SHADOW_QUALITY: ShadowQuality = {
  enabled: true,
  mapSize: 2048,
  cascades: 3,
  maxFar: 600,
};

const LIGHT_MARGIN = SHADOW_FIT_DEFAULTS.baseMargin; // m, casters this far toward the light still shadow the view
const SHADOW_NEAR = 1; // m, the cascade light cameras' near plane

// What the cascades are fitted to: the rendering camera and the boats (shadowFit.ts).
export interface ShadowFitInput {
  camera: PerspectiveCamera;
  casters: readonly ShadowCaster[];
}

const cameraBasis = new Vector3();

const sameElements = (a: readonly number[], b: ArrayLike<number>): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const luminance = (c: Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export class SunMoonLight {
  readonly light: DirectionalLight;
  private parent: Object3D;
  private csm: CSMShadowNode | null = null;
  private quality: ShadowQuality;
  private distance = 1000;
  private sunColor = new Color();
  private moonColor = new Color();
  private direction = new Vector3();
  private currentSource: LightSource = 'none';
  private illuminance = 0; // lux at sea level, physical
  private weight = 0;
  private warm = false;
  // The cascades' current fit (maxFar, lightMargin, depth range) and what it was applied to.
  private fitFar = 0;
  private fitMargin = 0;
  private fitRange = 0;
  private appliedLights = -1;
  private projection: number[] = [];
  private view: ShadowView = {
    position: new Vector3(),
    forward: new Vector3(),
    right: new Vector3(),
    up: new Vector3(),
    tanHalfV: 1,
    tanHalfH: 1,
  };

  constructor(parent: Object3D, quality: ShadowQuality = DEFAULT_SHADOW_QUALITY) {
    this.parent = parent;
    this.quality = { ...quality };
    this.light = new DirectionalLight(0xffffff, 0);
    this.light.name = 'sun-moon-light';
    parent.add(this.light);
    parent.add(this.light.target);
    this.configureShadows();
  }

  get source(): LightSource {
    return this.currentSource;
  }

  // Physical illuminance (lux) delivered by the light this frame.
  get illuminanceLux(): number {
    return this.illuminance;
  }

  // 0..1 weight of the chosen body (the moon fades in through twilight; 0 with no light).
  get sourceWeight(): number {
    return this.weight;
  }

  get shadowNode(): CSMShadowNode | null {
    return this.csm;
  }

  setShadowQuality(quality: Partial<ShadowQuality>): void {
    const next = { ...this.quality, ...quality };
    next.cascades = Math.min(4, Math.max(1, Math.round(next.cascades)));
    const same =
      next.enabled === this.quality.enabled &&
      next.mapSize === this.quality.mapSize &&
      next.cascades === this.quality.cascades &&
      next.maxFar === this.quality.maxFar;
    this.quality = next;
    if (!same) this.configureShadows();
  }

  // target: world position the shadows are centred on (the player boat); preExposure from Exposure;
  // direct: 0..1 share of the light that stays directional (an overcast deck flattens it to 0, see
  // CloudSystem.overcast). illuminanceLux stays the clear-sky value. fit: the camera and boats the
  // cascades stretch to cover (without it they keep the quality's base distance).
  update(sky: SkySystem, preExposure: number, target: Vector3, direct = 1, fit?: ShadowFitInput): void {
    sky.sunIlluminance(this.sunColor);
    sky.moonIlluminance(this.moonColor);
    const choice = chooseLightSource(sky.sunElevation, luminance(this.sunColor), luminance(this.moonColor));
    this.currentSource = choice.source;
    const color = choice.source === 'moon' ? this.moonColor : this.sunColor;
    this.direction.copy(choice.source === 'moon' ? sky.moonDirection : sky.sunDirection);
    const lux = choice.source === 'none' ? 0 : luminance(color) * choice.weight;
    this.illuminance = lux;
    this.weight = choice.source === 'none' ? 0 : choice.weight;
    const k = Math.min(1, Math.max(0, direct));

    const light = this.light;
    if (lux > 0) light.color.setRGB(color.r, color.g, color.b).multiplyScalar(choice.weight / lux);
    // three's DirectionalLight intensity is illuminance (lux) under physical lighting.
    light.intensity = lux * preExposure * k;
    // Never hidden and castShadow never toggled: either changes the scene's light set, which
    // recompiles every lit material (a stall at sunset or moonset). A dark light just stops
    // re-rendering its shadow maps (except during warm-up, which builds their pipelines), so a
    // closed overcast saves the shadow passes too.
    this.setShadowUpdates(lux * k > 0 || this.warm);
    light.target.position.copy(target);
    light.position.copy(target).addScaledVector(this.direction, this.distance);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    this.fitShadows(fit);
  }

  // The shadow distance (CSM maxFar) currently in use, m.
  get shadowFar(): number {
    return this.fitFar || this.quality.maxFar;
  }

  // The light margin toward the light currently in use, m.
  get shadowMargin(): number {
    return this.fitMargin || LIGHT_MARGIN;
  }

  // Stretches the cascades over the boats' shadows (shadowFit.ts) and keeps them fitted to the
  // camera's projection (CSMShadowNode only reads it once, so a resize or FOV change would leave
  // them fitted to the old frustum).
  private fitShadows(fit: ShadowFitInput | undefined): void {
    const csm = this.csm;
    if (!csm) return;
    const base = this.quality.maxFar;
    const camera = (csm.camera as PerspectiveCamera | null) ?? fit?.camera ?? null;
    let far = base;
    let tallest = 0;
    const toLight = this.direction;
    if (camera?.isPerspectiveCamera) {
      const view = this.view;
      const e = camera.matrixWorld.elements;
      (view.position as Vector3).set(e[12], e[13], e[14]);
      (view.right as Vector3).copy(cameraBasis.set(e[0], e[1], e[2]).normalize());
      (view.up as Vector3).copy(cameraBasis.set(e[4], e[5], e[6]).normalize());
      (view.forward as Vector3).copy(cameraBasis.set(-e[8], -e[9], -e[10]).normalize());
      view.tanHalfV = Math.tan(((camera.fov / 2) * Math.PI) / 180) / (camera.zoom || 1);
      view.tanHalfH = view.tanHalfV * camera.aspect;
      if (fit) {
        const options = { ...SHADOW_FIT_DEFAULTS, baseFar: base };
        far = fitShadowFar(view, toLight, fit.casters, options);
        for (const caster of fit.casters) tallest = Math.max(tallest, caster.height);
      }
    }
    const nextFar = quantizeShadowFar(far, this.fitFar || base);
    const nextMargin = shadowLightMargin(tallest, toLight, LIGHT_MARGIN, SHADOW_FIT_DEFAULTS.maxShadowLength);
    // The margin only moves the light cameras along the light (no texel shimmer); it shrinks lazily.
    const margin =
      nextMargin >= this.fitMargin || nextMargin <= this.fitMargin - 200 ? nextMargin : this.fitMargin;
    const range = cascadeDepthRange(margin, nextFar, this.view.tanHalfV, this.view.tanHalfH);
    const projectionChanged =
      camera !== null && !sameElements(this.projection, camera.projectionMatrix.elements);
    const lights = csm.lights.length;
    if (
      nextFar === this.fitFar &&
      margin === this.fitMargin &&
      range === this.fitRange &&
      lights === this.appliedLights &&
      !projectionChanged
    )
      return;
    this.fitFar = nextFar;
    this.fitMargin = margin;
    this.fitRange = range;
    this.appliedLights = lights;
    csm.maxFar = nextFar;
    csm.lightMargin = margin;
    // The template shadow (cloned per cascade when the node first builds) and the cascades.
    const template = cascadeBias(0, nextFar, base, SHADOW_NEAR, range);
    this.applyShadowCamera(this.light.shadow, range, template.bias, template.normalBias);
    csm.lights.forEach((cascade, i) => {
      const { bias, normalBias } = cascadeBias(i, nextFar, base, SHADOW_NEAR, range);
      if (cascade.shadow) this.applyShadowCamera(cascade.shadow, range, bias, normalBias);
    });
    if (camera && csm.camera) {
      this.projection = Array.from(camera.projectionMatrix.elements);
      csm.updateFrustums();
    }
  }

  private applyShadowCamera(
    shadow: DirectionalLight['shadow'],
    far: number,
    bias: number,
    normalBias: number,
  ): void {
    shadow.bias = bias;
    shadow.normalBias = normalBias;
    if (shadow.camera.far !== far) {
      shadow.camera.far = far;
      shadow.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    // The cascades' shadow maps too (CSMShadowNode.dispose leaves them), then the light's own.
    disposeCascadedShadows(this.csm);
    this.csm = null;
    this.light.shadow.dispose();
    this.light.dispose();
    this.parent.remove(this.light);
    this.parent.remove(this.light.target);
  }

  // Warm-up (loading screen): shadow maps render even with the light dark.
  setWarmup(on: boolean): void {
    this.warm = on;
  }

  private setShadowUpdates(on: boolean): void {
    this.light.shadow.autoUpdate = on;
    for (const cascade of this.csm?.lights ?? []) if (cascade.shadow) cascade.shadow.autoUpdate = on;
  }

  private configureShadows(): void {
    const light = this.light;
    const q = this.quality;
    disposeCascadedShadows(this.csm);
    this.csm = null;
    light.castShadow = q.enabled;
    if (!q.enabled) {
      light.shadow.shadowNode = undefined;
      return;
    }
    light.shadow.mapSize.set(q.mapSize, q.mapSize);
    light.shadow.camera.near = SHADOW_NEAR;
    // The boats' merged shadow casters (kit/shadowProxy.ts); the cascades clone this camera.
    enableShadowLayer(light.shadow.camera);
    // CSM places each cascade camera lightMargin behind its slice; far must cover the slice depth.
    // fitShadows sets far and the bias (≈ 3 cm of depth at the base distance, × the cascade
    // number; larger values erase the shadows of small casters) before the first frame.
    light.shadow.camera.far = LIGHT_MARGIN + q.maxFar * 2.5 + 100;
    light.shadow.bias = -0.00002;
    light.shadow.normalBias = 0.02;
    this.fitFar = 0;
    this.fitMargin = 0;
    this.fitRange = 0;
    this.appliedLights = -1;
    this.projection = [];
    this.csm = new CSMShadowNode(light, {
      cascades: q.cascades,
      maxFar: q.maxFar,
      mode: 'practical',
      lightMargin: LIGHT_MARGIN,
    });
    this.csm.fade = true;
    light.shadow.shadowNode = this.csm;
    light.shadow.needsUpdate = true;
  }
}
