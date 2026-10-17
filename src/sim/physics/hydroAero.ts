// Aerodynamics of a three-point hydroplane: the hull flies. At 200 mph the air under the boat is
// worth about four times its weight in dynamic pressure on its planform, so the tunnel between the
// sponsons (ram air, the sponsons as end plates, the water as the ground) and the after-body carry a
// large share of the weight, and an adjustable wing above the transom trims it. Each lifting surface
// is a low-aspect-ratio wing at its own centre of pressure, with its own angle of attack from the air
// moving past that point (the boat's motion and the wind, sheared with height), so pitching and
// heaving damp themselves:
//
//   L = ½ρ_air·V²·S·C_L(α + i)·G(h),   D = ½ρ_air·V²·S·C_D(α + i)
//   G(h) = 1 + g·exp(−2h/c)                (ground effect: h the surface's height over the water)
//
// C_L and C_D are the appendage foils' (physics/foils.ts: Helmbold's lift slope for the effective
// aspect ratio, induced drag, stall into flat-plate normal force). The wing's incidence i is the
// driver's trim (BoatControls.trim, a rate like an outboard's trim): more down-force presses the
// stern and the propeller down. On flat water that hardly moves the trim (the pads and the propeller
// set it) and costs drag; flying off a wave it holds the bow up, and less of it lets the bow drop.
//
// Blow-over is emergent, not scripted: the tunnel's centre of pressure is well forward of the
// centre of gravity, so a bow rising by a degree or two (a wave, a gust, too much wing) adds lift
// ahead of the CG; once the sponsons are clear of the water the boat pivots on its propeller, the
// lift's moment about it grows with the angle faster than the weight's, and past a few degrees above
// its running trim the bow keeps going: lift and then the planform's flat-plate normal force throw it
// over backwards. The bluff-body drag and the side force are the windage's (physics/windage.ts).
// A surface under water carries no air load.
//
// Telemetry: aeroLift (N, all surfaces, + up in the body), aeroLiftShare (of the weight),
// wingAngle (rad), wingTrim (0 least down-force .. 1 most: bow up), outboardTrim (= wingTrim, for the HUD),
// aeroAlpha (rad, the tunnel's angle of attack).

import { qRotateInverse, type Vec3, vec3 } from '../core/math';
import { GRAVITY, RHO_AIR } from '../core/units';
import { foilCoefficients, type FoilCoefficients, type FoilSpec } from './foils';
import type { ForceContext, ForceModule } from './modules';
import { clamp } from './propulsion/common';
import { waterSample } from './water';

export interface AeroSurfaceSpec {
  name: string;
  centre: Vec3; // centre of pressure, body frame
  area: number; // planform, m²
  aspectRatio: number; // effective (end plates included)
  incidence: number; // rad: chord to the body's x–z plane, + leading edge up
  stallAngle: number; // rad
  zeroLiftDrag: number;
  groundEffect?: { chord: number; gain: number };
  // The adjustable wing: incidence + trim angle, the angle set by the trim control.
  trim?: { min: number; max: number; rate: number; initial: number };
  // Centre of pressure moving forward (−z) as the angle of attack grows past `from` (rad), by
  // `perRad` m per rad up to `max` m: the ram air under a climbing bow.
  cpTravel?: { from: number; perRad: number; max: number };
}

export interface HydroAeroSpec {
  surfaces: AeroSurfaceSpec[];
}

const air = vec3();
const pv = vec3();
const rel = vec3();
const coeff: FoilCoefficients = { cl: 0, cd: 0 };

export class HydroAero implements ForceModule {
  readonly spec: HydroAeroSpec;
  readonly foils: FoilSpec[];
  readonly world: Vec3[];
  // The wing's trim angle (rad), for the surface with `trim`.
  wingAngle = 0;
  lift = 0;
  liftShare = 0;
  alpha = 0;
  private readonly sample = waterSample();
  private readonly forceBody = vec3();
  private readonly cp = vec3();
  private readonly trimmed: AeroSurfaceSpec | undefined;

  constructor(spec: HydroAeroSpec) {
    this.spec = spec;
    this.foils = spec.surfaces.map((s) => ({
      name: s.name,
      kind: 'fin' as const,
      centre: s.centre,
      spanAxis: vec3(1, 0, 0),
      chordAxis: vec3(0, 0, 1),
      span: Math.sqrt(s.aspectRatio * s.area),
      area: s.area,
      effectiveAspectRatio: s.aspectRatio,
      stallAngle: s.stallAngle,
      zeroLiftDrag: s.zeroLiftDrag,
    }));
    this.world = spec.surfaces.map(() => vec3());
    this.trimmed = spec.surfaces.find((s) => s.trim);
    this.reset();
  }

  apply(ctx: ForceContext): void {
    const { body, dt } = ctx;
    const t = this.trimmed?.trim;
    if (t)
      this.wingAngle = clamp(this.wingAngle + clamp(ctx.controls.trim, -1, 1) * -t.rate * dt, t.min, t.max);
    let lift = 0;
    const surfaces = this.spec.surfaces;
    for (let i = 0; i < surfaces.length; i++) {
      const s = surfaces[i]!;
      const p = this.world[i]!;
      body.bodyToWorldPoint(p, s.centre);
      ctx.water.sample(p.x, p.y, p.z, ctx.time, this.sample);
      if (this.sample.pressureHead > 0) continue;
      ctx.wind.sample(p.x, Math.max(p.y, 0.1), p.z, ctx.time, air);
      body.pointVelocity(pv, p);
      air.x -= pv.x;
      air.y -= pv.y;
      air.z -= pv.z;
      qRotateInverse(rel, body.orientation, air);
      // The flow in the surface's section plane (body y–z): + α with the air coming from below.
      const v2 = rel.y * rel.y + rel.z * rel.z;
      if (v2 < 1e-4) continue;
      const v = Math.sqrt(v2);
      const angle = s.incidence + (s.trim ? this.wingAngle : 0);
      const alpha = Math.atan2(rel.y, rel.z) + angle;
      if (i === 0) this.alpha = alpha;
      foilCoefficients(this.foils[i]!, wrap(alpha), coeff);
      const g = s.groundEffect;
      const h = -this.sample.pressureHead;
      const ground = g ? 1 + g.gain * Math.exp((-2 * h) / g.chord) : 1;
      const q = 0.5 * RHO_AIR * v2 * s.area;
      const cl = coeff.cl * ground;
      // Lift ⟂ the flow (up for air streaming aft), drag along it.
      const ly = rel.z / v;
      const lz = -rel.y / v;
      const f = this.forceBody;
      f.x = 0;
      f.y = q * (cl * ly + (coeff.cd * rel.y) / v);
      f.z = q * (cl * lz + (coeff.cd * rel.z) / v);
      lift += f.y;
      const travel = s.cpTravel;
      if (travel) {
        const c = this.cp;
        c.x = s.centre.x;
        c.y = s.centre.y;
        c.z = s.centre.z - Math.min(travel.max, Math.max(0, wrap(alpha) - travel.from) * travel.perRad);
        body.addBodyForceAtBodyPoint(f, c);
      } else body.addBodyForceAtBodyPoint(f, s.centre);
    }
    this.lift = lift;
    this.liftShare = lift / (body.mass * GRAVITY);
  }

  writeTelemetry(out: Record<string, number>): void {
    out['aeroLift'] = this.lift;
    out['aeroLiftShare'] = this.liftShare;
    out['aeroAlpha'] = this.alpha;
    const t = this.trimmed?.trim;
    if (t) {
      const trim01 = (t.max - this.wingAngle) / (t.max - t.min);
      out['wingAngle'] = this.wingAngle;
      out['wingTrim'] = trim01;
      out['outboardTrim'] = trim01;
    }
  }

  reset(): void {
    this.wingAngle = this.trimmed?.trim?.initial ?? 0;
    this.lift = 0;
    this.liftShare = 0;
  }
}

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
