// Post-processing for the main view, wrapped around the existing exposure/tone-mapping output:
//
//   scene pass (HDR, pre-exposed; + velocity MRT for TRAA and the ocean mask)
//     → + ocean SSR (optional; a trace pass at half or full resolution, OceanReflections.ts)
//     → × GTAO (optional; boats and fittings only: the sky and the ocean are masked out)
//     → TRAA (optional, on HDR so its history clamps see true contrast)
//     → lens droplets (optional; rain and spray on the lens or the bridge windows)
//     → underwater absorption fog (depth based; a no-op above water)
//     → depth of field (only while a photo camera asks for it: setDof)
//     → + bloom (threshold in pre-exposed units: glints, sun and lamps only)
//     → + sun flare (High and Ultra; occluded by whatever covers the sun's disk)
//     → Exposure output node (GPU auto-exposure residual, Purkinje, dither)
//     → tone mapping + sRGB → FXAA / SMAA (optional; they expect display-referred input)
//
// Auto-exposure keeps metering the raw scene pass, before bloom and fog. Turning an effect on or
// off rebuilds the node graph (one shader compile); everything else is uniforms, and an effect
// that is off is not in the graph at all.
//
// TRAA and the ocean: three's velocity node only sees object transforms, but every ocean vertex
// moves every frame, so OceanMaterial writes its own motion vectors from the previous frame's
// displacement (enable with OceanSurface.setMotionVectors(plan.motionVectors)). It also sets the
// velocity buffer's z to 1, which is how GTAO tells the sea from the boats. Spray/rain particles
// still lack motion vectors and may ghost slightly; pass `temporal: false` to fall back to SMAA.
//
// Screen-space reflections: OceanSurface.setReflections(plan.ssr !== null) makes sure the sea copies
// the opaque scene, and setReflectionSource hands this pipeline those copies, the boat rectangles
// and the sea's surface sampling to trace with.

import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import {
  DepthTexture,
  FloatType,
  HalfFloatType,
  type Node,
  type PassNode,
  type PerspectiveCamera,
  RenderPipeline,
  Matrix4,
  type Scene,
  Vector2,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../../app/Scenario';
import type { Exposure } from '../lighting/Exposure';
import { type N, tsl } from '../tsl';
import { LensDropLayer, LensDropletUniforms, lensDroplets } from './LensDroplets';
import type { LensDrops } from './lensDrops';
import type { LensView } from './lensWetness';
import { MaskedGtaoNode } from './maskedGtao';
import { composeReflections, OceanReflectionNode, type OceanReflectionSource } from './OceanReflections';
import {
  cocScalePx,
  DOF_MAX_BLUR_PX,
  type DofSettings,
  type PostCapabilities,
  type PostPlan,
  planPost,
  postGraphChanged,
  type PostSettings,
} from './postSettings';
import { SunFlareUniforms, sunFlare } from './SunFlare';

const {
  clamp,
  convertToTexture,
  exp,
  float,
  luminance,
  max,
  min,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  uniform,
  textureSize,
  uv,
  vec2,
  vec3,
  vec4,
  velocity,
} = tsl;

// TRAA resolves to a slightly soft image; a light unsharp mask on its output, clamped to the 3×3
// neighbourhood's range so edges don't ring or halo, brings back the crispness.
const SHARPEN = 0.18; // per neighbour

function sharpen(tex: N): N {
  const texel = vec2(1).div(vec2(textureSize(tex)));
  const at = (dx: number, dy: number): N => tex.sample(uv().add(texel.mul(vec2(dx, dy)))).rgb;
  const c: N = tex.sample(uv());
  const n = at(0, -1);
  const s = at(0, 1);
  const e = at(1, 0);
  const w = at(-1, 0);
  const lo = min(min(min(n, s), min(e, w)), c.rgb);
  const hi = max(max(max(n, s), max(e, w)), c.rgb);
  const edge = c.rgb.mul(4).sub(n.add(s).add(e).add(w));
  return vec4(clamp(c.rgb.add(edge.mul(SHARPEN)), lo, hi), c.a);
}

const DEG = Math.PI / 180;
const BLOOM_FEED_MAX = 6; // pre-exposed luminance (~1 is diffuse white)
const SUN_ANGULAR_RADIUS = 0.267 * DEG;

export interface UnderwaterState {
  amount: number; // 0 above water, 1 fully submerged (smooth across the surface)
  depth: number; // m below the local surface (dims the light reaching the camera)
  extinction: readonly [number, number, number]; // absorption + scattering, m⁻¹
  absorption: readonly [number, number, number]; // m⁻¹
  // Pre-exposed downwelling illuminance at the surface (sun/moon + sky), linear RGB.
  light: { r: number; g: number; b: number };
  scatterColor: readonly [number, number, number]; // region deepColor
}

interface Disposable {
  dispose(): void;
}

const sameSource = (a: OceanReflectionSource, b: OceanReflectionSource): boolean =>
  a.color === b.color && a.depth === b.depth && a.occluders === b.occluders;

const RTT_OPTIONS = { type: HalfFloatType, depthBuffer: false };
const sunPoint = new Vector3();
const bufferSize = new Vector2();
let velocityMrt: Parameters<PassNode['setMRT']>[0] | undefined;

export class PostPipeline {
  private scene: Scene;
  private camera: PerspectiveCamera;
  private exposure: Exposure;
  private quality: QualityPreset;
  private capabilities: PostCapabilities;
  private settings: PostSettings;
  private planned: PostPlan;
  private pipeline: RenderPipeline;
  private disposables: Disposable[] = [];
  private bloomNode: BloomNode | null = null;
  private dirty = true;

  // The graph rebuilds at the next render (an effect turned on or off).
  get needsBuild(): boolean {
    return this.dirty;
  }
  private reflectionSource: OceanReflectionSource | null = null;
  private dofSettings: DofSettings = { enabled: false, focusDistance: 10, aperture: 0.5 };
  private underwater = {
    amount: uniform(0),
    extinction: uniform(new Vector3(0.6, 0.3, 0.35)),
    inscatter: uniform(new Vector3()),
    tanHalf: uniform(new Vector2(1, 1)),
    cameraRotation: uniform(new Matrix4()),
  };
  private dofUniforms = { focus: uniform(10), cocScale: uniform(0) };
  private flareUniforms = new SunFlareUniforms();
  private sunDirection = new Vector3(0, 1, 0);
  private sunUp = false;
  readonly lens = new LensDropletUniforms();
  private dropLayer = new LensDropLayer(this.lens);
  private drops: Readonly<LensDrops> | null = null;
  private lensView: LensView = { mode: 'none', windowDistance: 0 };

  constructor(
    renderer: WebGPURenderer,
    scene: Scene,
    camera: PerspectiveCamera,
    exposure: Exposure,
    options: { quality: QualityPreset; settings: PostSettings; capabilities?: PostCapabilities },
  ) {
    this.scene = scene;
    this.camera = camera;
    this.exposure = exposure;
    this.quality = options.quality;
    this.capabilities = options.capabilities ?? { temporal: true };
    this.settings = { ...options.settings };
    this.planned = planPost(this.settings, this.quality, this.capabilities);
    this.pipeline = new RenderPipeline(renderer);
  }

  get plan(): Readonly<PostPlan> {
    return this.planned;
  }

  // Applies graphics settings; returns the resulting plan (motionVectors/ssr → OceanSurface).
  apply(settings: Partial<PostSettings>): Readonly<PostPlan> {
    this.settings = { ...this.settings, ...settings };
    const next = planPost(this.settings, this.quality, this.capabilities);
    const rebuild = postGraphChanged(this.planned, next);
    this.planned = next;
    if (rebuild) this.dirty = true;
    else this.updateBloom();
    return next;
  }

  // Depth of field for the photo camera: focus distance (m) and aperture (0 pinhole .. 1 f/1.4,
  // see fNumberFromAperture). Toggling `enabled` rebuilds the graph; focus and aperture are uniforms.
  setDof(settings: Partial<DofSettings>): void {
    const next = { ...this.dofSettings, ...settings };
    if (next.enabled !== this.dofSettings.enabled) this.dirty = true;
    this.dofSettings = next;
  }

  // What the sea's SSR pass traces (OceanSurface.reflectionSource); without it plan.ssr is ignored.
  setReflectionSource(source: OceanReflectionSource | null): void {
    if (source === this.reflectionSource) return;
    if (source && this.reflectionSource && sameSource(source, this.reflectionSource)) return;
    this.reflectionSource = source;
    if (this.planned.ssr) this.dirty = true;
  }

  // World direction toward the sun and whether it is above the horizon (lens flare).
  setSun(direction: { x: number; y: number; z: number }, up: boolean): void {
    this.sunDirection.set(direction.x, direction.y, direction.z).normalize();
    this.sunUp = up;
  }

  // Water on the lens / windows (the drop simulation, lensDrops), drawn when graphics.lensDroplets
  // is on; null while there is none.
  setLens(drops: Readonly<LensDrops> | null, view: LensView): void {
    this.drops = drops;
    this.lensView = view;
  }

  setUnderwater(state: UnderwaterState | null): void {
    const u = this.underwater;
    if (!state || state.amount <= 0) {
      u.amount.value = 0;
      return;
    }
    u.amount.value = Math.min(1, state.amount);
    const [er, eg, eb] = state.extinction;
    (u.extinction.value as Vector3).set(er, eg, eb);
    // Light reaching the camera's depth, then the single-scattering equilibrium radiance
    // (∝ b / (a + b), folded into the region's deep colour) of the water around it.
    const depth = Math.max(0, state.depth);
    const [ar, ag, ab] = state.absorption;
    const [sr, sg, sb] = state.scatterColor;
    const k = 0.6 / Math.PI;
    (u.inscatter.value as Vector3).set(
      state.light.r * Math.exp(-ar * depth) * sr * k,
      state.light.g * Math.exp(-ag * depth) * sg * k,
      state.light.b * Math.exp(-ab * depth) * sb * k,
    );
  }

  render(): void {
    if (this.dirty) this.build();
    const camera = this.camera;
    const tanY = Math.tan((camera.fov * DEG) / 2) / camera.zoom;
    (this.underwater.tanHalf.value as Vector2).set(tanY * camera.aspect, tanY);
    (this.underwater.cameraRotation.value as Matrix4).extractRotation(camera.matrixWorld);
    if (this.planned.flare) this.updateFlare(tanY);
    if (this.planned.droplets) this.updateDrops();
    if (this.dofSettings.enabled) {
      const height = this.pipeline.renderer.getDrawingBufferSize(bufferSize).y;
      this.dofUniforms.focus.value = Math.max(0.05, this.dofSettings.focusDistance);
      this.dofUniforms.cocScale.value = cocScalePx(this.dofSettings, camera.fov / camera.zoom, height);
    }
    this.pipeline.render();
  }

  dispose(): void {
    this.disposeNodes();
    this.dropLayer.dispose();
    this.pipeline.dispose();
  }

  // `node` as a texture node. Anything else renders into a full-resolution target of its own
  // (convertToTexture → RTTNode), which is freed with the graph: traa(), fxaa(), smaa() and dof()
  // convert their input the same way but never dispose that target (one leaked per build).
  private textureOf(node: N): N {
    if (node.isTextureNode || node.isSampleNode || node.isPassNode) return convertToTexture(node);
    // Colour only: a fullscreen pass needs no depth buffer (4 B/px saved).
    const target: N = convertToTexture(node, null, null, RTT_OPTIONS);
    this.disposables.push(target);
    return target;
  }

  private disposeNodes(): void {
    for (const node of this.disposables) node.dispose();
    this.disposables = [];
    this.bloomNode = null;
  }

  private updateBloom(): void {
    const node = this.bloomNode as (BloomNode & { strength: N; radius: N; threshold: N }) | null;
    const params = this.planned.bloom;
    if (!node || !params) return;
    node.strength.value = params.strength;
    node.radius.value = params.radius;
    node.threshold.value = params.threshold;
  }

  private updateFlare(tanY: number): void {
    const u = this.flareUniforms;
    const camera = this.camera;
    camera.updateMatrixWorld();
    sunPoint.copy(this.sunDirection).multiplyScalar(1000).add(camera.position);
    sunPoint.applyMatrix4(camera.matrixWorldInverse);
    const inFront = sunPoint.z < 0;
    sunPoint.applyMatrix4(camera.projectionMatrix);
    (u.sunUv.value as Vector2).set(sunPoint.x * 0.5 + 0.5, 0.5 - sunPoint.y * 0.5);
    const onScreen = Math.abs(sunPoint.x) < 1.05 && Math.abs(sunPoint.y) < 1.05;
    u.visible.value = inFront && onScreen && this.sunUp ? 1 : 0;
    u.aspect.value = camera.aspect;
    // Disk radius as a fraction of the screen height.
    u.diskRadius.value = Math.tan(SUN_ANGULAR_RADIUS) / (2 * tanY);
    u.strength.value = this.planned.flare?.strength ?? 0;
  }

  private updateDrops(): void {
    const renderer = this.pipeline.renderer as WebGPURenderer;
    const count = this.drops ? this.dropLayer.render(renderer, this.drops) : 0;
    const size = renderer.getDrawingBufferSize(bufferSize);
    this.lens.set(count, this.lensView, size.x, size.y);
  }

  private build(): void {
    this.dirty = false;
    this.disposeNodes();
    const plan = this.planned;

    // Reversed-Z renders into depth32float; a float depth texture keeps copies format-compatible.
    const depthTexture = new DepthTexture(1, 1);
    depthTexture.type = FloatType;
    const scenePass = pass(this.scene, this.camera, { depthTexture }) as PassNode;
    // One MRT node for every build: three keys the scene pass's render context (and with it every
    // scene pipeline) by the MRT node's id, so a new node would recompile the whole scene for an
    // effect that only changes the post graph (bloom, droplets, FXAA ↔ SMAA, DOF, SSR).
    if (plan.motionVectors) scenePass.setMRT((velocityMrt ??= mrt({ output, velocity })));
    this.disposables.push(scenePass);
    const sceneColor: N = scenePass.getTextureNode('output');
    const viewZ: N = (scenePass as N).getViewZNode();

    let color: N = sceneColor;
    let colorTexture: N = sceneColor; // a texture node holding `color`, when there is one

    const source = this.reflectionSource;
    if (plan.ssr && source) {
      // The sea's screen-space reflections (OceanReflections.ts), on the HDR scene before AO/TRAA.
      // The scene pass draws as without them.
      const depth: N = scenePass.getTextureNode('depth');
      const underwater = this.underwater.amount;
      const trace = new OceanReflectionNode(plan.ssr, source, depth, this.camera, this.scene, underwater);
      this.disposables.push(trace);
      color = composeReflections(color, trace, source, depth, this.camera).toVar('ssrColor');
      colorTexture = null;
    }

    if (plan.ao) {
      const depth: N = scenePass.getTextureNode('depth');
      // Boats and fittings only: not the sky (reversed-Z depth 0), not the sea (velocity z = 1, less
      // where glass or spray blended over it) and nothing beyond a few hundred metres, where the
      // view-space reconstruction of a reversed-Z depth near 0 loses precision. The AO pass skips
      // the same pixels (MaskedGtaoNode), so it costs only what the boats cover.
      const intensity = plan.ao.intensity;
      const used = (): { weight: N; valid: N } => {
        const ocean = scenePass.getTextureNode('velocity').z;
        const weight = float(intensity)
          .mul(float(1).sub(ocean.clamp(0, 1)))
          .mul(float(1).sub(tsl.smoothstep(150, 400, viewZ.negate())))
          .toVar();
        return { weight, valid: depth.r.greaterThan(0).and(weight.greaterThan(0.001)) };
      };
      const node: N = new MaskedGtaoNode(depth, this.camera, used().valid);
      node.resolutionScale = plan.ao.resolutionScale;
      node.samples.value = plan.ao.samples;
      node.radius.value = plan.ao.radius;
      node.thickness.value = plan.ao.thickness;
      node.useTemporalFiltering = plan.aa === 'traa';
      this.disposables.push(node);
      const { weight, valid } = used();
      // The colour is built first so the scene pass renders before the AO pass reads its depth.
      const occlusion = node.getTextureNode().r;
      // select, not mix: the AO of a sky pixel may be NaN, and NaN × 0 would still poison TRAA.
      const factor = valid.select(mix(float(1), occlusion.clamp(0, 1), weight), float(1));
      color = vec4(color.rgb.mul(factor), color.a);
      colorTexture = null;
    }

    if (plan.aa === 'traa') {
      const resolve: N = traa(
        this.textureOf(color),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('velocity'),
        this.camera,
      );
      this.disposables.push(resolve);
      // TRAANode.dispose leaves the 1×1 placeholder it reads as the previous depth before frame one.
      const placeholder = (resolve as { _previousDepthNode?: { value?: Disposable } })._previousDepthNode
        ?.value;
      if (placeholder) this.disposables.push(placeholder);
      color = sharpen(resolve.getTextureNode());
      colorTexture = null;
    }

    if (plan.droplets) {
      const source: N = colorTexture ?? this.textureOf(color);
      color = lensDroplets(source, this.dropLayer.texture, viewZ, this.lens);
      colorTexture = null;
    }

    color = this.underwaterNode(color, scenePass);

    if (this.dofSettings.enabled) {
      // three's DoF blurs by smoothstep(0, focalLength, |−viewZ − focus|) × bokehScale pixels; feeding
      // it the signed thin-lens circle of confusion (normalised to the largest blur) instead makes
      // the blur physical: c = K·(D − S)/D, which levels off toward infinity.
      const d = viewZ.negate().max(0.01);
      const signed = this.dofUniforms.cocScale.mul(d.sub(this.dofUniforms.focus)).div(d);
      const coc = clamp(signed.div(DOF_MAX_BLUR_PX), -1, 1);
      const node: N = dof(this.textureOf(color), coc.negate(), float(0), float(1), float(DOF_MAX_BLUR_PX));
      this.disposables.push(node);
      color = node;
    }

    if (plan.bloom) {
      // Clamp what feeds the bloom: a lit crabber deck or a flood seen head-on is thousands of
      // pre-exposed units, and the wide mips would spread that into a veil over the whole frame.
      const feed = color.mul(min(float(1), float(BLOOM_FEED_MAX).div(max(luminance(color.rgb), 1e-4))));
      const glow = bloom(feed, plan.bloom.strength, plan.bloom.radius, plan.bloom.threshold);
      this.bloomNode = glow;
      this.disposables.push(glow);
      color = color.add(glow);
    }

    if (plan.flare) color = color.add(sunFlare(sceneColor, this.flareUniforms, plan.flare.ghosts));

    let outputNode: N = this.exposure.createOutputNode(color as Node);
    if (plan.aa === 'fxaa' || plan.aa === 'smaa') {
      const display = renderOutput(outputNode);
      const input = this.textureOf(display);
      const filtered = plan.aa === 'fxaa' ? fxaa(input) : smaa(input);
      this.disposables.push(filtered);
      outputNode = filtered;
      this.pipeline.outputColorTransform = false;
    } else {
      this.pipeline.outputColorTransform = true;
    }
    this.pipeline.outputNode = outputNode as Node;
    this.pipeline.needsUpdate = true;
    this.exposure.setMeasureSource(scenePass.getTexture('output'));
  }

  // Beer–Lambert absorption toward each pixel plus in-scattered light, when the camera is submerged.
  private underwaterNode(color: N, scenePass: PassNode): N {
    const u = this.underwater;
    const viewZ = (scenePass as N).getViewZNode() as N;
    // View-ray length per unit depth, from the pixel's position on the image plane.
    const ndc = uv().mul(2).sub(1);
    // uv() has y down; view space has y up and looks along −z.
    const viewRay = vec3(ndc.x.mul(u.tanHalf.x), ndc.y.negate().mul(u.tanHalf.y), -1);
    const ray = viewRay.length();
    const distance = viewZ.negate().mul(ray).min(5000);
    const transmittance = exp(u.extinction.mul(distance).negate());
    // Light comes from above: the water glows toward the surface and darkens into the deep.
    const up = u.cameraRotation.mul(vec4(viewRay.div(ray), 0)).y;
    const glow = mix(float(0.15), float(1.4), up.mul(0.5).add(0.5).pow(1.5));
    const fogged = color.rgb.mul(transmittance).add(u.inscatter.mul(glow).mul(float(1).sub(transmittance)));
    return vec4(mix(color.rgb, fogged, u.amount), color.a);
  }
}
