// Minimal float64 vector and quaternion helpers for the simulation. They work
// on plain mutable objects and write into an `out` argument so hot loops can
// run without allocating.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quatIdentity = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

export function v3Set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function v3Copy(out: Vec3, a: Vec3): Vec3 {
  return v3Set(out, a.x, a.y, a.z);
}

export function qSet(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function qCopy(out: Quat, q: Quat): Quat {
  return qSet(out, q.x, q.y, q.z, q.w);
}

export function qFromAxisAngle(out: Quat, axis: Vec3, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return qSet(out, axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
}

// out = a * b (apply b first, then a).
export function qMultiply(out: Quat, a: Quat, b: Quat): Quat {
  return qSet(
    out,
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  );
}

function qNormalize(out: Quat, q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length === 0) return qSet(out, 0, 0, 0, 1);
  return qSet(out, q.x / length, q.y / length, q.z / length, q.w / length);
}

function qConjugate(out: Quat, q: Quat): Quat {
  return qSet(out, -q.x, -q.y, -q.z, q.w);
}

// Rotates v by unit quaternion q (body → world when q is the body orientation).
export function qRotate(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return v3Set(
    out,
    v.x + q.w * tx + (q.y * tz - q.z * ty),
    v.y + q.w * ty + (q.z * tx - q.x * tz),
    v.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

const inverseScratch: Quat = { x: 0, y: 0, z: 0, w: 1 };

// Rotates v by the inverse of q (world → body).
export function qRotateInverse(out: Vec3, q: Quat, v: Vec3): Vec3 {
  return qRotate(out, qConjugate(inverseScratch, q), v);
}

// Integrates orientation by a world-space angular velocity over dt.
export function qIntegrate(out: Quat, q: Quat, angularVelocity: Vec3, dt: number): Quat {
  const half = dt / 2;
  const wx = angularVelocity.x * half;
  const wy = angularVelocity.y * half;
  const wz = angularVelocity.z * half;
  return qNormalize(
    out,
    qSet(
      out,
      q.x + wx * q.w + wy * q.z - wz * q.y,
      q.y - wx * q.z + wy * q.w + wz * q.x,
      q.z + wx * q.y - wy * q.x + wz * q.w,
      q.w - wx * q.x - wy * q.y - wz * q.z,
    ),
  );
}

// Spherical interpolation for render-time pose interpolation.
export function qSlerp(out: Quat, a: Quat, b: Quat, t: number): Quat {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return qNormalize(
      out,
      qSet(out, a.x + (bx - a.x) * t, a.y + (by - a.y) * t, a.z + (bz - a.z) * t, a.w + (bw - a.w) * t),
    );
  }
  const angle = Math.acos(cos);
  const sin = Math.sin(angle);
  const wa = Math.sin((1 - t) * angle) / sin;
  const wb = Math.sin(t * angle) / sin;
  return qSet(out, a.x * wa + bx * wb, a.y * wa + by * wb, a.z * wa + bz * wb, a.w * wa + bw * wb);
}
