// Runtime boat visual. A model builder produces a BoatTemplate once per kind
// (geometry, materials, AO); every BoatVisual clones its LOD trees (sharing
// geometry and materials), exposes named light mounts, the helm eye point and
// a water-exclusion mask, animates radar scanners and wipers plus telemetry-driven
// parts (rudders, wheels, outboards, nozzles, booms), picks its LOD by projected
// size, and can drive a few real deck floodlights.
//
// Body frame: x starboard, y up (0 = design waterline), z aft (bow −Z); the
// root's origin is the physics body origin (centreline, design waterline,
// midway between the waterline ends), so BoatSnapshot.position applies as-is.

import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  type BufferGeometry,
  Group,
  type InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  type Object3D,
  type PerspectiveCamera,
  type Skeleton,
  type SkinnedMesh,
  SpotLight,
  type Texture,
  Vector3,
} from 'three/webgpu';

import type { BoatKind, SimEvent } from '../../../sim/world/protocol';
import { releaseBuffer } from '../../gpuResources';
import {
  type Animator,
  type AnimatorFactory,
  DriveSet,
  type Telemetry,
  type TelemetryDrive,
} from './animate';
import { boatEnvironment } from './environment';
import { DEFAULT_LOD_THRESHOLDS, type LodThresholds, projectedPixels, selectLod } from './lod';
import { INTERIOR_MESH, INTERIOR_SLOTS } from './slotMerge';

// COLREG navigation lights and signals (Annex I positions), plus working lights.
export type LightKind =
  | 'mastheadForward'
  | 'mastheadAft'
  | 'sidePort'
  | 'sideStarboard'
  | 'stern'
  | 'allRoundWhite'
  | 'nucUpper' // not under command: two all-round red, vertical line
  | 'nucLower'
  | 'anchorForward'
  | 'anchorAft'
  | 'fishingRed' // trawling/fishing: all-round red over white
  | 'fishingWhite'
  | 'tricolour'
  | 'spreader'
  | 'searchlight' // moves the boat's default searchlight mounts (lights/mounts.ts), same beam
  | 'deckFlood';

export interface LightMountSpec {
  kind: LightKind;
  position: [number, number, number];
  // Beam/aim direction for directional lights (floods); sector lights face their arc centre.
  direction?: [number, number, number];
  name?: string;
}

export interface LightMount {
  name: string;
  kind: LightKind;
  object: Object3D; // child of the root: world position/orientation via matrixWorld
}

export type AnimatedSpec =
  | { type: 'radar'; name: string; rpm: number }
  | { type: 'wiper'; name: string; amplitude: number; period: number; phase?: number };

export interface FloodSpec {
  position: [number, number, number];
  target: [number, number, number];
  intensity: number; // cd
  angle: number; // half-angle, rad
  distance?: number; // m
}

export interface BoatTemplate {
  kind: BoatKind;
  name: string;
  length: number; // LOA, m (LOD sizing)
  lods: Object3D[]; // LOD0 (full, with interior), LOD1, LOD2
  triangles: number[]; // per LOD, counting instances
  lodThresholds?: LodThresholds;
  lights: LightMountSpec[];
  floods: FloodSpec[];
  animated: AnimatedSpec[]; // node names inside LOD0
  eye: Vector3; // helm eye, body frame
  wingEyes?: { port: Vector3; starboard: Vector3 }; // bridge-wing camera variants
  // Closed volume of hull interior / open decks below the potential water level: render into the
  // stencil before the ocean so water isn't drawn inside the hull or the deck well.
  waterMask: BufferGeometry;
  drives?: TelemetryDrive[]; // telemetry-driven nodes (all LODs)
  animator?: AnimatorFactory; // linkages that need more than one axis (sheets, a rider's arms)
  textures?: Texture[]; // textures the template owns (liveries, the AO volume), freed with it
}

const NO_TELEMETRY: Telemetry = {};

function hasSkin(root: Object3D): boolean {
  let found = false;
  root.traverse((o) => {
    found ||= (o as SkinnedMesh).isSkinnedMesh === true;
  });
  return found;
}

// The skeleton clone gives every skinned mesh a skeleton of its own; meshes on the same bones with the
// same bind matrices (a character's body, hair, eyes, clothes) share one again, so its bone matrices
// are computed and uploaded once a frame.
function shareSkeletons(root: Object3D): Object3D {
  const skeletons: Skeleton[] = [];
  root.traverse((o) => {
    const mesh = o as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const own = mesh.skeleton;
    const same = skeletons.find(
      (s) =>
        s.bones.length === own.bones.length &&
        s.bones.every((bone, i) => bone === own.bones[i] && s.boneInverses[i]!.equals(own.boneInverses[i]!)),
    );
    if (same) mesh.bind(same, mesh.bindMatrix);
    else skeletons.push(own);
  });
  return root;
}

const tmp = new Vector3();

// Beyond the distance where a metre spans this many pixels the wheelhouse interior, seen only
// through tinted glass, is hidden (the camera on board is always nearer).
const INTERIOR_PIXELS_PER_METRE = 2;

// The wheelhouse interior's meshes (kit/bridge.ts slots, merged or not).
function interiorMeshes(lod: Object3D): Object3D[] {
  const out: Object3D[] = [];
  lod.traverse((o) => {
    if ((o as Mesh).isMesh && (INTERIOR_SLOTS.has(o.name) || o.name === INTERIOR_MESH)) out.push(o);
  });
  return out;
}

export class BoatVisual {
  readonly kind: BoatKind;
  readonly root = new Group();
  readonly lods: Object3D[];
  readonly lights: LightMount[] = [];
  readonly eye: Vector3;
  readonly wingEyes?: { port: Vector3; starboard: Vector3 };
  readonly waterMask: Mesh;
  readonly template: BoatTemplate;
  wipersOn = false;
  private lodIndex = 0;
  private forcedLod: number | null = null;
  private warm: { object: Object3D; culled: boolean }[] | null = null;
  private radars: { object: Object3D; speed: number }[] = [];
  private wipers: { object: Object3D; amplitude: number; period: number; phase: number }[] = [];
  private floodLights: SpotLight[] = [];
  private interior: Object3D[]; // LOD0's wheelhouse interior meshes
  private interiorShown = true;
  private time = 0;
  private telemetry: Telemetry = NO_TELEMETRY;
  private readonly drives: DriveSet;
  private readonly animator: Animator | null;

  constructor(template: BoatTemplate) {
    this.template = template;
    this.kind = template.kind;
    this.root.name = `boat:${template.kind}`;
    this.lods = template.lods.map((lod, i) => {
      // A skinned rider needs its own skeleton per visual, bound to the copied bones.
      const copy = hasSkin(lod) ? shareSkeletons(cloneSkinned(lod)) : lod.clone();
      copy.name = `lod${i}`;
      copy.visible = i === 0;
      this.root.add(copy);
      return copy;
    });
    this.eye = template.eye.clone();
    this.wingEyes = template.wingEyes && {
      port: template.wingEyes.port.clone(),
      starboard: template.wingEyes.starboard.clone(),
    };
    const counts = new Map<LightKind, number>();
    for (const spec of template.lights) {
      const n = counts.get(spec.kind) ?? 0;
      counts.set(spec.kind, n + 1);
      const name = spec.name ?? `light:${spec.kind}${n > 0 || spec.kind === 'deckFlood' ? `:${n}` : ''}`;
      const object = new Group();
      object.name = name;
      object.userData.lightKind = spec.kind;
      object.position.set(...spec.position);
      if (spec.direction) {
        tmp
          .set(...spec.direction)
          .normalize()
          .add(object.position);
        object.lookAt(tmp); // three's lookAt on non-cameras points +Z at the target
      }
      this.root.add(object);
      this.lights.push({ name, kind: spec.kind, object });
    }
    const lod0 = this.lods[0]!;
    this.interior = interiorMeshes(lod0);
    for (const spec of template.animated) {
      const object = lod0.getObjectByName(spec.name);
      if (!object) continue;
      object.matrixAutoUpdate = true;
      if (spec.type === 'radar') this.radars.push({ object, speed: (spec.rpm / 60) * Math.PI * 2 });
      else
        this.wipers.push({ object, amplitude: spec.amplitude, period: spec.period, phase: spec.phase ?? 0 });
    }
    const maskMaterial = new MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
    maskMaterial.name = 'water-mask';
    this.waterMask = new Mesh(template.waterMask, maskMaterial);
    this.waterMask.name = 'water-mask';
    this.waterMask.visible = false;
    this.root.add(this.waterMask);
    this.drives = new DriveSet(template.drives ?? [], this.lods);
    this.animator = template.animator?.(this.lods) ?? null;
  }

  // Latest BoatSnapshot.telemetry; drives read it on the next update.
  setTelemetry(telemetry: Telemetry): void {
    this.telemetry = telemetry;
  }

  // A sim event for this boat (a capsize throws the jet ski's rider off; a recovery seats him again).
  simEvent(type: SimEvent['type']): void {
    this.animator?.event?.(type);
  }

  get lod(): number {
    return this.lodIndex;
  }

  get triangles(): number {
    return this.template.triangles[this.lodIndex] ?? 0;
  }

  // null = automatic by projected size.
  setLod(index: number | null): void {
    this.forcedLod = index;
    if (index !== null) this.showLod(index);
  }

  // Warm-up (loading screens, a boat joining): every LOD drawn and nothing frustum-culled, so a
  // render or compileAsync() builds the pipelines of all levels, shadow passes included.
  setWarmup(on: boolean): void {
    if (on === (this.warm !== null)) return;
    if (on) {
      this.warm = [];
      this.root.traverse((object) => {
        this.warm!.push({ object, culled: object.frustumCulled });
        object.frustumCulled = false;
      });
      for (const lod of this.lods) lod.visible = true;
      this.showInterior(true);
      return;
    }
    for (const { object, culled } of this.warm ?? []) object.frustumCulled = culled;
    this.warm = null;
    this.showLod(this.lodIndex);
  }

  // Adds up to `count` real spot lights at the template's flood positions (costly: keep for the player boat).
  enableFloodLights(count: number): void {
    for (const light of this.floodLights) {
      this.root.remove(light, light.target);
      light.dispose();
    }
    this.floodLights = [];
    for (const spec of this.template.floods.slice(0, count)) {
      const light = new SpotLight(0xffe2b8, 0, spec.distance ?? 60, spec.angle, 0.5, 2);
      light.position.set(...spec.position);
      light.target.position.set(...spec.target);
      light.castShadow = false;
      light.userData.candela = spec.intensity;
      this.root.add(light, light.target);
      this.floodLights.push(light);
    }
  }

  get floodLightCount(): number {
    return this.floodLights.length;
  }

  update(dt: number, camera?: PerspectiveCamera, viewportHeight = 1080, telemetry?: Telemetry): void {
    this.time += dt;
    if (telemetry) this.telemetry = telemetry;
    this.drives.update(dt, this.telemetry);
    this.animator?.(dt, this.telemetry, this.lodIndex);
    for (const radar of this.radars) radar.object.rotation.y -= radar.speed * dt;
    for (const wiper of this.wipers) {
      const target = this.wipersOn
        ? wiper.amplitude * Math.sin((this.time / wiper.period) * Math.PI * 2 + wiper.phase)
        : -wiper.amplitude;
      wiper.object.rotation.z += (target - wiper.object.rotation.z) * Math.min(1, dt * 12);
    }
    const deck = boatEnvironment.deck.value as number;
    const exposure = boatEnvironment.preExposure.value as number;
    for (const light of this.floodLights) {
      light.intensity = (light.userData.candela as number) * deck * exposure;
    }
    if (this.warm === null && camera) {
      this.root.getWorldPosition(tmp);
      const distance = tmp.distanceTo(camera.position);
      const fov = (camera.fov * Math.PI) / 180;
      if (this.forcedLod === null) {
        const pixels = projectedPixels(this.template.length, distance, fov, viewportHeight);
        const next = selectLod(pixels, this.lodIndex, this.template.lodThresholds ?? DEFAULT_LOD_THRESHOLDS);
        if (next !== this.lodIndex) this.showLod(next);
      }
      if (this.interior.length > 0) {
        // With 10% hysteresis, so a camera at the threshold doesn't flicker it.
        const perMetre = projectedPixels(1, distance, fov, viewportHeight);
        const limit = INTERIOR_PIXELS_PER_METRE * (this.interiorShown ? 0.9 : 1.1);
        this.showInterior(perMetre >= limit);
      }
    }
  }

  // Whether LOD0's wheelhouse interior draws (it is hidden from far off; see update).
  get interiorVisible(): boolean {
    return this.interiorShown;
  }

  private showInterior(on: boolean): void {
    if (on === this.interiorShown) return;
    this.interiorShown = on;
    for (const mesh of this.interior) mesh.visible = on;
  }

  private showLod(index: number): void {
    const i = Math.min(this.lods.length - 1, Math.max(0, index));
    this.lodIndex = i;
    if (this.warm) return;
    this.lods.forEach((lod, k) => (lod.visible = k === i));
  }

  // Geometry and materials (but the water mask's) belong to the shared per-kind template: this only
  // releases the copies' render objects, the flood lights' shadows and the mask material.
  dispose(): void {
    this.root.traverse((object) => {
      object.dispose();
      // An InstancedMesh copy has instance matrices of its own (the template's geometry stays).
      const instanced = object as InstancedMesh;
      if (instanced.isInstancedMesh) {
        releaseBuffer(instanced.instanceMatrix);
        if (instanced.instanceColor) releaseBuffer(instanced.instanceColor);
      }
    });
    (this.waterMask.material as MeshBasicNodeMaterial).dispose();
    this.root.removeFromParent();
  }
}
