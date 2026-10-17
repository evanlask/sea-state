// MMG 3-DOF manoeuvring hull forces (Yasukawa & Yoshimura 2015, the MMG
// standard method) for the displacement ships, applied as a force module.
// Kerner's velocity-dependent horizontal terms are disabled on those hulls, so
// these provide all hull surge (drift/turn induced), sway and yaw loads; the
// straight-ahead resistance R₀ comes from the calibrated resistance table
// instead (resistanceModule.ts), and Froude-Krylov pressure stays in Kerner.
//
//   X_H = ½ρ L d U² (X'vv v'² + X'vr v'r' + X'rr r'² + X'vvvv v'⁴)
//   Y_H = ½ρ L d U² (Y'v v' + Y'r r' + Y'vvv v'³ + Y'vvr v'²r' + Y'vrr v'r'² + Y'rrr r'³)
//   N_H = ½ρ L² d U² (N'v v' + … same terms)
//
// v' = v_m/U, r' = r·L/U with v_m the sway at midship and r the yaw rate (+ bow
// to starboard). U includes ½·r·L so a ship turning on the spot gets cross-flow
// style quadratic yaw damping rather than a singularity. Running astern uses
// the ship-reversed frame (u, v → −u, −v), blended smoothly through u = 0.
//
// The rigid body integrates in the world frame with per-axis body added mass,
// which already gives (m + m_x)·v·r and (m + m_y)·u·r Coriolis terms in
// surge/sway; MMG's equations want (m + m_y)·v·r and (m + m_x)·u·r, so the
// difference (m_y − m_x)·(v·r, u·r) is added here.
//
// Coefficient sources: KCS from the SIMMAN/KCS MMG data set (as used in
// github.com/Shaadalam9/rl_ship_controller, src/kcs/kcs.py, converted from its
// β-form to Yasukawa's v'-form) [V]. Cruise ship and crab boat: Kijima et al.
// (1990) regressions for the linear derivatives from L, B, d, Cb and trim, with
// the non-linear derivatives scaled from KCS by the ratio of the Kijima linear
// derivatives (engineering estimate) [E].

import { qRotate, qRotateInverse, vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import type { ForceContext, ForceModule } from './modules';

export interface MmgDerivatives {
  Xvv: number;
  Xvr: number;
  Xrr: number;
  Xvvvv: number;
  Yv: number;
  Yr: number;
  Yvvv: number;
  Yvvr: number;
  Yvrr: number;
  Yrrr: number;
  Nv: number;
  Nr: number;
  Nvvv: number;
  Nvvr: number;
  Nvrr: number;
  Nrrr: number;
}

// KCS [V]: β = −v', so odd-in-β coefficients change sign; (X_βr − m_y) and
// (Y_r − m_x) are converted back with m'_x = 0.00627, m'_y = 0.1552.
export const KCS_DERIVATIVES: MmgDerivatives = {
  Xvv: -0.0549,
  Xvr: -(-0.1084 + 0.1552),
  Xrr: -0.012,
  Xvvvv: -0.0417,
  Yv: -0.2252,
  Yr: 0.0398 + 0.00627,
  Yvvv: -1.7179,
  Yvvr: -0.4832,
  Yvrr: -0.8341,
  Yrrr: -0.005,
  Nv: -0.1111,
  Nr: -0.0465,
  Nvvv: -0.1752,
  Nvvr: -0.6168,
  Nvrr: -0.0512,
  Nrrr: -0.0387,
};

const KCS_PARTICULARS = { L: 230, B: 32.2, d: 10.8, cb: 0.651 };

interface KijimaLinear {
  Yv: number;
  Yr: number;
  Nv: number;
  Nr: number;
}

// Kijima et al. (1990) linear derivatives; trim τ' = (d_aft − d_fwd)/d (by the stern +).
function kijimaLinear(L: number, B: number, d: number, cb: number, trim = 0): KijimaLinear {
  const k = (2 * d) / L;
  const tau = trim / d;
  const Yv = -((Math.PI / 2) * k + 1.4 * cb * (B / L)) * (1 + 0.67 * tau);
  const Yr = (Math.PI / 4) * k * (1 + 0.8 * tau);
  const Nv = -k * (1 - (0.27 * tau) / Math.max(0.05, k / -Yv));
  const Nr = -(0.54 * k - k * k) * (1 + 0.3 * tau);
  return { Yv, Yr, Nv, Nr };
}

// Kijima linear derivatives for the target hull, non-linear ones scaled from KCS.
export function kijimaDerivatives(L: number, B: number, d: number, cb: number, trim = 0): MmgDerivatives {
  const t = kijimaLinear(L, B, d, cb, trim);
  const ref = kijimaLinear(KCS_PARTICULARS.L, KCS_PARTICULARS.B, KCS_PARTICULARS.d, KCS_PARTICULARS.cb);
  const K = KCS_DERIVATIVES;
  const sy = t.Yv / ref.Yv;
  const sn = t.Nr / ref.Nr;
  return {
    Xvv: K.Xvv * sy,
    Xvr: K.Xvr * sy,
    Xrr: K.Xrr * sn,
    Xvvvv: K.Xvvvv * sy,
    Yv: t.Yv,
    Yr: t.Yr,
    Yvvv: K.Yvvv * sy,
    Yvvr: K.Yvvr * sy,
    Yvrr: K.Yvrr * sy,
    Yrrr: K.Yrrr * (t.Yr / ref.Yr),
    Nv: t.Nv,
    Nr: t.Nr,
    Nvvv: K.Nvvv * (t.Nv / ref.Nv),
    Nvvr: K.Nvvr * sn,
    Nvrr: K.Nvrr * (t.Nv / ref.Nv),
    Nrrr: K.Nrrr * sn,
  };
}

export interface MmgHullSpec {
  length: number; // Lpp, m
  draft: number; // d, m
  derivatives: MmgDerivatives;
  forceDepth: number; // body y where the lateral hull force acts (≈ −d/2)
  surgeAddedMass: number; // m_x, kg
  swayAddedMass: number; // m_y, kg
}

export interface MmgForces {
  X: number; // N, + ahead
  Y: number; // N, + starboard
  N: number; // N·m, + bow to starboard
}

// Non-dimensional polynomial (ahead frame).
function hullForces(D: MmgDerivatives, v: number, r: number, out: MmgForces): MmgForces {
  const v2 = v * v;
  const r2 = r * r;
  out.X = D.Xvv * v2 + D.Xvr * v * r + D.Xrr * r2 + D.Xvvvv * v2 * v2;
  out.Y = D.Yv * v + D.Yr * r + D.Yvvv * v2 * v + D.Yvvr * v2 * r + D.Yvrr * v * r2 + D.Yrrr * r2 * r;
  out.N = D.Nv * v + D.Nr * r + D.Nvvv * v2 * v + D.Nvvr * v2 * r + D.Nvrr * v * r2 + D.Nrrr * r2 * r;
  return out;
}

const ahead: MmgForces = { X: 0, Y: 0, N: 0 };
const astern: MmgForces = { X: 0, Y: 0, N: 0 };

// Dimensional MMG hull forces for surge u, midship sway v and yaw rate r.
function mmgHullForces(spec: MmgHullSpec, u: number, v: number, r: number, out: MmgForces): MmgForces {
  const L = spec.length;
  const U2 = u * u + v * v + 0.25 * r * r * L * L;
  if (U2 < 1e-10) {
    out.X = out.Y = out.N = 0;
    return out;
  }
  const U = Math.sqrt(U2);
  const vp = v / U;
  const rp = (r * L) / U;
  const q = 0.5 * RHO_SEAWATER * L * spec.draft * U2;
  const s = u / U;
  const w = s >= 0.3 ? 1 : s <= -0.3 ? 0 : 0.5 + (s / 0.3) * (0.75 - 0.25 * (s / 0.3) ** 2);
  if (w > 0) hullForces(spec.derivatives, vp, rp, ahead);
  if (w < 1) {
    // Ship turned end for end: v → −v, r unchanged; forces X, Y → −X, −Y.
    hullForces(spec.derivatives, -vp, rp, astern);
    astern.X = -astern.X;
    astern.Y = -astern.Y;
  }
  const a = w;
  const b = 1 - w;
  out.X = q * (a * (w > 0 ? ahead.X : 0) + b * (w < 1 ? astern.X : 0));
  out.Y = q * (a * (w > 0 ? ahead.Y : 0) + b * (w < 1 ? astern.Y : 0));
  out.N = q * L * (a * (w > 0 ? ahead.N : 0) + b * (w < 1 ? astern.N : 0));
  return out;
}

const vBody = vec3();
const wBody = vec3();
const fBody = vec3();
const fWorld = vec3();
const pBody = vec3();
const pWorld = vec3();
const forces: MmgForces = { X: 0, Y: 0, N: 0 };

export class MmgHull implements ForceModule {
  readonly spec: MmgHullSpec;
  readonly last: MmgForces = { X: 0, Y: 0, N: 0 };

  constructor(spec: MmgHullSpec) {
    this.spec = spec;
  }

  apply(ctx: ForceContext): void {
    const body = ctx.body;
    // MMG describes an upright hull: fade it out past ~50° of heel (and with immersion),
    // so a capsized or airborne hull gets no manoeuvring forces.
    const q = body.orientation;
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const upright = upY >= 0.7 ? 1 : upY <= 0.3 ? 0 : (upY - 0.3) / 0.4;
    const imm = (ctx.hull ? ctx.hull.immersion : body.immersion) * upright;
    if (imm <= 0) return;
    qRotateInverse(vBody, q, body.velocity);
    qRotateInverse(wBody, q, body.angularVelocity);
    const r = -wBody.y;
    // Sway at midship (the body origin), not at the CG.
    const v = vBody.x - wBody.y * body.cg.z;
    const u = -vBody.z;
    mmgHullForces(this.spec, u, v, r, forces);
    const k = ctx.tuning?.timeCompression ?? 1;
    const s = this.spec;
    // Added-mass Coriolis correction (see header); not time-compressed, it is inertia.
    const dm = s.swayAddedMass - s.surgeAddedMass;
    // Drift/turn-induced surge drag is not time-compressed: Arcade ships keep their way on in a turn.
    const X = forces.X * imm;
    const Y = forces.Y * imm;
    const N = forces.N * imm * k;
    this.last.X = X;
    this.last.Y = Y * k;
    this.last.N = N;
    // The inertia correction acts on the body as a whole: at the CG.
    fBody.x = dm * u * r * imm;
    fBody.y = 0;
    fBody.z = -dm * v * r * imm;
    qRotate(fWorld, q, fBody);
    body.force.x += fWorld.x;
    body.force.y += fWorld.y;
    body.force.z += fWorld.z;
    // MMG forces act at midship (the body origin), N about it; sway at the lateral centre's depth.
    fBody.x = Y;
    fBody.y = 0;
    fBody.z = -X;
    pBody.x = 0;
    // Arcade turns are k times tighter in time; raising the lateral centre toward the CG by
    // the same factor keeps the heel in a turn about as large as the real ship's.
    pBody.y = body.cg.y + (s.forceDepth - body.cg.y) / (k * (ctx.tuning?.turnBoost ?? 1));
    pBody.z = 0;
    qRotate(fWorld, q, fBody);
    body.bodyToWorldPoint(pWorld, pBody);
    body.addForceAtPointXYZ(fWorld.x, fWorld.y, fWorld.z, pWorld.x, pWorld.y, pWorld.z);
    if (k !== 1) {
      // Extra (k − 1) of the sway force at midship but the CG's height: no extra heel.
      fBody.x = Y * (k - 1);
      fBody.z = 0;
      qRotate(fWorld, q, fBody);
      body.addForceAtPointXYZ(fWorld.x, 0, fWorld.z, pWorld.x, body.position.y, pWorld.z);
    }
    // Yaw moment (+N turns the bow to starboard = −y rotation): the real share about the
    // body vertical, the time-compressed extra about the world vertical (no heel/trim coupling).
    fBody.x = 0;
    fBody.y = -N / k;
    fBody.z = 0;
    qRotate(fWorld, q, fBody);
    body.addTorque(fWorld);
    body.torque.y -= (N - N / k) * upY;
  }

  writeTelemetry(): void {}
}
