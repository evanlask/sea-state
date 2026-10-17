// Flat-water hydrostatics of a closed hull mesh: submerged volume, centre of
// buoyancy, waterplane properties, equilibrium draft and trim, and the GZ
// (righting lever) curve to 180° with the angle of vanishing stability.
//
// Integrals use the divergence theorem over the clipped wetted surface only:
// the waterplane cap lies at y = 0 where the integrands vanish, so the open
// clipped surface gives exact volumes and moments of the closed submerged body.
//
// Pose convention: the mesh is rotated about its centre of gravity by heel φ
// (positive = starboard down, about the body's longitudinal axis) and then
// trim θ (positive = bow up, about the world transverse axis), and the CG is
// placed at (0, height, 0). The waterline is world y = 0. The GZ curve is at
// FREE TRIM by default: for each heel the trim is solved so the centre of
// buoyancy lies on the CG's vertical in the longitudinal plane.

import { type Vec3, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import { CLIP_OUT_SIZE, CLIP_STRIDE, clipTriangle } from './clip';
import type { TriMesh } from './mesh';

export interface HydrostaticResult {
  volume: number; // m³ submerged
  centre: Vec3; // centre of buoyancy, world (waterline y = 0)
  waterplaneArea: number; // m²
  waterplaneX: number; // waterplane centroid, world
  waterplaneZ: number;
  // Second moments of the waterplane about its centroid: transverse (about the
  // fore-aft axis, uses x²) and longitudinal (uses z²), m⁴.
  waterplaneIxx: number;
  waterplaneIzz: number;
  wettedArea: number; // m²
}

const hydrostaticResult = (): HydrostaticResult => ({
  volume: 0,
  centre: vec3(),
  waterplaneArea: 0,
  waterplaneX: 0,
  waterplaneZ: 0,
  waterplaneIxx: 0,
  waterplaneIzz: 0,
  wettedArea: 0,
});

export interface Pose {
  heel: number; // rad, starboard down positive
  trim: number; // rad, bow up positive
  height: number; // world y of the CG, m
}

export interface Equilibrium {
  height: number;
  trim: number;
  hydro: HydrostaticResult;
  gz: number; // righting lever, m (positive restores toward upright)
  converged: boolean;
}

export interface GzCurve {
  angles: Float64Array; // rad
  gz: Float64Array; // m
  trim: Float64Array; // rad (zero for fixed trim)
  avs: number; // angle of vanishing stability, rad (π when the curve never crosses zero)
  maxGz: number;
  angleOfMaxGz: number;
  gm: number; // from the initial slope
}

export interface GzOptions {
  maxAngle?: number; // rad, default π
  step?: number; // rad, default 5°
  freeTrim?: boolean; // default true
}

export class Hydrostatics {
  readonly mesh: TriMesh;
  private readonly world: Float64Array;
  private readonly src = new Float64Array(CLIP_STRIDE * 3);
  private readonly clipped = new Float64Array(CLIP_OUT_SIZE);
  private readonly radius: number;

  constructor(mesh: TriMesh) {
    this.mesh = mesh;
    this.world = new Float64Array(mesh.positions.length);
    let r2 = 0;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) r2 = Math.max(r2, p[i]! ** 2 + p[i + 1]! ** 2 + p[i + 2]! ** 2);
    this.radius = Math.sqrt(r2);
  }

  // Hydrostatics with the waterline at body height `waterline`, upright.
  upright(waterline: number, out: HydrostaticResult = hydrostaticResult()): HydrostaticResult {
    const p = this.mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      this.world[i] = p[i]!;
      this.world[i + 1] = p[i + 1]! - waterline;
      this.world[i + 2] = p[i + 2]!;
    }
    return this.integrate(out);
  }

  evaluate(cg: Vec3, pose: Pose, out: HydrostaticResult = hydrostaticResult()): HydrostaticResult {
    this.transform(cg, pose);
    return this.integrate(out);
  }

  // CG height that displaces `volume` at the given heel and trim (Newton on
  // dV/dh = −A_wp, bisection fallback).
  solveHeight(cg: Vec3, volume: number, heel: number, trim: number, guess = 0): number {
    const scratch = this.scratchResult;
    const pose = this.scratchPose;
    pose.heel = heel;
    pose.trim = trim;
    // Bracket from the mesh's extent around the CG: fully submerged / clear.
    const reach = this.radius + Math.hypot(cg.x, cg.y, cg.z);
    let lo = -reach; // deep: maximum volume
    let hi = reach; // high: zero volume
    let h = Math.min(hi, Math.max(lo, guess));
    const tol = Math.max(1e-12, volume * 1e-10);
    for (let i = 0; i < 80; i++) {
      pose.height = h;
      this.evaluate(cg, pose, scratch);
      const err = scratch.volume - volume;
      if (Math.abs(err) < tol) return h;
      if (err > 0) lo = h;
      else hi = h;
      let next = scratch.waterplaneArea > 1e-9 ? h + err / scratch.waterplaneArea : NaN;
      if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
      if (hi - lo < 1e-10) return next;
      h = next;
    }
    return h;
  }

  equilibrium(cg: Vec3, volume: number, heel: number, freeTrim = true, trimGuess = 0): Equilibrium {
    const hydro = hydrostaticResult();
    let height = this.solveHeight(cg, volume, heel, trimGuess, 0);
    let trim = trimGuess;
    let converged = true;
    if (freeTrim) {
      const limit = 1.2;
      // f(θ) = longitudinal offset of B from the CG vertical; root = free trim.
      const f = (theta: number): number => {
        height = this.solveHeight(cg, volume, heel, theta, height);
        this.evaluate(cg, { heel, trim: theta, height }, hydro);
        return hydro.centre.z;
      };
      const tol = 1e-7 * (this.radius + 1);
      let t0 = trimGuess;
      let f0 = f(t0);
      if (Math.abs(f0) > tol) {
        let t1 = t0 + (f0 > 0 ? -0.01 : 0.01);
        let f1 = f(t1);
        converged = false;
        // Expand to a bracket, then Illinois regula falsi.
        for (let i = 0; i < 40 && f0 * f1 > 0; i++) {
          const slope = (f1 - f0) / (t1 - t0);
          let step = slope !== 0 ? -f1 / slope : 0.05;
          step = Math.max(-0.15, Math.min(0.15, step));
          if (!Number.isFinite(step) || Math.abs(step) < 1e-9) step = 0.05 * Math.sign(-f1 || 1);
          t0 = t1;
          f0 = f1;
          t1 = Math.max(-limit, Math.min(limit, t1 + step));
          f1 = f(t1);
          if (Math.abs(f1) < tol) {
            converged = true;
            t0 = t1;
            f0 = f1;
            break;
          }
        }
        if (!converged && f0 * f1 < 0) {
          let side = 0;
          for (let i = 0; i < 60; i++) {
            const t = (t0 * f1 - t1 * f0) / (f1 - f0);
            const ft = f(t);
            if (Math.abs(ft) < tol || Math.abs(t1 - t0) < 1e-10) {
              t0 = t;
              f0 = ft;
              converged = true;
              break;
            }
            if (ft * f1 > 0) {
              t1 = t;
              f1 = ft;
              if (side === -1) f0 /= 2;
              side = -1;
            } else {
              t0 = t;
              f0 = ft;
              if (side === 1) f1 /= 2;
              side = 1;
            }
          }
        }
        trim = Math.abs(f0) <= Math.abs(f1) ? t0 : t1;
      } else {
        trim = t0;
      }
      height = this.solveHeight(cg, volume, heel, trim, height);
    }
    this.evaluate(cg, { heel, trim, height }, hydro);
    return { height, trim, hydro, gz: hydro.centre.x, converged };
  }

  gzCurve(cg: Vec3, volume: number, options: GzOptions = {}): GzCurve {
    const maxAngle = options.maxAngle ?? Math.PI;
    const step = options.step ?? (5 * Math.PI) / 180;
    const freeTrim = options.freeTrim ?? true;
    const n = Math.round(maxAngle / step) + 1;
    const angles = new Float64Array(n);
    const gz = new Float64Array(n);
    const trim = new Float64Array(n);
    let trimGuess = 0;
    for (let i = 0; i < n; i++) {
      const heel = Math.min(maxAngle, i * step);
      const eq = this.equilibrium(cg, volume, heel, freeTrim, trimGuess);
      angles[i] = heel;
      gz[i] = eq.gz;
      trim[i] = eq.trim;
      trimGuess = eq.trim;
    }
    let maxGz = -Infinity;
    let angleOfMaxGz = 0;
    for (let i = 0; i < n; i++) {
      if (gz[i]! > maxGz) {
        maxGz = gz[i]!;
        angleOfMaxGz = angles[i]!;
      }
    }
    const small = Math.PI / 180;
    const gm = this.equilibrium(cg, volume, small, freeTrim, 0).gz / Math.sin(small);
    return { angles, gz, trim, avs: angleOfVanishingStability(angles, gz), maxGz, angleOfMaxGz, gm };
  }

  private readonly scratchResult = hydrostaticResult();
  private readonly scratchPose: Pose = { heel: 0, trim: 0, height: 0 };

  private transform(cg: Vec3, pose: Pose): void {
    const p = this.mesh.positions;
    const w = this.world;
    // R = Rx(trim) · Rz(−heel)
    const ch = Math.cos(-pose.heel);
    const sh = Math.sin(-pose.heel);
    const ct = Math.cos(pose.trim);
    const st = Math.sin(pose.trim);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i]! - cg.x;
      const y = p[i + 1]! - cg.y;
      const z = p[i + 2]! - cg.z;
      const x1 = x * ch - y * sh;
      const y1 = x * sh + y * ch;
      w[i] = x1;
      w[i + 1] = y1 * ct - z * st + pose.height;
      w[i + 2] = y1 * st + z * ct;
    }
  }

  private integrate(out: HydrostaticResult): HydrostaticResult {
    const w = this.world;
    const idx = this.mesh.indices;
    const src = this.src;
    const sub = this.clipped;
    let volume = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    let awp = 0;
    let fx = 0;
    let fz = 0;
    let ixx = 0;
    let izz = 0;
    let wetted = 0;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3;
      const b = idx[t + 1]! * 3;
      const c = idx[t + 2]! * 3;
      const ya = w[a + 1]!;
      const yb = w[b + 1]!;
      const yc = w[c + 1]!;
      if (ya >= 0 && yb >= 0 && yc >= 0) continue;
      let count: number;
      let base: Float64Array;
      if (ya <= 0 && yb <= 0 && yc <= 0) {
        // Fully submerged: integrate directly.
        src[0] = w[a]!;
        src[1] = ya;
        src[2] = w[a + 2]!;
        src[7] = w[b]!;
        src[8] = yb;
        src[9] = w[b + 2]!;
        src[14] = w[c]!;
        src[15] = yc;
        src[16] = w[c + 2]!;
        count = 1;
        base = src;
      } else {
        writeClipVertex(src, 0, w, a);
        writeClipVertex(src, CLIP_STRIDE, w, b);
        writeClipVertex(src, 2 * CLIP_STRIDE, w, c);
        count = clipTriangle(src, sub) & 3;
        base = sub;
      }
      for (let s = 0; s < count; s++) {
        const o = s * CLIP_STRIDE * 3;
        const x0 = base[o]!;
        const y0 = base[o + 1]!;
        const z0 = base[o + 2]!;
        const x1 = base[o + 7]!;
        const y1 = base[o + 8]!;
        const z1 = base[o + 9]!;
        const x2 = base[o + 14]!;
        const y2 = base[o + 15]!;
        const z2 = base[o + 16]!;
        const ux = x1 - x0;
        const uy = y1 - y0;
        const uz = z1 - z0;
        const vx = x2 - x0;
        const vy = y2 - y0;
        const vz = z2 - z0;
        // Area vector n·A.
        const ax = 0.5 * (uy * vz - uz * vy);
        const ay = 0.5 * (uz * vx - ux * vz);
        const az = 0.5 * (ux * vy - uy * vx);
        wetted += Math.hypot(ax, ay, az);
        const sx = x0 + x1 + x2;
        const sy = y0 + y1 + y2;
        const sz = z0 + z1 + z2;
        // Triangle means of x, x², ... (exact for linear fields).
        const meanY = sy / 3;
        const meanX = sx / 3;
        const meanZ = sz / 3;
        const meanX2 = (x0 * x0 + x1 * x1 + x2 * x2 + sx * sx) / 12;
        const meanY2 = (y0 * y0 + y1 * y1 + y2 * y2 + sy * sy) / 12;
        const meanZ2 = (z0 * z0 + z1 * z1 + z2 * z2 + sz * sz) / 12;
        volume += ay * meanY;
        mx += 0.5 * ax * meanX2;
        my += 0.5 * ay * meanY2;
        mz += 0.5 * az * meanZ2;
        // Waterplane (cap) integrals via ∮ f·n_y dA = 0 for f independent of y.
        awp -= ay;
        fx -= ay * meanX;
        fz -= ay * meanZ;
        ixx -= ay * meanX2;
        izz -= ay * meanZ2;
      }
    }
    out.volume = volume;
    if (volume > 1e-15) {
      out.centre.x = mx / volume;
      out.centre.y = my / volume;
      out.centre.z = mz / volume;
    } else {
      out.centre.x = 0;
      out.centre.y = 0;
      out.centre.z = 0;
    }
    out.waterplaneArea = awp;
    if (awp > 1e-12) {
      const cx = fx / awp;
      const cz = fz / awp;
      out.waterplaneX = cx;
      out.waterplaneZ = cz;
      out.waterplaneIxx = ixx - awp * cx * cx;
      out.waterplaneIzz = izz - awp * cz * cz;
    } else {
      out.waterplaneX = 0;
      out.waterplaneZ = 0;
      out.waterplaneIxx = 0;
      out.waterplaneIzz = 0;
    }
    out.wettedArea = wetted;
    return out;
  }
}

function writeClipVertex(dst: Float64Array, d: number, w: Float64Array, i: number): void {
  dst[d] = w[i]!;
  dst[d + 1] = w[i + 1]!;
  dst[d + 2] = w[i + 2]!;
  dst[d + 3] = -w[i + 1]!; // head = depth below the flat waterline
  dst[d + 4] = 0;
  dst[d + 5] = 0;
  dst[d + 6] = 0;
}

// First downward zero crossing of GZ after its positive range (linear
// interpolation). Returns the last angle when GZ never vanishes.
export function angleOfVanishingStability(angles: Float64Array, gz: Float64Array): number {
  let seenPositive = false;
  for (let i = 1; i < angles.length; i++) {
    const g0 = gz[i - 1]!;
    const g1 = gz[i]!;
    if (g1 > 0) seenPositive = true;
    if (seenPositive && g0 > 0 && g1 <= 0) {
      return angles[i - 1]! + ((angles[i]! - angles[i - 1]!) * g0) / (g0 - g1);
    }
  }
  return angles[angles.length - 1] ?? 0;
}

// Natural roll period of a body with roll radius of gyration k (including
// added inertia) and metacentric height GM.
export const rollPeriod = (k: number, gm: number): number => (2 * Math.PI * k) / Math.sqrt(GRAVITY * gm);
