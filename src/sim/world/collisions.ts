// Boat–boat collisions between compound hull shapes (collisionShapes.ts): each boat is two to four
// vertical-sided convex prisms following its hull's plan view, each with a body-height range.
//
// Broad phase: one bounding circle per boat, then one per prism. Narrow phase: prism pairs whose
// height ranges overlap (each prism's range rides on the world height of its own reference point,
// so a ship's bow pitching up clears a jet ski) are tested in plan view with the separating-axis
// test; the contact point is the middle of the clipped contact edge, so a glancing blow on the bow
// acts at the bow (and spins the boat) while boats lying side by side touch amidships. All the
// prism contacts between two boats merge into one contact (depth-weighted point and normal, the
// deepest penetration). Plan view follows the heading only: heel and pitch don't tilt the prisms.
//
// Fast pairs (a hydroplane at 90 m/s moves 0.75 m a step, more than half a jet ski's beam) are swept:
// the pair is tested at sub-steps along its relative path through the step, from where both stood at
// its start, and the first touch gives the contact normal and point; the penetration grows by the
// relative motion since then. Without it a fast bow lands deep inside a thin hull and is pushed out
// through the far side, or two hydroplanes closing at 180 m/s pass through each other.
//
// Overlapping pairs get a positional correction split by mass and an impulse along the contact
// normal (with a little restitution and friction), using the sway added mass and yaw added inertia
// so a jet ski bounces off a container ship rather than the reverse. Each impact is reported as a
// Contact (the boats, the contact point, the normal impulse and the closing speed) for the world's
// 'collision' events.

import { qRotate, vec3 } from '../core/math';
import type { RigidBody } from '../physics/RigidBody';
import type { CollisionShape } from './collisionShapes';

export interface CollisionHull {
  id: string;
  body: RigidBody;
  shape: CollisionShape;
}

// One impact this step: the pair, where they touched (world) and how hard.
export interface Contact {
  a: string;
  b: string;
  x: number;
  y: number;
  z: number;
  impulse: number; // N·s along the contact normal
  speed: number; // m/s closing speed at the contact point
}

const RESTITUTION = 0.2;
const FRICTION = 0.3;
// Pairs whose relative motion in a step exceeds this are swept, in sub-steps of SWEEP_STEP at most.
const SWEEP_MIN = 0.3; // m
const SWEEP_STEP = 0.25; // m
const MAX_SWEEP = 24;
const MAX_VERTS = 32;
const BOW = vec3(0, 0, -1);
const fa = vec3();
const va = vec3();
const vb = vec3();
const pc = vec3();
const bodyPoint = vec3();
const worldPoint = vec3();

// A prism placed in the world for this call.
class PlacedPiece {
  n = 0;
  readonly x = new Float64Array(MAX_VERTS);
  readonly z = new Float64Array(MAX_VERTS);
  readonly nx = new Float64Array(MAX_VERTS);
  readonly nz = new Float64Array(MAX_VERTS);
  cx = 0; // reference point (world)
  cy = 0;
  cz = 0;
  radius = 0;
  y0 = 0; // world height range
  y1 = 0;
}

// One boat placed for this call: plan frame, bounding circle and (lazily) its prisms.
class Frame {
  dx = 0; // bow direction (unit, horizontal)
  dz = 0;
  cx = 0; // bounding circle centre (world)
  cz = 0;
  radius = 0;
  placed = false;
  pieces: PlacedPiece[] = [];
}

const frames: Frame[] = [];

function frameOf(i: number, h: CollisionHull): Frame {
  let f = frames[i];
  if (!f) {
    f = new Frame();
    frames[i] = f;
  }
  const body = h.body;
  qRotate(fa, body.orientation, BOW);
  const len = Math.hypot(fa.x, fa.z) || 1;
  f.dx = fa.x / len;
  f.dz = fa.z / len;
  // Body point (0, ·, zc) → world, in plan, from the CG along the heading; the margin covers the CG
  // standing off the centreline and the waterline (heeled, the origin swings out from under it).
  const along = h.shape.zc - body.cg.z;
  f.cx = body.position.x - f.dx * along;
  f.cz = body.position.z - f.dz * along;
  f.radius = h.shape.radius + Math.hypot(body.cg.x, body.cg.y);
  f.placed = false;
  return f;
}

// Places every prism of a boat: reference point through the full pose, the outline by heading.
function place(f: Frame, h: CollisionHull): void {
  if (f.placed) return;
  f.placed = true;
  const body = h.body;
  const pieces = h.shape.pieces;
  while (f.pieces.length < pieces.length) f.pieces.push(new PlacedPiece());
  // Starboard and aft unit vectors in plan.
  const sx = -f.dz;
  const sz = f.dx;
  const ax = -f.dx;
  const az = -f.dz;
  for (let k = 0; k < pieces.length; k++) {
    const src = pieces[k]!;
    const dst = f.pieces[k]!;
    bodyPoint.x = 0;
    bodyPoint.y = 0;
    bodyPoint.z = src.zc;
    body.bodyToWorldPoint(worldPoint, bodyPoint);
    dst.cx = worldPoint.x;
    dst.cy = worldPoint.y;
    dst.cz = worldPoint.z;
    dst.y0 = worldPoint.y + src.y0;
    dst.y1 = worldPoint.y + src.y1;
    dst.radius = src.radius;
    const n = Math.min(MAX_VERTS, src.xs.length);
    dst.n = n;
    for (let i = 0; i < n; i++) {
      const x = src.xs[i]!;
      const z = src.zs[i]! - src.zc;
      dst.x[i] = worldPoint.x + sx * x + ax * z;
      dst.z[i] = worldPoint.z + sz * x + az * z;
      const nx = src.nxs[i]!;
      const nz = src.nzs[i]!;
      dst.nx[i] = sx * nx + ax * nz;
      dst.nz[i] = sz * nx + az * nz;
    }
  }
}

// Moves a placed boat by (dx, dz) in plan (its prisms, their centres and its bounding circle).
function shift(f: Frame, dx: number, dz: number): void {
  f.cx += dx;
  f.cz += dz;
  for (const piece of f.pieces) {
    piece.cx += dx;
    piece.cz += dz;
    for (let i = 0; i < piece.n; i++) {
      piece.x[i]! += dx;
      piece.z[i]! += dz;
    }
  }
}

// Largest separation of q from p along p's edge normals; the edge goes to `edgeOut`.
let edgeOut = 0;
function maxSeparation(p: PlacedPiece, q: PlacedPiece): number {
  let best = -Infinity;
  for (let i = 0; i < p.n; i++) {
    const nx = p.nx[i]!;
    const nz = p.nz[i]!;
    const px = p.x[i]!;
    const pz = p.z[i]!;
    let s = Infinity;
    for (let j = 0; j < q.n; j++) {
      const d = nx * (q.x[j]! - px) + nz * (q.z[j]! - pz);
      if (d < s) s = d;
    }
    if (s > best) {
      best = s;
      edgeOut = i;
      if (best > 0) return best;
    }
  }
  return best;
}

// Result of one prism pair: normal from B to A, depth and contact point (plan).
const hit = { nx: 0, nz: 0, depth: 0, x: 0, z: 0 };
const clipX = new Float64Array(2);
const clipZ = new Float64Array(2);

function collidePieces(A: PlacedPiece, B: PlacedPiece): boolean {
  const sepA = maxSeparation(A, B);
  if (sepA > 0) return false;
  const edgeA = edgeOut;
  const sepB = maxSeparation(B, A);
  if (sepB > 0) return false;
  const edgeB = edgeOut;
  // Reference face: the axis of least penetration (with a bias so it doesn't flicker).
  const flip = sepB > 0.98 * sepA + 0.001;
  const R = flip ? B : A;
  const I = flip ? A : B;
  const e = flip ? edgeB : edgeA;
  const nx = R.nx[e]!;
  const nz = R.nz[e]!;
  const v1x = R.x[e]!;
  const v1z = R.z[e]!;
  const e2 = (e + 1) % R.n;
  const v2x = R.x[e2]!;
  const v2z = R.z[e2]!;
  // Incident edge: the one facing the reference normal most.
  let inc = 0;
  let minDot = Infinity;
  for (let j = 0; j < I.n; j++) {
    const d = nx * I.nx[j]! + nz * I.nz[j]!;
    if (d < minDot) {
      minDot = d;
      inc = j;
    }
  }
  const inc2 = (inc + 1) % I.n;
  clipX[0] = I.x[inc]!;
  clipZ[0] = I.z[inc]!;
  clipX[1] = I.x[inc2]!;
  clipZ[1] = I.z[inc2]!;
  // Clip the incident edge to the reference edge's extent.
  let tx = v2x - v1x;
  let tz = v2z - v1z;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl;
  tz /= tl;
  if (!clip(tx, tz, tx * v1x + tz * v1z) || !clip(-tx, -tz, -(tx * v2x + tz * v2z))) {
    // Degenerate (no overlap along the face): fall back to the incident vertex.
    clipX[0] = clipX[1] = I.x[inc]!;
    clipZ[0] = clipZ[1] = I.z[inc]!;
  }
  let sx = 0;
  let sz = 0;
  let count = 0;
  for (let k = 0; k < 2; k++) {
    const depth = -(nx * (clipX[k]! - v1x) + nz * (clipZ[k]! - v1z));
    if (depth < 0) continue;
    // Midway between the two surfaces.
    sx += clipX[k]! + nx * depth * 0.5;
    sz += clipZ[k]! + nz * depth * 0.5;
    count++;
  }
  if (count === 0) {
    sx = 0.5 * (clipX[0]! + clipX[1]!);
    sz = 0.5 * (clipZ[0]! + clipZ[1]!);
    count = 1;
  }
  hit.x = sx / count;
  hit.z = sz / count;
  hit.depth = -(flip ? sepB : sepA);
  // The reference normal points from R towards I; the result points from B to A.
  hit.nx = flip ? nx : -nx;
  hit.nz = flip ? nz : -nz;
  return true;
}

// Keeps the part of the clip segment with n·p ≥ c; false when nothing is left.
function clip(nx: number, nz: number, c: number): boolean {
  const d0 = nx * clipX[0]! + nz * clipZ[0]! - c;
  const d1 = nx * clipX[1]! + nz * clipZ[1]! - c;
  if (d0 < 0 && d1 < 0) return false;
  if (d0 < 0 || d1 < 0) {
    const s = d0 / (d0 - d1);
    const x = clipX[0]! + (clipX[1]! - clipX[0]!) * s;
    const z = clipZ[0]! + (clipZ[1]! - clipZ[0]!) * s;
    if (d0 < 0) {
      clipX[0] = x;
      clipZ[0] = z;
    } else {
      clipX[1] = x;
      clipZ[1] = z;
    }
  }
  return true;
}

// The merged contact of two boats (normal from B to A); false when they don't touch.
const contact = { nx: 0, nz: 0, depth: 0, x: 0, y: 0, z: 0 };

function boatContact(A: CollisionHull, fA: Frame, B: CollisionHull, fB: Frame): boolean {
  place(fA, A);
  place(fB, B);
  let w = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let snx = 0;
  let snz = 0;
  let deepest = 0;
  const na = A.shape.pieces.length;
  const nb = B.shape.pieces.length;
  for (let i = 0; i < na; i++) {
    const pa = fA.pieces[i]!;
    for (let j = 0; j < nb; j++) {
      const pb = fB.pieces[j]!;
      const lo = Math.max(pa.y0, pb.y0);
      const hi = Math.min(pa.y1, pb.y1);
      if (hi <= lo) continue;
      const ddx = pa.cx - pb.cx;
      const ddz = pa.cz - pb.cz;
      const reach = pa.radius + pb.radius;
      if (ddx * ddx + ddz * ddz > reach * reach) continue;
      if (!collidePieces(pa, pb)) continue;
      const d = Math.max(hit.depth, 1e-6);
      // Height: the waterline between the two prisms, kept inside the shared height range.
      const y = Math.min(hi, Math.max(lo, 0.5 * (pa.cy + pb.cy)));
      w += d;
      sx += hit.x * d;
      sy += y * d;
      sz += hit.z * d;
      snx += hit.nx * d;
      snz += hit.nz * d;
      if (hit.depth > deepest) deepest = hit.depth;
    }
  }
  if (w === 0) return false;
  contact.x = sx / w;
  contact.y = sy / w;
  contact.z = sz / w;
  const len = Math.hypot(snx, snz);
  if (len > 1e-9) {
    contact.nx = snx / len;
    contact.nz = snz / len;
  } else {
    // Opposed normals cancel (deep inside each other): push apart along the centre line.
    const cx = fA.cx - fB.cx;
    const cz = fA.cz - fB.cz;
    const cl = Math.hypot(cx, cz);
    contact.nx = cl > 1e-9 ? cx / cl : 1;
    contact.nz = cl > 1e-9 ? cz / cl : 0;
  }
  contact.depth = deepest;
  return true;
}

// Effective translational mass and yaw inertia (with added mass).
const massOf = (b: RigidBody): number => b.mass * (1 + b.addedMass.sway * b.immersion);
const yawInertiaOf = (b: RigidBody): number => b.inertia.y * (1 + b.addedMass.yaw * b.immersion);

// The first touch of a fast pair over the last `dt` (relative motion (rx, rz) m in it): tested at
// sub-steps from where both stood at the step's start; the contact moved on to now, its penetration
// grown by the relative motion since. False when they never touched.
function sweptContact(
  A: CollisionHull,
  fA: Frame,
  B: CollisionHull,
  fB: Frame,
  dt: number,
  rx: number,
  rz: number,
): boolean {
  place(fA, A);
  place(fB, B);
  const va = A.body.velocity;
  const vb = B.body.velocity;
  const n = Math.min(MAX_SWEEP, Math.ceil(Math.hypot(rx, rz) / SWEEP_STEP));
  let ax = 0;
  let az = 0;
  let bx = 0;
  let bz = 0;
  let found = false;
  let back = 0; // s from the touch to now
  for (let k = 0; k <= n && !found; k++) {
    back = dt * (1 - k / n);
    // Move both to where they were `back` s ago.
    const tax = -va.x * back - ax;
    const taz = -va.z * back - az;
    const tbx = -vb.x * back - bx;
    const tbz = -vb.z * back - bz;
    shift(fA, tax, taz);
    shift(fB, tbx, tbz);
    ax += tax;
    az += taz;
    bx += tbx;
    bz += tbz;
    found = boatContact(A, fA, B, fB);
  }
  shift(fA, -ax, -az);
  shift(fB, -bx, -bz);
  if (!found) return false;
  // On to now: the contact rides with the pair's mean motion; the bodies' approach along the
  // normal since the touch adds to the depth.
  const closing = -((va.x - vb.x) * contact.nx + (va.z - vb.z) * contact.nz) * back;
  contact.depth = Math.max(contact.depth, contact.depth + closing);
  contact.x += 0.5 * (va.x + vb.x) * back;
  contact.z += 0.5 * (va.z + vb.z) * back;
  return true;
}

// Separates overlapping hulls and returns the number of overlapping pairs; impacts (pairs still
// closing) are appended to `contacts` when given. `dt` (s, the step just taken) sweeps fast pairs
// along their relative motion; 0 tests the poses as they stand.
export function resolveCollisions(hulls: readonly CollisionHull[], contacts?: Contact[], dt = 0): number {
  let overlaps = 0;
  for (let i = 0; i < hulls.length; i++) frameOf(i, hulls[i]!);
  for (let i = 0; i < hulls.length; i++) {
    for (let j = i + 1; j < hulls.length; j++) {
      const A = hulls[i]!;
      const B = hulls[j]!;
      const fA = frames[i]!;
      const fB = frames[j]!;
      const ddx = fA.cx - fB.cx;
      const ddz = fA.cz - fB.cz;
      // Relative motion over the step: a fast pair is swept, its broad phase widened by it.
      const rx = (A.body.velocity.x - B.body.velocity.x) * dt;
      const rz = (A.body.velocity.z - B.body.velocity.z) * dt;
      const sweep = Math.hypot(rx, rz);
      const swept = sweep > SWEEP_MIN;
      const reach = fA.radius + fB.radius + (swept ? sweep : 0);
      // (Also skips a pair with a non-finite position.)
      if (!(ddx * ddx + ddz * ddz <= reach * reach)) continue;
      if (!(swept ? sweptContact(A, fA, B, fB, dt, rx, rz) : boatContact(A, fA, B, fB))) continue;
      overlaps++;
      const { nx, nz } = contact;
      const pen = contact.depth;
      const a = A.body;
      const b = B.body;
      const ma = massOf(a);
      const mb = massOf(b);
      const ia = yawInertiaOf(a);
      const ib = yawInertiaOf(b);
      pc.x = contact.x;
      pc.y = contact.y;
      pc.z = contact.z;
      // Push apart, the lighter boat moving most (their prisms move with them).
      const wa = mb / (ma + mb);
      a.position.x += nx * pen * wa;
      a.position.z += nz * pen * wa;
      b.position.x -= nx * pen * (1 - wa);
      b.position.z -= nz * pen * (1 - wa);
      fA.cx += nx * pen * wa;
      fA.cz += nz * pen * wa;
      fB.cx -= nx * pen * (1 - wa);
      fB.cz -= nz * pen * (1 - wa);
      fA.placed = false;
      fB.placed = false;
      a.pointVelocity(va, pc);
      b.pointVelocity(vb, pc);
      const rvx = va.x - vb.x;
      const rvz = va.z - vb.z;
      const vn = rvx * nx + rvz * nz;
      if (vn >= 0) continue;
      // Lever arms (horizontal) for the yaw response: (r × n)_y = rz·nx − rx·nz.
      const rax = pc.x - a.position.x;
      const raz = pc.z - a.position.z;
      const rbx = pc.x - b.position.x;
      const rbz = pc.z - b.position.z;
      const ca = raz * nx - rax * nz;
      const cb = rbz * nx - rbx * nz;
      const k = 1 / ma + 1 / mb + (ca * ca) / ia + (cb * cb) / ib;
      const jn = (-(1 + RESTITUTION) * vn) / k;
      // Friction along the tangent, bounded by μ·jn.
      const tx = -nz;
      const tz = nx;
      const vt = rvx * tx + rvz * tz;
      const cta = raz * tx - rax * tz;
      const ctb = rbz * tx - rbx * tz;
      const kt = 1 / ma + 1 / mb + (cta * cta) / ia + (ctb * ctb) / ib;
      const jt = Math.max(-FRICTION * jn, Math.min(FRICTION * jn, -vt / kt));
      const jx = jn * nx + jt * tx;
      const jz = jn * nz + jt * tz;
      a.velocity.x += jx / ma;
      a.velocity.z += jz / ma;
      b.velocity.x -= jx / mb;
      b.velocity.z -= jz / mb;
      a.angularVelocity.y += (raz * jx - rax * jz) / ia;
      b.angularVelocity.y -= (rbz * jx - rbx * jz) / ib;
      contacts?.push({ a: A.id, b: B.id, x: pc.x, y: pc.y, z: pc.z, impulse: jn, speed: -vn });
    }
  }
  return overlaps;
}

// Tests and tools: the merged contact between two hulls as they stand (null when apart).
export function contactBetween(
  A: CollisionHull,
  B: CollisionHull,
): { nx: number; nz: number; depth: number; x: number; y: number; z: number } | null {
  const fA = frameOf(0, A);
  const fB = frameOf(1, B);
  return boatContact(A, fA, B, fB) ? { ...contact } : null;
}
