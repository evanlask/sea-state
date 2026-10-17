// Float64 6-DOF rigid body for boats: CG position, quaternion orientation,
// world-frame velocities, diagonal body-frame inertia, and per-axis added mass
// scaled by how much of the hull is immersed. Semi-implicit (symplectic) Euler.
//
// Body axes (conventions.ts): x starboard, y up, z aft (bow = −Z). Added mass
// therefore maps sway → x, heave → y, surge → z for translation and
// pitch → x, yaw → y, roll → z for rotation.

import {
  type Quat,
  type Vec3,
  qCopy,
  qIntegrate,
  qRotate,
  qRotateInverse,
  quatIdentity,
  v3Copy,
  vec3,
} from '../core/math';
import { GRAVITY } from '../core/units';

// Added mass (and added inertia) as fractions of the dry mass (inertia).
export interface AddedMassRatios {
  surge: number;
  sway: number;
  heave: number;
  roll: number;
  pitch: number;
  yaw: number;
}

const noAddedMass = (): AddedMassRatios => ({
  surge: 0,
  sway: 0,
  heave: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
});

export interface RadiiOfGyration {
  roll: number; // k_xx about the fore-aft axis, m
  pitch: number; // k_yy about the transverse axis, m
  yaw: number; // k_zz about the vertical axis, m
}

// Body-frame principal inertia (x pitch, y yaw, z roll) from radii of gyration.
export function inertiaFromGyration(mass: number, k: RadiiOfGyration): Vec3 {
  return vec3(mass * k.pitch * k.pitch, mass * k.yaw * k.yaw, mass * k.roll * k.roll);
}

export interface RigidBodyOptions {
  mass: number;
  inertia: Vec3; // body principal moments: x pitch, y yaw, z roll
  cg?: Vec3; // CG in body coordinates (relative to the body/mesh origin)
  addedMass?: AddedMassRatios;
}

const tmpA = vec3();
const tmpB = vec3();
const tmpC = vec3();

export class RigidBody {
  readonly position = vec3(); // world position of the CG
  readonly orientation: Quat = quatIdentity();
  readonly velocity = vec3(); // world, of the CG
  readonly angularVelocity = vec3(); // world
  readonly force = vec3(); // accumulated, world
  readonly torque = vec3(); // accumulated about the CG, world
  mass: number;
  readonly inertia: Vec3;
  readonly cg: Vec3;
  readonly addedMass: AddedMassRatios;
  immersion = 0; // 0..1, scales added mass; set each step from the hull forces

  constructor(options: RigidBodyOptions) {
    this.mass = options.mass;
    this.inertia = { ...options.inertia };
    this.cg = options.cg ? { ...options.cg } : vec3();
    this.addedMass = options.addedMass ? { ...options.addedMass } : noAddedMass();
  }

  // Places the body so that its ORIGIN (not the CG) sits at `origin`.
  setOriginPose(origin: Vec3, orientation: Quat): void {
    qCopy(this.orientation, orientation);
    qRotate(tmpA, this.orientation, this.cg);
    this.position.x = origin.x + tmpA.x;
    this.position.y = origin.y + tmpA.y;
    this.position.z = origin.z + tmpA.z;
  }

  getOrigin(out: Vec3): Vec3 {
    qRotate(out, this.orientation, this.cg);
    out.x = this.position.x - out.x;
    out.y = this.position.y - out.y;
    out.z = this.position.z - out.z;
    return out;
  }

  bodyToWorldPoint(out: Vec3, p: Vec3): Vec3 {
    tmpA.x = p.x - this.cg.x;
    tmpA.y = p.y - this.cg.y;
    tmpA.z = p.z - this.cg.z;
    qRotate(out, this.orientation, tmpA);
    out.x += this.position.x;
    out.y += this.position.y;
    out.z += this.position.z;
    return out;
  }

  worldToBodyPoint(out: Vec3, p: Vec3): Vec3 {
    tmpA.x = p.x - this.position.x;
    tmpA.y = p.y - this.position.y;
    tmpA.z = p.z - this.position.z;
    qRotateInverse(out, this.orientation, tmpA);
    out.x += this.cg.x;
    out.y += this.cg.y;
    out.z += this.cg.z;
    return out;
  }

  bodyToWorldDirection(out: Vec3, d: Vec3): Vec3 {
    return qRotate(out, this.orientation, d);
  }

  worldToBodyDirection(out: Vec3, d: Vec3): Vec3 {
    return qRotateInverse(out, this.orientation, d);
  }

  // Velocity of a world point moving with the body.
  pointVelocity(out: Vec3, worldPoint: Vec3): Vec3 {
    const w = this.angularVelocity;
    const rx = worldPoint.x - this.position.x;
    const ry = worldPoint.y - this.position.y;
    const rz = worldPoint.z - this.position.z;
    out.x = this.velocity.x + w.y * rz - w.z * ry;
    out.y = this.velocity.y + w.z * rx - w.x * rz;
    out.z = this.velocity.z + w.x * ry - w.y * rx;
    return out;
  }

  clearForces(): void {
    this.force.x = this.force.y = this.force.z = 0;
    this.torque.x = this.torque.y = this.torque.z = 0;
  }

  addGravity(g = GRAVITY): void {
    this.force.y -= this.mass * g;
  }

  addForce(f: Vec3): void {
    this.force.x += f.x;
    this.force.y += f.y;
    this.force.z += f.z;
  }

  addTorque(t: Vec3): void {
    this.torque.x += t.x;
    this.torque.y += t.y;
    this.torque.z += t.z;
  }

  addForceAtPoint(f: Vec3, worldPoint: Vec3): void {
    this.addForceAtPointXYZ(f.x, f.y, f.z, worldPoint.x, worldPoint.y, worldPoint.z);
  }

  addForceAtPointXYZ(fx: number, fy: number, fz: number, px: number, py: number, pz: number): void {
    const rx = px - this.position.x;
    const ry = py - this.position.y;
    const rz = pz - this.position.z;
    this.force.x += fx;
    this.force.y += fy;
    this.force.z += fz;
    this.torque.x += ry * fz - rz * fy;
    this.torque.y += rz * fx - rx * fz;
    this.torque.z += rx * fy - ry * fx;
  }

  // Force given in WORLD axes, applied at a BODY-frame point.
  addForceAtBodyPoint(f: Vec3, bodyPoint: Vec3): void {
    this.bodyToWorldPoint(tmpB, bodyPoint);
    this.addForceAtPoint(f, tmpB);
  }

  // Force and point both in body coordinates.
  addBodyForceAtBodyPoint(fBody: Vec3, bodyPoint: Vec3): void {
    this.bodyToWorldDirection(tmpC, fBody);
    this.bodyToWorldPoint(tmpB, bodyPoint);
    this.addForceAtPoint(tmpC, tmpB);
  }

  // Effective (dry + added) mass along a body axis: 0 x sway, 1 y heave, 2 z surge.
  effectiveMass(axis: 0 | 1 | 2): number {
    const a = this.addedMass;
    const ratio = axis === 0 ? a.sway : axis === 1 ? a.heave : a.surge;
    return this.mass * (1 + ratio * this.immersion);
  }

  // Effective inertia about a body axis: 0 x pitch, 1 y yaw, 2 z roll.
  effectiveInertia(axis: 0 | 1 | 2): number {
    const a = this.addedMass;
    const ratio = axis === 0 ? a.pitch : axis === 1 ? a.yaw : a.roll;
    const base = axis === 0 ? this.inertia.x : axis === 1 ? this.inertia.y : this.inertia.z;
    return base * (1 + ratio * this.immersion);
  }

  // One semi-implicit Euler step: velocities from the accumulated loads, then
  // positions from the new velocities. Does not clear the accumulators.
  integrate(dt: number): void {
    const q = this.orientation;
    const imm = this.immersion;
    const a = this.addedMass;
    const m = this.mass;

    // Translation, with per-axis effective mass in the body frame.
    const fb = qRotateInverse(tmpA, q, this.force);
    fb.x /= m * (1 + a.sway * imm);
    fb.y /= m * (1 + a.heave * imm);
    fb.z /= m * (1 + a.surge * imm);
    const acc = qRotate(tmpB, q, fb);
    this.velocity.x += acc.x * dt;
    this.velocity.y += acc.y * dt;
    this.velocity.z += acc.z * dt;
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // Rotation through the world angular momentum L = R·I·Rᵀ·ω: L += τ·dt, then ω from
    // L with the inertia carried by the rotated body. Unlike explicit Euler on the
    // gyroscopic term ω × Iω this stays stable for fast tumbles of bodies whose roll
    // inertia is much smaller than their pitch/yaw inertia (a capsizing boat).
    const ix = this.inertia.x * (1 + a.pitch * imm);
    const iy = this.inertia.y * (1 + a.yaw * imm);
    const iz = this.inertia.z * (1 + a.roll * imm);
    const L = qRotateInverse(tmpA, q, this.angularVelocity);
    L.x *= ix;
    L.y *= iy;
    L.z *= iz;
    qRotate(tmpC, q, L);
    tmpC.x += this.torque.x * dt;
    tmpC.y += this.torque.y * dt;
    tmpC.z += this.torque.z * dt;
    // Orientation advanced with ω from L in the old pose, then ω re-derived in the new pose.
    const wb = qRotateInverse(tmpA, q, tmpC);
    wb.x /= ix;
    wb.y /= iy;
    wb.z /= iz;
    qRotate(tmpB, q, wb);
    qIntegrate(this.orientation, q, tmpB, dt);
    const wn = qRotateInverse(tmpA, this.orientation, tmpC);
    wn.x /= ix;
    wn.y /= iy;
    wn.z /= iz;
    qRotate(this.angularVelocity, this.orientation, wn);
  }

  copyStateFrom(other: RigidBody): void {
    v3Copy(this.position, other.position);
    qCopy(this.orientation, other.orientation);
    v3Copy(this.velocity, other.velocity);
    v3Copy(this.angularVelocity, other.angularVelocity);
    this.immersion = other.immersion;
  }
}

// Steps a body `substeps` times across dt, rebuilding loads before each
// substep (the callback must clear nothing: the body's accumulators are
// cleared here first).
export function stepRigidBody(
  body: RigidBody,
  dt: number,
  substeps: number,
  applyLoads: (body: RigidBody, time: number, h: number) => void,
  time = 0,
): void {
  const h = dt / substeps;
  for (let s = 0; s < substeps; s++) {
    body.clearForces();
    applyLoads(body, time + s * h, h);
    body.integrate(h);
  }
}
