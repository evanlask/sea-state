import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  Group,
  type Material,
  MeshBasicNodeMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BoatVisual, type BoatTemplate } from '../kit/BoatVisual';
import { gripAt } from '../models/pwcLayout';
import type { RiderAsset } from './asset';
import { buildVestShell } from './outfit';
import { RIDER_EYE } from './pose';
import { RIDER_NODE, skinnedRider, skinnedRiderAnimator } from './skinnedRider';
import { RIDER_EXTENT, riderSkeleton } from './testRig';

// The real skeleton with stand-in meshes: a box of a body skinned to the spine and hands, and a vest.
function fakeAsset(): RiderAsset {
  const { scene, joints } = riderSkeleton();
  const skeleton = new Skeleton(joints);
  const skinned = (
    geometry: BoxGeometry | CylinderGeometry,
    joint: string,
  ): BoxGeometry | CylinderGeometry => {
    const n = geometry.getAttribute('position').count;
    const index = new Uint16Array(n * 4);
    const weight = new Float32Array(n * 4);
    const j = joints.findIndex((b) => b.name === joint);
    for (let i = 0; i < n; i++) {
      index[i * 4] = j;
      weight[i * 4] = 1;
    }
    geometry.setAttribute('skinIndex', new BufferAttribute(index, 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(weight, 4));
    return geometry;
  };
  const body = new SkinnedMesh(skinned(new BoxGeometry(0.3, 1.8, 0.2).translate(0, 0.9, 0), 'spine_03'));
  body.name = 'SuperHero_Male';
  const armature = scene.getObjectByName('Armature')!;
  armature.add(body);
  scene.updateMatrixWorld(true);
  body.bind(skeleton);
  const vestBody = skinned(
    new CylinderGeometry(0.15, 0.15, 0.7, 24, 10, true).translate(0, 1.25, 0),
    'spine_03',
  );
  const skin = new Texture();
  return {
    scene,
    body,
    hair: [],
    eyes: null,
    extent: RIDER_EXTENT,
    maps: { skin, skinNormal: null, hair: null, hairNormal: null, eyes: null },
    vest: buildVestShell(vestBody),
  };
}

const materials = new Proxy({} as Record<string, Material>, { get: () => new MeshBasicNodeMaterial() });

function template(asset: RiderAsset): BoatTemplate {
  const lods = [0, 1].map(() => {
    const group = new Group();
    const tilt = new Group();
    const bar = new Group();
    bar.name = 'handlebar';
    tilt.add(bar);
    group.add(tilt, ...skinnedRider(asset, materials));
    return group;
  });
  return {
    kind: 'pwc',
    name: 'test',
    length: 3.3,
    lods,
    triangles: [0, 0],
    lights: [],
    floods: [],
    animated: [],
    eye: RIDER_EYE.clone(),
    waterMask: new BoxGeometry(),
    drives: [{ name: 'handlebar', axis: 'y', key: 'nozzle', rate: 0 }],
    animator: skinnedRiderAnimator(asset),
  };
}

const bodyOf = (visual: BoatVisual, lod: number): SkinnedMesh => {
  let body: SkinnedMesh | null = null;
  visual.lods[lod]!.traverse((o) => {
    if (o instanceof SkinnedMesh && o.name === 'SuperHero_Male') body = o;
  });
  return body!;
};

describe('skinned rider', () => {
  const asset = fakeAsset();

  it('dresses each near LOD in a vest, with a lean marker', () => {
    const lod0 = skinnedRider(asset, materials);
    expect(lod0.map((o) => o.name)).toEqual([RIDER_NODE, 'rider:torso']);
    expect(lod0[0]!.getObjectByName('rider:vest')).toBeInstanceOf(SkinnedMesh);
    // The original stays in its bind pose for the next clone.
    expect(
      asset.scene
        .getObjectByName('pelvis')!
        .quaternion.angleTo(riderSkeleton().scene.getObjectByName('pelvis')!.quaternion),
    ).toBeLessThan(1e-9);
  });

  it('gives every visual its own skeleton, the vest bound to the same one', () => {
    const t = template(asset);
    const a = new BoatVisual(t);
    const b = new BoatVisual(t);
    for (const lod of [0, 1]) {
      const bodyA = bodyOf(a, lod);
      const bodyB = bodyOf(b, lod);
      expect(bodyA.skeleton.bones[0]).not.toBe(bodyB.skeleton.bones[0]);
      // Bones live in the visual's own tree.
      let root = bodyA.skeleton.bones[0]!.parent;
      while (root?.parent) root = root.parent;
      expect(root).toBe(a.root);
      // The vest shares the body's skeleton: one bone update a frame.
      const vest = a.lods[lod]!.getObjectByName('rider:vest') as SkinnedMesh;
      expect(vest.skeleton).toBe(bodyA.skeleton);
    }
  });

  it('poses the hands on the grips as the bars turn, per visual', () => {
    const t = template(asset);
    const a = new BoatVisual(t);
    const b = new BoatVisual(t);
    a.update(1 / 60, undefined, 1080, { nozzle: 0.4 });
    b.update(1 / 60, undefined, 1080, { nozzle: 0 });
    const hand = (visual: BoatVisual): Vector3 => {
      const bone = bodyOf(visual, 0).skeleton.bones.find((x) => x.name === 'hand_r')!;
      visual.root.updateMatrixWorld(true);
      return bone.getWorldPosition(new Vector3());
    };
    // The palm is about a hand's width from the wrist; the wrist follows its grip.
    expect(hand(a).distanceTo(gripAt(1, 0.4, new Vector3()))).toBeLessThan(0.15);
    expect(hand(b).distanceTo(gripAt(1, 0, new Vector3()))).toBeLessThan(0.15);
    expect(hand(a).distanceTo(hand(b))).toBeGreaterThan(0.05);
  });

  it('goes overboard on a capsize, sinks out of sight, and is back on the seat on recovery', () => {
    const visual = new BoatVisual(template(asset));
    const pelvis = (): Vector3 => {
      const bone = bodyOf(visual, 0).skeleton.bones.find((x) => x.name === 'pelvis')!;
      visual.root.updateMatrixWorld(true);
      return bone.getWorldPosition(new Vector3());
    };
    const hand = (): Vector3 => {
      const bone = bodyOf(visual, 0).skeleton.bones.find((x) => x.name === 'hand_r')!;
      visual.root.updateMatrixWorld(true);
      return visual.root.worldToLocal(bone.getWorldPosition(new Vector3()));
    };
    const dt = 1 / 30;
    visual.update(dt, undefined, 1080, { capsized: 0 });
    const seated = pelvis();
    // The boat drifts on at 2 m/s; he lets go and sinks beside where it was.
    const frames = (seconds: number, telemetry: Record<string, number>): void => {
      for (let t = 0; t < seconds; t += dt) {
        visual.root.position.x += 2 * dt;
        visual.update(dt, undefined, 1080, telemetry);
      }
    };
    frames(5, { capsized: 1 });
    const sunk = pelvis();
    expect(sunk.y).toBeLessThan(seated.y - 1.2);
    expect(visual.root.position.x - sunk.x).toBeGreaterThan(3);
    const character = visual.lods[0]!.getObjectByName(RIDER_NODE)!;
    expect(character.visible).toBe(true);
    // Recovered: on the seat at once, hands on the grips, and a stale capsized flag leaves him there.
    visual.simEvent('recovered');
    visual.update(dt, undefined, 1080, { capsized: 1 });
    expect(hand().distanceTo(gripAt(1, 0, new Vector3()))).toBeLessThan(0.15);
    visual.update(dt, undefined, 1080, { capsized: 0 });
    // The event alone throws him off too; deep enough, he's gone.
    visual.simEvent('capsized');
    frames(100, { capsized: 0 });
    expect(character.visible).toBe(false);
    expect(visual.lods[1]!.getObjectByName(RIDER_NODE)!.visible).toBe(false);
    visual.simEvent('recovered');
    expect(character.visible).toBe(true);
    expect(hand().distanceTo(gripAt(1, 0, new Vector3()))).toBeLessThan(0.15);
  });
});
