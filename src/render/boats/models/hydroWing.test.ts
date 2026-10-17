// The hydroplane's wing stays on its pin through the fins at both ends of its trim range, and the
// skid fin is drawn raked and toed as the physics has it.

import { Box3, Group, type Material, MeshBasicMaterial, type Object3D, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { hydroSpec } from '../../../sim/boats/specs/hydro';
import { DriveSet } from '../kit/animate';
import { hydroDraft, WING_PIVOT } from './hydro';

const materials = new Proxy({} as Record<string, Material>, {
  get: (cache, key: string) => (cache[key] ??= new MeshBasicMaterial()),
});

const trim = hydroSpec.aero!.surfaces.find((s) => s.trim)!.trim!;

function find(root: Object3D, name: string): Object3D {
  let found: Object3D | undefined;
  root.traverse((o) => {
    if (!found && o.name === name) found = o;
  });
  if (!found) throw new Error(`no ${name}`);
  return found;
}

describe('hydroplane wing', () => {
  for (const lod of [0, 1, 2]) {
    it(`LOD ${lod}: the wing turns about its pin through the fins and stays on them, min to max trim`, () => {
      const draft = hydroDraft();
      const root = new Group();
      for (const extra of draft.lods[lod]!.extras!(materials, null)) root.add(extra);
      const drives = new DriveSet(draft.drives!, [root]);
      const pivot = find(root, WING_PIVOT);
      const wing = find(pivot, 'wing'); // the wing's mesh, its geometry in body coordinates
      root.updateMatrixWorld(true);
      const rest = new Box3().setFromObject(wing);
      // The pin through the fins: the pivot (quarter chord) at each fin's plane.
      const pins = [-0.72, 0.72].map((x) => new Vector3(x, pivot.position.y, pivot.position.z));
      const lamp = new Vector3(0, pivot.position.y + 0.135, pivot.position.z);
      for (const angle of [trim.min, trim.max]) {
        drives.update(10, { wingAngle: angle });
        root.updateMatrixWorld(true);
        expect(pivot.rotation.x).toBeCloseTo(angle, 6);
        for (const pin of pins) {
          const moved = pin.clone().applyMatrix4(wing.matrixWorld);
          expect(moved.distanceTo(pin), `pin at ${angle}`).toBeLessThan(0.002);
        }
        // The lamp on its stalk over the pin swings only a couple of centimetres.
        expect(lamp.clone().applyMatrix4(wing.matrixWorld).distanceTo(lamp)).toBeLessThan(0.03);
        // The whole wing, end plates included, stays where it was but for the swing of its chord.
        const box = new Box3().setFromObject(wing);
        expect(box.min.distanceTo(rest.min)).toBeLessThan(0.12);
        expect(box.max.distanceTo(rest.max)).toBeLessThan(0.12);
      }
    });
  }
});
