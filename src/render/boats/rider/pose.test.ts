import { Group, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_CAMERA_INFO } from '../../../camera/boatCameraInfo';
import { FOOT_AFT, FOOT_FRONT, FOOT_Y, gripAt, gripAxis, SEAT_HW, seatSurfaceY } from '../models/pwcLayout';
import {
  alignRotation,
  createRiderRig,
  fitScale,
  palmCentre,
  poseLimp,
  poseRider,
  RIDER_EYE,
  RIDER_HEIGHT,
  RIDER_POSE,
  riderEye,
  type RiderRig,
} from './pose';
import { RIDER_EXTENT as extent, riderSkeleton } from './testRig';

// A rig in a body frame (the jet ski), as the game builds it.
function rig(): RiderRig {
  const character = riderSkeleton().scene;
  new Group().add(character);
  return createRiderRig(character, extent);
}

const position = (r: RiderRig, name: string): Vector3 => {
  const bone = r.character.getObjectByName(name)!;
  r.character.parent!.updateMatrixWorld(true);
  return bone.getWorldPosition(new Vector3());
};

describe('rider fit', () => {
  it('scales the character to an adult height', () => {
    expect(extent.top - extent.bottom).toBeGreaterThan(1.7);
    const r = rig();
    expect(r.scale).toBeCloseTo(fitScale(extent.top - extent.bottom), 9);
    expect((extent.top - extent.bottom) * r.scale).toBeCloseTo(RIDER_HEIGHT, 6);
  });

  it('turns the character to face the bow', () => {
    const r = rig();
    poseRider(r, 0, 0);
    // His left (bones *_l) is port; his face is forward of the back of his head.
    expect(position(r, 'hand_l').x).toBeLessThan(0);
    expect(position(r, 'hand_r').x).toBeGreaterThan(0);
    expect(position(r, 'ball_l').z).toBeLessThan(position(r, 'foot_l').z);
  });
});

describe('rider stance', () => {
  const r = rig();
  poseRider(r, 0, 0);

  it('sits the hips over the seat', () => {
    const hips = position(r, 'thigh_l').add(position(r, 'thigh_r')).multiplyScalar(0.5);
    expect(hips.distanceTo(RIDER_POSE.hips)).toBeLessThan(1e-6);
    for (const side of ['l', 'r']) {
      const hip = position(r, `thigh_${side}`);
      const clearance = hip.y - seatSurfaceY(hip.x, hip.z);
      // Hip joints a buttock's depth over the vinyl.
      expect(clearance).toBeGreaterThan(0.04);
      expect(clearance).toBeLessThan(0.12);
    }
  });

  it('plants both feet flat in the footwells', () => {
    for (const side of ['l', 'r']) {
      const ankle = position(r, `foot_${side}`);
      const toe = position(r, `ball_${side}`);
      expect(Math.abs(ankle.x)).toBeGreaterThan(SEAT_HW + 0.03);
      expect(Math.abs(ankle.x)).toBeLessThan(0.5);
      expect(ankle.z).toBeGreaterThan(FOOT_FRONT);
      expect(toe.z).toBeGreaterThan(FOOT_FRONT - 0.1);
      expect(ankle.z).toBeLessThan(FOOT_AFT);
      expect(ankle.y - FOOT_Y).toBeGreaterThan(0.05);
      expect(ankle.y - FOOT_Y).toBeLessThan(0.12);
      // The ball of the foot about as high as the bind pose has it over the heel: soles flat.
      expect(Math.abs(toe.y - (FOOT_Y + 0.006 + 0.0245 * r.scale))).toBeLessThan(0.02);
    }
  });

  it('bends the knees forward and the elbows out and down', () => {
    for (const side of ['l', 'r']) {
      const hip = position(r, `thigh_${side}`);
      const knee = position(r, `calf_${side}`);
      const ankle = position(r, `foot_${side}`);
      expect(knee.z).toBeLessThan(hip.z);
      expect(knee.z).toBeLessThan(ankle.z);
      expect(knee.y).toBeGreaterThan(ankle.y + 0.2);
      expect(Math.abs(knee.x)).toBeGreaterThan(Math.abs(hip.x));
      const shoulder = position(r, `upperarm_${side}`);
      const elbow = position(r, `lowerarm_${side}`);
      const wrist = position(r, `hand_${side}`);
      expect(elbow.y).toBeLessThan(shoulder.y);
      expect(Math.abs(elbow.x)).toBeGreaterThan(Math.abs(shoulder.x));
      expect(elbow.z).toBeGreaterThan(wrist.z);
    }
  });

  it('puts the helm camera at his eyes', () => {
    const eye = riderEye(r, new Vector3());
    expect(eye.distanceTo(RIDER_EYE)).toBeLessThan(0.002);
    const camera = BOAT_CAMERA_INFO.pwc.eye;
    expect(new Vector3(camera.x, camera.y, camera.z).distanceTo(RIDER_EYE)).toBeLessThan(1e-9);
    // Eyes over the bars, not out over the hood.
    expect(eye.z).toBeGreaterThan(gripAt(1, 0, new Vector3()).z);
  });
});

describe('rider hands', () => {
  const steers = [-0.45, -0.2, 0, 0.2, 0.45];
  const leans = [-0.22, 0, 0.22];

  it('keeps both palms on the grips wherever the bars turn and the torso leans', () => {
    const r = rig();
    for (const steer of steers)
      for (const lean of leans) {
        expect(poseRider(r, steer, lean).reachMiss).toBe(0);
        for (const side of [-1, 1]) {
          const palm = palmCentre(r, side, new Vector3());
          expect(palm.distanceTo(gripAt(side, steer, new Vector3()))).toBeLessThan(0.003);
        }
      }
  });

  it('lines the knuckles up along the grip, pinky outboard', () => {
    const r = rig();
    for (const steer of [-0.45, 0, 0.45]) {
      poseRider(r, steer, 0);
      for (const [side, s] of [
        [-1, 'l'],
        [1, 'r'],
      ] as const) {
        const knuckles = position(r, `pinky_01_${s}`)
          .sub(position(r, `index_01_${s}`))
          .normalize();
        expect(knuckles.dot(gripAxis(side, steer, new Vector3()))).toBeGreaterThan(0.9);
      }
    }
  });

  it('curls the fingers round the grip', () => {
    const r = rig();
    poseRider(r, 0, 0);
    for (const s of ['l', 'r']) {
      const grip = gripAt(s === 'l' ? -1 : 1, 0, new Vector3());
      const axis = gripAxis(s === 'l' ? -1 : 1, 0, new Vector3());
      // Fingertips end up near the grip's surface, not sticking out straight.
      const tip = position(r, `middle_03_${s}`);
      const off = tip.clone().sub(grip);
      const radial = off.addScaledVector(axis, -off.dot(axis)).length();
      expect(radial).toBeLessThan(0.06);
    }
  });
});

describe('rider lean', () => {
  it('leans into the turn from the hips, feet planted, eyes kept nearly level', () => {
    const r = rig();
    poseRider(r, 0, 0);
    const ankles = ['l', 'r'].map((s) => position(r, `foot_${s}`));
    const head = position(r, 'Head');
    // Positive lean (the 'rider:torso' drive's z rotation) tips the body to port.
    poseRider(r, 0, 0.2);
    const leaned = position(r, 'Head');
    expect(leaned.x).toBeLessThan(head.x - 0.05);
    ['l', 'r'].forEach((s, i) => expect(position(r, `foot_${s}`).distanceTo(ankles[i]!)).toBeLessThan(1e-6));
    // The head's roll is a fraction of the torso's.
    const up = (name: string): Vector3 =>
      new Vector3(0, 1, 0).applyQuaternion(
        r.character.getObjectByName(name)!.getWorldQuaternion(new Quaternion()),
      );
    expect(Math.abs(up('Head').x)).toBeLessThan(Math.abs(up('spine_03').x));
  });

  it('rebuilds the same pose from any previous one', () => {
    const r = rig();
    poseRider(r, 0, 0);
    const before = r.bones.map((b) => b.quaternion.clone());
    poseRider(r, 0.4, -0.2);
    poseRider(r, 0, 0);
    r.bones.forEach((b, i) => expect(b.quaternion.angleTo(before[i]!)).toBeLessThan(1e-6));
  });
});

describe('limp pose', () => {
  // Positions in the character's own frame (+Z forward, his left +X, up +Y).
  const local = (r: RiderRig, name: string): Vector3 => r.character.worldToLocal(position(r, name));

  it('lets the arms and legs hang loose and drops the head', () => {
    const r = rig();
    poseRider(r, 0, 0);
    poseLimp(r, 0);
    for (const s of ['l', 'r']) {
      const shoulder = local(r, `upperarm_${s}`);
      const hand = local(r, `hand_${s}`);
      expect(hand.y).toBeLessThan(shoulder.y - 0.15);
      expect(hand.z).toBeGreaterThan(shoulder.z + 0.1);
      expect(Math.sign(hand.x)).toBe(s === 'l' ? 1 : -1);
      // Hips and knees bent forward, the feet below and apart.
      const hip = local(r, `thigh_${s}`);
      const knee = local(r, `calf_${s}`);
      const foot = local(r, `foot_${s}`);
      expect(knee.z).toBeGreaterThan(hip.z + 0.05);
      expect(foot.z).toBeLessThan(knee.z);
      expect(foot.y).toBeLessThan(knee.y);
      expect(Math.abs(foot.x)).toBeGreaterThan(Math.abs(hip.x));
    }
    const forward = (name: string): number => {
      const q = r.character.getObjectByName(name)!.getWorldQuaternion(new Quaternion());
      const up = new Vector3(0, 1, 0).applyQuaternion(q);
      return up.applyQuaternion(r.character.getWorldQuaternion(new Quaternion()).invert()).z;
    };
    expect(forward('Head')).toBeGreaterThan(forward('pelvis') + 0.3);
  });

  it('sways without drifting off the pose', () => {
    const r = rig();
    poseLimp(r, 1);
    const swayed = r.bones.map((b) => b.quaternion.clone());
    poseLimp(r, 0);
    const still = r.bones.map((b) => b.quaternion.clone());
    const most = Math.max(...still.map((q, i) => q.angleTo(swayed[i]!)));
    expect(most).toBeGreaterThan(0.05);
    expect(most).toBeLessThan(0.4);
    poseLimp(r, 1);
    r.bones.forEach((b, i) => expect(b.quaternion.angleTo(swayed[i]!)).toBeLessThan(1e-6));
  });
});

describe('alignRotation', () => {
  it('maps a local direction and side onto targets', () => {
    const q = alignRotation(
      new Vector3(0, 1, 0),
      new Vector3(1, 0, 0),
      new Vector3(0, 0, -1),
      new Vector3(0, 1, 0.2),
      new Quaternion(),
    );
    expect(new Vector3(0, 1, 0).applyQuaternion(q).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    // The side is made perpendicular to the direction first.
    expect(new Vector3(1, 0, 0).applyQuaternion(q).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
  });
});
