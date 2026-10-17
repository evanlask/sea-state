// Kerner-style per-triangle water interaction (J. Kerner, "Water interaction
// model for boats in video games", parts 1 & 2, 2015), after Habrador's Unity
// boat-physics tutorial, with two deviations:
//  - the pressure-drag reference speed is a fixed per-boat speed (the current
//    speed would make v/v_ref ≡ 1 and drag speed-independent);
//  - Γmax is a per-boat constant (the current Γ would saturate every slam).
//
// Per step: water is sampled at every hull vertex; each triangle is clipped
// against the local waterline (zero of the pressure head); every submerged
// piece gets
//  - Froude-Krylov / hydrostatic pressure −ρg∫h·n dA at its exact centre of
//    pressure (linear head over the piece), in all directions;
//  - pressure drag (leading faces) or suction (trailing faces):
//      F = q_ref·(C1·v/v_ref + C2·(v/v_ref)²)·A·|cos θ|^f,  q_ref = ½ρ·v_ref²,
//    with v the triangle-centre velocity relative to the (orbital) water;
//  - ITTC-1957 skin friction, Cf = 0.075/(log10 Re − 2)², on the tangential flow;
//  - slamming from the rate of change of swept volume Γ = d(A·v_n)/dt / A_tri:
//      F = clamp(Γ/Γmax, 0, 1)^p · cos θ · m·v·(2A/S)/τ_stop, against the motion;
//  - optionally (planing V-hulls) lateral cross-flow drag on the leading side:
//      F = −C_D·½ρ·A·|n_l|·|v_l|·v_l along the body's starboard axis.
//    A V-bottom's panels meet a sideways flow at a grazing angle, so the
//    per-panel normal force turns a slide into lift (the hull rides up and gets
//    cheaper) and gives little yaw damping; the real flow separates at the
//    chine like round a bluff body. The term is zero running straight. On the
//    plane its roll moment is left out (it acts at the CG height): these high-CG
//    craft already get too much of their side force below the CG from the panel
//    model, and their bank in a turn is set by physics/planingCarve.ts. Off the
//    plane (`crossFlowRollSpeed`) it acts where the immersed hull meets the flow,
//    below the CG: a hull shoved sideways by a sea, lying stopped or slow, trips
//    over its lee chine as a real one does (the carve's planing support is gone).
// Emerged pieces optionally get still-air drag (windage.ts covers wind).
//
// `horizontalVelocityTerms: false` (ships driven by an MMG manoeuvring model)
// drives the velocity-dependent terms (drag, suction, friction, slam) by the
// vertical relative velocity only and zeroes their world-horizontal part;
// Froude-Krylov pressure stays in all directions.

import { type Vec3, vec3 } from '../core/math';
import { GRAVITY, NU_SEAWATER, RHO_AIR, RHO_SEAWATER } from '../core/units';
import { CLIP_EMERGED_OFFSET, CLIP_OUT_SIZE, CLIP_STRIDE, clipTriangle } from './clip';
import type { TriMesh } from './mesh';
import type { RigidBody } from './RigidBody';
import type { WaterSample, WaterSampler } from './water';
import { waterSample } from './water';

export interface KernerParams {
  referenceSpeed: number; // v_ref, m/s (fixed per boat, e.g. design speed)
  pressureDragLinear: number; // C_PD1, dimensionless (× q_ref)
  pressureDragQuadratic: number; // C_PD2
  pressureFalloff: number; // f_P
  suctionDragLinear: number; // C_SD1
  suctionDragQuadratic: number; // C_SD2
  suctionFalloff: number; // f_S
  slamGammaMax: number; // Γmax, m/s²
  slamExponent: number; // p
  slamStopTime: number; // τ_stop, s: F_stop stops the triangle's share of momentum in τ
  waterlineLength: number; // Reynolds length, m
  frictionFormFactor?: number; // (1 + k), default 1
  crossFlowDrag?: number; // C_D of the lateral cross-flow round a sliding V (see header), default 0
  // m/s of surge: the cross-flow's roll moment acts at its own height below the first, at the CG height
  // above the second (see the header). Absent: always at the CG height.
  crossFlowRollSpeed?: [number, number];
  airDragCoefficient: number; // emerged-triangle still-air drag; 0 disables
  horizontalVelocityTerms: boolean;
}

export interface KernerResult {
  force: Vec3; // total, world, N
  torque: Vec3; // total about the CG, world, N·m
  hydrostatic: Vec3; // Froude-Krylov part
  pressureDrag: Vec3; // pressure drag + suction
  friction: Vec3;
  slam: Vec3;
  air: Vec3;
  wettedArea: number; // m²
  wettedCentroid: Vec3; // area centroid of the wetted surface, world
  submergedVolume: number; // m³ (exact in calm water)
  immersion: number; // submergedVolume / design volume, clamped 0..1
  reynolds: number;
  frictionCoefficient: number;
  slamStrength: number; // |slam force| / (m g)
  slamSpeed: number; // force-weighted normal impact speed of the slamming faces, m/s
  slamPoint: Vec3; // force-weighted slam centre, world
  // Yaw (world y) torque of the drag + friction terms alone, so Arcade can
  // scale hull damping without touching roll and pitch.
  dragYawTorque: number;
}

export const kernerResult = (): KernerResult => ({
  force: vec3(),
  torque: vec3(),
  hydrostatic: vec3(),
  pressureDrag: vec3(),
  friction: vec3(),
  slam: vec3(),
  air: vec3(),
  wettedArea: 0,
  wettedCentroid: vec3(),
  submergedVolume: 0,
  immersion: 0,
  reynolds: 0,
  frictionCoefficient: 0,
  slamStrength: 0,
  slamSpeed: 0,
  slamPoint: vec3(),
  dragYawTorque: 0,
});

const zero = (v: Vec3): void => {
  v.x = v.y = v.z = 0;
};

// Math.hypot is several times slower than sqrt in V8; this is the hot loop.
const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

// |cos θ|^f with the common exponents special-cased (pow is slow).
const falloff = (c: number, f: number): number => (f === 1 ? c : f === 0.5 ? Math.sqrt(c) : c ** f);

export function ittc57(reynolds: number): number {
  const re = Math.max(reynolds, 1e5); // the line is meaningless at very low Re
  const d = Math.log10(re) - 2;
  return 0.075 / (d * d);
}

export class KernerHull {
  readonly mesh: TriMesh;
  readonly params: KernerParams;
  readonly designVolume: number;
  readonly totalArea: number;
  private readonly world: Float64Array;
  private readonly head: Float64Array;
  private readonly waterVel: Float64Array;
  private readonly triArea: Float64Array;
  private readonly prevSwept: Float64Array;
  private readonly src = new Float64Array(CLIP_STRIDE * 3);
  private readonly sub = new Float64Array(CLIP_OUT_SIZE);
  private readonly sample: WaterSample = waterSample();
  private readonly rel = vec3();
  private primed = false;
  // Multiplies slam forces (Arcade softens them); 1 = physical.
  slamScale = 1;

  constructor(mesh: TriMesh, params: KernerParams, designVolume: number) {
    this.mesh = mesh;
    this.params = params;
    this.designVolume = designVolume;
    const nv = mesh.positions.length / 3;
    const nt = mesh.indices.length / 3;
    this.world = new Float64Array(nv * 3);
    this.head = new Float64Array(nv);
    this.waterVel = new Float64Array(nv * 3);
    this.triArea = new Float64Array(nt);
    this.prevSwept = new Float64Array(nt);
    let total = 0;
    const p = mesh.positions;
    for (let t = 0; t < nt; t++) {
      const a = mesh.indices[t * 3]! * 3;
      const b = mesh.indices[t * 3 + 1]! * 3;
      const c = mesh.indices[t * 3 + 2]! * 3;
      const ux = p[b]! - p[a]!;
      const uy = p[b + 1]! - p[a + 1]!;
      const uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!;
      const vy = p[c + 1]! - p[a + 1]!;
      const vz = p[c + 2]! - p[a + 2]!;
      const area = 0.5 * len3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      this.triArea[t] = area;
      total += area;
    }
    this.totalArea = total;
  }

  // Forget the swept-volume history (after a teleport/recover) so the next
  // step does not register a slam.
  reset(): void {
    this.primed = false;
  }

  // Computes all hull loads, adds them to the body's accumulators and returns
  // the breakdown. dt is the (sub)step used for the slam rate.
  apply(body: RigidBody, water: WaterSampler, time: number, dt: number, out: KernerResult): KernerResult {
    const P = this.params;
    const mesh = this.mesh;
    const pos = mesh.positions;
    const idx = mesh.indices;
    const world = this.world;
    const head = this.head;
    const wv = this.waterVel;
    const sample = this.sample;
    const q = body.orientation;
    const cg = body.cg;
    const px = body.position.x;
    const py = body.position.y;
    const pz = body.position.z;
    const v = body.velocity;
    const w = body.angularVelocity;

    // Body → world for every vertex (quaternion rotation inlined), then water.
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    const fast = water.sampleHead !== undefined;
    for (let i = 0; i < pos.length; i += 3) {
      const bx = pos[i]! - cg.x;
      const by = pos[i + 1]! - cg.y;
      const bz = pos[i + 2]! - cg.z;
      const tx = 2 * (qy * bz - qz * by);
      const ty = 2 * (qz * bx - qx * bz);
      const tz = 2 * (qx * by - qy * bx);
      const x = px + bx + qw * tx + (qy * tz - qz * ty);
      const y = py + by + qw * ty + (qz * tx - qx * tz);
      const z = pz + bz + qw * tz + (qx * ty - qy * tx);
      world[i] = x;
      world[i + 1] = y;
      world[i + 2] = z;
      if (fast) water.sampleHead!(x, y, z, time, sample);
      else water.sample(x, y, z, time, sample);
      const k = i / 3;
      head[k] = sample.pressureHead;
      wv[i] = sample.velocityX;
      wv[i + 1] = sample.velocityY;
      wv[i + 2] = sample.velocityZ;
    }

    const rho = RHO_SEAWATER;
    const rhoG = rho * GRAVITY;
    const vref = P.referenceSpeed;
    const qref = 0.5 * rho * vref * vref;
    const speed = len3(v.x, v.y, v.z);
    const reynolds = (speed * P.waterlineLength) / NU_SEAWATER;
    const cf = ittc57(reynolds) * (P.frictionFormFactor ?? 1);
    const horizontal = P.horizontalVelocityTerms;
    const airC = P.airDragCoefficient;
    const stopScale = (body.mass * 2) / (this.totalArea * P.slamStopTime);
    const primed = this.primed;
    // Cross-flow: ½ρ·C_D, and the body's starboard axis in the world.
    const cfd = horizontal ? 0.5 * rho * (P.crossFlowDrag ?? 0) : 0;
    const lx = 1 - 2 * (qy * qy + qz * qz);
    const ly = 2 * (qx * qy + qw * qz);
    const lz = 2 * (qx * qz - qw * qy);
    // Share of the cross-flow's own height kept (1 off the plane, 0 planing); surge along the bow (−z body).
    let cfRoll = 0;
    const cfSpeed = P.crossFlowRollSpeed;
    if (cfd > 0 && cfSpeed) {
      const fx = -2 * (qx * qz + qw * qy);
      const fy = -2 * (qy * qz - qw * qx);
      const fz = -(1 - 2 * (qx * qx + qy * qy));
      const surge = Math.abs(v.x * fx + v.y * fy + v.z * fz);
      const t = Math.min(1, Math.max(0, (surge - cfSpeed[0]) / (cfSpeed[1] - cfSpeed[0])));
      cfRoll = 1 - t * t * (3 - 2 * t);
    }

    let tqx = 0;
    let tqy = 0;
    let tqz = 0;
    let hsx = 0;
    let hsy = 0;
    let hsz = 0;
    let pdx = 0;
    let pdy = 0;
    let pdz = 0;
    let frx = 0;
    let fry = 0;
    let frz = 0;
    let slx = 0;
    let sly = 0;
    let slz = 0;
    let arx = 0;
    let ary = 0;
    let arz = 0;
    let slamMag = 0;
    let slamSpd = 0;
    let dragTy = 0;
    let slamPx = 0;
    let slamPy = 0;
    let slamPz = 0;
    let wetted = 0;
    let wcx = 0;
    let wcy = 0;
    let wcz = 0;
    let volume = 0;

    const src = this.src;
    const sub = this.sub;
    const rel = this.rel;

    const nt = idx.length / 3;
    for (let t = 0; t < nt; t++) {
      const ia = idx[t * 3]!;
      const ib = idx[t * 3 + 1]!;
      const ic = idx[t * 3 + 2]!;
      const ha = head[ia]!;
      const hb = head[ib]!;
      const hc = head[ic]!;
      const a3 = ia * 3;
      const b3 = ib * 3;
      const c3 = ic * 3;
      // Outward unit normal of the full triangle (pieces share it).
      const ux = world[b3]! - world[a3]!;
      const uy = world[b3 + 1]! - world[a3 + 1]!;
      const uz = world[b3 + 2]! - world[a3 + 2]!;
      const vx = world[c3]! - world[a3]!;
      const vy = world[c3 + 1]! - world[a3 + 1]!;
      const vz = world[c3 + 2]! - world[a3 + 2]!;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const n2 = len3(nx, ny, nz);
      if (n2 < 1e-14) continue;
      nx /= n2;
      ny /= n2;
      nz /= n2;

      const allDry = ha < 0 && hb < 0 && hc < 0;
      if (allDry && airC <= 0) {
        this.prevSwept[t] = 0;
        continue;
      }
      // Fill the clip source (x, y, z, head, water velocity) for the triangle.
      writeVertex(src, 0, world, wv, a3, ha);
      writeVertex(src, CLIP_STRIDE, world, wv, b3, hb);
      writeVertex(src, 2 * CLIP_STRIDE, world, wv, c3, hc);
      let wetCount: number;
      let dryCount: number;
      let wetBuf: Float64Array;
      let dryBuf: Float64Array;
      let dryOffset: number;
      if (allDry) {
        wetCount = 0;
        dryCount = 1;
        wetBuf = src;
        dryBuf = src;
        dryOffset = 0;
      } else if (ha >= 0 && hb >= 0 && hc >= 0) {
        wetCount = 1;
        dryCount = 0;
        wetBuf = src;
        dryBuf = src;
        dryOffset = 0;
      } else {
        const counts = clipTriangle(src, sub);
        wetCount = counts & 3;
        dryCount = counts >> 2;
        wetBuf = sub;
        dryBuf = sub;
        dryOffset = CLIP_EMERGED_OFFSET;
      }

      let swept = 0;
      let wetArea = 0;
      let scx = 0;
      let scy = 0;
      let scz = 0;
      let svx = 0;
      let svy = 0;
      let svz = 0;
      for (let s = 0; s < wetCount; s++) {
        const o = s * CLIP_STRIDE * 3;
        const x0 = wetBuf[o]!;
        const y0 = wetBuf[o + 1]!;
        const z0 = wetBuf[o + 2]!;
        const h0 = wetBuf[o + 3]!;
        const x1 = wetBuf[o + 7]!;
        const y1 = wetBuf[o + 8]!;
        const z1 = wetBuf[o + 9]!;
        const h1 = wetBuf[o + 10]!;
        const x2 = wetBuf[o + 14]!;
        const y2 = wetBuf[o + 15]!;
        const z2 = wetBuf[o + 16]!;
        const h2 = wetBuf[o + 17]!;
        const ex = x1 - x0;
        const ey = y1 - y0;
        const ez = z1 - z0;
        const gx = x2 - x0;
        const gy = y2 - y0;
        const gz = z2 - z0;
        const area = 0.5 * len3(ey * gz - ez * gy, ez * gx - ex * gz, ex * gy - ey * gx);
        if (area < 1e-12) continue;
        const sx = x0 + x1 + x2;
        const sy = y0 + y1 + y2;
        const sz = z0 + z1 + z2;
        const cx = sx / 3;
        const cy = sy / 3;
        const cz = sz / 3;

        // Froude-Krylov: linear head integrated exactly over the piece.
        const H = h0 + h1 + h2;
        if (H > 0) {
          const pf = (-rhoG * area * H) / 3;
          const hfx = pf * nx;
          const hfy = pf * ny;
          const hfz = pf * nz;
          const inv4H = 1 / (4 * H);
          const cpx = (h0 * x0 + h1 * x1 + h2 * x2 + H * sx) * inv4H - px;
          const cpy = (h0 * y0 + h1 * y1 + h2 * y2 + H * sy) * inv4H - py;
          const cpz = (h0 * z0 + h1 * z1 + h2 * z2 + H * sz) * inv4H - pz;
          hsx += hfx;
          hsy += hfy;
          hsz += hfz;
          tqx += cpy * hfz - cpz * hfy;
          tqy += cpz * hfx - cpx * hfz;
          tqz += cpx * hfy - cpy * hfx;
          volume -= (H / 3) * area * ny;
        }
        wetted += area;
        wcx += area * cx;
        wcy += area * cy;
        wcz += area * cz;

        // Centre velocity relative to the orbital water velocity.
        const rx = cx - px;
        const ry = cy - py;
        const rz = cz - pz;
        rel.x = v.x + w.y * rz - w.z * ry - (wetBuf[o + 4]! + wetBuf[o + 11]! + wetBuf[o + 18]!) / 3;
        rel.y = v.y + w.z * rx - w.x * rz - (wetBuf[o + 5]! + wetBuf[o + 12]! + wetBuf[o + 19]!) / 3;
        rel.z = v.z + w.x * ry - w.y * rx - (wetBuf[o + 6]! + wetBuf[o + 13]! + wetBuf[o + 20]!) / 3;
        // MMG hulls: only the vertical relative motion drives the velocity terms
        // (heave/pitch damping and slamming), so forward speed adds no spurious lift.
        if (!horizontal) rel.x = rel.z = 0;
        const sp = len3(rel.x, rel.y, rel.z);
        const vn = rel.x * nx + rel.y * ny + rel.z * nz;
        swept += area * vn;
        wetArea += area;
        scx += area * cx;
        scy += area * cy;
        scz += area * cz;
        svx += area * rel.x;
        svy += area * rel.y;
        svz += area * rel.z;
        if (sp < 1e-6) continue;

        // Pressure drag on leading faces, suction on trailing faces.
        const cosTheta = vn / sp;
        const ratio = sp / vref;
        let dragN: number; // signed magnitude along +n
        if (cosTheta > 0) {
          dragN =
            -qref *
            (P.pressureDragLinear * ratio + P.pressureDragQuadratic * ratio * ratio) *
            area *
            falloff(cosTheta, P.pressureFalloff);
        } else {
          dragN =
            qref *
            (P.suctionDragLinear * ratio + P.suctionDragQuadratic * ratio * ratio) *
            area *
            falloff(-cosTheta, P.suctionFalloff);
        }
        let dfx = dragN * nx;
        let dfy = dragN * ny;
        let dfz = dragN * nz;
        // Skin friction on the tangential flow.
        const tx = rel.x - vn * nx;
        const ty = rel.y - vn * ny;
        const tz = rel.z - vn * nz;
        const vt = len3(tx, ty, tz);
        const ff = -0.5 * rho * cf * area * vt;
        let ffx = ff * tx;
        const ffy = ff * ty;
        let ffz = ff * tz;
        if (!horizontal) {
          dfx = dfz = 0;
          ffx = ffz = 0;
        }
        // Cross-flow of a sliding V: the leading side's lateral projection A·|n_l| meets
        // the local sideways flow v_l (body starboard axis) as a bluff body. Horizontal,
        // at the CG height planing, at the piece's own height off the plane (see the header).
        if (cfd > 0) {
          const vl = rel.x * lx + rel.y * ly + rel.z * lz;
          const nl = nx * lx + ny * ly + nz * lz;
          if (vl * nl > 0) {
            const f = -cfd * area * Math.abs(nl) * Math.abs(vl) * vl;
            const cfx = f * lx;
            const cfz = f * lz;
            pdx += cfx;
            pdz += cfz;
            const cty = rz * cfx - rx * cfz;
            tqy += cty;
            dragTy += cty;
            if (cfRoll > 0) {
              tqx += cfRoll * ry * cfz;
              tqz -= cfRoll * ry * cfx;
            }
          }
        }
        pdx += dfx;
        pdy += dfy;
        pdz += dfz;
        frx += ffx;
        fry += ffy;
        frz += ffz;
        const sumX = dfx + ffx;
        const sumY = dfy + ffy;
        const sumZ = dfz + ffz;
        tqx += ry * sumZ - rz * sumY;
        tqy += rz * sumX - rx * sumZ;
        tqz += rx * sumY - ry * sumX;
        dragTy += rz * sumX - rx * sumZ;
      }

      // Slamming: rate of change of this triangle's swept volume.
      const prev = this.prevSwept[t]!;
      this.prevSwept[t] = swept;
      if (primed && swept > 0 && wetArea > 0) {
        const gamma = (swept - prev) / (this.triArea[t]! * dt);
        if (gamma > 0) {
          const inv = 1 / wetArea;
          const rvx = svx * inv;
          const rvy = svy * inv;
          const rvz = svz * inv;
          const sp = len3(rvx, rvy, rvz);
          if (sp > 1e-6) {
            const cosTheta = (rvx * nx + rvy * ny + rvz * nz) / sp;
            if (cosTheta > 0) {
              const ratio = Math.min(1, gamma / P.slamGammaMax);
              const mag =
                (P.slamExponent === 2 ? ratio * ratio : ratio ** P.slamExponent) *
                cosTheta *
                stopScale *
                sp *
                wetArea *
                this.slamScale;
              let sfx = (-mag * rvx) / sp;
              const sfy = (-mag * rvy) / sp;
              let sfz = (-mag * rvz) / sp;
              if (!horizontal) sfx = sfz = 0;
              const cx = scx * inv;
              const cy = scy * inv;
              const cz = scz * inv;
              const rx = cx - px;
              const ry = cy - py;
              const rz = cz - pz;
              slx += sfx;
              sly += sfy;
              slz += sfz;
              tqx += ry * sfz - rz * sfy;
              tqy += rz * sfx - rx * sfz;
              tqz += rx * sfy - ry * sfx;
              slamMag += mag;
              slamSpd += mag * sp * cosTheta;
              slamPx += mag * cx;
              slamPy += mag * cy;
              slamPz += mag * cz;
            }
          }
        }
      }

      // Still-air drag on emerged pieces.
      if (airC > 0) {
        for (let s = 0; s < dryCount; s++) {
          const o = dryOffset + s * CLIP_STRIDE * 3;
          const x0 = dryBuf[o]!;
          const y0 = dryBuf[o + 1]!;
          const z0 = dryBuf[o + 2]!;
          const ex = dryBuf[o + 7]! - x0;
          const ey = dryBuf[o + 8]! - y0;
          const ez = dryBuf[o + 9]! - z0;
          const gx = dryBuf[o + 14]! - x0;
          const gy = dryBuf[o + 15]! - y0;
          const gz = dryBuf[o + 16]! - z0;
          const area = 0.5 * len3(ey * gz - ez * gy, ez * gx - ex * gz, ex * gy - ey * gx);
          const rx = (x0 + dryBuf[o + 7]! + dryBuf[o + 14]!) / 3 - px;
          const ry = (y0 + dryBuf[o + 8]! + dryBuf[o + 15]!) / 3 - py;
          const rz = (z0 + dryBuf[o + 9]! + dryBuf[o + 16]!) / 3 - pz;
          const avx = v.x + w.y * rz - w.z * ry;
          const avy = v.y + w.z * rx - w.x * rz;
          const avz = v.z + w.x * ry - w.y * rx;
          const sp = len3(avx, avy, avz);
          if (sp < 1e-6) continue;
          const cosTheta = (avx * nx + avy * ny + avz * nz) / sp;
          if (cosTheta <= 0) continue;
          const k = -0.5 * RHO_AIR * airC * area * cosTheta * sp;
          const afx = k * avx;
          const afy = k * avy;
          const afz = k * avz;
          arx += afx;
          ary += afy;
          arz += afz;
          tqx += ry * afz - rz * afy;
          tqy += rz * afx - rx * afz;
          tqz += rx * afy - ry * afx;
        }
      }
    }
    this.primed = true;

    const fx = hsx + pdx + frx + slx + arx;
    const fy = hsy + pdy + fry + sly + ary;
    const fz = hsz + pdz + frz + slz + arz;
    body.force.x += fx;
    body.force.y += fy;
    body.force.z += fz;
    body.torque.x += tqx;
    body.torque.y += tqy;
    body.torque.z += tqz;

    out.force.x = fx;
    out.force.y = fy;
    out.force.z = fz;
    out.torque.x = tqx;
    out.torque.y = tqy;
    out.torque.z = tqz;
    out.hydrostatic.x = hsx;
    out.hydrostatic.y = hsy;
    out.hydrostatic.z = hsz;
    out.pressureDrag.x = pdx;
    out.pressureDrag.y = pdy;
    out.pressureDrag.z = pdz;
    out.friction.x = frx;
    out.friction.y = fry;
    out.friction.z = frz;
    out.slam.x = slx;
    out.slam.y = sly;
    out.slam.z = slz;
    out.air.x = arx;
    out.air.y = ary;
    out.air.z = arz;
    out.wettedArea = wetted;
    if (wetted > 0) {
      out.wettedCentroid.x = wcx / wetted;
      out.wettedCentroid.y = wcy / wetted;
      out.wettedCentroid.z = wcz / wetted;
    } else {
      out.wettedCentroid.x = px;
      out.wettedCentroid.y = py;
      out.wettedCentroid.z = pz;
    }
    out.submergedVolume = volume;
    out.immersion = Math.max(0, Math.min(1, volume / this.designVolume));
    out.reynolds = reynolds;
    out.frictionCoefficient = cf;
    out.slamStrength = slamMag / (body.mass * GRAVITY);
    out.slamSpeed = slamMag > 0 ? slamSpd / slamMag : 0;
    out.dragYawTorque = dragTy;
    if (slamMag > 0) {
      out.slamPoint.x = slamPx / slamMag;
      out.slamPoint.y = slamPy / slamMag;
      out.slamPoint.z = slamPz / slamMag;
    } else zero(out.slamPoint);
    return out;
  }
}

function writeVertex(
  dst: Float64Array,
  d: number,
  world: Float64Array,
  wv: Float64Array,
  i3: number,
  h: number,
): void {
  dst[d] = world[i3]!;
  dst[d + 1] = world[i3 + 1]!;
  dst[d + 2] = world[i3 + 2]!;
  dst[d + 3] = h;
  dst[d + 4] = wv[i3]!;
  dst[d + 5] = wv[i3 + 1]!;
  dst[d + 6] = wv[i3 + 2]!;
}
