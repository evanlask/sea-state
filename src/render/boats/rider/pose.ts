// The jet ski rider's pose on the skinned character (Quaternius "Universal Base Characters", a
// UE-mannequin-style skeleton): seated on the driver's seat in a forward athletic stance, knees bent
// and feet flat in the footwells, hands round the grips. Everything is set from bone rotations in code,
// so the stance is tuned in RIDER_POSE below. Each frame poseRider() rebuilds it from the bind pose:
//
//   pelvis    tipped forward and leaned into the turn (riderLean), hips placed on the seat
//   spine     three bends forward plus their share of the lean
//   head      looks down the bow, cancelling most of the lean (riders keep their eyes level)
//   legs      two-bone IK (thigh, calf) to ankle targets in the footwells, knees forward and out
//   arms      two-bone IK (upperarm, lowerarm) so the palm wraps the grip wherever the bars turn;
//             the hand aligns to the grip (knuckle line along it), half the wrist twist goes to the
//             forearm, and the fingers curl round it
//
// Frames: the character's parent is the boat body frame (bow −Z, up +Y, starboard +X). The bind pose
// stands facing +Z, so the character is turned half round; its left side (bones *_l) is port.
// Pure math on three's Object3D (no renderer), so it runs in tests on the skeleton alone.

import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three/webgpu';

import { twoBoneJoint } from '../kit/animate';
import { FOOT_Y, GRIP_RADIUS, gripAt, gripAxis } from '../models/pwcLayout';

const DEG = Math.PI / 180;

export const RIDER_HEIGHT = 1.8; // m, standing

// The stance. Angles in radians; points in the body frame for the starboard side (port mirrors x).
export const RIDER_POSE = {
  hips: new Vector3(0, 0.69, 0.22), // midway between the hip joints, over the driver's seat
  pelvisPitch: -16 * DEG, // tipped forward from standing
  spinePitch: [-9 * DEG, -8 * DEG, -5 * DEG], // spine_01..03 bend further forward
  headPitch: -6 * DEG, // the head's attitude: a little down the bow
  neckShare: 0.55, // of the head's correction taken by the neck
  clavicle: { protract: 12 * DEG, raise: -3 * DEG }, // shoulders forward toward the bars
  ankle: new Vector3(0.355, 0, -0.03), // y is set so the soles sit on the footwell floor
  footYaw: 12 * DEG, // toes out
  kneePole: new Vector3(0.55, 0.35, -1), // from the hip: knees forward, up and out
  elbowPole: new Vector3(0.7, -0.45, 0.35), // from the shoulder: elbows out, down and back
  wristPitch: 12 * DEG, // knuckles rolled over the top of the grip
  palm: { forward: 0.075, depth: GRIP_RADIUS + 0.017 }, // grip centre from the wrist, hand frame
  forearmTwist: 0.5, // share of the wrist's twist taken by the forearm
  fingerCurl: [62 * DEG, 78 * DEG, 42 * DEG], // _01 (knuckle), _02, _03 of each finger
  thumbCurl: [-22 * DEG, 28 * DEG, 20 * DEG], // thumb_01..03 round the grip's underside
  lean: { pelvis: 0.45, spine: [0.2, 0.2, 0.15], headLevel: 0.75 }, // shares of riderLean
};

// The helm camera eye: between the rider's eyes in the RIDER_POSE stance, bars straight and no lean
// (BOAT_CAMERA_INFO.pwc.eye repeats it; pose.test.ts checks they agree with the skeleton).
export const RIDER_EYE = new Vector3(0, 1.324, -0.199);

// Between the eyes, just behind the corneas, in the bind pose (character frame: +Z forward).
const EYE_BIND = new Vector3(0, 1.699, 0.07);

const MAT = 0.006; // footwell mat thickness

const FINGERS = ['index', 'middle', 'ring', 'pinky'] as const;

export const fitScale = (bindHeight: number): number => RIDER_HEIGHT / bindHeight;

interface Limb {
  upper: Object3D;
  lower: Object3D;
  end: Object3D;
  hinge: Vector3; // bend axis (character frame): the lower bone flexes positively about it
}

interface Side {
  side: number; // −1 port (bones *_l), +1 starboard (*_r)
  clavicle: Object3D;
  arm: Limb;
  leg: Limb;
  foot: Object3D;
  fingers: Object3D[][]; // [finger][joint]
  thumb: Object3D[];
  handDir: Vector3; // hand frame: wrist → middle knuckle
  handSide: Vector3; // hand frame: index → pinky knuckle
  palm: Vector3; // hand frame: back of the hand → palm
}

export interface RiderRig {
  character: Object3D; // the glTF scene, child of the body frame
  scale: number;
  bones: Object3D[]; // every bone the pose sets
  bind: Map<Object3D, Quaternion>; // bind-pose local rotations
  bindChar: Map<Object3D, Quaternion>; // bind-pose rotations in the character frame
  pelvis: Object3D;
  spine: Object3D[];
  neck: Object3D;
  head: Object3D;
  thighs: Object3D[];
  sides: Side[];
  eyeLocal: Vector3; // EYE_BIND in the head bone's frame
  ankleHeight: number; // ankle joint over the soles, scaled
}

// Scratch objects (poseRider runs every frame for every visible rider).
const m1 = new Matrix4();
const m2 = new Matrix4();
const m3 = new Matrix4();
const q1 = new Quaternion();
const q2 = new Quaternion();
const q3 = new Quaternion();
const qa = new Quaternion();
const qHead = new Quaternion();
const v1 = new Vector3();
const v2 = new Vector3();
const v3 = new Vector3();
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const AXIS_Z = new Vector3(0, 0, 1);

// Transforms from an object up to (not including) `stop`: the body frame when stop is the
// character's parent. Recomputed on every query, so they're never stale while bones change.
function frameMatrix(o: Object3D | null, stop: Object3D | null, out: Matrix4): Matrix4 {
  out.identity();
  for (let n = o; n && n !== stop; n = n.parent)
    out.premultiply(m3.compose(n.position, n.quaternion, n.scale));
  return out;
}

function frameQuaternion(o: Object3D | null, stop: Object3D | null, out: Quaternion): Quaternion {
  out.identity();
  for (let n = o; n && n !== stop; n = n.parent) out.premultiply(n.quaternion);
  return out;
}

const framePosition = (o: Object3D, stop: Object3D | null, out: Vector3): Vector3 =>
  out.setFromMatrixPosition(frameMatrix(o, stop, m1));

const hq = new Quaternion();
const rq = new Quaternion();

function setFrameQuaternion(o: Object3D, stop: Object3D | null, q: Quaternion): void {
  frameQuaternion(o.parent, stop, hq).invert();
  o.quaternion.multiplyQuaternions(hq, q).normalize();
}

function rotateInFrame(o: Object3D, stop: Object3D | null, delta: Quaternion): void {
  frameQuaternion(o, stop, rq).premultiply(delta);
  setFrameQuaternion(o, stop, rq);
}

function setFramePosition(o: Object3D, stop: Object3D | null, p: Vector3): void {
  o.position.copy(p).applyMatrix4(frameMatrix(o.parent, stop, m1).invert());
}

// Orthonormal basis with x along `dir` and y toward `side`.
function basis(dir: Vector3, side: Vector3, out: Matrix4): Matrix4 {
  const x = v1.copy(dir).normalize();
  const y = v2.copy(side).addScaledVector(x, -side.dot(x)).normalize();
  const z = v3.crossVectors(x, y);
  return out.makeBasis(x, y, z);
}

// The rotation taking local axes (dirLocal, sideLocal) onto (dir, side).
export function alignRotation(
  dirLocal: Vector3,
  sideLocal: Vector3,
  dir: Vector3,
  side: Vector3,
  out: Quaternion,
): Quaternion {
  const a = basis(dirLocal, sideLocal, m2).transpose();
  const b = basis(dir, side, m1);
  return out.setFromRotationMatrix(b.multiply(a));
}

const bone = (root: Object3D, name: string): Object3D => {
  const found = root.getObjectByName(name);
  if (!found) throw new Error(`rider skeleton has no ${name}`);
  return found;
};

// Binds the pose to a character, places it in the body frame (turned to face the bow) and scales it
// to RIDER_HEIGHT. extent: the body mesh's bind-pose height range (soles to crown), as modelled.
// The bind pose is read from `bindSource` (the loaded original, never posed), so the character
// itself may be a clone in any pose.
export function createRiderRig(
  character: Object3D,
  extent: { bottom: number; top: number },
  bindSource: Object3D = character,
): RiderRig {
  const scale = fitScale(extent.top - extent.bottom);
  character.position.set(0, 0, 0);
  character.quaternion.setFromAxisAngle(AXIS_Y, Math.PI);
  character.scale.setScalar(scale);
  const bones: Object3D[] = [];
  const bind = new Map<Object3D, Quaternion>();
  const bindChar = new Map<Object3D, Quaternion>();
  const source = (name: string): Object3D => bone(bindSource, name);
  const get = (name: string): Object3D => {
    const o = bone(character, name);
    const s = source(name);
    bones.push(o);
    bind.set(o, s.quaternion.clone().normalize());
    bindChar.set(o, frameQuaternion(s, bindSource, new Quaternion()));
    return o;
  };
  const pelvis = get('pelvis');
  const spine = ['spine_01', 'spine_02', 'spine_03'].map(get);
  const neck = get('neck_01');
  const head = get('Head');
  const sides = (['l', 'r'] as const).map((s): Side => {
    const hand = get(`hand_${s}`);
    const fingers = FINGERS.map((f) => [1, 2, 3].map((k) => get(`${f}_0${k}_${s}`)));
    const index = fingers[0]![0]!;
    const middle = fingers[1]![0]!;
    const pinky = fingers[3]![0]!;
    const foot = get(`foot_${s}`);
    return {
      side: s === 'l' ? -1 : 1,
      clavicle: get(`clavicle_${s}`),
      arm: {
        upper: get(`upperarm_${s}`),
        lower: get(`lowerarm_${s}`),
        end: hand,
        // T-pose, palms down: the elbow flexes the forearm toward the front (+Z).
        hinge: new Vector3(0, s === 'l' ? -1 : 1, 0),
      },
      leg: { upper: get(`thigh_${s}`), lower: get(`calf_${s}`), end: foot, hinge: new Vector3(1, 0, 0) },
      foot,
      fingers,
      thumb: [1, 2, 3].map((k) => get(`thumb_0${k}_${s}`)),
      handDir: middle.position.clone().normalize(),
      handSide: pinky.position.clone().sub(index.position).normalize(),
      // Palms face down in the bind pose.
      palm: new Vector3(0, -1, 0).applyQuaternion(bindChar.get(hand)!.clone().invert()),
    };
  });
  const headPos = framePosition(source('Head'), bindSource, new Vector3());
  const eyeLocal = EYE_BIND.clone().sub(headPos).applyQuaternion(bindChar.get(head)!.clone().invert());
  return {
    character,
    scale,
    bones,
    bind,
    bindChar,
    pelvis,
    spine,
    neck,
    head,
    thighs: sides.map((s) => s.leg.upper),
    sides,
    eyeLocal,
    ankleHeight: (framePosition(source('foot_l'), bindSource, new Vector3()).y - extent.bottom) * scale,
  };
}

// A bone's bind-pose attitude in the body frame (the character turned to face the bow).
function restInBody(rig: RiderRig, b: Object3D, out: Quaternion): Quaternion {
  return out.multiplyQuaternions(rig.character.quaternion, rig.bindChar.get(b)!);
}

const target = new Vector3();
const pole = new Vector3();
const joint = new Vector3();
const root = new Vector3();
const du = new Vector3();
const dl = new Vector3();
const hinge = new Vector3();
const dirLocal = new Vector3();
const hingeLocal = new Vector3();

// Two-bone IK: the end bone's origin to `goal`, bending toward `polePoint` (both body frame).
// Returns the distance left over when the goal is out of reach (0 when reached).
function solveLimb(rig: RiderRig, limb: Limb, goal: Vector3, polePoint: Vector3): number {
  const stop = rig.character.parent;
  framePosition(limb.upper, stop, root);
  const l1 = framePosition(limb.lower, stop, joint).distanceTo(root);
  const l2 = framePosition(limb.end, stop, v1).distanceTo(joint);
  twoBoneJoint(root, goal, l1, l2, polePoint, joint);
  du.subVectors(joint, root).normalize();
  dl.subVectors(goal, joint);
  const reach = dl.length();
  dl.multiplyScalar(1 / Math.max(reach, 1e-9));
  hinge.crossVectors(du, dl);
  if (hinge.lengthSq() < 1e-10) hinge.crossVectors(du, v1.subVectors(polePoint, root)).negate();
  hinge.normalize();
  for (const [b, child, dir] of [
    [limb.upper, limb.lower, du],
    [limb.lower, limb.end, dl],
  ] as const) {
    dirLocal.copy(child.position).normalize();
    hingeLocal.copy(limb.hinge).applyQuaternion(q3.copy(rig.bindChar.get(b)!).invert());
    setFrameQuaternion(b, stop, alignRotation(dirLocal, hingeLocal, dir, hinge, qa));
  }
  return Math.max(0, root.distanceTo(goal) - (l1 + l2));
}

const grip = new Vector3();
const axis = new Vector3();
const forearm = new Vector3();
const handDir = new Vector3();
const palm = new Vector3();
const shoulder = new Vector3();
const wrist = new Vector3();
const handQ = new Quaternion();
const twist = new Quaternion();

// The hand's attitude on the grip (body frame) for a forearm direction: knuckle line along the grip
// (pinky outboard), the wrist straight but for wristPitch over the top.
function handOnGrip(s: Side, steer: number, forearmDir: Vector3, out: Quaternion): Quaternion {
  gripAxis(s.side, steer, axis);
  handDir.copy(forearmDir).addScaledVector(axis, -forearmDir.dot(axis)).normalize();
  // Positive pitch rolls the knuckles up over the grip: about the outboard axis, sign by side.
  handDir.applyAxisAngle(axis, -s.side * RIDER_POSE.wristPitch);
  return alignRotation(s.handDir, s.handSide, handDir, axis, out);
}

function poseArm(rig: RiderRig, s: Side, steer: number): number {
  const stop = rig.character.parent;
  const p = RIDER_POSE;
  gripAt(s.side, steer, grip);
  framePosition(s.arm.upper, stop, shoulder);
  forearm.subVectors(grip, shoulder).normalize();
  pole
    .copy(p.elbowPole)
    .setX(p.elbowPole.x * s.side)
    .add(shoulder);
  let miss = 0;
  // Twice: the hand's attitude depends on the forearm's direction, which depends on the wrist.
  for (let pass = 0; pass < 2; pass++) {
    handOnGrip(s, steer, forearm, handQ);
    palm.copy(s.palm).applyQuaternion(handQ);
    wrist
      .copy(grip)
      .addScaledVector(v1.copy(s.handDir).applyQuaternion(handQ), -p.palm.forward)
      .addScaledVector(palm, -p.palm.depth);
    miss = solveLimb(rig, s.arm, wrist, pole);
    framePosition(s.arm.end, stop, v2);
    forearm.subVectors(v2, framePosition(s.arm.lower, stop, v3)).normalize();
  }
  setFrameQuaternion(s.arm.end, stop, handQ);
  // Swing-twist: the hand's roll about the forearm, partly moved into the forearm itself.
  const hand = s.arm.end;
  dirLocal.copy(hand.position).normalize();
  const r = hand.quaternion;
  const d = r.x * dirLocal.x + r.y * dirLocal.y + r.z * dirLocal.z;
  twist.set(dirLocal.x * d, dirLocal.y * d, dirLocal.z * d, r.w).normalize();
  q1.identity().slerp(twist, p.forearmTwist);
  s.arm.lower.quaternion.multiply(q1);
  setFrameQuaternion(hand, stop, handQ);
  // Fingers wrap the grip: local x is each joint's flexion axis.
  for (const finger of s.fingers)
    finger.forEach((b, k) =>
      b.quaternion.copy(rig.bind.get(b)!).multiply(q1.setFromAxisAngle(AXIS_X, p.fingerCurl[k]!)),
    );
  s.thumb.forEach((b, k) =>
    b.quaternion.copy(rig.bind.get(b)!).multiply(q1.setFromAxisAngle(AXIS_X, p.thumbCurl[k]!)),
  );
  return miss;
}

function poseLeg(rig: RiderRig, s: Side): number {
  const stop = rig.character.parent;
  const p = RIDER_POSE;
  target.set(p.ankle.x * s.side, FOOT_Y + MAT + rig.ankleHeight, p.ankle.z);
  framePosition(s.leg.upper, stop, root);
  pole
    .copy(p.kneePole)
    .setX(p.kneePole.x * s.side)
    .add(root);
  const miss = solveLimb(rig, s.leg, target, pole);
  // Soles flat on the floor, toes out.
  restInBody(rig, s.foot, q2).premultiply(q1.setFromAxisAngle(AXIS_Y, -s.side * p.footYaw));
  setFrameQuaternion(s.foot, stop, q2);
  return miss;
}

export interface PoseResult {
  reachMiss: number; // largest distance an arm or leg fell short of its target, m
}

// Poses the rider for a handlebar steer angle (the 'handlebar' node's yaw) and a lean (the
// 'rider:torso' drive, rad; positive leans to port).
export function poseRider(rig: RiderRig, steer: number, lean: number): PoseResult {
  const stop = rig.character.parent;
  const p = RIDER_POSE;
  for (const b of rig.bones) b.quaternion.copy(rig.bind.get(b)!);
  // Pelvis: forward tilt and its share of the lean, then the hips onto the seat.
  rotateInFrame(
    rig.pelvis,
    stop,
    q1.setFromAxisAngle(AXIS_Z, lean * p.lean.pelvis).multiply(q2.setFromAxisAngle(AXIS_X, p.pelvisPitch)),
  );
  const mid = framePosition(rig.thighs[0]!, stop, v2)
    .add(framePosition(rig.thighs[1]!, stop, v3))
    .multiplyScalar(0.5);
  const offset = target.copy(p.hips).sub(mid);
  setFramePosition(rig.pelvis, stop, framePosition(rig.pelvis, stop, v1).add(offset));
  rig.spine.forEach((b, k) =>
    rotateInFrame(
      b,
      stop,
      q1
        .setFromAxisAngle(AXIS_Z, lean * p.lean.spine[k]!)
        .multiply(q2.setFromAxisAngle(AXIS_X, p.spinePitch[k]!)),
    ),
  );
  // Head: looks down the bow with most of the lean cancelled; the neck takes part of the turn.
  const leanSum = p.lean.pelvis + p.lean.spine.reduce((a, b) => a + b, 0);
  const headTarget = restInBody(rig, rig.head, qHead).premultiply(
    q1
      .setFromAxisAngle(AXIS_Z, lean * leanSum * (1 - p.lean.headLevel))
      .multiply(q2.setFromAxisAngle(AXIS_X, p.headPitch)),
  );
  frameQuaternion(rig.head, stop, q3);
  const correction = q1.multiplyQuaternions(headTarget, q3.invert());
  rotateInFrame(rig.neck, stop, q2.identity().slerp(correction, p.neckShare));
  setFrameQuaternion(rig.head, stop, headTarget);
  let reachMiss = 0;
  for (const s of rig.sides) {
    rotateInFrame(
      s.clavicle,
      stop,
      q1
        .setFromAxisAngle(AXIS_Y, s.side * p.clavicle.protract)
        .multiply(q2.setFromAxisAngle(AXIS_Z, s.side * p.clavicle.raise)),
    );
    reachMiss = Math.max(reachMiss, poseLeg(rig, s), poseArm(rig, s, steer));
  }
  return { reachMiss };
}

// Limp in the water (overboard.ts): from the bind pose, in the character frame (+Z forward, his left
// +X). Arms drift down and forward with the elbows soft, legs hang a little forward and apart with the
// knees bent, the back curls and the head drops forward, hands and feet relaxed. `sway` (−1..1) moves
// the arms and legs slowly with the water.
const LIMP_POSE = {
  armDrop: 40 * DEG, // below the T-pose's horizontal
  armForward: 35 * DEG,
  elbow: 35 * DEG,
  hip: 25 * DEG, // thighs forward
  hipSpread: 8 * DEG,
  knee: 40 * DEG,
  spine: [6 * DEG, 6 * DEG, 5 * DEG], // forward curl
  neck: 12 * DEG,
  head: 18 * DEG, // dropped forward
  ankle: 30 * DEG, // toes pointed
  fingerCurl: [18 * DEG, 25 * DEG, 15 * DEG],
  thumbCurl: [-8 * DEG, 10 * DEG, 8 * DEG],
  sway: { arm: 12 * DEG, leg: 6 * DEG },
};

// Turns a bone about its own hinge (an axis in the character frame at bind) from the bind pose, so it
// bends the same way whatever its parent does.
function bendFromBind(rig: RiderRig, b: Object3D, hingeChar: Vector3, angle: number): void {
  v1.copy(hingeChar).applyQuaternion(q3.copy(rig.bindChar.get(b)!).invert());
  b.quaternion.copy(rig.bind.get(b)!).multiply(q1.setFromAxisAngle(v1, angle));
}

// Poses the rig limp (bone rotations only: the pelvis stays where it is).
export function poseLimp(rig: RiderRig, sway: number): void {
  const stop = rig.character;
  const p = LIMP_POSE;
  for (const b of rig.bones) b.quaternion.copy(rig.bind.get(b)!);
  rig.spine.forEach((b, k) => rotateInFrame(b, stop, q1.setFromAxisAngle(AXIS_X, p.spine[k]!)));
  rotateInFrame(rig.neck, stop, q1.setFromAxisAngle(AXIS_X, p.neck));
  rotateInFrame(rig.head, stop, q1.setFromAxisAngle(AXIS_X, p.head));
  for (const s of rig.sides) {
    // Port (s.side −1, bones *_l) reaches along +X in the bind pose. The arms sway together, the legs
    // in turn.
    const swing = sway * s.side;
    rotateInFrame(
      s.arm.upper,
      stop,
      q1
        .setFromAxisAngle(AXIS_Y, s.side * (p.armForward + p.sway.arm * sway))
        .multiply(q2.setFromAxisAngle(AXIS_Z, s.side * (p.armDrop - p.sway.arm * 0.5 * sway))),
    );
    bendFromBind(rig, s.arm.lower, s.arm.hinge, p.elbow + p.sway.arm * 0.5 * sway);
    rotateInFrame(
      s.leg.upper,
      stop,
      q1
        .setFromAxisAngle(AXIS_X, -(p.hip + p.sway.leg * swing))
        .multiply(q2.setFromAxisAngle(AXIS_Z, -s.side * p.hipSpread)),
    );
    bendFromBind(rig, s.leg.lower, s.leg.hinge, p.knee - p.sway.leg * swing);
    bendFromBind(rig, s.foot, AXIS_X, p.ankle);
    for (const finger of s.fingers)
      finger.forEach((b, k) =>
        b.quaternion.copy(rig.bind.get(b)!).multiply(q1.setFromAxisAngle(AXIS_X, p.fingerCurl[k]!)),
      );
    s.thumb.forEach((b, k) =>
      b.quaternion.copy(rig.bind.get(b)!).multiply(q1.setFromAxisAngle(AXIS_X, p.thumbCurl[k]!)),
    );
  }
}

// The point between the rider's eyes in the body frame.
export function riderEye(rig: RiderRig, out: Vector3): Vector3 {
  return out.copy(rig.eyeLocal).applyMatrix4(frameMatrix(rig.head, rig.character.parent, m2));
}

// The centre of a hand's grip (palm) in the body frame, for checks.
export function palmCentre(rig: RiderRig, side: number, out: Vector3): Vector3 {
  const s = rig.sides.find((x) => x.side === side)!;
  const stop = rig.character.parent;
  frameQuaternion(s.arm.end, stop, q1);
  return framePosition(s.arm.end, stop, out)
    .addScaledVector(v1.copy(s.handDir).applyQuaternion(q1), RIDER_POSE.palm.forward)
    .addScaledVector(v2.copy(s.palm).applyQuaternion(q1), RIDER_POSE.palm.depth);
}
