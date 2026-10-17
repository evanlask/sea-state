// For the rider's tests: the shipped character's skeleton and body extent, read from the GLB's JSON
// chunk (node transforms and accessor bounds stay plain JSON with Meshopt-compressed buffers).

import { Bone, Group, type Object3D } from 'three/webgpu';

interface GltfJson {
  nodes: {
    name?: string;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  scenes: { nodes: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number }; material?: number }[] }[];
  materials: { name?: string }[];
  accessors: { min?: number[]; max?: number[] }[];
  skins: { joints: number[] }[];
}

// Node's fs, typed here: src/ is compiled without Node's types.
const NODE_FS = 'node:fs';
const fs = (await import(/* @vite-ignore */ NODE_FS)) as { readFileSync(url: URL): Uint8Array };

function readGlbJson(url: URL): GltfJson {
  const data = fs.readFileSync(url);
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + length))) as GltfJson;
}

const gltf = readGlbJson(new URL('../../../../public/models/characters/rider/model.glb', import.meta.url));

// The glTF scene's node tree (no meshes) in its bind pose, and its skin's joints in order.
export function riderSkeleton(): { scene: Object3D; joints: Bone[] } {
  const skin = gltf.skins[0]!.joints;
  const joints = new Set(skin);
  const nodes = gltf.nodes.map((n, i) => {
    const o = joints.has(i) ? new Bone() : new Group();
    o.name = n.name ?? '';
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => nodes[i]!.add(nodes[c]!)));
  const scene = new Group();
  for (const i of gltf.scenes[0]!.nodes) scene.add(nodes[i]!);
  return { scene, joints: skin.map((i) => nodes[i] as Bone) };
}

const bodyMaterial = gltf.materials.findIndex((m) => m.name === 'MI_Superhero_Male');
const bodyBounds =
  gltf.accessors[
    gltf.meshes.flatMap((m) => m.primitives).find((p) => p.material === bodyMaterial)!.attributes.POSITION
  ]!;

// The body mesh's bind-pose height range.
export const RIDER_EXTENT = { bottom: bodyBounds.min![1]!, top: bodyBounds.max![1]! };
