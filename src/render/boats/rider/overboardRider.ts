// Applies overboard.ts to a jet ski's rider: on a capsize (the 'capsized' telemetry flag or the event)
// each near LOD's skinned character lets go of the ski, keeping where it was in the world, and from
// then on is placed in world space under the boat's moving frame (it stays in its LOD's tree, so it
// goes with the visual when that's disposed), relaxing from the riding pose into the limp one as it
// falls, sinks and tumbles. The procedural figures (far LOD, or every LOD before the character loads)
// just hide. Gone below the visible depth, the character hides too; a reset ('recovered') puts it back
// on the seat at once.

import { Matrix4, type Object3D, Quaternion, Vector3 } from 'three/webgpu';

import type { Telemetry } from '../kit/animate';
import {
  createOverboard,
  detach,
  limbSway,
  limpWeight,
  resetOverboard,
  stepOverboard,
  tumbleRate,
  wantsDetach,
} from './overboard';
import { poseLimp, type RiderRig } from './pose';

const PROCEDURAL = /^rider:(legs|torso|arm:)/;

interface Held {
  rig: RiderRig;
  home: { position: Vector3; quaternion: Quaternion; scale: Vector3 }; // on the seat, in its LOD
  quaternion: Quaternion; // world attitude
  scale: Vector3; // world scale
  hips: Vector3; // the pelvis in the character's frame (the tumble's pivot)
  riding: Quaternion[]; // every posed bone as he let go
}

const m1 = new Matrix4();
const m2 = new Matrix4();
const v1 = new Vector3();
const q1 = new Quaternion();
const q2 = new Quaternion();
const axis = new Vector3();

export class RiderOverboard {
  private readonly state = createOverboard();
  private readonly held: Held[];
  private readonly procedural: Object3D[] = [];
  private readonly boatPosition = new Vector3();
  private readonly boatVelocity = new Vector3();
  private tracked = false;
  private forced = false;
  private readonly root: () => Object3D | null;
  private readonly onReset: () => void;

  // onReset re-poses the riders on the seat.
  constructor(lods: readonly Object3D[], rigs: readonly RiderRig[], onReset: () => void) {
    this.root = () => lods[0]?.parent ?? null;
    this.onReset = onReset;
    this.held = rigs.map((rig) => ({
      rig,
      home: {
        position: rig.character.position.clone(),
        quaternion: rig.character.quaternion.clone(),
        scale: rig.character.scale.clone(),
      },
      quaternion: new Quaternion(),
      scale: new Vector3(),
      hips: new Vector3(),
      riding: rig.bones.map(() => new Quaternion()),
    }));
    for (const lod of lods) lod.traverse((o) => PROCEDURAL.test(o.name) && this.procedural.push(o));
  }

  // Whether he's off the ski (the riding pose must leave him alone).
  get overboard(): boolean {
    return this.state.phase !== 'seated';
  }

  // The boat's sim events: a capsize (or sinking) throws him off, a recovery puts him back.
  event(type: string): void {
    if (type === 'capsized' || type === 'sunk') this.forced = true;
    else if (type === 'recovered') this.reset();
  }

  reset(): void {
    this.forced = false;
    if (this.state.phase === 'seated') return;
    resetOverboard(this.state);
    for (const h of this.held) {
      const c = h.rig.character;
      c.position.copy(h.home.position);
      c.quaternion.copy(h.home.quaternion);
      c.scale.copy(h.home.scale);
      c.visible = true;
    }
    for (const o of this.procedural) o.visible = true;
    this.onReset();
  }

  update(dt: number, telemetry: Telemetry): void {
    const root = this.root();
    if (!root) return;
    const s = this.state;
    if (s.phase === 'seated') {
      this.trackBoat(root, dt);
      const capsized = (telemetry['capsized'] ?? 0) > 0.5 || (telemetry['sunk'] ?? 0) > 0.5;
      if (wantsDetach(s, capsized) || this.forced) this.letGo();
      return;
    }
    if (s.phase === 'gone') return;
    if (stepOverboard(s, dt) === 'gone') {
      for (const h of this.held) h.rig.character.visible = false;
      return;
    }
    const w = limpWeight(s);
    const sway = limbSway(s);
    q1.setFromAxisAngle(axis.set(s.axis.x, s.axis.y, s.axis.z), tumbleRate(s) * dt);
    for (const h of this.held) {
      const c = h.rig.character;
      poseLimp(h.rig, sway);
      h.rig.bones.forEach((b, i) => {
        q2.copy(b.quaternion);
        b.quaternion.slerpQuaternions(h.riding[i]!, q2, w);
      });
      // Turned about his hips, which are where the state says; then into the boat's frame.
      h.quaternion.premultiply(q1).normalize();
      v1.copy(h.hips).multiply(h.scale).applyQuaternion(h.quaternion);
      v1.set(s.position.x - v1.x, s.position.y - v1.y, s.position.z - v1.z);
      c.parent!.updateWorldMatrix(true, false);
      m1.compose(v1, h.quaternion, h.scale);
      m2.copy(c.parent!.matrixWorld).invert().multiply(m1);
      m2.decompose(c.position, c.quaternion, c.scale);
    }
  }

  // The boat's velocity from its frame-to-frame motion, for the speed he's thrown off with.
  private trackBoat(root: Object3D, dt: number): void {
    root.updateWorldMatrix(true, false);
    v1.setFromMatrixPosition(root.matrixWorld);
    if (this.tracked && dt > 0) {
      this.boatVelocity.subVectors(v1, this.boatPosition).divideScalar(dt).clampLength(0, 20);
    }
    this.boatPosition.copy(v1);
    this.tracked = true;
  }

  private letGo(): void {
    this.forced = false;
    for (const o of this.procedural) o.visible = false;
    const first = this.held[0];
    const hips = new Vector3();
    if (first) {
      first.rig.pelvis.updateWorldMatrix(true, false);
      hips.setFromMatrixPosition(first.rig.pelvis.matrixWorld);
    } else hips.copy(this.boatPosition);
    detach(this.state, {
      hips,
      boatVelocity: this.boatVelocity,
      away: { x: hips.x - this.boatPosition.x, z: hips.z - this.boatPosition.z },
      surface: this.boatPosition.y,
      seed: Math.random(),
    });
    for (const h of this.held) {
      const c = h.rig.character;
      h.rig.pelvis.updateWorldMatrix(true, false);
      c.matrixWorld.decompose(v1, h.quaternion, h.scale);
      h.hips.setFromMatrixPosition(m1.copy(c.matrixWorld).invert().multiply(h.rig.pelvis.matrixWorld));
      h.rig.bones.forEach((b, i) => h.riding[i]!.copy(b.quaternion));
    }
  }
}
