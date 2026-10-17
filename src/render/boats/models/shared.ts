// Helpers shared by the vessel models.

import { Group, type Material, Mesh, type Object3D } from 'three/webgpu';

import type { WiperPivot } from '../kit/bridge';
import { wiperGeometry } from '../kit/props';

// Animated wipers: a pivot group in the window plane with a child named wiper:<i> rotating about z.
export function wiperMeshes(pivots: readonly WiperPivot[], material: Material): Object3D[] {
  return pivots.map((p, i) => {
    const pivot = new Group();
    pivot.position.set(...p.position);
    pivot.rotation.x = p.tilt;
    const arm = new Mesh(wiperGeometry(p.length), material);
    arm.name = `wiper:${i}`;
    arm.rotation.z = -0.9;
    pivot.add(arm);
    return pivot;
  });
}
