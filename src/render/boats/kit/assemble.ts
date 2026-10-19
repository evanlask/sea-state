// Turns a model draft (per-LOD PartBuilders plus extra objects) into a
// BoatTemplate: bakes the AO volume from one LOD's geometry and solid boxes,
// creates the slot materials with it, builds the merged meshes and counts
// triangles (instances included).

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  type Material,
  Mesh,
  type Object3D,
  type Texture,
  Vector3,
} from 'three/webgpu';

import type { TriMesh } from '../../../sim/physics/mesh';
import type { BoatKind } from '../../../sim/world/protocol';
import type { AnimatorFactory, TelemetryDrive } from './animate';
import { type AoBakeInput, type AoBox, type AoVolumeData, bakeAoVolume } from './ao';
import type { AnimatedSpec, BoatTemplate, FloodSpec, LightMountSpec } from './BoatVisual';
import type { PartBuilder } from './geometry';
import { triangleSoup } from './hull';
import type { LodThresholds } from './lod';
import { type AoVolume, createAoVolume } from './materials';
import { createSlotMaterials, type Palette } from './palette';
import { SHADOW_PROXY } from './shadowProxy';
import { collectTextures, trackTexture } from './textures';

interface LodDraft {
  builder: PartBuilder;
  // Extra objects (instanced meshes, decals, animated parts) for this LOD.
  extras?: (materials: Record<string, Material>, ao: AoVolume | null) => Object3D[];
  shadows?: boolean;
}

export interface ModelDraft {
  kind: BoatKind;
  name: string;
  length: number;
  lods: LodDraft[];
  palette: Palette;
  extraMaterials?: (ao: AoVolume | null) => Record<string, Material>;
  aoVoxel: number; // m
  aoLod?: number; // which LOD's geometry to voxelise (default 1)
  aoBoxes?: AoBox[];
  aoDistance?: number;
  aoExclude?: readonly string[]; // slots left out of the AO bake (a tall rig would bloat the volume)
  lights: LightMountSpec[];
  floods: FloodSpec[];
  animated: AnimatedSpec[];
  eye: Vector3;
  wingEyes?: { port: Vector3; starboard: Vector3 };
  waterMask: BufferGeometry;
  lodThresholds?: LodThresholds;
  drives?: TelemetryDrive[];
  animator?: AnimatorFactory;
  textures?: Texture[]; // made while the draft was built (createBoatVisual collects them)
}

export function triMeshGeometry(mesh: TriMesh): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(mesh.positions), 3));
  g.setIndex(new BufferAttribute(new Uint32Array(mesh.indices), 1));
  g.computeVertexNormals();
  return g;
}

function countTriangles(root: Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || mesh.name === 'water-mask' || mesh.name === SHADOW_PROXY) return;
    const g = mesh.geometry;
    const tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    n += tris * ((o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh).count : 1);
  });
  return n;
}

export function assemble(draft: ModelDraft): BoatTemplate {
  return assembleWithAo(draft, bakeAoVolume(aoBakeInput(draft)));
}

// What the AO bake needs from a draft: the chosen LOD's merged slots (glass and lamps excluded:
// they don't occlude much) and the solid boxes. Pure data, so the bake can run in a worker.
export function aoBakeInput(draft: ModelDraft): AoBakeInput {
  const aoBuilder = draft.lods[Math.min(draft.aoLod ?? 1, draft.lods.length - 1)]!.builder;
  const soups: Float32Array[] = [];
  const bounds = new Box3();
  for (const slot of aoBuilder.slots()) {
    if (slot === 'glass' || draft.aoExclude?.includes(slot)) continue;
    const g = aoBuilder.merged(slot)!;
    g.computeBoundingBox();
    bounds.union(g.boundingBox!);
    soups.push(triangleSoup(g));
  }
  for (const box of draft.aoBoxes ?? []) {
    bounds.expandByPoint(new Vector3(...box.min));
    bounds.expandByPoint(new Vector3(...box.max));
  }
  return {
    min: bounds.min.toArray() as [number, number, number],
    max: bounds.max.toArray() as [number, number, number],
    voxel: draft.aoVoxel,
    triangles: soups,
    boxes: draft.aoBoxes,
    distance: draft.aoDistance,
  };
}

// The decals of one parent (its children named 'decal') sharing a material, as one mesh each: a
// name on both bows is one draw.
function mergeDecals(group: Object3D): void {
  const byMaterial = new Map<Material, Mesh[]>();
  for (const child of group.children) {
    const mesh = child as Mesh;
    if (!mesh.isMesh || mesh.name !== 'decal' || (mesh as InstancedMesh).isInstancedMesh) continue;
    if (mesh.children.length > 0 || Array.isArray(mesh.material)) continue;
    const material = mesh.material as Material;
    const list = byMaterial.get(material);
    if (list) list.push(mesh);
    else byMaterial.set(material, [mesh]);
  }
  for (const [material, meshes] of byMaterial) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map((mesh) => {
      mesh.updateMatrix();
      return mesh.geometry.clone().applyMatrix4(mesh.matrix);
    });
    const geometry = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!geometry) continue;
    geometry.computeBoundingSphere();
    const merged = new Mesh(geometry, material);
    merged.name = 'decal';
    merged.receiveShadow = meshes[0]!.receiveShadow;
    merged.castShadow = meshes[0]!.castShadow;
    merged.renderOrder = meshes[0]!.renderOrder;
    merged.matrixAutoUpdate = false;
    for (const mesh of meshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    group.add(merged);
  }
}

// The template from a draft and its baked AO volume (bakeAoVolume(aoBakeInput(draft))).
export function assembleWithAo(draft: ModelDraft, aoData: AoVolumeData): BoatTemplate {
  const { result, textures } = collectTextures(() => buildTemplate(draft, aoData));
  result.textures = [...new Set([...(draft.textures ?? []), ...textures])];
  return result;
}

function buildTemplate(draft: ModelDraft, aoData: AoVolumeData): BoatTemplate {
  const ao = createAoVolume(aoData);
  trackTexture(ao.texture);
  ao.texture.name = `${draft.kind}-ao (${aoData.nx}×${aoData.ny}×${aoData.nz})`;
  const materials = { ...createSlotMaterials(draft.palette, ao, draft.kind), ...draft.extraMaterials?.(ao) };
  const lods: Object3D[] = [];
  const triangles: number[] = [];
  for (const lod of draft.lods) {
    const group = new Group();
    group.add(lod.builder.build(materials, { shadows: lod.shadows ?? true }).group);
    for (const extra of lod.extras?.(materials, ao) ?? []) group.add(extra);
    const parents: Object3D[] = [];
    group.traverse((object) => void (object.children.length > 1 && parents.push(object)));
    for (const parent of parents) mergeDecals(parent);
    lods.push(group);
    triangles.push(countTriangles(group));
  }
  return {
    kind: draft.kind,
    name: draft.name,
    length: draft.length,
    lods,
    triangles,
    lodThresholds: draft.lodThresholds,
    lights: draft.lights,
    floods: draft.floods,
    animated: draft.animated,
    eye: draft.eye,
    wingEyes: draft.wingEyes,
    waterMask: draft.waterMask,
    drives: draft.drives,
    animator: draft.animator,
  };
}
