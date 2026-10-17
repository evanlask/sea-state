// Lens droplets: water on the camera lens or the bridge windows, from the drop simulation
// (lensDrops). Two steps, both cheap:
//
//   layer    the drops (≤ LENS_DROP_CAP) are drawn as instanced quads, additively, into a small
//            half-float target (≤ 720 px tall): per pixel Σ (offset from the drop's centre,
//            thickness, coverage), each drop an elliptical cap (sheets long and thin). Touching
//            drops sum smoothly, like the films that join them.
//   post     one sample of that target per pixel; inside a drop the scene is sampled through it:
//            flipped and shrunk (a ray through a drop's rim sees the far side of the view), a little
//            blurred (drops sit far out of focus), slightly darker toward the rim where the surface
//            turns away, with a thin highlight on the side toward the sky.
//
// With the glass dry the layer isn't drawn and the post pass is a single copy. The pass adds one
// sampler (the layer) to the post shader.

import {
  AddEquation,
  Color,
  CustomBlending,
  DynamicDrawUsage,
  Float32BufferAttribute,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  OrthographicCamera,
  RenderTarget,
  RGBAFormat,
  Scene,
  type Texture,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu';

import { type N, tsl } from '../tsl';
import { LENS_DROP_CAP, type LensDrops, packLensDrops } from './lensDrops';
import type { LensView } from './lensWetness';

const {
  Fn,
  If,
  attribute,
  dot,
  float,
  length,
  max,
  mix,
  positionGeometry,
  saturate,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} = tsl;

// --- tuning ---
const REFRACTION = 3; // the view through a drop: uv offset = −3 × (offset from its centre)
const BLUR_PX = 2.5; // spread of the blur through a drop (4 taps)
const OPACITY = 0.82; // how much of a drop's view replaces the scene at full coverage
const DARKEN = 0.04; // light lost through a drop
const RIM_DARK = 0.22; // extra darkening at the rim
const GLINT = 0.16; // the highlight toward the sky
const EDGE = 0.65; // a drop's edge softens from this share of its radius out
// --- end tuning ---

const QUAD_MARGIN = 1.1; // quads a little larger than the drop, so its soft edge isn't clipped
const TARGET_MAX_HEIGHT = 720; // px of the drop layer, at most

export class LensDropletUniforms {
  readonly active: N = uniform(0);
  readonly windowDistance: N = uniform(0); // m; 0 = the whole frame is glass
  readonly strength: N = uniform(1); // refraction scale (lens vs window)
  readonly aspect: N = uniform(16 / 9);
  readonly texel: N = uniform(new Vector2(1 / 1920, 1 / 1080));

  get isActive(): boolean {
    return (this.active.value as number) > 0.5;
  }

  set(count: number, view: LensView, width: number, height: number): void {
    this.active.value = count > 0 ? 1 : 0;
    this.windowDistance.value = view.mode === 'window' ? view.windowDistance : 0;
    this.strength.value = view.mode === 'window' ? 0.6 : 1;
    this.aspect.value = width / Math.max(1, height);
    (this.texel.value as Vector2).set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }
}

const size = new Vector2();
const clearColor = new Color();

// The drops drawn into the layer target (see the header).
export class LensDropLayer {
  readonly target: RenderTarget;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera();
  private readonly geometry: InstancedBufferGeometry;
  private readonly shape: InstancedBufferAttribute;
  private readonly look: InstancedBufferAttribute;
  private readonly material: MeshBasicNodeMaterial;

  constructor(uniforms: LensDropletUniforms) {
    this.scene.name = 'lens-droplets';
    this.target = new RenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'lens-drops';
    this.geometry = LensDropLayer.createGeometry();
    this.shape = this.geometry.getAttribute('dropShape') as InstancedBufferAttribute;
    this.look = this.geometry.getAttribute('dropLook') as InstancedBufferAttribute;
    this.material = LensDropLayer.createMaterial(uniforms.aspect);
    const mesh = new Mesh(this.geometry, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.scene.name = 'lens-drops';
  }

  // A unit quad per drop, with room for LENS_DROP_CAP instances.
  static createGeometry(): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    for (const name of ['dropShape', 'dropLook']) {
      const a = new InstancedBufferAttribute(new Float32Array(LENS_DROP_CAP * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
    }
    g.instanceCount = 0;
    return g;
  }

  // One drop per instance: dropShape = (x, y, r, stretch) in screen heights (y down), dropLook =
  // (long axis, opacity, 0). Writes (Σ offset from the centre, Σ thickness, Σ coverage).
  static createMaterial(aspect: N): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendEquationAlpha: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
    });
    material.fog = false;
    material.toneMapped = false;
    const shape = attribute('dropShape', 'vec4');
    const look = attribute('dropLook', 'vec4');
    const corner = positionGeometry.xy.mul(QUAD_MARGIN); // in drop radii
    const axis = look.xy;
    const across = vec2(axis.y.negate(), axis.x);
    const r = shape.z;
    const p = shape.xy.add(across.mul(corner.x.mul(r))).add(axis.mul(corner.y.mul(r).mul(shape.w)));
    material.vertexNode = vec4(p.x.div(aspect).mul(2).sub(1), float(1).sub(p.y.mul(2)), 0, 1);
    const q2 = dot(corner, corner);
    const m = smoothstep(1, EDGE, q2.sqrt()).mul(look.z);
    // The offset across a sheet is its width's, not its length's: it refracts like a long bead.
    const d = across.mul(corner.x).add(axis.mul(corner.y)).mul(r);
    material.outputNode = vec4(d.mul(m), float(1).sub(q2).max(0).mul(m), m);
    material.name = 'lens-drops';
    return material;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  // Uploads the drops and draws them (before the post pass); returns how many there are.
  render(renderer: WebGPURenderer, drops: Readonly<LensDrops>): number {
    const n = packLensDrops(drops, this.shape.array as Float32Array, this.look.array as Float32Array);
    this.geometry.instanceCount = n;
    if (n === 0) return 0;
    renderer.getDrawingBufferSize(size);
    const scale = Math.min(1, TARGET_MAX_HEIGHT / Math.max(1, size.y));
    const width = Math.max(1, Math.round(size.x * scale));
    const height = Math.max(1, Math.round(size.y * scale));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.shape.clearUpdateRanges();
    this.shape.addUpdateRange(0, n * 4);
    this.shape.needsUpdate = true;
    this.look.clearUpdateRanges();
    this.look.addUpdateRange(0, n * 4);
    this.look.needsUpdate = true;
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    const previousAutoClear = renderer.autoClear;
    renderer.getClearColor(clearColor);
    // Always from clear: the layer is additive, so anything left over would stay on the glass.
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    renderer.setClearColor(clearColor, previousAlpha);
    return n;
  }

  dispose(): void {
    this.target.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// `color` must be a texture node (it is sampled away from the pixel); `drops` the layer's texture;
// `viewZ` the scene's view-space depth at this pixel (window mode keeps the inside of the
// wheelhouse dry).
export function lensDroplets(color: N, drops: Texture, viewZ: N, u: LensDropletUniforms): N {
  const layer = texture(drops);
  return Fn(() => lensDropletsBody(color, layer, viewZ, u))();
}

function lensDropletsBody(color: N, layer: N, viewZ: N, u: LensDropletUniforms): N {
  const coord = uv();
  const base = color.sample(coord).toVar();
  const out = vec4(base).toVar();
  If(u.active.greaterThan(0.5), () => {
    const w = layer.sample(coord).level(0).toVar();
    const glass = u.windowDistance
      .lessThanEqual(0)
      .select(float(1), smoothstep(u.windowDistance, u.windowDistance.mul(1.25), viewZ.negate()));
    const cover = smoothstep(0.02, 0.6, w.a).mul(glass).toVar();
    If(cover.greaterThan(0.002), () => {
      // Through the drop: the view flipped about its centre, shrunk and softly blurred.
      const offset = vec2(w.r.div(u.aspect), w.g).mul(-REFRACTION).mul(u.strength);
      const at = coord.add(offset);
      const spread = u.texel.mul(BLUR_PX);
      const across = vec2(spread.x, spread.y.negate());
      const seen = color
        .sample(at.add(spread))
        .level(0)
        .add(color.sample(at.sub(spread)).level(0))
        .add(color.sample(at.add(across)).level(0))
        .add(color.sample(at.sub(across)).level(0))
        .mul(0.25);
      // Thickness 1 at a drop's centre, 0 at its rim; the rim faces the light up and to the left.
      const thick = saturate(w.b.div(max(w.a, 1e-3)));
      const rim = float(1).sub(thick);
      const outward = w.rg.div(max(length(w.rg), 1e-6));
      const glint = smoothstep(0.5, 0.95, dot(outward, vec2(-0.6, -0.8)))
        .mul(smoothstep(0.55, 0.85, rim))
        .mul(smoothstep(0.98, 0.9, rim))
        .mul(GLINT);
      const drop = seen.rgb
        .mul(float(1 - DARKEN).sub(rim.mul(rim).mul(RIM_DARK)))
        .add(seen.rgb.max(0.05).mul(glint));
      out.assign(vec4(mix(base.rgb, drop, cover.mul(OPACITY)), base.a));
    });
  });
  return out;
}
