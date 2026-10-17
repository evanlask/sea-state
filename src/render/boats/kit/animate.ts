// Telemetry-driven animation for boat models: rudders, wheels, outboards,
// jet nozzles, booms and handlebars follow BoatSnapshot.telemetry through
// declarative drives (a node's rotation/position on one axis, smoothed), and
// models with linkages (sheets, a rider's arms) add an animator closure.
// linkMesh/stretch hang a thin cylinder between two moving points (ropes, arms).

import {
  type BufferGeometry,
  CylinderGeometry,
  type Material,
  Mesh,
  type Object3D,
  Vector3,
} from 'three/webgpu';

export type Telemetry = Readonly<Record<string, number>>;

export interface TelemetryDrive {
  name: string; // node name; every node of that name in every LOD is driven
  axis: 'x' | 'y' | 'z';
  key?: string; // telemetry key
  value?: (t: Telemetry) => number; // custom mapping (overrides key/scale/offset)
  scale?: number; // per telemetry unit (rad or m), default 1
  offset?: number; // added to the telemetry value before scaling
  fallback?: number; // telemetry value when the key is absent, default 0
  min?: number;
  max?: number;
  rate?: number; // first-order approach rate, 1/s (0 = instant), default 12
  spin?: boolean; // the value is an angular speed (rad/s): integrate it
  property?: 'rotation' | 'position';
}

// Per-instance animation hook built for a visual's cloned LODs; `lod` is the visible level. `event`, if
// set, hears the boat's sim events ('capsized', 'sunk', 'recovered').
export type Animator = ((dt: number, telemetry: Telemetry, lod: number) => void) & {
  event?: (type: string) => void;
};
export type AnimatorFactory = (lods: readonly Object3D[]) => Animator;

export function driveTarget(d: TelemetryDrive, t: Telemetry): number {
  let v: number;
  if (d.value) v = d.value(t);
  else {
    const raw = d.key !== undefined ? (t[d.key] ?? d.fallback ?? 0) : (d.fallback ?? 0);
    v = (raw + (d.offset ?? 0)) * (d.scale ?? 1);
  }
  if (!Number.isFinite(v)) v = 0;
  if (d.min !== undefined) v = Math.max(d.min, v);
  if (d.max !== undefined) v = Math.min(d.max, v);
  return v;
}

// Frame-rate independent exponential approach.
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (rate <= 0) return target;
  return target + (current - target) * Math.exp(-rate * dt);
}

interface DriveState {
  drive: TelemetryDrive;
  nodes: { object: Object3D; base: number }[];
  value: number;
  angle: number; // integrated spin
}

// Drives bound to a set of LOD trees.
export class DriveSet {
  private readonly states: DriveState[];

  constructor(drives: readonly TelemetryDrive[], lods: readonly Object3D[]) {
    this.states = drives.map((drive) => {
      const nodes: DriveState['nodes'] = [];
      for (const lod of lods) {
        lod.traverse((o) => {
          if (o.name !== drive.name) return;
          o.matrixAutoUpdate = true;
          const prop = drive.property === 'position' ? o.position : o.rotation;
          nodes.push({ object: o, base: prop[drive.axis] });
        });
      }
      return { drive, nodes, value: driveTarget(drive, {}), angle: 0 };
    });
  }

  update(dt: number, t: Telemetry): void {
    for (const s of this.states) {
      if (s.nodes.length === 0) continue;
      const d = s.drive;
      s.value = approach(s.value, driveTarget(d, t), d.rate ?? 12, dt);
      let v = s.value;
      if (d.spin) {
        s.angle = (s.angle + s.value * dt) % (Math.PI * 2);
        v = s.angle;
      }
      for (const n of s.nodes) {
        const prop = d.property === 'position' ? n.object.position : n.object.rotation;
        prop[d.axis] = n.base + v;
      }
    }
  }
}

const UP = new Vector3(0, 1, 0);
const dir = new Vector3();

// A unit cylinder (y ∈ [0, 1]) for stretch(): ropes, sheets, a rider's limbs. Built in a model's extras
// so it shares the slot material; animators find it by name in their cloned LOD and move it.
export function linkMesh(radius: number, material: Material, name: string, segments = 5): Mesh {
  const g: BufferGeometry = new CylinderGeometry(radius, radius, 1, segments, 1, true).translate(0, 0.5, 0);
  const mesh = new Mesh(g, material);
  mesh.name = name;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

// Points a link from a to b (in its parent's frame).
export function stretch(mesh: Object3D, a: Vector3, b: Vector3): void {
  dir.subVectors(b, a);
  const len = dir.length();
  mesh.position.copy(a);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
  mesh.scale.set(1, Math.max(1e-4, len), 1);
}

const jointDelta = new Vector3();
const jointAxis = new Vector3();
const jointBend = new Vector3();

// Two-bone limb: the elbow/knee for a root and an end `reach` apart, bending toward `pole`.
export function twoBoneJoint(
  root: Vector3,
  end: Vector3,
  upper: number,
  lower: number,
  pole: Vector3,
  out: Vector3,
): Vector3 {
  const d = jointDelta.subVectors(end, root);
  // A reach of zero (hand on the shoulder) would divide by it below.
  const len = Math.max(1e-6, Math.min(d.length(), upper + lower - 1e-4));
  const axis = jointAxis.copy(d).normalize();
  // Distance along the root→end axis to the joint, and its offset off the axis (law of cosines).
  const a = (upper * upper - lower * lower + len * len) / (2 * len);
  const h = Math.sqrt(Math.max(0, upper * upper - a * a));
  const bend = jointBend.subVectors(pole, root);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-10) bend.set(0, -1, 0);
  bend.normalize();
  return out.copy(root).addScaledVector(axis, a).addScaledVector(bend, h);
}
