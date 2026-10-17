// Sideslip drag of a planing hull. A planing bottom sliding sideways meets the
// water with its leading chine: the flow separates round the chine and is
// thrown off as a sheet of spray, and the bottom's lateral lift (a planform of
// aspect ratio ~0.2) sheds its cross-flow as vortices, so a slide costs about
// as much as its cross-flow. The per-triangle hull model gives each panel a
// force along its normal from the local inflow and misses this: a sliding V
// even rises on its leading side's panels and gets cheaper. Planing craft lose
// a third to over half their speed in a hard turn, the jet ski the most, because
// a hard-over turn makes them slide. This adds that drag against the water
// velocity, scaled by the wetted bottom (so it vanishes in the air) and faded in
// with planing speed (off the plane the hull's own cross-flow, kerner.ts, carries
// the slide):
//
//   D = C_s·½ρ·V²·A_wet·sin²β · s(u),   β = atan(|v|/|u|) at the CG
//
// the cross-flow form C_s·½ρ·v²·A_wet for small β. It acts at the wetted
// bottom's centroid in plan (aft of the CG when planing, so it also steadies the
// slide), at the CG height so it adds no roll moment (the bank is set in
// planingCarve.ts), and is zero running straight: the towing-tank calibration
// is untouched.
//
// Telemetry: slipDrag (N).

import { qRotate, qRotateInverse, vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import type { ForceContext, ForceModule } from './modules';

export interface SlipSpec {
  coefficient: number; // C_s, per unit ½ρV²·A_wet·sin²β
  planingSpeed: [number, number]; // m/s surge: off below the first, full above the second
}

const vb = vec3();
const fb = vec3();
const fw = vec3();

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class PlaningSlip implements ForceModule {
  readonly spec: SlipSpec;
  drag = 0;

  constructor(spec: SlipSpec) {
    this.spec = spec;
  }

  apply(ctx: ForceContext): void {
    const body = ctx.body;
    const hull = ctx.hull;
    this.drag = 0;
    if (!hull || hull.wettedArea <= 0) return;
    qRotateInverse(vb, body.orientation, body.velocity);
    const v2 = vb.x * vb.x + vb.z * vb.z;
    if (v2 < 1e-6) return;
    const s = this.spec;
    const planing = smoothstep(s.planingSpeed[0], s.planingSpeed[1], -vb.z);
    if (planing <= 0) return;
    // ½ρV²·sin²β = ½ρ·v².
    const d = s.coefficient * 0.5 * RHO_SEAWATER * vb.x * vb.x * hull.wettedArea * planing;
    this.drag = d;
    const speed = Math.sqrt(v2);
    fb.x = (-d * vb.x) / speed;
    fb.y = 0;
    fb.z = (-d * vb.z) / speed;
    qRotate(fw, body.orientation, fb);
    // Resistance: time-compressed in Arcade like the hull's (tuning.ts), all at the CG height.
    const k = ctx.tuning?.timeCompression ?? 1;
    const c = hull.wettedCentroid;
    body.addForceAtPointXYZ(k * fw.x, 0, k * fw.z, c.x, body.position.y, c.z);
  }

  writeTelemetry(out: Record<string, number>): void {
    out['slipDrag'] = this.drag;
  }
}
