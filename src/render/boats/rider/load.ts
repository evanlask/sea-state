// Downloads and decodes the jet ski rider (models/characters/rider/model.glb: Meshopt geometry, KTX2
// textures through the page's shared KTX2 loader) into a RiderAsset. Imported on demand by
// preloadRider, so GLTFLoader stays out of the main bundle until a voyage has a jet ski.

import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  Box3,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  SkinnedMesh,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

import type { LoadingManager } from '../../../app/loading/LoadingManager';
import { assetUrl } from '../../../app/loading/manifest';
import { sharedKtx2 } from '../detail/loadDetailTextures';
import type { ListedAsset } from '../glb/files';
import type { RiderAsset } from './asset';
import { buildVestShell } from './outfit';

export async function loadRider(
  file: ListedAsset,
  renderer: WebGPURenderer,
  loading: LoadingManager,
  base: string = import.meta.env.BASE_URL,
): Promise<RiderAsset> {
  const buffer = await loading.download(
    {
      id: 'rider',
      label: 'Downloading the jet ski rider',
      kind: 'download',
      bytes: file.entry.bytes,
      url: assetUrl(base, file.path, file.entry),
    },
    { onError: 'throw', retries: 1 },
  );
  return loading.run(
    { id: 'rider:decode', label: 'Dressing the jet ski rider', kind: 'decode', weight: 0.3 },
    async () => {
      const gltf = new GLTFLoader()
        .setMeshoptDecoder(MeshoptDecoder)
        .setKTX2Loader(sharedKtx2(renderer, base));
      const { scene } = await gltf.parseAsync(buffer, `${base}models/characters/rider/`);
      return riderFromScene(scene);
    },
    { onError: 'throw' },
  );
}

// Sorts the character's meshes by material (body, hair and eyebrows, eyes), keeps their textures
// for the game's own materials, and grows the life vest off the body.
function riderFromScene(scene: Object3D): RiderAsset {
  const meshes: SkinnedMesh[] = [];
  scene.traverse((o) => {
    if (o instanceof SkinnedMesh) meshes.push(o);
  });
  const named = (material: string): SkinnedMesh[] =>
    meshes.filter((m) => (m.material as Material).name === material);
  const body = named('MI_Superhero_Male')[0];
  if (!body) throw new Error('The rider model has no body mesh');
  const hair = named('MI_Hair_1');
  const eyes = named('MI_Eyes')[0] ?? null;
  const map = (mesh: SkinnedMesh | undefined | null, slot: 'map' | 'normalMap'): Texture | null =>
    mesh ? ((mesh.material as MeshStandardMaterial)[slot] ?? null) : null;
  const skin = map(body, 'map');
  if (!skin) throw new Error('The rider model has no skin texture');
  const hairMesh = hair.find((m) => /hair/i.test(m.name)) ?? hair[0];
  const maps = {
    skin,
    skinNormal: map(body, 'normalMap'),
    hair: map(hairMesh, 'map'),
    hairNormal: map(hairMesh, 'normalMap'),
    eyes: map(eyes, 'map'),
  };
  // The loader's materials are replaced by the rider's own (materials.ts); their textures are kept.
  for (const mesh of meshes) (mesh.material as Material).dispose();
  body.geometry.computeBoundingBox();
  const box = body.geometry.boundingBox ?? new Box3();
  return {
    scene,
    body,
    hair,
    eyes,
    extent: { bottom: box.min.y, top: box.max.y },
    maps,
    vest: buildVestShell(body.geometry),
  };
}
