// The sailboat's rig as one pure, body-frame state machine: sail plan (reef and furl, animated), main
// and genoa aerodynamics at their own centres of effort, sheets (rate-driven or auto-trimmed toward the
// ideal angle), the boom and genoa hinges, trim state and telltales. The force module feeds it the
// relative air at each centre of effort and applies its forces to the hull; the sail lab drives it
// directly. No allocation per step.

import { type Vec3, vec3 } from '../core/math';
import { RHO_AIR } from '../core/units';
import {
  GENOA_POLAR,
  MAIN_POLAR,
  type SailForce,
  type SailPolar,
  sailForce,
  sailForceResult,
  windAngleOffBow,
} from './aero';
import { SheetedHinge } from './hinge';
import {
  CC115_RIG,
  type GenoaPlan,
  type MainPlan,
  type RigSpec,
  boomEnd,
  emptyGenoaPlan,
  emptyMainPlan,
  genoaCentre,
  genoaClew,
  genoaPlan,
  mainCentre,
  mainClew,
  mainPlan,
} from './rig';
import { approach, clamp, smoothstep } from './util';

const DEG = Math.PI / 180;

// Arcade keeps the sails drawing in a near calm.
const LIGHT_AIR_MIN = 6 * (1852 / 3600); // m/s apparent, at the sails
const FURL_STEPS: readonly number[] = [0, 1 / 3, 2 / 3, 1];

// Sheet speeds: a winch in Realistic, a quick trimmer in Arcade (rad/s of sheeting angle).
const SHEET_RATE = { realistic: { main: 8 * DEG, jib: 10 * DEG }, arcade: { main: 22 * DEG, jib: 26 * DEG } };
const AUTO_TRIM_RATE = { realistic: 10 * DEG, arcade: 30 * DEG };
const REEF_TIME = { realistic: 5, arcade: 1.5 }; // s per reef
const FURL_RATE = { realistic: 0.2, arcade: 0.6 }; // fraction per second
// Auto-trim re-optimizes at this interval; the apparent wind changes slowly against it.
const OPTIMIZE_INTERVAL = 1 / 30;
const OPTIMIZE_STEP = 1 * DEG;
// Trim tolerance either side of the ideal sheeting angle.
const TRIM_TOLERANCE = 5 * DEG;
// Accidental gybes: by-the-lee angle where the leech starts to back, the ramp to fully backed, and the
// backed leech's moment coefficient (× q·A·arm).
const GYBE_ONSET = 5 * DEG;
const GYBE_RAMP = 8 * DEG;
const LEECH_BACKING = 0.9;
// Past this heel the trimmer feathers the sails (accepts less drive for less heeling force).
const FEATHER_HEEL = 16 * DEG;

type TrimCode = -1 | 0 | 1; // luffing, optimal, stalled

export interface SailRigInputs {
  dt: number;
  mainAir: Vec3; // body-frame air velocity relative to the boat at the main's centre of effort, m/s
  jibAir: Vec3; // … at the genoa's centre of effort
  gravity: Vec3; // body-frame gravity, m/s² (for the hinges when heeled)
  heel: number; // rad, + starboard down
  mainSheet: number; // −1 ease .. +1 trim (rate)
  jibSheet: number;
  // Let fly: both sheets released to their stops while held (the sails swing out and spill the wind).
  // Auto-trim stays as it was, so the crew trims back in on release; without it the sheets stay out.
  letFly?: boolean;
  arcade: boolean;
  rho?: number;
}

export interface SailState {
  readonly aero: SailForce;
  readonly force: Vec3; // body frame, N
  readonly centre: Vec3; // centre of effort, body frame
  readonly clew: Vec3; // body frame
  readonly air: Vec3; // section-plane relative air used (after the light-air assist), body frame
  ideal: number; // signed ideal hinge angle (boom β / sheeting angle γ), rad
  trim: TrimCode;
  luff: number; // 0..1 how hard the sail is flogging (audio, cloth)
  area: number;
  aspectRatio: number;
  blanket: number; // 1 = clean air, smaller when in the main's wind shadow (genoa)
}

const sailState = (): SailState => ({
  aero: sailForceResult(),
  force: vec3(),
  centre: vec3(),
  clew: vec3(),
  air: vec3(),
  ideal: 0,
  trim: 0,
  luff: 0,
  area: 0,
  aspectRatio: 0,
  blanket: 1,
});

const scratchForce = sailForceResult();

export class SailRig {
  readonly rig: RigSpec;
  readonly main: SailState = sailState();
  readonly jib: SailState = sailState();
  readonly mainPlan: MainPlan = emptyMainPlan();
  readonly genoaPlan: GenoaPlan = emptyGenoaPlan();
  readonly boom: SheetedHinge;
  readonly jibHinge: SheetedHinge;
  reef = 0; // animated level 0..3
  reefTarget = 0;
  furl = 0; // animated 0 set .. 1 rolled away
  furlTarget = 0;
  autoTrim = true;
  lightAir = false; // the arcade light-air assist is lifting the apparent wind
  telltaleJibWindward = 1;
  telltaleJibLeeward = 1;
  telltaleMainLeech = 1;
  private optimizeTimer = 0;

  constructor(rig: RigSpec = CC115_RIG) {
    this.rig = rig;
    this.boom = new SheetedHinge(rig.boom, 20 * DEG);
    this.jibHinge = new SheetedHinge(rig.jib, 20 * DEG);
    this.reset();
  }

  // At rest with the sheets at 20°; `keepSail` keeps the reef and genoa furl the crew has set (a boat
  // put back upright after a capsize comes back rigged as it was), else full sail.
  reset(keepSail = false): void {
    this.reef = this.reefTarget = keepSail ? this.reefTarget : 0;
    this.furl = this.furlTarget = keepSail ? this.furlTarget : 0;
    this.boom.reset(0, 20 * DEG);
    this.jibHinge.reset(this.rig.jibMinIn, 20 * DEG);
    this.optimizeTimer = 0;
    this.updatePlans();
    this.updateGeometry();
  }

  // Sets up the sails at once (a boat spawning ready to sail): the reef and furl already in, the sheets
  // at these limits and both sails out against them on `side` (−1 port, +1 starboard), at rest.
  preset(reef: number, furl: number, mainSheet: number, jibSheet: number, side: -1 | 1): void {
    this.setReef(reef);
    this.reef = this.reefTarget;
    const i = FURL_STEPS.findIndex((f) => f >= furl - 1e-6);
    this.furl = this.furlTarget = i < 0 ? 1 : FURL_STEPS[i]!;
    this.mainSheetLimit = mainSheet;
    this.jibSheetLimit = jibSheet;
    this.boom.reset(side * this.boom.limit, this.boom.limit);
    this.jibHinge.reset(side * this.jibHinge.limit, this.jibHinge.limit);
    this.updatePlans();
    this.updateGeometry();
  }

  setReef(level: number): void {
    this.reefTarget = clamp(Math.round(level), 0, this.rig.reefDepths.length - 1);
  }

  // Cycles the furler: full → ⅓ → ⅔ → furled → full.
  cycleFurl(): void {
    const i = FURL_STEPS.findIndex((f) => f > this.furlTarget + 1e-6);
    this.furlTarget = i < 0 ? 0 : FURL_STEPS[i]!;
  }

  get mainSheetLimit(): number {
    return this.boom.limit;
  }

  set mainSheetLimit(v: number) {
    this.boom.limit = clamp(v, this.rig.boomMinIn, this.rig.boomMaxOut);
  }

  get jibSheetLimit(): number {
    return this.jibHinge.limit;
  }

  set jibSheetLimit(v: number) {
    this.jibHinge.limit = clamp(v, this.rig.jibMinIn, this.rig.jibMaxOut);
  }

  // Horizontal sheeting angle of the genoa (signed): the hinge variable itself.
  get jibAngle(): number {
    return this.jibHinge.angle;
  }

  get boomAngle(): number {
    return this.boom.angle;
  }

  private updatePlans(): void {
    mainPlan(this.rig, this.reef, this.mainPlan);
    genoaPlan(this.rig, this.furl, this.genoaPlan);
    this.main.area = this.mainPlan.area;
    this.main.aspectRatio = this.mainPlan.aspectRatio;
    // A rolled-away genoa has no area left to drive.
    this.jib.area = this.furl >= 0.999 ? 0 : this.genoaPlan.area;
    this.jib.aspectRatio = this.genoaPlan.aspectRatio;
  }

  // Centres of effort and clews for the current hinge angles (call before sampling the wind).
  updateGeometry(): void {
    mainCentre(this.main.centre, this.rig, this.mainPlan, this.boom.angle);
    mainClew(this.main.clew, this.rig, this.mainPlan, this.boom.angle);
    genoaCentre(this.jib.centre, this.rig, this.genoaPlan, this.jibHinge.angle);
    genoaClew(this.jib.clew, this.rig, this.genoaPlan, this.jibHinge.angle);
  }

  boomEnd(out: Vec3): Vec3 {
    return boomEnd(out, this.rig, this.boom.angle);
  }

  private jibClMaxScale(): number {
    // A part-rolled genoa sets with a poor, baggy shape.
    return 1 - 0.35 * this.furl;
  }

  // Horizontal lever arm of the genoa's centre of effort from the tack (for the hinge moment).
  private jibArm(): number {
    const p = this.genoaPlan;
    return (p.along * p.luffDir.z + p.lp * p.footDir.z + (p.head.z - this.rig.tack.z)) / 3;
  }

  step(input: SailRigInputs): void {
    const dt = input.dt;
    const mode = input.arcade ? 'arcade' : 'realistic';
    const rho = input.rho ?? RHO_AIR;
    // Reef and furl animate toward their targets.
    this.reef = approach(this.reef, this.reefTarget, dt / REEF_TIME[mode]);
    this.furl = approach(this.furl, this.furlTarget, dt * FURL_RATE[mode]);
    this.updatePlans();

    // Section-plane air (the component along the mast does nothing; heel shrinks the rest).
    this.lightAir = false;
    this.prepareAir(this.main.air, input.mainAir, input.arcade);
    this.prepareAir(this.jib.air, input.jibAir, input.arcade);

    // The genoa sails in the main's wind shadow when running.
    const awaMain = Math.abs(windAngleOffBow(this.main.air.x, this.main.air.z));
    this.jib.blanket = 1 - 0.75 * smoothstep((awaMain - 125 * DEG) / (40 * DEG));

    // Auto-trim: re-optimize the ideal angles, steer the sheet limits toward them.
    this.optimizeTimer -= dt;
    if (this.optimizeTimer <= 0) {
      this.optimizeTimer = OPTIMIZE_INTERVAL;
      this.main.ideal = this.optimize(
        MAIN_POLAR,
        this.main,
        this.rig.boomMinIn,
        this.rig.boomMaxOut,
        1,
        input,
      );
      const jibScale = this.jibClMaxScale();
      this.jib.ideal = this.optimize(
        GENOA_POLAR,
        this.jib,
        this.rig.jibMinIn,
        this.rig.jibMaxOut,
        jibScale,
        input,
      );
    }
    const manual = Math.abs(input.mainSheet) > 0.05 || Math.abs(input.jibSheet) > 0.05;
    if (manual && !input.letFly) this.autoTrim = false;
    if (input.letFly) {
      // Sheets running free to their stops; the hinges swing out under the wind.
      this.mainSheetLimit = this.rig.boomMaxOut;
      this.jibSheetLimit = this.rig.jibMaxOut;
    } else if (this.autoTrim) {
      const rate = AUTO_TRIM_RATE[mode] * dt;
      this.mainSheetLimit = approach(this.boom.limit, Math.abs(this.main.ideal), rate);
      this.jibSheetLimit = approach(this.jibHinge.limit, Math.abs(this.jib.ideal), rate);
    } else {
      this.mainSheetLimit = this.boom.limit - input.mainSheet * SHEET_RATE[mode].main * dt;
      this.jibSheetLimit = this.jibHinge.limit - input.jibSheet * SHEET_RATE[mode].jib * dt;
    }

    // Aerodynamic forces at the current angles; they also swing the hinges.
    this.computeForce(MAIN_POLAR, this.main, this.boom.angle, 1, 1, rho);
    this.computeForce(
      GENOA_POLAR,
      this.jib,
      this.jibHinge.angle,
      this.jibClMaxScale(),
      this.jib.blanket,
      rho,
    );
    const g = input.gravity;
    const mainArm = this.mainPlan.ceAft;
    const b = this.boom.angle;
    let mainTorque = mainArm * (Math.cos(b) * this.main.force.x - Math.sin(b) * this.main.force.z);
    // By the lee (wind from astern on the boom's side) the twisted head and leech get backed and push
    // the boom inboard, which is what starts an accidental gybe. The flat section model alone would
    // hold the boom out until the wind is abeam on the wrong side, so this is an empirical term.
    const awa = windAngleOffBow(this.main.air.x, this.main.air.z);
    if (Math.abs(awa) > Math.PI / 2 && Math.sign(awa) === Math.sign(b) && Math.abs(b) > 2 * DEG) {
      const byTheLee = Math.PI - Math.abs(awa);
      const backing = smoothstep((byTheLee - GYBE_ONSET) / GYBE_RAMP);
      mainTorque *= 1 - backing;
      mainTorque -= Math.sign(b) * backing * LEECH_BACKING * this.main.aero.q * this.main.area * mainArm;
    }
    this.boom.step(dt, mainTorque + this.boom.gravityTorque(g.x, g.z));
    const j = this.jibHinge.angle;
    const jibTorque = this.jibArm() * (Math.cos(j) * this.jib.force.x - Math.sin(j) * this.jib.force.z);
    this.jibHinge.step(dt, jibTorque + this.jibHinge.gravityTorque(g.x, g.z));
    this.updateGeometry();
    this.classify(this.main, this.boom.angle);
    this.classify(this.jib, this.jibHinge.angle);
    this.updateTelltales();
  }

  private prepareAir(out: Vec3, air: Vec3, arcade: boolean): void {
    out.x = air.x;
    out.y = 0;
    out.z = air.z;
    if (!arcade) return;
    const speed = Math.hypot(out.x, out.z);
    if (speed < LIGHT_AIR_MIN && speed > 1e-3) {
      const k = LIGHT_AIR_MIN / speed;
      out.x *= k;
      out.z *= k;
      this.lightAir = true;
    }
  }

  private computeForce(
    polar: SailPolar,
    sail: SailState,
    angle: number,
    clMaxScale: number,
    blanket: number,
    rho: number,
  ): void {
    sailForce(
      polar,
      sail.area * blanket,
      sail.aspectRatio,
      angle,
      sail.air.x,
      sail.air.z,
      rho,
      sail.aero,
      clMaxScale,
    );
    sail.force.x = sail.aero.fx;
    sail.force.y = 0;
    sail.force.z = sail.aero.fz;
  }

  // Ideal hinge angle on the leeward side: the one with the most drive, feathering when overpowered.
  private optimize(
    polar: SailPolar,
    sail: SailState,
    minAngle: number,
    maxAngle: number,
    clMaxScale: number,
    input: SailRigInputs,
  ): number {
    const air = sail.air;
    const speed = Math.hypot(air.x, air.z);
    const awa = windAngleOffBow(air.x, air.z);
    const hingeSide = (sail === this.main ? this.boom.side : this.jibHinge.side) || 1;
    const side = speed < 1e-3 ? hingeSide : awa >= 0 ? -1 : 1;
    if (speed < 1e-3 || sail.area <= 0) return side * minAngle;
    const feather = 1.2 * smoothstep((Math.abs(input.heel) - FEATHER_HEEL) / (14 * DEG));
    let best = minAngle;
    let bestScore = -Infinity;
    for (let a = minAngle; a <= maxAngle + 1e-9; a += OPTIMIZE_STEP) {
      sailForce(polar, sail.area, sail.aspectRatio, side * a, air.x, air.z, 1, scratchForce, clMaxScale);
      const score = -scratchForce.fz - feather * Math.abs(scratchForce.fx);
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    return side * best;
  }

  private classify(sail: SailState, angle: number): void {
    const a = sail.aero;
    sail.luff = sail.area > 0 && a.speed > 0.3 ? 1 - a.fill : 0;
    if (sail.area <= 0) {
      sail.trim = 0;
      return;
    }
    const sameSide = Math.sign(angle) === Math.sign(sail.ideal) || Math.abs(angle) < 3 * DEG;
    const eased = Math.abs(angle) - Math.abs(sail.ideal);
    // At the ideal angle the sail is trimmed right even if it isn't fully drawing: when overpowered the
    // ideal is feathered (eased to cut heel), and the HUD's reef advice covers that, not "trim in".
    const backing = a.fill < 0.7 && eased > TRIM_TOLERANCE / 2;
    if (!sameSide || backing || eased > TRIM_TOLERANCE) sail.trim = -1;
    else if (eased < -TRIM_TOLERANCE && a.stall > 0.3) sail.trim = 1;
    else sail.trim = 0;
  }

  private updateTelltales(): void {
    const j = this.jib.aero;
    const m = this.main.aero;
    // Windward jib telltale lifts as the luff starts to back; leeward one curls when the flow separates.
    this.telltaleJibWindward = this.jib.area > 0 ? j.fill : 0;
    this.telltaleJibLeeward = this.jib.area > 0 ? j.fill * (1 - 2 * j.stall) : 0;
    this.telltaleMainLeech = m.fill * (1 - 2 * m.stall);
  }
}

// The sheet limits auto-trim settles on sailing at `speed` (m/s, ahead) in a true wind of `tws` (m/s)
// at `twa` (rad, + from starboard) under this reef and furl, heeled `heel` (past FEATHER_HEEL the
// trimmer feathers): where a manual trimmer would set the sheets to sail off. Unsigned, rad.
export function trimmedSheets(
  tws: number,
  twa: number,
  speed: number,
  reef: number,
  furl: number,
  heel = 0,
  rig: RigSpec = CC115_RIG,
): { main: number; jib: number } {
  const sail = new SailRig(rig);
  sail.preset(reef, furl, 20 * DEG, 20 * DEG, twa >= 0 ? -1 : 1);
  // Body-frame air relative to the boat: the true wind from `twa` off the bow plus the boat's own
  // speed from dead ahead.
  const air = vec3(-tws * Math.sin(twa), 0, tws * Math.cos(twa) + speed);
  sail.step({
    dt: 0,
    mainAir: air,
    jibAir: air,
    gravity: vec3(0, -1, 0),
    heel,
    mainSheet: 0,
    jibSheet: 0,
    arcade: false,
  });
  return { main: Math.abs(sail.main.ideal), jib: Math.abs(sail.jib.ideal) };
}
