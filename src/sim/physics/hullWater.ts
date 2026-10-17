// Per-boat water sampler over a choppy ocean surface. Instead of an inverse
// (Newton) surface query for every hull vertex every substep, the ocean is
// queried once per master step on a small grid that moves with the boat
// (warm-started from the previous step), at the surface and at a reference
// depth; hull vertices, foils, propellers and openings then interpolate:
//   head(y) = η − y above the surface,
//   head(y) = −y + η_eff(d) below it, d = η − y, with η_eff linear from η at
//            the surface to the attenuated Σ η_c·e^{−k_c·d_ref} at d_ref
//            (and decaying beyond at the rate it fell over d_ref), as
//            WaterSample.pressureHead defines.
// Within a master step the surface is advanced with its vertical velocity.
// Points outside the grid clamp to its edge.

import type { DeepSample, SurfaceSample } from '../ocean/OceanSurface';
import type { RigidBody } from './RigidBody';
import type { WaterSample, WaterSampler } from './water';

// The query side of OceanSurface (and of the analytic test seas).
export interface SurfaceQuery {
  query(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth?: number,
    mask?: number,
    warmStart?: boolean,
  ): SurfaceSample;
  // Optional: query() at the surface plus, into `deep`, the pressure head and velocity `depth` below
  // the same surface particle, in one pass (what a second warm-started query() at that depth reads).
  queryWithDepth?(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth: number,
    deep: DeepSample,
    mask?: number,
    warmStart?: boolean,
  ): SurfaceSample;
}

export interface HullWaterOptions {
  halfLength: number; // grid half-extent along the boat, m
  halfWidth: number; // across, m
  nx: number; // points along
  nz: number; // points across
  referenceDepth: number; // m
  mask: number; // cascade mask
}

const FIELDS = 15;
// Per grid point: η, nx, ny, nz, vx, vy, vz (surface), J, η_ref, vx_ref, vy_ref, vz_ref, steepness,
// crest vx, crest vz.

const surfaceSample = (): SurfaceSample => ({
  height: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  velocityX: 0,
  velocityY: 0,
  velocityZ: 0,
  jacobian: 1,
  pressureHead: 0,
  steepness: 0,
  crestVelocityX: 0,
  crestVelocityZ: 0,
  lagrangianX: 0,
  lagrangianZ: 0,
  iterations: 0,
  converged: true,
});

// A quantity's value `n` reference depths further down, from its value at the surface and at the
// reference depth: it keeps the ratio per reference depth when that is a decay (0..1), else (mixed
// cascades of opposite sign, or nothing to decay) holds the reference value.
function extend(surface: number, ref: number, n: number): number {
  const r = surface !== 0 ? ref / surface : 0;
  return r > 0 && r < 1 ? ref * r ** n : ref;
}

export class HullWater implements WaterSampler {
  readonly surface: SurfaceQuery;
  readonly options: HullWaterOptions;
  private readonly grid: Float64Array;
  private readonly lagX: Float64Array;
  private readonly lagZ: Float64Array;
  private readonly lastX: Float64Array;
  private readonly lastZ: Float64Array;
  private readonly scratch = surfaceSample();
  private readonly deep: DeepSample = { pressureHead: 0, velocityX: 0, velocityY: 0, velocityZ: 0 };
  private cx = 0;
  private cz = 0;
  private fx = 0; // unit forward (bow) direction, world xz
  private fz = -1;
  private time = 0;
  private primed = false;
  queries = 0; // surface queries made (for profiling)
  // Bilinear corners and weights of the current sample (fields: no allocation).
  private p00 = 0;
  private p01 = 0;
  private p10 = 0;
  private p11 = 0;
  private w00 = 1;
  private w01 = 0;
  private w10 = 0;
  private w11 = 0;

  constructor(surface: SurfaceQuery, options: HullWaterOptions) {
    this.surface = surface;
    this.options = options;
    const n = options.nx * options.nz;
    this.grid = new Float64Array(n * FIELDS);
    this.lagX = new Float64Array(n);
    this.lagZ = new Float64Array(n);
    this.lastX = new Float64Array(n);
    this.lastZ = new Float64Array(n);
  }

  reset(): void {
    this.primed = false;
  }

  // Re-samples the grid around the body for this master step.
  update(body: RigidBody, time: number): void {
    const o = this.options;
    const q = body.orientation;
    // Bow direction (body −z) projected on the horizontal.
    let fx = -2 * (q.x * q.z + q.w * q.y);
    let fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const len = Math.hypot(fx, fz);
    if (len > 1e-3) {
      fx /= len;
      fz /= len;
    } else {
      fx = this.fx;
      fz = this.fz;
    }
    this.fx = fx;
    this.fz = fz;
    // Grid centred on the body origin's plan position.
    this.cx = body.position.x;
    this.cz = body.position.z;
    this.time = time;
    const s = this.scratch;
    const g = this.grid;
    const rx = -fz; // starboard
    const rz = fx;
    const fused = this.surface.queryWithDepth !== undefined;
    for (let i = 0; i < o.nx; i++) {
      const a = o.nx > 1 ? -o.halfLength + (2 * o.halfLength * i) / (o.nx - 1) : 0;
      for (let j = 0; j < o.nz; j++) {
        const b = o.nz > 1 ? -o.halfWidth + (2 * o.halfWidth * j) / (o.nz - 1) : 0;
        const k = i * o.nz + j;
        const x = this.cx + fx * a + rx * b;
        const z = this.cz + fz * a + rz * b;
        const warm = this.primed && Math.abs(x - this.lastX[k]!) < 3 && Math.abs(z - this.lastZ[k]!) < 3;
        s.lagrangianX = this.lagX[k]!;
        s.lagrangianZ = this.lagZ[k]!;
        const deep = this.deep;
        if (fused) this.surface.queryWithDepth!(x, z, time, s, o.referenceDepth, deep, o.mask, warm);
        else this.surface.query(x, z, time, s, 0, o.mask, warm);
        this.lagX[k] = s.lagrangianX;
        this.lagZ[k] = s.lagrangianZ;
        this.lastX[k] = x;
        this.lastZ[k] = z;
        const p = k * FIELDS;
        g[p] = s.height;
        g[p + 1] = s.normalX;
        g[p + 2] = s.normalY;
        g[p + 3] = s.normalZ;
        g[p + 4] = s.velocityX;
        g[p + 5] = s.velocityY;
        g[p + 6] = s.velocityZ;
        g[p + 7] = s.jacobian;
        g[p + 12] = s.steepness;
        g[p + 13] = s.crestVelocityX;
        g[p + 14] = s.crestVelocityZ;
        if (!fused) {
          // Same rest point, attenuated to the reference depth: one evaluation.
          this.surface.query(x, z, time, s, o.referenceDepth, o.mask, true);
          deep.pressureHead = s.pressureHead;
          deep.velocityX = s.velocityX;
          deep.velocityY = s.velocityY;
          deep.velocityZ = s.velocityZ;
        }
        g[p + 8] = deep.pressureHead;
        g[p + 9] = deep.velocityX;
        g[p + 10] = deep.velocityY;
        g[p + 11] = deep.velocityZ;
        this.queries += fused ? 1 : 2;
      }
    }
    this.primed = true;
  }

  sample(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample {
    const o = this.options;
    const dx = x - this.cx;
    const dz = z - this.cz;
    // Grid coordinates.
    const a = dx * this.fx + dz * this.fz;
    const b = dx * -this.fz + dz * this.fx;
    let u = o.nx > 1 ? ((a + o.halfLength) / (2 * o.halfLength)) * (o.nx - 1) : 0;
    let v = o.nz > 1 ? ((b + o.halfWidth) / (2 * o.halfWidth)) * (o.nz - 1) : 0;
    u = u < 0 ? 0 : u > o.nx - 1 ? o.nx - 1 : u;
    v = v < 0 ? 0 : v > o.nz - 1 ? o.nz - 1 : v;
    const i0 = Math.min(o.nx - 2, Math.floor(u));
    const j0 = Math.min(o.nz - 2, Math.floor(v));
    const fu = o.nx > 1 ? u - i0 : 0;
    const fv = o.nz > 1 ? v - j0 : 0;
    const p00 = (Math.max(0, i0) * o.nz + Math.max(0, j0)) * FIELDS;
    this.p00 = p00;
    this.p01 = p00 + (o.nz > 1 ? FIELDS : 0);
    this.p10 = p00 + (o.nx > 1 ? o.nz * FIELDS : 0);
    this.p11 = this.p10 + (o.nz > 1 ? FIELDS : 0);
    this.w00 = (1 - fu) * (1 - fv);
    this.w01 = (1 - fu) * fv;
    this.w10 = fu * (1 - fv);
    this.w11 = fu * fv;
    const dt = time - this.time;
    const vy0 = this.at(5);
    const eta = this.at(0) + vy0 * dt;
    let nx = this.at(1);
    let ny = this.at(2);
    let nz = this.at(3);
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv;
    ny *= inv;
    nz *= inv;
    out.height = eta;
    out.normalX = nx;
    out.normalY = ny;
    out.normalZ = nz;
    out.jacobian = this.at(7);
    out.steepness = this.at(12);
    out.crestVelocityX = this.at(13);
    out.crestVelocityZ = this.at(14);
    const d = eta - y;
    if (d <= 0) {
      out.pressureHead = d;
      out.velocityX = this.at(4);
      out.velocityY = vy0;
      out.velocityZ = this.at(6);
      return out;
    }
    const dRef = o.referenceDepth;
    const etaRef = this.at(8) + this.at(10) * dt;
    if (d <= dRef) {
      // Linear from the surface to the reference depth.
      const t = d / dRef;
      out.pressureHead = -y + eta + (etaRef - eta) * t;
      out.velocityX = this.at(4) + (this.at(9) - this.at(4)) * t;
      out.velocityY = vy0 + (this.at(10) - vy0) * t;
      out.velocityZ = this.at(6) + (this.at(11) - this.at(6)) * t;
      return out;
    }
    // Deeper, each quantity keeps decaying at the rate it fell over [0, dRef]: exact for one
    // cascade, a lower bound for several (Σ w·e^{−k·d} is log-convex). The long waves that carry
    // most of a crest barely attenuate in a hull's depth, so a slower (1/d) decay would lose head.
    const n = (d - dRef) / dRef;
    out.pressureHead = -y + extend(eta, etaRef, n);
    out.velocityX = extend(this.at(4), this.at(9), n);
    out.velocityY = extend(vy0, this.at(10), n);
    out.velocityZ = extend(this.at(6), this.at(11), n);
    return out;
  }

  // The hull's per-vertex query (WaterSampler.sampleHead): height, pressure head and velocity exactly
  // as sample() computes them, with the bilinear lookups inlined and nothing else evaluated.
  sampleHead(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample {
    const o = this.options;
    const nxg = o.nx;
    const nzg = o.nz;
    const dx = x - this.cx;
    const dz = z - this.cz;
    const a = dx * this.fx + dz * this.fz;
    const b = dx * -this.fz + dz * this.fx;
    let u = nxg > 1 ? ((a + o.halfLength) / (2 * o.halfLength)) * (nxg - 1) : 0;
    let v = nzg > 1 ? ((b + o.halfWidth) / (2 * o.halfWidth)) * (nzg - 1) : 0;
    u = u < 0 ? 0 : u > nxg - 1 ? nxg - 1 : u;
    v = v < 0 ? 0 : v > nzg - 1 ? nzg - 1 : v;
    const i0 = Math.min(nxg - 2, Math.floor(u));
    const j0 = Math.min(nzg - 2, Math.floor(v));
    const fu = nxg > 1 ? u - i0 : 0;
    const fv = nzg > 1 ? v - j0 : 0;
    const p00 = (Math.max(0, i0) * nzg + Math.max(0, j0)) * FIELDS;
    const p01 = p00 + (nzg > 1 ? FIELDS : 0);
    const p10 = p00 + (nxg > 1 ? nzg * FIELDS : 0);
    const p11 = p10 + (nzg > 1 ? FIELDS : 0);
    const w00 = (1 - fu) * (1 - fv);
    const w01 = (1 - fu) * fv;
    const w10 = fu * (1 - fv);
    const w11 = fu * fv;
    const g = this.grid;
    const dt = time - this.time;
    const vy0 = w00 * g[p00 + 5]! + w01 * g[p01 + 5]! + w10 * g[p10 + 5]! + w11 * g[p11 + 5]!;
    const eta = w00 * g[p00]! + w01 * g[p01]! + w10 * g[p10]! + w11 * g[p11]! + vy0 * dt;
    const vx0 = w00 * g[p00 + 4]! + w01 * g[p01 + 4]! + w10 * g[p10 + 4]! + w11 * g[p11 + 4]!;
    const vz0 = w00 * g[p00 + 6]! + w01 * g[p01 + 6]! + w10 * g[p10 + 6]! + w11 * g[p11 + 6]!;
    out.height = eta;
    const d = eta - y;
    if (d <= 0) {
      out.pressureHead = d;
      out.velocityX = vx0;
      out.velocityY = vy0;
      out.velocityZ = vz0;
      return out;
    }
    const dRef = o.referenceDepth;
    const vyRef = w00 * g[p00 + 10]! + w01 * g[p01 + 10]! + w10 * g[p10 + 10]! + w11 * g[p11 + 10]!;
    const etaRef = w00 * g[p00 + 8]! + w01 * g[p01 + 8]! + w10 * g[p10 + 8]! + w11 * g[p11 + 8]! + vyRef * dt;
    const vxRef = w00 * g[p00 + 9]! + w01 * g[p01 + 9]! + w10 * g[p10 + 9]! + w11 * g[p11 + 9]!;
    const vzRef = w00 * g[p00 + 11]! + w01 * g[p01 + 11]! + w10 * g[p10 + 11]! + w11 * g[p11 + 11]!;
    if (d <= dRef) {
      const t = d / dRef;
      out.pressureHead = -y + eta + (etaRef - eta) * t;
      out.velocityX = vx0 + (vxRef - vx0) * t;
      out.velocityY = vy0 + (vyRef - vy0) * t;
      out.velocityZ = vz0 + (vzRef - vz0) * t;
      return out;
    }
    const n = (d - dRef) / dRef;
    out.pressureHead = -y + extend(eta, etaRef, n);
    out.velocityX = extend(vx0, vxRef, n);
    out.velocityY = extend(vy0, vyRef, n);
    out.velocityZ = extend(vz0, vzRef, n);
    return out;
  }

  private at(c: number): number {
    const g = this.grid;
    return (
      this.w00 * g[this.p00 + c]! +
      this.w01 * g[this.p01 + c]! +
      this.w10 * g[this.p10 + c]! +
      this.w11 * g[this.p11 + c]!
    );
  }
}
