// The sailboat's sails as a ForceModule: samples the sheared true wind at each sail's centre of effort,
// subtracts the boat's velocity there (so pitching, rolling and yawing feed back into the apparent
// wind), steps the SailRig (sheets, auto-trim, boom and genoa hinges, reef/furl) and applies the main
// and genoa forces to the hull at their centres of effort, so drive, side force, heeling and yaw
// moments all come out of where the forces act. Sheet snubs (an accidental gybe slamming the boom
// into the mainsheet) hand their angular momentum to the hull.
//
// Physics modes: Arcade turns auto-trim on by default, lifts the apparent wind at the sails to at
// least 6 kn (never becalmed) and nudges the bow off the wind when the boat is stuck in irons.
// Realistic is manual: you can be becalmed, stuck in irons, or gybe by accident. Changing mode resets
// auto-trim to the mode's default; the 'autoTrim' command overrides it until the next change.
//
// Commands: { type: 'reef', delta } (0..3), { type: 'furl' } (cycles full → ⅓ → ⅔ → furled → full),
// { type: 'autoTrim', enabled }. Manual sheet input (controls.mainSheet / jibSheet) turns auto-trim off;
// letting fly (controls.letFly) runs both sheets out while held and leaves auto-trim as it was.
// Telemetry keys: see telemetry.ts.

import type { BoatSpec } from '../boats/BoatSpec';
import { attitudeFromQuat } from '../core/attitude';
import { signedAngle, velocityToFromDirection } from '../core/conventions';
import { type Vec3, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import type { ForceContext, ForceModule } from '../physics/modules';
import { addCompressedForce } from '../physics/tuning';
import type { PhysicsMode, SailSetup, SimCommand } from '../world/protocol';
import { windAngleOffBow } from './aero';
import { polarAngles, polarSpeed } from './orcPolar';
import { CC115_RIG, jibSheetLength, mainSheetLength, type RigSpec } from './rig';
import { SailRig, type SailState } from './SailRig';
import { SAIL_KEYS as K } from './telemetry';

const DEG = Math.PI / 180;
const IRONS_TWA = 38 * DEG; // inside this, with no way on, the boat is in irons
const IRONS_SPEED = 0.5; // m/s forward through the water
const IRONS_TIME = 2.5; // s before it counts
const IRONS_HELP_ACCEL = 0.12; // rad/s² yaw the Arcade assist gives at full strength
const GYBE_DANGER_TWA = 165 * DEG;
const BY_THE_LEE_TWA = 150 * DEG;
const DOWNWIND_TWA = 120 * DEG;

export interface SailModuleOptions {
  rig?: RigSpec;
}

const att = { heading: 0, pitch: 0, roll: 0 };
const worldPoint = vec3();
const windVel = vec3();
const pointVel = vec3();
const rel = vec3();
const tmp = vec3();
const tmpB = vec3();
const gravityWorld = vec3(0, -GRAVITY, 0);

export class SailModule implements ForceModule {
  readonly spec: BoatSpec;
  readonly rig: SailRig;
  private readonly mainAir = vec3();
  private readonly jibAir = vec3();
  private readonly gravity = vec3();
  private readonly mastheadAir = vec3();
  private readonly yawInertia: number;
  private mode: PhysicsMode | null = null;
  private trimCommanded = false; // an 'autoTrim' command arrived since the last step
  private ironsTimer = 0;
  private gybes = 0;
  private lastCrossings = 0;
  // Last-step readouts.
  private tws = 0;
  private twa = 0;
  private heel = 0;
  private vmg = 0;
  private speed = 0;
  private inIrons = false;
  private drive = 0;
  private side = 0;
  private heelMoment = 0;
  private yawMoment = 0;

  constructor(spec: BoatSpec, options: SailModuleOptions = {}) {
    this.spec = spec;
    this.rig = new SailRig(options.rig ?? CC115_RIG);
    const k = spec.gyration.yaw;
    this.yawInertia = spec.mass * k * k * (1 + spec.addedMass.yaw);
  }

  // Placed at rest (spawn, recover, respawn): the reef and furl stay as the crew set them.
  reset(): void {
    this.rig.reset(true);
    this.rig.autoTrim = this.mode !== 'realistic';
    this.ironsTimer = 0;
    this.inIrons = false;
    this.resetGybeCount();
  }

  // The rig's crossing counter restarts at zero whenever the hinges are reset, so the gybe count
  // (and the crossings it was last compared with) restart with it.
  private resetGybeCount(): void {
    this.gybes = 0;
    this.lastCrossings = 0;
  }

  // Spawn: the sails already set as `setup` says, out to leeward of a true wind `twa` off the bow.
  setup(setup: SailSetup, twa: number): void {
    this.rig.preset(setup.reef, setup.furl, setup.mainSheet, setup.jibSheet, twa >= 0 ? -1 : 1);
    this.resetGybeCount();
  }

  command(command: SimCommand): boolean {
    switch (command.type) {
      case 'reef':
        this.rig.setReef(this.rig.reefTarget + command.delta);
        return true;
      case 'furl':
        this.rig.cycleFurl();
        return true;
      case 'autoTrim':
        this.rig.autoTrim = command.enabled;
        this.trimCommanded = true;
        return true;
      default:
        return false;
    }
  }

  // Relative air at a body point, returned in body axes.
  private sampleAir(ctx: ForceContext, bodyPoint: Vec3, out: Vec3): Vec3 {
    const b = ctx.body;
    b.bodyToWorldPoint(worldPoint, bodyPoint);
    ctx.wind.sample(worldPoint.x, Math.max(worldPoint.y, 0.5), worldPoint.z, ctx.time, windVel);
    b.pointVelocity(pointVel, worldPoint);
    rel.x = windVel.x - pointVel.x;
    rel.y = windVel.y - pointVel.y;
    rel.z = windVel.z - pointVel.z;
    return b.worldToBodyDirection(out, rel);
  }

  private applySailForce(ctx: ForceContext, sail: SailState, compression: number): void {
    const b = ctx.body;
    tmp.x = sail.force.x;
    tmp.y = 0;
    tmp.z = sail.force.z;
    b.bodyToWorldDirection(tmpB, tmp);
    b.bodyToWorldPoint(worldPoint, sail.centre);
    addCompressedForce(b, compression, tmpB.x, tmpB.y, tmpB.z, worldPoint.x, worldPoint.y, worldPoint.z);
  }

  apply(ctx: ForceContext): void {
    const b = ctx.body;
    const rig = this.rig;
    if (ctx.physicsMode !== this.mode) {
      // A mode change resets auto-trim to the mode's default, unless a command came with it.
      this.mode = ctx.physicsMode;
      if (!this.trimCommanded) rig.autoTrim = this.mode === 'arcade';
    }
    this.trimCommanded = false;
    const arcade = ctx.physicsMode === 'arcade';
    attitudeFromQuat(b.orientation, att);
    this.heel = att.roll;
    this.sampleAir(ctx, rig.main.centre, this.mainAir);
    this.sampleAir(ctx, rig.jib.centre, this.jibAir);
    b.worldToBodyDirection(this.gravity, gravityWorld);
    rig.step({
      dt: ctx.dt,
      mainAir: this.mainAir,
      jibAir: this.jibAir,
      gravity: this.gravity,
      heel: this.heel,
      mainSheet: ctx.controls.mainSheet,
      jibSheet: ctx.controls.jibSheet,
      letFly: ctx.controls.letFly,
      arcade,
    });

    // Forces at the centres of effort (body frame), so heel and yaw moments follow from the geometry.
    // Arcade time compression adds (k − 1) of the horizontal force at CG height: faster speed and
    // turning response without extra heel (see physics/tuning.ts).
    const compression = ctx.tuning?.timeCompression ?? 1;
    const m = rig.main;
    const j = rig.jib;
    this.applySailForce(ctx, m, compression);
    this.applySailForce(ctx, j, compression);
    const fx = m.force.x + j.force.x;
    const fz = m.force.z + j.force.z;
    this.drive = -fz;
    this.side = fx;
    // Heel about the bow axis (+ starboard down), yaw + bow to starboard, both about the CG.
    const cg = b.cg;
    this.heelMoment = m.force.x * (m.centre.y - cg.y) + j.force.x * (j.centre.y - cg.y);
    this.yawMoment =
      (m.centre.x - cg.x) * m.force.z -
      (m.centre.z - cg.z) * m.force.x +
      (j.centre.x - cg.x) * j.force.z -
      (j.centre.z - cg.z) * j.force.x;

    // Sheet snubs hand the hinge's momentum to the hull about the mast (body +Y).
    const impulse = rig.boom.reactionImpulse + rig.jibHinge.reactionImpulse;
    if (impulse !== 0 && ctx.dt > 0) {
      tmp.x = 0;
      tmp.y = impulse / ctx.dt;
      tmp.z = 0;
      b.addTorque(b.bodyToWorldDirection(tmpB, tmp));
    }

    // True wind at 10 m over the boat, the masthead instrument, VMG.
    ctx.wind.sample(b.position.x, 10, b.position.z, ctx.time, windVel);
    this.tws = Math.hypot(windVel.x, windVel.z);
    this.twa = signedAngle(velocityToFromDirection(windVel.x, windVel.z) - att.heading);
    this.vmg = this.tws > 1e-6 ? -(b.velocity.x * windVel.x + b.velocity.z * windVel.z) / this.tws : 0;
    tmp.x = 0;
    tmp.y = rig.rig.mastheadY;
    tmp.z = rig.rig.mastZ;
    this.sampleAir(ctx, tmp, this.mastheadAir);
    b.worldToBodyDirection(tmp, b.velocity);
    this.speed = -tmp.z;

    // Irons: pointing inside the no-go zone with no way on.
    const pinned = Math.abs(this.twa) < IRONS_TWA && this.speed < IRONS_SPEED;
    this.ironsTimer = pinned ? this.ironsTimer + ctx.dt : Math.max(0, this.ironsTimer - 2 * ctx.dt);
    this.inIrons = this.ironsTimer > IRONS_TIME;
    if (arcade && this.ironsTimer > 1 && Math.abs(this.twa) < 50 * DEG) {
      // Bear away to the side the wind is already on (as backing the jib would).
      const strength = Math.min(1, (this.ironsTimer - 1) / 2);
      const dir = this.twa >= 0 ? 1 : -1;
      tmp.x = 0;
      tmp.y = dir * strength * IRONS_HELP_ACCEL * this.yawInertia;
      tmp.z = 0;
      b.addTorque(b.bodyToWorldDirection(tmpB, tmp));
    }

    // Count gybes: boom crossings made with the wind aft.
    const crossings = rig.boom.crossings;
    if (crossings !== this.lastCrossings) {
      if (Math.abs(this.twa) > DOWNWIND_TWA) this.gybes += crossings - this.lastCrossings;
      this.lastCrossings = crossings;
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    const rig = this.rig;
    const m = rig.main;
    const j = rig.jib;
    const boom = rig.boom.angle;
    const angles = polarAngles(this.tws);
    const target = polarSpeed(this.tws, this.twa);
    const byTheLee = Math.sign(boom) === Math.sign(this.twa) && Math.abs(boom) > 10 * DEG;
    const absTwa = Math.abs(this.twa);
    out[K.tws] = this.tws;
    out[K.twa] = this.twa;
    out[K.aws] = Math.hypot(this.mastheadAir.x, this.mastheadAir.z);
    out[K.awa] = windAngleOffBow(this.mastheadAir.x, this.mastheadAir.z);
    out[K.boomAngle] = boom;
    out[K.jibAngle] = rig.jibAngle;
    out[K.idealBoomAngle] = m.ideal;
    out[K.idealJibAngle] = j.ideal;
    out[K.mainTrim] = m.trim;
    out[K.jibTrim] = j.trim;
    out[K.telltaleJibWindward] = rig.telltaleJibWindward;
    out[K.telltaleJibLeeward] = rig.telltaleJibLeeward;
    out[K.telltaleMainLeech] = rig.telltaleMainLeech;
    out[K.reef] = rig.reefTarget;
    out[K.reefProgress] = rig.reef;
    out[K.jibFurl] = rig.furl;
    out[K.autoTrim] = rig.autoTrim ? 1 : 0;
    out[K.heel] = this.heel;
    out[K.vmg] = this.vmg;
    out[K.targetSpeed] = target;
    out[K.targetPct] = target > 0.05 ? this.speed / target : 0;
    out[K.bestUpwindTwa] = angles.beatTwa;
    out[K.bestDownwindTwa] = angles.runTwa;
    out[K.gybeDanger] = absTwa > GYBE_DANGER_TWA || (absTwa > BY_THE_LEE_TWA && byTheLee) ? 1 : 0;
    out[K.inIrons] = this.inIrons ? 1 : 0;
    out[K.mainLuff] = m.luff;
    out[K.jibLuff] = j.luff;
    out[K.boomSlams] = rig.boom.impacts;
    out[K.boomSlam] = rig.boom.lastImpactSpeed;
    out[K.boomCrossings] = rig.boom.crossings;
    out[K.gybes] = this.gybes;
    out[K.mainClewX] = m.clew.x;
    out[K.mainClewY] = m.clew.y;
    out[K.mainClewZ] = m.clew.z;
    out[K.jibClewX] = j.clew.x;
    out[K.jibClewY] = j.clew.y;
    out[K.jibClewZ] = j.clew.z;
    rig.boomEnd(tmp);
    out[K.boomEndX] = tmp.x;
    out[K.boomEndY] = tmp.y;
    out[K.boomEndZ] = tmp.z;
    out[K.mainAwX] = this.mainAir.x;
    out[K.mainAwY] = this.mainAir.y;
    out[K.mainAwZ] = this.mainAir.z;
    out[K.jibAwX] = this.jibAir.x;
    out[K.jibAwY] = this.jibAir.y;
    out[K.jibAwZ] = this.jibAir.z;
    out[K.mainForce] = Math.hypot(m.force.x, m.force.z);
    out[K.jibForce] = Math.hypot(j.force.x, j.force.z);
    out[K.mainFill] = m.aero.fill;
    out[K.jibFill] = j.aero.fill;
    out[K.mainSheet] = rig.mainSheetLimit;
    out[K.jibSheet] = rig.jibSheetLimit;
    out[K.mainSheetLength] = mainSheetLength(rig.rig, boom);
    out[K.jibSheetLength] = jibSheetLength(rig.rig, rig.genoaPlan, rig.jibAngle, tmp);
    out[K.mainAlpha] = m.aero.alpha;
    out[K.jibAlpha] = j.aero.alpha;
    out[K.mainCl] = m.aero.cl;
    out[K.mainCd] = m.aero.cd;
    out[K.jibCl] = j.aero.cl;
    out[K.jibCd] = j.aero.cd;
    out[K.mainArea] = m.area;
    out[K.jibArea] = j.area;
    out[K.drive] = this.drive;
    out[K.side] = this.side;
    out[K.heelMoment] = this.heelMoment;
    out[K.yawMoment] = this.yawMoment;
    out[K.lightAir] = rig.lightAir ? 1 : 0;
  }
}

export function createSailModule(spec: BoatSpec, options: SailModuleOptions = {}): SailModule {
  return new SailModule(spec, options);
}
