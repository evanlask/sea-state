// The loaded rider character (load.ts), registered for the jet ski model to dress, pose and clone.
// Kept apart from the loader so pwc.ts doesn't pull GLTFLoader into the main bundle.

import type { BufferGeometry, Object3D, SkinnedMesh, Texture } from 'three/webgpu';

export interface RiderAsset {
  scene: Object3D; // the glTF scene in its bind pose; never drawn itself, only cloned
  body: SkinnedMesh;
  hair: SkinnedMesh[]; // hair and eyebrows
  eyes: SkinnedMesh | null;
  extent: { bottom: number; top: number }; // the body's bind-pose height range (soles to crown)
  maps: {
    skin: Texture;
    skinNormal: Texture | null;
    hair: Texture | null;
    hairNormal: Texture | null;
    eyes: Texture | null;
  };
  vest: BufferGeometry | null; // the life vest shell (outfit.ts)
}

// userData flag on meshes whose geometry belongs to the asset: rebuilding the jet ski template
// mustn't dispose it (createBoatVisual.ts).
export const SHARED_GEOMETRY = 'sharedGeometry';

let current: RiderAsset | null = null;
let version = 0;

export const riderAsset = (): RiderAsset | null => current;

export function setRiderAsset(asset: RiderAsset | null): void {
  current = asset;
  version++;
}

// Part of the jet ski template's cache key: a template built before the rider loaded is rebuilt.
export const riderKey = (): string => (current ? `rider:${version}` : 'procedural');
