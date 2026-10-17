// Physics query of the sea surface: the sum of the CPU physics cascades, each periodic on its own patch,
// sampled bilinearly and interpolated between the two 60 Hz time samples. Because the surface is
// displaced horizontally (choppy waves), the height at a world point needs the rest position x0 whose
// particle lands there: x0 + D(x0) = x, solved by Newton iteration on the 2×2 Jacobian I + ∂D/∂x0.

import type { OceanField, OceanSample } from '../world/SimWorld';
import { CASCADE_MASK_ALL, CASCADE_MASK_SEAS, PHYSICS_CASCADES, type CascadeConfig } from './cascades';
import {
  CH_DX,
  CH_DX_X,
  CH_DX_Z,
  CH_DY,
  CH_DY_X,
  CH_DY_Z,
  CH_DZ,
  CH_DZ_Z,
  type CpuCascade,
  CpuOcean,
  FIELD_CHANNELS,
  TEXEL_STRIDE,
} from './CpuOcean';
import type { CascadeSpectrum } from './h0';

export interface SurfaceSample extends OceanSample {
  normalY: number;
  velocityX: number; // orbital velocity of the surface particle, m/s, depth-attenuated
  velocityZ: number;
  jacobian: number; // det(I + ∂D/∂x0); < ~0.3 means a crest is folding (breaking, foam)
  pressureHead: number; // Σ η_c e^{−k_c·depth}: dynamic pressure / (ρg) at that depth, m
  // The seas (waves at least 25 m long, CASCADE_MASK_SEAS) at the surface: their linear local steepness
  // Σ a·k·cos θ (the divergence of the horizontal displacement at unit choppiness, −(∂Dx/∂x + ∂Dz/∂z)/λ;
  // a crest of a single wave reads a·k) and their horizontal orbital velocity (not depth-attenuated).
  // Breaking crests (physics/flooding.ts BreakingWaves) are where the steepness is high.
  steepness: number;
  crestVelocityX: number;
  crestVelocityZ: number;
  lagrangianX: number; // rest position x0 found by the inversion; reused as the next warm start
  lagrangianZ: number;
  iterations: number;
  converged: boolean;
}

// Pressure head and orbital velocity below the surface (SurfaceQuery.queryWithDepth).
export interface DeepSample {
  pressureHead: number;
  velocityX: number;
  velocityY: number;
  velocityZ: number;
}

export const createSurfaceSample = (): SurfaceSample => ({
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

const NEWTON_MAX_ITERATIONS = 8;
const NEWTON_TOLERANCE = 1e-4; // m of horizontal residual
// Below this the Jacobian is too close to a fold to invert; fall back to a damped fixed-point step.
const JACOBIAN_FLOOR = 0.05;

// e^{−k·depth}: how much of a wave's orbital motion and dynamic pressure reaches that depth.
function depthAttenuation(k: number, depth: number): number {
  return depth > 0 ? Math.exp(-k * depth) : 1;
}

export class OceanSurface implements OceanField {
  readonly ocean: CpuOcean;
  defaultMask = CASCADE_MASK_ALL;
  private originX = 0; // float64 world offset of the local frame
  private originZ = 0;
  private readonly offsetX: Float64Array; // origin reduced mod each cascade's L
  private readonly offsetZ: Float64Array;
  private attenuation: Float64Array; // per cascade, for the current query (one of the two below)
  private readonly unattenuated: Float64Array; // all 1: at the surface
  private readonly attenuated: Float64Array; // at attenuationDepth
  private readonly inverseChoppiness: Float64Array; // per cascade, 1/λ (0 when not choppy)
  // What the per-time state was last set up for, so the many queries at one time share it.
  private setupAt = Number.NaN; // time
  private setupUpdates = -1; // ocean.updateCount then (a sample recomputed since invalidates it)
  private setupSpectra = -1; // ocean.spectraVersion then
  private cascadesAt = Number.NaN; // time of inverseChoppiness
  private cascadesSpectra = -1;
  private attenuationDepth = Number.NaN; // depth of attenuated, at cascadesAt
  private deepAttenuation: Float64Array | null = null; // queryWithDepth's second depth
  private readonly scratch = createSurfaceSample();
  // Accumulators filled by evaluate(); fields rather than locals so nothing allocates.
  private sDx = 0;
  private sDy = 0;
  private sDz = 0;
  private sDyX = 0;
  private sDyZ = 0;
  private sDxX = 0;
  private sDxZ = 0;
  private sDzZ = 0;
  private sVx = 0;
  private sVy = 0;
  private sVz = 0;
  private sPressure = 0;
  private sDeepPressure = 0; // at deepAttenuation
  private sDeepVx = 0;
  private sDeepVy = 0;
  private sDeepVz = 0;
  private sSteepness = 0;
  private sCrestVx = 0;
  private sCrestVz = 0;
  // Time interpolation state for the current query.
  private w0 = 1;
  private w1 = 0;
  private slot0 = 0;
  private slot1 = 1;
  private invDt = 60;

  constructor(ocean: CpuOcean) {
    this.ocean = ocean;
    const count = ocean.cascades.length;
    this.offsetX = new Float64Array(count);
    this.offsetZ = new Float64Array(count);
    this.unattenuated = new Float64Array(count).fill(1);
    this.attenuated = new Float64Array(count);
    this.attenuation = this.unattenuated;
    this.inverseChoppiness = new Float64Array(count);
  }

  static create(spectra: readonly CascadeSpectrum[], cascades: readonly CascadeConfig[] = PHYSICS_CASCADES) {
    const ocean = new CpuOcean(cascades);
    ocean.setSpectra(spectra);
    return new OceanSurface(ocean);
  }

  // World position of the local frame's origin (floating origin). Kept in float64 and reduced modulo
  // each patch so the local coordinates stay small; the GPU uses the same reduced offsets.
  setOrigin(x: number, z: number): void {
    this.originX = x;
    this.originZ = z;
    for (let c = 0; c < this.ocean.cascades.length; c++) {
      const size = (this.ocean.cascades[c] as CpuCascade).size;
      this.offsetX[c] = x - size * Math.floor(x / size);
      this.offsetZ[c] = z - size * Math.floor(z / size);
    }
  }

  get origin(): { x: number; z: number } {
    return { x: this.originX, z: this.originZ };
  }

  cascadeOffset(cascade: number): { x: number; z: number } {
    return { x: this.offsetX[cascade] as number, z: this.offsetZ[cascade] as number };
  }

  prepare(time: number): void {
    this.ocean.prepare(time);
  }

  // OceanField for SimWorld: no warm start, full mask.
  sample(x: number, z: number, time: number, out: OceanSample): OceanSample {
    const s = this.query(x, z, time, this.scratch, 0, this.defaultMask, false);
    out.height = s.height;
    out.normalX = s.normalX;
    out.normalZ = s.normalZ;
    out.velocityY = s.velocityY;
    return out;
  }

  // Full surface query at world (x, z). With warmStart, out.lagrangianX/Z must hold the previous rest
  // position for this point (e.g. the same hull vertex last step); Newton then usually needs 1–2 steps.
  // depth (m, positive down) attenuates velocity and pressure per cascade; mask selects cascades.
  query(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth = 0,
    mask = this.defaultMask,
    warmStart = false,
  ): SurfaceSample {
    this.setupTime(time);
    this.setupCascades(time, depth);
    this.deepAttenuation = null;
    return this.solve(x, z, out, mask, warmStart);
  }

  // query() at the surface, plus the pressure head and velocity `depth` below the same surface
  // particle into `deep` (what a second, warm-started query() at that depth reads), from the same
  // evaluations.
  queryWithDepth(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth: number,
    deep: DeepSample,
    mask = this.defaultMask,
    warmStart = false,
  ): SurfaceSample {
    this.setupTime(time);
    this.setupCascades(time, depth);
    this.deepAttenuation = this.attenuation;
    this.attenuation = this.unattenuated;
    this.solve(x, z, out, mask, warmStart);
    this.deepAttenuation = null;
    deep.pressureHead = this.sDeepPressure;
    deep.velocityX = this.sDeepVx;
    deep.velocityY = this.sDeepVy;
    deep.velocityZ = this.sDeepVz;
    return out;
  }

  // The inversion and outputs of a query, once its time and cascades are set up.
  private solve(x: number, z: number, out: SurfaceSample, mask: number, warmStart: boolean): SurfaceSample {
    let x0: number;
    let z0: number;
    if (warmStart && Number.isFinite(out.lagrangianX) && Number.isFinite(out.lagrangianZ)) {
      x0 = out.lagrangianX;
      z0 = out.lagrangianZ;
    } else {
      // One fixed-point step from the query point is a good start for gentle and moderate seas.
      this.evaluate(x, z, mask, false);
      x0 = x - this.sDx;
      z0 = z - this.sDz;
    }

    // Every evaluation is full, so the common warm-started case (already converged) costs one.
    let converged = false;
    let iterations = 0;
    for (; iterations < NEWTON_MAX_ITERATIONS; iterations++) {
      this.evaluate(x0, z0, mask, true);
      const rx = x0 + this.sDx - x;
      const rz = z0 + this.sDz - z;
      if (rx * rx + rz * rz < NEWTON_TOLERANCE * NEWTON_TOLERANCE) {
        converged = true;
        break;
      }
      const j11 = 1 + this.sDxX;
      const j12 = this.sDxZ;
      const j22 = 1 + this.sDzZ;
      const det = j11 * j22 - j12 * j12;
      if (det > JACOBIAN_FLOOR) {
        x0 -= (j22 * rx - j12 * rz) / det;
        z0 -= (j11 * rz - j12 * rx) / det;
      } else {
        // Near a fold the Newton step is unreliable; a half fixed-point step always shrinks the
        // residual where |∂D/∂x0| < 1 and cannot jump across the fold.
        x0 -= 0.5 * rx;
        z0 -= 0.5 * rz;
      }
    }
    if (!converged) this.evaluate(x0, z0, mask, true);

    const j11 = 1 + this.sDxX;
    const j12 = this.sDxZ;
    const j22 = 1 + this.sDzZ;
    const det = j11 * j22 - j12 * j12;
    // World-space height gradient: ∇_x y = J⁻ᵀ ∇_x0 y (J is symmetric here).
    const detSafe = det > JACOBIAN_FLOOR ? det : JACOBIAN_FLOOR;
    const gx = (j22 * this.sDyX - j12 * this.sDyZ) / detSafe;
    const gz = (j11 * this.sDyZ - j12 * this.sDyX) / detSafe;
    const invLen = 1 / Math.sqrt(gx * gx + 1 + gz * gz);

    out.height = this.sDy;
    out.normalX = -gx * invLen;
    out.normalY = invLen;
    out.normalZ = -gz * invLen;
    out.velocityX = this.sVx;
    out.velocityY = this.sVy;
    out.velocityZ = this.sVz;
    out.jacobian = det;
    out.pressureHead = this.sPressure;
    out.steepness = this.sSteepness;
    out.crestVelocityX = this.sCrestVx;
    out.crestVelocityZ = this.sCrestVz;
    out.lagrangianX = x0;
    out.lagrangianZ = z0;
    out.iterations = iterations;
    out.converged = converged;
    return out;
  }

  // Horizontal displacement and height at rest position (x0, z0), no inversion. Cheap; used by
  // tests and anything that already works in Lagrangian coordinates.
  displacementAt(x0: number, z0: number, time: number, out: { x: number; y: number; z: number }) {
    this.setupTime(time);
    this.evaluate(x0, z0, this.defaultMask, true);
    out.x = this.sDx;
    out.y = this.sDy;
    out.z = this.sDz;
    return out;
  }

  // Per-cascade choppiness and depth attenuation for queries at this time and depth.
  private setupCascades(time: number, depth: number): void {
    const ocean = this.ocean;
    const count = ocean.cascades.length;
    if (time !== this.cascadesAt || ocean.spectraVersion !== this.cascadesSpectra) {
      for (let c = 0; c < count; c++) {
        const lambda = ocean.choppinessAt(c, time);
        this.inverseChoppiness[c] = lambda > 0.05 ? 1 / lambda : 0;
      }
      this.cascadesAt = time;
      this.cascadesSpectra = ocean.spectraVersion;
      this.attenuationDepth = Number.NaN;
    }
    if (!(depth > 0)) {
      this.attenuation = this.unattenuated; // depthAttenuation is 1 at and above the surface
      return;
    }
    if (depth !== this.attenuationDepth) {
      for (let c = 0; c < count; c++) {
        this.attenuated[c] = depthAttenuation(ocean.representativeK(c, time), depth);
      }
      this.attenuationDepth = depth;
    }
    this.attenuation = this.attenuated;
  }

  private setupTime(time: number): void {
    const ocean = this.ocean;
    if (
      time === this.setupAt &&
      ocean.updateCount === this.setupUpdates &&
      ocean.spectraVersion === this.setupSpectra
    )
      return;
    ocean.prepare(time);
    this.setupAt = time;
    this.setupUpdates = ocean.updateCount;
    this.setupSpectra = ocean.spectraVersion;
    const k0 = ocean.sampleIndex(time);
    const t0 = ocean.sampleTime(k0);
    let f = (time - t0) / ocean.interval;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    this.w0 = 1 - f;
    this.w1 = f;
    this.slot0 = ocean.slotOf(k0);
    this.slot1 = ocean.slotOf(k0 + 1);
    this.invDt = 1 / ocean.interval;
  }

  // Sums masked cascades at a rest position: bilinear in space, linear in time. `full` adds height
  // gradient, velocity and pressure.
  private evaluate(x0: number, z0: number, mask: number, full: boolean): void {
    let dx = 0;
    let dy = 0;
    let dz = 0;
    let dyX = 0;
    let dyZ = 0;
    let dxX = 0;
    let dxZ = 0;
    let dzZ = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let pressure = 0;
    let steepness = 0;
    let crestVx = 0;
    let crestVz = 0;
    let deepPressure = 0;
    let deepVx = 0;
    let deepVy = 0;
    let deepVz = 0;
    const deepAtt = this.deepAttenuation;
    const s0 = this.slot0 * FIELD_CHANNELS;
    const s1 = this.slot1 * FIELD_CHANNELS;
    const w0 = this.w0;
    const w1 = this.w1;
    const cascades = this.ocean.cascades;
    for (let c = 0; c < cascades.length; c++) {
      if ((mask & (1 << c)) === 0) continue;
      const cascade = cascades[c] as CpuCascade;
      const n = cascade.n;
      const nMask = n - 1;
      const scale = n / cascade.size;
      const u = (x0 + (this.offsetX[c] as number)) * scale;
      const v = (z0 + (this.offsetZ[c] as number)) * scale;
      const iu = Math.floor(u);
      const iv = Math.floor(v);
      const fu = u - iu;
      const fv = v - iv;
      const i0 = iu & nMask;
      const i1 = (iu + 1) & nMask;
      const r0 = (iv & nMask) * n;
      const r1 = ((iv + 1) & nMask) * n;
      const t00 = (r0 + i0) * TEXEL_STRIDE;
      const t10 = (r0 + i1) * TEXEL_STRIDE;
      const t01 = (r1 + i0) * TEXEL_STRIDE;
      const t11 = (r1 + i1) * TEXEL_STRIDE;
      const b00 = (1 - fu) * (1 - fv);
      const b10 = fu * (1 - fv);
      const b01 = (1 - fu) * fv;
      const b11 = fu * fv;
      const p0 = t00 + s0;
      const p1 = t10 + s0;
      const p2 = t01 + s0;
      const p3 = t11 + s0;
      const q0 = t00 + s1;
      const q1 = t10 + s1;
      const q2 = t01 + s1;
      const q3 = t11 + s1;
      const f = cascade.field;
      const x0a = b00 * f[p0 + CH_DX] + b10 * f[p1 + CH_DX] + b01 * f[p2 + CH_DX] + b11 * f[p3 + CH_DX];
      const x1a = b00 * f[q0 + CH_DX] + b10 * f[q1 + CH_DX] + b01 * f[q2 + CH_DX] + b11 * f[q3 + CH_DX];
      const z0a = b00 * f[p0 + CH_DZ] + b10 * f[p1 + CH_DZ] + b01 * f[p2 + CH_DZ] + b11 * f[p3 + CH_DZ];
      const z1a = b00 * f[q0 + CH_DZ] + b10 * f[q1 + CH_DZ] + b01 * f[q2 + CH_DZ] + b11 * f[q3 + CH_DZ];
      dx += w0 * x0a + w1 * x1a;
      dz += w0 * z0a + w1 * z1a;
      const xX0 =
        w0 * (b00 * f[p0 + CH_DX_X] + b10 * f[p1 + CH_DX_X] + b01 * f[p2 + CH_DX_X] + b11 * f[p3 + CH_DX_X]);
      const xX1 =
        w1 * (b00 * f[q0 + CH_DX_X] + b10 * f[q1 + CH_DX_X] + b01 * f[q2 + CH_DX_X] + b11 * f[q3 + CH_DX_X]);
      const zZ0 =
        w0 * (b00 * f[p0 + CH_DZ_Z] + b10 * f[p1 + CH_DZ_Z] + b01 * f[p2 + CH_DZ_Z] + b11 * f[p3 + CH_DZ_Z]);
      const zZ1 =
        w1 * (b00 * f[q0 + CH_DZ_Z] + b10 * f[q1 + CH_DZ_Z] + b01 * f[q2 + CH_DZ_Z] + b11 * f[q3 + CH_DZ_Z]);
      dxX += xX0;
      dxX += xX1;
      dxZ +=
        w0 * (b00 * f[p0 + CH_DX_Z] + b10 * f[p1 + CH_DX_Z] + b01 * f[p2 + CH_DX_Z] + b11 * f[p3 + CH_DX_Z]);
      dxZ +=
        w1 * (b00 * f[q0 + CH_DX_Z] + b10 * f[q1 + CH_DX_Z] + b01 * f[q2 + CH_DX_Z] + b11 * f[q3 + CH_DX_Z]);
      dzZ += zZ0;
      dzZ += zZ1;
      if (full && (CASCADE_MASK_SEAS & (1 << c)) !== 0) {
        steepness -= (xX0 + xX1 + zZ0 + zZ1) * (this.inverseChoppiness[c] as number);
        crestVx += (x1a - x0a) * this.invDt;
        crestVz += (z1a - z0a) * this.invDt;
      }
      if (full) {
        const att = this.attenuation[c] as number;
        const y0 = b00 * f[p0 + CH_DY] + b10 * f[p1 + CH_DY] + b01 * f[p2 + CH_DY] + b11 * f[p3 + CH_DY];
        const y1 = b00 * f[q0 + CH_DY] + b10 * f[q1 + CH_DY] + b01 * f[q2 + CH_DY] + b11 * f[q3 + CH_DY];
        const cy = w0 * y0 + w1 * y1;
        dy += cy;
        dyX +=
          w0 *
          (b00 * f[p0 + CH_DY_X] + b10 * f[p1 + CH_DY_X] + b01 * f[p2 + CH_DY_X] + b11 * f[p3 + CH_DY_X]);
        dyX +=
          w1 *
          (b00 * f[q0 + CH_DY_X] + b10 * f[q1 + CH_DY_X] + b01 * f[q2 + CH_DY_X] + b11 * f[q3 + CH_DY_X]);
        dyZ +=
          w0 *
          (b00 * f[p0 + CH_DY_Z] + b10 * f[p1 + CH_DY_Z] + b01 * f[p2 + CH_DY_Z] + b11 * f[p3 + CH_DY_Z]);
        dyZ +=
          w1 *
          (b00 * f[q0 + CH_DY_Z] + b10 * f[q1 + CH_DY_Z] + b01 * f[q2 + CH_DY_Z] + b11 * f[q3 + CH_DY_Z]);
        pressure += cy * att;
        // Particle velocity: time difference of the bilinearly sampled displacement.
        const rate = att * this.invDt;
        vx += (x1a - x0a) * rate;
        vy += (y1 - y0) * rate;
        vz += (z1a - z0a) * rate;
        if (deepAtt !== null) {
          const deep = deepAtt[c] as number;
          deepPressure += cy * deep;
          const deepRate = deep * this.invDt;
          deepVx += (x1a - x0a) * deepRate;
          deepVy += (y1 - y0) * deepRate;
          deepVz += (z1a - z0a) * deepRate;
        }
      }
    }
    this.sDx = dx;
    this.sDy = dy;
    this.sDz = dz;
    this.sDyX = dyX;
    this.sDyZ = dyZ;
    this.sDxX = dxX;
    this.sDxZ = dxZ;
    this.sDzZ = dzZ;
    this.sVx = vx;
    this.sVy = vy;
    this.sVz = vz;
    this.sPressure = pressure;
    this.sDeepPressure = deepPressure;
    this.sDeepVx = deepVx;
    this.sDeepVy = deepVy;
    this.sDeepVz = deepVz;
    this.sSteepness = steepness;
    this.sCrestVx = crestVx;
    this.sCrestVz = crestVz;
  }
}
