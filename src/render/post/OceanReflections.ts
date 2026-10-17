// Screen-space reflections of the opaque scene (the boats) in the sea, as a post pass of its own
// that costs the scene pass nothing.
//
// The scene pass draws exactly as without SSR (no extra outputs); this pass finds what it needs on
// its own:
//
//  1. The sea is where the scene depth lies in front of the opaque depth copy the ocean makes when
//     it draws (nothing else drawn after the opaques writes depth: spray, rain, glass and glows
//     don't). Its surface point comes from the depth; its Lagrangian position from inverting the
//     cascades' displacement (two fixed-point steps); its normal and roughness from the ocean
//     material's own sampling of the cascades, wakes and ripples there (OceanMaterial.surfaceAt).
//  2. OceanReflectionNode, per texel (half or full resolution): the reflection weight W (Fresnel ×
//     smooth enough × reflected upward), the reflected ray traced through the opaque depth copy
//     over the boats' screen rectangles (ocean/ssrOccluders.ts), a hit shaded from the opaque
//     colour copy with confidence a, and the sky probe's reflection env in the same direction:
//     output a·W·(hit − env), the sea's view z in alpha (0 where there is no sea).
//  3. composeReflections adds that at full resolution where the sea is, upsampled from half
//     resolution by bilinear weights that skip texels without sea and fall off across depth.

import {
  type DepthTexture,
  HalfFloatType,
  NodeMaterial,
  type NodeFrame,
  NodeUpdateType,
  type PerspectiveCamera,
  QuadMesh,
  RendererUtils,
  RenderTarget,
  type Scene,
  TempNode,
  type Texture,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { fresnelNode } from '../ocean/OceanMaterial';
import { WATER_F0, WATER_IOR } from '../ocean/oceanOptics';
import { type N, tsl } from '../tsl';
import type { SsrParams } from './postSettings';

const {
  Break,
  Fn,
  If,
  Loop,
  abs,
  ceil,
  clamp,
  dot,
  float,
  floor,
  fract,
  int,
  ivec2,
  length,
  max,
  min,
  mix,
  normalize,
  passTexture,
  perspectiveDepthToViewZ,
  pmremTexture,
  reference,
  saturate,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} = tsl;

// Below this reflection weight a pixel is not traced (≈ a 1 % share at the water's F0).
const SSR_MIN_WEIGHT = 2e-4;

// What the ocean shares with the pass (OceanSurface.reflectionSource).
export interface OceanReflectionSource {
  color: Texture; // opaque colour copy, made when the ocean draws
  depth: DepthTexture; // opaque depth copy
  occluders: N; // uniformArray vec4, two per slot (ssrOccluders.packScreenRects)
  occluderCount: N; // uniform: slots in use
  frame: N; // uniform: frame counter mod 64 (jitter)
  // The sea's shading normal (world) and GGX α² at a Lagrangian point (OceanMaterial.surfaceAt).
  surface: (xz: N, footprint: N, lodFootprint: N) => { normal: N; alpha2: N };
  // The cascades' displacement of a Lagrangian point at a distance from the camera.
  displacement: (xz: N, distance: N) => N;
}

// The sea in front of the opaque scene at a pixel: its view z there, or 0.
function seaViewZ(sceneZ: N, opaqueZ: N): N {
  return select(sceneZ.greaterThan(opaqueZ.add(abs(sceneZ).mul(1e-4).add(1e-3))), sceneZ, float(0));
}

const quad = new QuadMesh(null as never);
let rendererState: ReturnType<typeof RendererUtils.resetRendererState> | undefined;
const size = new Vector2();

export class OceanReflectionNode extends TempNode<'vec4'> {
  readonly resolutionScale: number;
  private params: SsrParams;
  private source: OceanReflectionSource;
  private scene: Scene;
  private sceneDepth: N; // texture node: the scene pass's depth (the sea's surface)
  private underwater: N; // 0 above water .. 1 submerged
  private target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: false });
  private material = new NodeMaterial();
  private textureNode: N;
  private environment: Texture | null = null; // the probe the material was built with
  private fullSize: N = uniform(new Vector2(1, 1));
  private traceSize: N = uniform(new Vector2(1, 1));
  private cameraWorld: N = uniform(new Vector3());
  private projection: N;
  private projectionInverse: N;
  private view: N;
  private viewInverse: N;
  private near: N;
  private far: N;
  private envIntensity: N;
  private camera: PerspectiveCamera;

  constructor(
    params: SsrParams,
    source: OceanReflectionSource,
    sceneDepth: N,
    camera: PerspectiveCamera,
    scene: Scene,
    underwater: N,
  ) {
    super('vec4');
    this.params = { ...params };
    this.resolutionScale = params.resolutionScale;
    this.source = source;
    this.scene = scene;
    this.sceneDepth = sceneDepth;
    this.underwater = underwater;
    this.camera = camera;
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.target.texture.name = 'OceanReflections';
    this.material.name = 'ocean-ssr';
    this.textureNode = passTexture(this as never, this.target.texture);
    this.projection = uniform(camera.projectionMatrix);
    this.projectionInverse = uniform(camera.projectionMatrixInverse);
    this.view = uniform(camera.matrixWorldInverse);
    this.viewInverse = uniform(camera.matrixWorld);
    this.near = reference('near', 'float', camera);
    this.far = reference('far', 'float', camera);
    this.envIntensity = reference('environmentIntensity', 'float', scene);
  }

  getTextureNode(): N {
    return this.textureNode;
  }

  get sizes(): { full: N; trace: N } {
    return { full: this.fullSize, trace: this.traceSize };
  }

  override setup(): N {
    this.buildMaterial();
    return this.textureNode;
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    const renderer = frame.renderer as N;
    // The probe exists after its first capture: the trace needs it for the reflection it replaces.
    if (this.scene.environment !== this.environment && this.scene.environment) this.buildMaterial();
    rendererState = RendererUtils.resetRendererState(renderer, rendererState as never);
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x * this.resolutionScale));
    const height = Math.max(1, Math.round(size.y * this.resolutionScale));
    (this.fullSize.value as Vector2).copy(size);
    (this.traceSize.value as Vector2).set(width, height);
    this.camera.getWorldPosition(this.cameraWorld.value as Vector3);
    this.target.setSize(width, height);
    quad.material = this.material;
    quad.name = 'OceanReflections';
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, rendererState);
    return undefined;
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    super.dispose();
  }

  private buildMaterial(): void {
    this.environment = this.scene.environment;
    this.material.fragmentNode = this.trace();
    this.material.needsUpdate = true;
  }

  private viewZOf(depth: N): N {
    return perspectiveDepthToViewZ(depth, this.near, this.far);
  }

  // One texel: the sea under its centre, its reflection weight, ray, trace and probe reflection.
  private trace(): N {
    const { params, source } = this;
    const opaqueDepth = texture(source.depth);
    return Fn(() => {
      const full = this.fullSize;
      const coord = uv().toVar();
      const pixel = ivec2(clamp(floor(coord.mul(full)), vec2(0), full.sub(1))).toVar();
      const sceneZ = this.viewZOf(this.sceneDepth.load(pixel).r);
      const seaZ = seaViewZ(sceneZ, this.viewZOf(opaqueDepth.load(pixel).x)).toVar();
      const result = vec4(0).toVar('ssrResult');
      If(seaZ.lessThan(0).and(this.underwater.lessThan(0.5)), () => {
        result.assign(vec4(0, 0, 0, seaZ));
        // The surface point: the pixel's view ray scaled to the sea's view z.
        const ndc = vec2(coord.x.mul(2).sub(1), float(1).sub(coord.y.mul(2)));
        const onRay = this.projectionInverse.mul(vec4(ndc, 0.5, 1));
        const rayView = onRay.xyz.div(onRay.w);
        const origin = rayView.mul(seaZ.div(rayView.z)).toVar();
        const world = this.viewInverse.mul(vec4(origin, 1)).xyz.toVar();
        const toCamera = this.cameraWorld.sub(world);
        const v = normalize(toCamera).toVar();
        // Lagrangian point: undo the cascades' displacement (fixed point, two steps).
        const camera = this.cameraWorld;
        const lagrangian = world.xz.toVar();
        for (let i = 0; i < 2; i++) {
          const distance = length(vec3(lagrangian.x, 0, lagrangian.y).sub(camera));
          lagrangian.assign(world.xz.sub(source.displacement(lagrangian, distance).xz));
        }
        // Metres per full-resolution pixel: across the view (the finer axis) and along it, foreshortened
        // (the worse axis, the material's derivative footprint).
        const pixelAngle = float(2).div(this.projection.element(1).y.mul(full.y));
        const across = length(toCamera).mul(pixelAngle).toVar();
        const footprint = across.div(max(abs(v.y), 0.02));
        const { normal, alpha2 } = source.surface(lagrangian, footprint, across);
        const n = normal.toVar();
        const roughness = sqrt(sqrt(alpha2)).toVar();
        // As OceanLightingModel.indirect: roughness-aware Fresnel; mirror-smooth, upward rays only.
        const grazing = max(float(1).sub(roughness), WATER_F0)
          .sub(WATER_F0)
          .div(1 - WATER_F0);
        const fresnel = mix(float(WATER_F0), fresnelNode(max(dot(n, v), 0), 1 / WATER_IOR), grazing);
        const r = v.negate().reflect(n).toVar();
        const weight = fresnel
          .mul(float(1).sub(smoothstep(0.16, 0.42, roughness)))
          .mul(smoothstep(0, 0.04, r.y))
          .mul(float(1).sub(this.underwater))
          .toVar();
        If(weight.greaterThan(SSR_MIN_WEIGHT), () => {
          const dir = normalize(this.view.mul(vec4(r, 0)).xyz);
          const hit = this.march(params, source, origin, dir);
          If(hit.a.greaterThan(0), () => {
            let env: N = vec3(0);
            if (this.environment) {
              env = pmremTexture(this.environment, vec3(r.x, abs(r.y), r.z), roughness).rgb.mul(
                this.envIntensity,
              );
            }
            result.assign(vec4(hit.rgb.sub(env).mul(hit.a.mul(weight)), seaZ));
          });
        });
      });
      return result;
    })();
  }

  // The reflected ray (view space) marched through the opaque depth copy: the hit's colour and
  // confidence, or a = 0.
  private march(params: SsrParams, source: OceanReflectionSource, origin: N, dir: N): N {
    const full = this.fullSize;
    const opaqueDepth = texture(source.depth);
    const opaqueColor = texture(source.color);
    const out = vec4(0).toVar('ssrHit');
    const sceneViewZ = (at: N): N => {
      const pixel = ivec2(at.mul(full).clamp(vec2(0), full.sub(1)));
      return this.viewZOf(opaqueDepth.load(pixel).x);
    };
    const toUv = (clip: N): N =>
      vec2(clip.x.div(clip.w).mul(0.5).add(0.5), clip.y.div(clip.w).mul(-0.5).add(0.5));
    const exit = (start: N, step: N): N =>
      select(
        step.greaterThan(1e-6),
        float(1).sub(start).div(step),
        select(step.lessThan(-1e-6), start.negate().div(step), float(1)),
      );
    // Stop short of the near plane for rays coming back toward the camera.
    const toNear = this.near.mul(-2).sub(origin.z).div(max(dir.z, 1e-4));
    const reach = select(
      dir.z.greaterThan(0),
      min(float(params.maxDistance), toNear),
      float(params.maxDistance),
    );
    const end = origin.add(dir.mul(reach));
    const c0 = this.projection.mul(vec4(origin, 1)).toVar();
    const c1 = this.projection.mul(vec4(end, 1)).toVar();
    const uv0 = toUv(c0).toVar();
    const delta = toUv(c1).sub(uv0).toVar();
    // The part of the segment that is on screen.
    const span = min(float(1), min(exit(uv0.x, delta.x), exit(uv0.y, delta.y))).toVar();
    // View z interpolates linearly in screen space as z/w against 1/w.
    const k0 = float(1).div(c0.w).toVar();
    const k1 = float(1).div(c1.w).toVar();
    const q0 = origin.z.mul(k0).toVar();
    const q1 = end.z.mul(k1).toVar();
    const rayZ = (t: N): N => mix(q0, q1, t).div(mix(k0, k1, t));
    // Interleaved gradient noise, shifted per frame (TRAA averages the steps' banding away).
    const noise = screenCoordinate.xy.add(source.frame.mul(vec2(5.588238, 3.7)));
    const jitter = fract(fract(dot(noise, vec2(0.06711056, 0.00583715))).mul(52.9829189)).toVar();
    // Only the stretch over some boat (ssrOccluders.ts) can hit: elsewhere the depth copy is sky.
    // Per rectangle: the slab interval of t within [0, span], kept if the ray gets farther from
    // the camera there than the boat's nearest point (view z is monotonic along the ray).
    const enter = float(1e9).toVar();
    const leave = float(-1).toVar();
    const nonZero = (d: N): N => select(abs(d).lessThan(1e-7), float(1e-7), d);
    const invDelta = float(1)
      .div(vec2(nonZero(delta.x), nonZero(delta.y)))
      .toVar();
    Loop(
      { start: int(0), end: int(source.occluderCount), type: 'int', condition: '<' },
      ({ i }: { i: N }) => {
        const rect = source.occluders.element(i.mul(2));
        const ta = rect.xy.sub(uv0).mul(invDelta);
        const tb = rect.zw.sub(uv0).mul(invDelta);
        const lo = min(ta, tb);
        const hi = max(ta, tb);
        const a = max(max(lo.x, lo.y), 0).toVar();
        const b = min(min(hi.x, hi.y), span).toVar();
        If(a.lessThanEqual(b), () => {
          const farthest = min(rayZ(a), rayZ(b)).negate();
          If(farthest.greaterThanEqual(source.occluders.element(i.mul(2).add(1)).x), () => {
            enter.assign(min(enter, a));
            leave.assign(max(leave, b));
          });
        });
      },
    );
    const steps = params.steps;
    // Denser near the start, where contact reflections need the precision.
    const sampleT = (i: N): N => {
      const f = float(i).add(jitter).div(steps);
      return f.mul(f).mul(span);
    };
    const hitT = float(-1).toVar();
    const lastT = float(0).toVar();
    const lastZ = origin.z.toVar();
    If(leave.greaterThanEqual(enter), () => {
      // The sample indices within [enter, leave] (ssrOccluders.marchRange): the samples outside
      // could not hit, so the hit, and the bisection from the sample before it, match a full march.
      const range = max(span, 1e-6);
      const first = int(clamp(ceil(sqrt(enter.div(range)).mul(steps).sub(jitter)), 0, steps)).toVar();
      const last = int(clamp(floor(sqrt(leave.div(range)).mul(steps).sub(jitter)), -1, steps - 1)).toVar();
      If(first.greaterThan(0), () => {
        lastT.assign(sampleT(first.sub(1)));
        lastZ.assign(rayZ(lastT));
      });
      Loop({ start: first, end: last, type: 'int', condition: '<=' }, ({ i }: { i: N }) => {
        const t = sampleT(i).toVar();
        const z = rayZ(t).toVar();
        const behind = sceneViewZ(uv0.add(delta.mul(t))).sub(z); // > 0 once behind the scene
        const thickness = max(abs(z.sub(lastZ)).mul(1.5), z.negate().mul(0.02).add(0.4));
        If(behind.greaterThan(0).and(behind.lessThan(thickness)), () => {
          hitT.assign(t);
          Break();
        });
        lastT.assign(t);
        lastZ.assign(z);
      });
    });
    If(hitT.greaterThan(0), () => {
      const lo = lastT.toVar();
      const hi = hitT.toVar();
      for (let r = 0; r < params.refine; r++) {
        const mid = lo.add(hi).mul(0.5).toVar();
        const isBehind = sceneViewZ(uv0.add(delta.mul(mid))).greaterThan(rayZ(mid));
        hi.assign(select(isBehind, mid, hi));
        lo.assign(select(isBehind, lo, mid));
      }
      const hitUv = uv0.add(delta.mul(hi)).toVar();
      const border = min(min(hitUv.x, float(1).sub(hitUv.x)), min(hitUv.y, float(1).sub(hitUv.y)));
      const edge = smoothstep(0, 0.07, border);
      const far = float(1).sub(smoothstep(0.75, 1, hi));
      // Nothing much nearer the camera than the water it is reflected in: a ray can only come back
      // that far toward the camera to meet the far side of what the camera sees (from a bridge or
      // cockpit, the window frames and posts of the boat's own interior, whose lit inner faces
      // made warm vertical bands in the sea through the windows).
      const nearer = sceneViewZ(hitUv).div(min(origin.z, -1e-3));
      const facing = smoothstep(0.2, 0.4, nearer);
      const confidence = saturate(edge.mul(far).mul(facing));
      const pixel = ivec2(hitUv.mul(full).clamp(vec2(0), full.sub(1)));
      out.assign(vec4(opaqueColor.load(pixel).rgb, confidence));
    });
    return out;
  }
}

// The frame plus the traced swap, where the sea is: colour + a·W·(hit − env), upsampled from the
// trace's resolution by bilinear weights that skip texels without sea and fall off across depth.
export function composeReflections(
  color: N,
  node: OceanReflectionNode,
  source: OceanReflectionSource,
  sceneDepth: N,
  camera: PerspectiveCamera,
): N {
  const trace: N = node.getTextureNode();
  const opaqueDepth = texture(source.depth);
  const { full, trace: traceSize } = node.sizes;
  const near = reference('near', 'float', camera);
  const far = reference('far', 'float', camera);
  const viewZOf = (depth: N): N => perspectiveDepthToViewZ(depth, near, far);
  return Fn(() => {
    const coord = uv();
    const pixel = ivec2(clamp(floor(coord.mul(full)), vec2(0), full.sub(1))).toVar();
    const seaZ = seaViewZ(viewZOf(sceneDepth.load(pixel).r), viewZOf(opaqueDepth.load(pixel).x)).toVar();
    const out = color.toVar();
    If(seaZ.lessThan(0), () => {
      const swap = vec3(0).toVar();
      if (node.resolutionScale >= 1) {
        const sample = trace.load(pixel);
        swap.assign(select(sample.a.lessThan(0), sample.rgb, vec3(0)));
      } else {
        const tolerance = abs(seaZ).mul(0.03).add(0.05);
        const h = vec2(pixel).add(0.5).mul(traceSize).div(full).sub(0.5).toVar();
        const base = floor(h).toVar();
        const f = h.sub(base).toVar();
        const sum = vec3(0).toVar();
        const total = float(0).toVar();
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          const sample = trace.load(ivec2(clamp(base.add(vec2(dx, dy)), vec2(0), traceSize.sub(1))));
          const gap = sample.a.sub(seaZ).div(tolerance);
          const bilinear = (dx ? f.x : float(1).sub(f.x)).mul(dy ? f.y : float(1).sub(f.y));
          const w = bilinear
            .div(gap.mul(gap).add(1))
            .mul(select(sample.a.lessThan(0), float(1), float(0)))
            .toVar();
          sum.addAssign(sample.rgb.mul(w));
          total.addAssign(w);
        }
        If(total.greaterThan(1e-4), () => {
          swap.assign(sum.div(total));
        });
      }
      out.assign(vec4(max(color.rgb.add(swap), vec3(0)), color.a));
    });
    return out;
  })();
}
