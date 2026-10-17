// Water exclusion: keeps the sea surface out of cockpits, deck wells and hull interiors.
//
// Each BoatVisual's waterMask (a closed volume: the hull below the potential waterline plus any
// open well) is drawn before the ocean into a small float target that records, per pixel, the view
// depths where the ray enters and leaves mask volumes (max-blended, no depth test):
//   r = 1 / nearest front face,  g = 1 / nearest back face,  b = farthest back face.
// The ocean discards a fragment at view depth d when it lies inside a volume:
//   camera outside (front before back):  front < d < farthest back
//   camera inside  (a back face first):  d < nearest back, or inside a further volume as above
// This is the stencil exclusion-volume test done with depths, so it works from the helm (camera
// inside the cockpit volume) and from outside alike, and the sea still shows past the volume —
// over the side, or through a window — where the ray has left it. Opaque hull geometry hides
// anything behind the far side of a volume anyway.

import {
  type BufferGeometry,
  CustomBlending,
  DoubleSide,
  HalfFloatType,
  MaxEquation,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  OneFactor,
  RenderTarget,
  RGBAFormat,
  Scene,
  type Camera,
  Color,
  type Texture,
  Vector2,
  type WebGPURenderer,
} from 'three/webgpu';

import type { BoatVisual } from '../boats/kit/BoatVisual';
import { type N, tsl } from '../tsl';

const { float, frontFacing, max, positionView, select, screenUV, texture, vec4 } = tsl;

const FAR = 1e9;
const MARGIN = 0.05; // m: water just outside a hull face is kept

// Signed volume of a closed mesh: > 0 when its triangles wind counter-clockwise seen from outside.
function signedVolume(geometry: BufferGeometry): number {
  const p = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const count = index ? index.count : p.count;
  let volume = 0;
  for (let t = 0; t + 2 < count; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    const ax = p.getX(a);
    const ay = p.getY(a);
    const az = p.getZ(a);
    const bx = p.getX(b);
    const by = p.getY(b);
    const bz = p.getZ(b);
    const cx = p.getX(c);
    const cy = p.getY(c);
    const cz = p.getZ(c);
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

const size = new Vector2();
const clearColor = new Color();

export class WaterMask {
  readonly target: RenderTarget;
  private readonly scene = new Scene();
  private readonly material: MeshBasicNodeMaterial;
  private readonly inverted: MeshBasicNodeMaterial; // for masks wound inside-out
  private readonly proxies = new Map<BoatVisual, Mesh>();
  private readonly seen = new Set<BoatVisual>(); // this frame's visuals (render)
  private cleared = false;

  constructor() {
    this.scene.name = 'water-mask';
    this.material = WaterMask.createMaterial(false);
    this.inverted = WaterMask.createMaterial(true);
    this.target = new RenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      depthBuffer: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'ocean-water-mask';
    this.scene.name = 'water-mask';
  }

  private static createMaterial(inverted: boolean): MeshBasicNodeMaterial {
    const material = new MeshBasicNodeMaterial({
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendEquation: MaxEquation,
      blendEquationAlpha: MaxEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: OneFactor,
      blendDstAlpha: OneFactor,
    });
    material.fog = false;
    material.toneMapped = false;
    const depth = max(positionView.z.negate(), 1e-3);
    const inverse = float(1).div(depth);
    const entering = inverted ? frontFacing.not() : frontFacing;
    material.outputNode = select(entering, vec4(inverse, 0, 0, 1), vec4(0, inverse, depth, 1));
    material.name = 'ocean-water-mask';
    return material;
  }

  get texture(): Texture {
    return this.target.texture;
  }

  // The ocean keeps a fragment unless it lies inside a mask volume (for OceanMaterial.maskNode).
  static keepNode(mask: Texture): N {
    const m = texture(mask, screenUV).level(0);
    const d = positionView.z.negate();
    const nearestFront = select(m.x.greaterThan(0), float(1).div(m.x), float(FAR));
    const nearestBack = select(m.y.greaterThan(0), float(1).div(m.y), float(FAR));
    const farthestBack = m.z;
    const inside = nearestBack.lessThan(nearestFront).and(d.lessThan(nearestBack.sub(MARGIN)));
    const within = d.greaterThan(nearestFront.add(MARGIN)).and(d.lessThan(farthestBack.sub(MARGIN)));
    return inside.or(within).not();
  }

  // Draws the masks of these boats as seen by the camera (call after the boats were posed and their
  // world matrices updated).
  render(renderer: WebGPURenderer, camera: Camera, visuals: Iterable<BoatVisual>): void {
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x));
    const height = Math.max(1, Math.round(size.y));
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height);
      this.cleared = false;
    }
    const seen = this.seen;
    seen.clear();
    for (const visual of visuals) {
      seen.add(visual);
      let proxy = this.proxies.get(visual);
      if (!proxy) {
        const geometry = visual.waterMask.geometry;
        proxy = new Mesh(geometry, signedVolume(geometry) < 0 ? this.inverted : this.material);
        proxy.matrixAutoUpdate = false;
        proxy.matrixWorldAutoUpdate = false;
        this.proxies.set(visual, proxy);
        this.scene.add(proxy);
      }
      proxy.matrixWorld.copy(visual.waterMask.matrixWorld); // the scene's world matrices are current
      proxy.visible = visual.root.visible && visual.root.parent !== null;
      // Culled by its bounds (boats out of view cost no draw), except while the boat warms up.
      proxy.frustumCulled = visual.root.frustumCulled;
    }
    for (const [visual, proxy] of this.proxies) {
      if (seen.has(visual)) continue;
      this.scene.remove(proxy);
      proxy.dispose(); // its render objects: the geometry (the boat's) and the shared materials stay
      this.proxies.delete(visual);
    }
    if (this.proxies.size === 0 && this.cleared) return;
    const previousTarget = renderer.getRenderTarget();
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, previousAlpha);
    this.cleared = true;
  }

  dispose(): void {
    for (const proxy of this.proxies.values()) proxy.dispose();
    this.proxies.clear();
    this.target.dispose();
    this.material.dispose();
    this.inverted.dispose();
  }
}
