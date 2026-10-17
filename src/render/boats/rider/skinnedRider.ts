// The skinned rider for the jet ski's near LODs: a clone of the loaded character (own skeleton per
// clone, so each jet ski poses its own) in the game's materials, with the life vest skinned to the
// same skeleton, and the animator that poses it from the handlebar and lean drives (pose.ts).

import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { Group, type Material, type Object3D, SkinnedMesh } from 'three/webgpu';

import type { Animator, AnimatorFactory } from '../kit/animate';
import { type RiderAsset, SHARED_GEOMETRY } from './asset';
import { riderBodyMaterial, riderEyeMaterial, riderHairMaterial, riderVestMaterial } from './materials';
import { RiderOverboard } from './overboardRider';
import { createRiderRig, poseRider, type RiderRig } from './pose';

export const RIDER_NODE = 'rider:character';

export function riderMaterials(asset: RiderAsset): Record<string, Material> {
  return {
    'rider:body': riderBodyMaterial(asset.maps.skin, asset.maps.skinNormal),
    'rider:vest': riderVestMaterial(),
    'rider:hair': riderHairMaterial(asset.maps.hair, asset.maps.hairNormal),
    'rider:eyes': riderEyeMaterial(asset.maps.eyes),
  };
}

// The character for one LOD, in its bind pose (the animator poses each BoatVisual's copy). An empty
// 'rider:torso' node rides along for the lean drive to set, as on the procedural rider.
export function skinnedRider(asset: RiderAsset, materials: Record<string, Material>): Object3D[] {
  const character = cloneSkinned(asset.scene);
  character.name = RIDER_NODE;
  const hair = new Set(asset.hair.map((m) => m.name));
  let body: SkinnedMesh | null = null;
  character.traverse((o) => {
    if (!(o instanceof SkinnedMesh)) return;
    if (o.name === asset.body.name) {
      o.material = materials['rider:body']!;
      body = o;
    } else if (hair.has(o.name)) o.material = materials['rider:hair']!;
    else o.material = materials['rider:eyes']!;
    o.castShadow = true;
    o.receiveShadow = true;
    // Its bounds would be the bind pose's (a T-pose) and stay at the seat while he's overboard.
    o.frustumCulled = false;
    o.userData[SHARED_GEOMETRY] = true;
  });
  const skinned = body as SkinnedMesh | null;
  if (skinned && asset.vest) {
    const vest = new SkinnedMesh(asset.vest, materials['rider:vest']!);
    vest.name = 'rider:vest';
    vest.castShadow = true;
    vest.receiveShadow = true;
    vest.frustumCulled = false;
    vest.userData[SHARED_GEOMETRY] = true;
    skinned.parent?.add(vest);
    vest.bind(skinned.skeleton, skinned.bindMatrix);
  }
  // Placed and scaled like the posed rider, so the template's bounds are right.
  poseRider(createRiderRig(character, asset.extent, asset.scene), 0, 0);
  const torso = new Group();
  torso.name = 'rider:torso';
  return [character, torso];
}

// Poses every skinned rider of a visual's LODs (each its own skeleton) from the handlebar's yaw and
// the lean drive, whenever one of those changes while a near LOD is showing; after a capsize the
// riders go overboard (overboardRider.ts) until the boat is recovered.
export function skinnedRiderAnimator(asset: RiderAsset): AnimatorFactory {
  return (lods) => {
    const rigs: RiderRig[] = [];
    for (const lod of lods) {
      const character = lod.getObjectByName(RIDER_NODE);
      if (character) rigs.push(createRiderRig(character, asset.extent, asset.scene));
    }
    const bar = lods[0]?.getObjectByName('handlebar');
    const torso = lods[0]?.getObjectByName('rider:torso');
    for (const rig of rigs) poseRider(rig, 0, 0);
    let steer = 0;
    let lean = 0;
    const seat = (): void => {
      steer = bar?.rotation.y ?? 0;
      lean = torso?.rotation.z ?? 0;
      for (const rig of rigs) poseRider(rig, steer, lean);
    };
    const overboard = new RiderOverboard(lods, rigs, seat);
    const animator: Animator = (dt, telemetry, lod) => {
      overboard.update(dt, telemetry);
      if (overboard.overboard || lod > 1 || !bar || !torso) return;
      if (bar.rotation.y === steer && torso.rotation.z === lean) return;
      seat();
    };
    animator.event = (type) => overboard.event(type);
    return animator;
  };
}
