// Instanced lamps for one boat: a small emissive lens per light (masked per pixel by its sector or
// beam, so a sidelight's lens goes dark past its arc) and a camera-facing glow sprite whose size and
// brightness follow the point-source physics in glowMath.ts. Two draw calls per field whatever the
// light count. Intensities are per instance (0 = off) and cheap to change.

import {
  AdditiveBlending,
  Group,
  InstancedBufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  SphereGeometry,
  Sprite,
  SpriteNodeMaterial,
} from 'three/webgpu';

import { releaseBuffer } from '../../gpuResources';
import { type N, tsl } from '../../tsl';
import { type LightSector, type Rgb, sectorCentre } from './colregs';
import { MAX_PRE_EXPOSED } from './glowMath';
import {
  cameraInObject,
  glowNodes,
  glowRadiance,
  lightUniforms,
  MODE_CONE,
  MODE_SECTOR,
  pixelAngleNode,
  transmittanceNode,
  twinkleNode,
  visibilityNode,
} from './lightNodes';
import type { Vec3Like } from './mounts';

const {
  float,
  instancedDynamicBufferAttribute,
  length,
  max,
  min,
  positionGeometry,
  uv,
  varying,
  vec2,
  vec4,
} = tsl;

type LampShape =
  | { mode: 'sector'; sector: LightSector; verticalFloor: number }
  | { mode: 'cone'; direction: Vec3Like; angle: number; leak: number };

export interface LampEntry {
  position: Vec3Like; // body frame
  lensRadius: number; // m
  colour: Rgb; // linear, unit luminance
  intensity: number; // cd toward the viewer when on (beam axis for cones)
  shape: LampShape;
}

export interface LampFieldOptions {
  lens?: boolean; // draw the lens meshes (default true); without them the glow core grows instead
}

const CONE_EDGE = 10 * (Math.PI / 180); // beam edge to housing leak

export class LampField {
  readonly object = new Group();
  readonly count: number;
  private entries: LampEntry[];
  private emission: InstancedBufferAttribute;
  private disposables: { dispose(): void }[] = [];
  private buffers: InstancedBufferAttribute[] = []; // the per-lamp vertex buffers (freed by dispose)
  private glow: Sprite;
  private lit = 0; // lamps with a non-zero intensity
  private warm = false;

  constructor(entries: readonly LampEntry[], options: LampFieldOptions = {}) {
    this.object.name = 'lamp-field';
    this.entries = entries.map((e) => ({ ...e }));
    const n = Math.max(1, entries.length);
    this.count = entries.length;
    const position = new Float32Array(n * 4);
    const emission = new Float32Array(n * 4);
    const shape = new Float32Array(n * 4);
    const edge0 = new Float32Array(n * 4);
    const edge1 = new Float32Array(n * 4);
    entries.forEach((e, i) => {
      const o = i * 4;
      position.set([e.position.x, e.position.y, e.position.z, e.lensRadius], o);
      emission.set([e.colour[0], e.colour[1], e.colour[2], 0], o);
      if (e.shape.mode === 'sector') {
        const { centre, halfWidth } = sectorCentre(e.shape.sector);
        const a = e.shape.sector.fromEdge;
        const b = e.shape.sector.toEdge;
        shape.set([centre, halfWidth, e.shape.verticalFloor, 0], o);
        edge0.set([a.insideFade, a.edgeValue, a.outsideCutoff, MODE_SECTOR], o);
        edge1.set([b.insideFade, b.edgeValue, b.outsideCutoff, 0], o);
      } else {
        const d = e.shape.direction;
        const l = Math.hypot(d.x, d.y, d.z) || 1;
        // Distinct inner and outer cosines (smoothstep with equal edges is undefined in WGSL).
        const inner = Math.min(e.shape.angle, Math.PI - 2 * CONE_EDGE);
        shape.set([d.x / l, d.y / l, d.z / l, Math.cos(inner)], o);
        edge0.set([Math.cos(inner + CONE_EDGE), e.shape.leak, 0, MODE_CONE], o);
      }
    });
    // Golden-angle phases so neighbouring lamps don't twinkle in step.
    const phase = new Float32Array(n);
    for (let i = 0; i < n; i++) phase[i] = (i * 2.399963) % (Math.PI * 2);

    this.emission = new InstancedBufferAttribute(emission, 4);
    this.buffers.push(this.emission);
    const attr = (array: Float32Array, size = 4): N => {
      const buffer = new InstancedBufferAttribute(array, size);
      this.buffers.push(buffer);
      return instancedDynamicBufferAttribute(buffer);
    };
    const aPosition = attr(position);
    const aEmission = instancedDynamicBufferAttribute(this.emission);
    const aShape = attr(shape);
    const aEdge0 = attr(edge0);
    const aEdge1 = attr(edge1);
    const aPhase = attr(phase, 1);
    const pre = lightUniforms.preExposure;
    const lensDrawn = options.lens !== false;

    // --- Glow sprites (vertex-stage physics, fragment-stage profile).
    const camera = cameraInObject();
    const toViewer = camera.sub(aPosition.xyz);
    const distance = length(toViewer);
    const visible = visibilityNode(toViewer, aShape, aEdge0, aEdge1);
    const px = pixelAngleNode();
    const illuminance = aEmission.xyz
      .mul(aEmission.w)
      .mul(visible)
      .mul(transmittanceNode(distance))
      .mul(twinkleNode(distance, aPhase))
      .mul(pre)
      .div(max(distance.mul(distance), 1e-4));
    const glow = glowNodes(illuminance, aPosition.w.div(max(distance, 1e-3)), px, lensDrawn);
    const vIlluminance = varying(illuminance, 'vLampE');
    const vGlow = {
      coreSigma: varying(glow.coreSigma, 'vLampSigma'),
      coreWeight: varying(glow.coreWeight, 'vLampCore'),
      quadRadius: varying(glow.quadRadius, 'vLampQuad'),
      theta0: varying(glow.theta0, 'vLampTheta0'),
    };
    const spriteMaterial = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      sizeAttenuation: false,
      fog: false,
    });
    // Pulled toward the camera past the lens so the lens surface doesn't clip the glow.
    const pull = aPosition.w.mul(1.6).add(0.03);
    spriteMaterial.positionNode = aPosition.xyz.add(toViewer.div(max(distance, 1e-3)).mul(pull));
    spriteMaterial.scaleNode = vec2(glow.quadRadius.mul(2));
    const theta = length(uv().sub(0.5)).mul(2).mul(vGlow.quadRadius);
    spriteMaterial.colorNode = vec4(glowRadiance(vIlluminance, theta, vGlow), 1);
    const sprite = new Sprite(spriteMaterial);
    sprite.count = this.count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 10;
    sprite.name = 'lamp-glow';
    sprite.visible = false; // drawn while a lamp is lit (or warming up): dark glows add nothing
    this.glow = sprite;
    this.object.add(sprite);
    this.object.visible = this.count > 0;
    this.disposables.push(spriteMaterial);

    // --- Lens meshes: dim tinted glass by day, lit by the light's luminance toward the viewer.
    if (lensDrawn) {
      const geometry = new SphereGeometry(1, 12, 8);
      const material = new MeshStandardNodeMaterial({ roughness: 0.25, metalness: 0 });
      const local = positionGeometry.mul(aPosition.w).add(aPosition.xyz);
      material.positionNode = local;
      const vLocal = varying(local, 'vLampLocal');
      const lensToViewer = cameraInObject().sub(vLocal);
      const lensVisible = visibilityNode(lensToViewer, aShape, aEdge0, aEdge1);
      const colour = aEmission.xyz;
      const peak = max(max(colour.x, colour.y), max(colour.z, 1e-3));
      material.colorNode = colour.div(peak).mul(0.25);
      const luminance = aEmission.w.div(aPosition.w.mul(aPosition.w).mul(Math.PI));
      material.emissiveNode = min(colour.mul(luminance).mul(lensVisible).mul(pre), float(MAX_PRE_EXPOSED));
      const lens = new Mesh(geometry, material);
      lens.count = this.count;
      lens.frustumCulled = false;
      lens.name = 'lamp-lens';
      this.object.add(lens);
      this.disposables.push(geometry, material);
    }
  }

  get size(): number {
    return this.count;
  }

  intensityOf(index: number): number {
    return this.emission.array[index * 4 + 3] ?? 0;
  }

  entry(index: number): Readonly<LampEntry> | undefined {
    return this.entries[index];
  }

  // cd toward the viewer (0 = off).
  setIntensity(index: number, intensity: number): void {
    const array = this.emission.array as Float32Array;
    const i = index * 4 + 3;
    if (index < 0 || index >= this.count || array[i] === intensity) return;
    this.lit += (intensity !== 0 ? 1 : 0) - (array[i] !== 0 ? 1 : 0);
    array[i] = intensity;
    this.emission.needsUpdate = true;
    this.glow.visible = this.warm || this.lit > 0;
  }

  // Warm-up (loading, a boat joining): the glows draw even when dark, so their pipelines are built
  // before the first lamp lights.
  setWarmup(on: boolean): void {
    this.warm = on;
    this.glow.visible = on || this.lit > 0;
  }

  setOn(index: number, on: boolean): void {
    this.setIntensity(index, on ? (this.entries[index]?.intensity ?? 0) : 0);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    // three frees a buffer only through a geometry that holds it; these belong to nodes.
    for (const buffer of this.buffers) releaseBuffer(buffer);
    this.buffers = [];
    this.object.removeFromParent();
  }
}
