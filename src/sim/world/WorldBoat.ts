// One boat in the world: its dynamics and force modules, the per-boat water
// grid over the ocean, the helm (player or autopilot), and the large-angle
// state machine — capsize detection (heel past the AVS and staying there, or rolled upside down),
// sinking and respawn, and recover (upright at the surface, at rest, dry). A capsize throws a sit-on
// craft's rider off (spec.rider): the boat drifts on without him, engine stopped and nobody at the
// helm, until recover puts him back. A capsize also throws an engine's kill switch (a hydroplane's
// turbine): it stays stopped, even if the boat comes upright, until recover restarts it.

import { CALIBRATION } from '../boats/calibration/index';
import { boatModel, createModules } from '../boats/drivetrains';
import { cachedLoadedModel, loadingConditionFor, loadTelemetry } from '../boats/loading';
import { BOAT_SPECS } from '../boats/specs/index';
import { attitudeFromQuat } from '../core/attitude';
import { headingToVector } from '../core/conventions';
import { qRotate, qRotateInverse, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import { CASCADE_MASK_ALL, CASCADE_MASK_SHIPS } from '../ocean/cascades';
import { BoatDynamics } from '../physics/BoatDynamics';
import { DeckWater, Flooding } from '../physics/flooding';
import { HullWater, type SurfaceQuery } from '../physics/hullWater';
import { meshBounds } from '../physics/mesh';
import { interpolate } from '../physics/resistance';
import { physicsTuning } from '../physics/tuning';
import { waterSample } from '../physics/water';
import type { WindSampler } from '../physics/windage';
import { SailModule } from '../sail/sailModule';
import { Autopilot, HYDRO_PILOT, type PilotState, type PilotTarget } from './autopilot';
import type { CollisionHull } from './collisions';
import { collisionShapeFor } from './collisionShapes';
import {
  type AutopilotSetting,
  type BoatControls,
  type BoatKind,
  type BoatLoad,
  type BoatSnapshot,
  neutralControls,
  type PhysicsMode,
  type SailSetup,
  type SimEvent,
} from './protocol';
import { AUTOPILOT_CODES } from './telemetry';

const SHIPS: ReadonlySet<BoatKind> = new Set(['cargo', 'cruise', 'crab']);
const CAPSIZE_HOLD = 2.5; // s past the AVS before it counts
// Upside down counts at once, even if the boat rolls on round and comes up again (a roll-over: the
// crew and anything loose are in the sea, outboards drown): past this tilt for ROLL_OVER_HOLD.
const ROLLED_OVER = (150 * Math.PI) / 180;
const ROLL_OVER_HOLD = 0.3; // s
const SINK_HOLD = 8; // s fully under before it counts
const RESPAWN_DELAY = 3; // s after sinking
const SLAM_INTERVAL = 0.25; // s between slam events per boat
const SLAM_MIN_G = 0.02; // slam force / weight worth an event
const SLAM_MIN_SPEED = 1; // m/s impact speed worth an event

const origin = vec3();
const up = vec3();
const NO_HELM: BoatControls = neutralControls();
const UP = vec3(0, 1, 0);

export class WorldBoat {
  readonly id: string;
  readonly kind: BoatKind;
  readonly dyn: BoatDynamics;
  readonly water: HullWater;
  readonly collision: CollisionHull;
  readonly telemetry: Record<string, number> = {};
  controls: BoatControls = neutralControls();
  autopilot: Autopilot | null = null;
  capsized = false;
  sunk = false;
  cpuUs = 0;
  private overAvs = 0;
  private inverted = 0; // s upside down
  private underAvs = 0;
  private underwater = 0;
  private respawnIn = -1;
  private slamCooldown = 0;
  private lastSlam = 0;
  private readonly avs: number;
  private readonly capsizeHeel: number;
  private readonly attitude = { heading: 0, pitch: 0, roll: 0 };
  private readonly originSample = waterSample();
  private readonly deckWater: DeckWater | null;
  private readonly flooding: Flooding | null;
  private readonly planingSpeed: number;
  private readonly restHeight: number; // origin above the water at rest in this loading condition
  private readonly loadTelemetry: Record<string, number>;

  constructor(
    id: string,
    kind: BoatKind,
    surface: SurfaceQuery,
    mode: PhysicsMode,
    capsizeAssist = false,
    load?: BoatLoad,
  ) {
    this.id = id;
    this.kind = kind;
    const model = cachedLoadedModel(
      kind,
      boatModel(kind),
      loadingConditionFor(kind, load),
      CALIBRATION[kind].stability.avs,
    );
    this.restHeight = model.restHeight;
    this.loadTelemetry = loadTelemetry(kind, load);
    const spec = BOAT_SPECS[kind];
    const modules = createModules(kind, model);
    this.dyn = new BoatDynamics(model, { modules, tuning: physicsTuning(kind, mode, capsizeAssist) });
    this.deckWater = (modules.find((m) => m instanceof DeckWater) as DeckWater | undefined) ?? null;
    this.flooding = (modules.find((m) => m instanceof Flooding) as Flooding | undefined) ?? null;
    const bounds = meshBounds(model.buoyant);
    const height = bounds.maxY - bounds.minY;
    const d = spec.dimensions;
    this.water = new HullWater(surface, {
      halfLength: (d.loa / 2) * 1.1,
      halfWidth: Math.max(d.beam / 2, 0.8 * height) * 1.1,
      nx: SHIPS.has(kind) ? 13 : 9,
      nz: 5,
      referenceDepth: Math.max(0.2, d.overallDraft * 0.8),
      mask: kind === 'cargo' || kind === 'cruise' ? CASCADE_MASK_SHIPS : CASCADE_MASK_ALL,
    });
    this.collision = { id, body: this.dyn.body, shape: collisionShapeFor(kind, model.hull) };
    this.avs = model.avs;
    this.capsizeHeel = Math.min(this.avs, (160 * Math.PI) / 180);
    const volume = model.designVolume;
    this.planingSpeed =
      spec.hull.family === 'planing' ? 2.3 * Math.sqrt(GRAVITY * Math.cbrt(volume)) : Infinity;
  }

  setMode(mode: PhysicsMode, capsizeAssist: boolean): void {
    this.dyn.setTuning(physicsTuning(this.kind, mode, capsizeAssist));
    if (this.autopilot && this.autopilot.setting.mode !== 'drift') this.autoTrimOn();
  }

  // The sails trim themselves while an autopilot sails the boat (a mode change resets auto-trim).
  private autoTrimOn(): void {
    for (const m of this.dyn.modules) m.command?.({ type: 'autoTrim', boatId: this.id, enabled: true });
  }

  setAutopilot(setting: AutopilotSetting | null): void {
    if (!setting) {
      this.autopilot = null;
      return;
    }
    const spec = BOAT_SPECS[this.kind];
    const lag = SHIPS.has(this.kind) ? 25 : 1.5;
    const top = spec.propulsion.serviceSpeed ?? spec.propulsion.topSpeed;
    this.autopilot = new Autopilot(
      setting,
      top,
      lag,
      this.kind === 'sail',
      this.kind === 'hydro' ? HYDRO_PILOT : null,
    );
    // Sailed by the autopilot (holding a wind angle, a course or station), the sails trim themselves.
    if (setting.mode !== 'drift') this.autoTrimOn();
  }

  // Places the boat at rest on the local surface at (x, z).
  place(x: number, z: number, heading: number, time: number, under = 0): void {
    this.dyn.placeAtRest(x, z, heading);
    this.water.reset();
    this.water.update(this.dyn.body, time);
    this.water.sample(x, 0, z, time, this.originSample);
    this.dyn.placeAtRest(x, z, heading, 0, this.originSample.height - under + this.restHeight);
    this.water.reset();
  }

  // Spawn under way: engines running at this order and the boat moving at that share of top speed.
  prime(order: number): void {
    this.dyn.prime(order);
  }

  // Spawn setup after place(): way on ahead with the engines stopped (it bleeds off unless the helm
  // opens the throttle) and, for the sailboat, the sails set for a true wind `twa` off the bow.
  setOff(speed: number, sail: SailSetup | undefined, twa: number): void {
    if (speed > 0) this.wayOn(speed);
    if (sail) for (const m of this.dyn.modules) if (m instanceof SailModule) m.setup(sail, twa);
  }

  // Under way at `speed` with the engines running at `order` (a boat joining a fleet mid-voyage).
  underWay(speed: number, order: number): void {
    this.wayOn(speed);
    this.prime(order);
  }

  // Moving ahead at `speed` on the present heading. A hydroplane (spec.aero) also takes the running
  // sinkage and trim of that speed (its calibration): dropped level into the water at speed, it is
  // launched off its own bottom and blows over.
  private wayOn(speed: number): void {
    const b = this.dyn.body;
    if (this.dyn.model.spec.aero) {
      const cal = CALIBRATION[this.kind];
      b.getOrigin(origin);
      this.dyn.placeUnderWay(
        origin.x,
        origin.z,
        this.attitudeNow().heading,
        speed,
        interpolate(cal.speeds, cal.sinkage, speed),
        interpolate(cal.speeds, cal.trim, speed),
        origin.y,
      );
      this.water.reset();
      return;
    }
    const f = headingToVector(this.attitudeNow().heading);
    b.velocity.x = f.x * speed;
    b.velocity.z = f.z * speed;
  }

  recover(time: number, events: SimEvent[]): void {
    const b = this.dyn.body;
    const att = this.attitudeNow();
    this.dyn.setRiderAboard(true);
    b.getOrigin(origin);
    this.place(origin.x, origin.z, att.heading, time);
    this.capsized = false;
    this.sunk = false;
    this.overAvs = this.underAvs = this.underwater = 0;
    this.respawnIn = -1;
    this.autopilot?.reset();
    events.push({ type: 'recovered', boatId: this.id });
  }

  private readonly safe = vec3();

  private recoverAfterBlowUp(time: number, events: SimEvent[]): void {
    const s = this.safe;
    this.dyn.setRiderAboard(true);
    this.place(s.x, s.z, 0, time);
    this.capsized = false;
    events.push({ type: 'recovered', boatId: this.id });
  }

  private attitudeNow() {
    return attitudeFromQuat(this.dyn.body.orientation, this.attitude);
  }

  pilotState(out: PilotState): PilotState {
    const att = this.attitudeNow();
    out.heading = att.heading;
    const b = this.dyn.body;
    qRotateInverse(up, b.orientation, b.velocity);
    out.speed = -up.z;
    qRotateInverse(up, b.orientation, b.angularVelocity);
    out.yawRate = -up.y;
    this.dyn.body.getOrigin(origin);
    out.x = origin.x;
    out.z = origin.z;
    return out;
  }

  pilotTarget(out: PilotTarget): PilotTarget {
    const att = this.attitudeNow();
    const v = this.dyn.body.velocity;
    out.heading = att.heading;
    out.speed = Math.hypot(v.x, v.z);
    this.dyn.body.getOrigin(origin);
    out.x = origin.x;
    out.z = origin.z;
    return out;
  }

  step(dt: number, time: number, wind: WindSampler, events: SimEvent[]): void {
    const started = performance.now();
    const dyn = this.dyn;
    const body = dyn.body;
    if (this.respawnIn >= 0) {
      this.respawnIn -= dt;
      if (this.respawnIn < 0) this.recover(time, events);
    }
    this.water.update(body, time);
    // Thrown off, the rider steers nothing (the lanyard has stopped the engine too).
    dyn.step(dt, this.water, wind, time, dyn.riderAboard ? this.controls : NO_HELM);
    // Last-resort guard: a numerically blown-up boat is put back upright where it was.
    if (!Number.isFinite(body.position.y + body.velocity.y + body.angularVelocity.x + body.orientation.w)) {
      this.recoverAfterBlowUp(time, events);
      return;
    }

    // Slam events: impact speed of the strongest slam in the window.
    this.slamCooldown -= dt;
    if (dyn.maxSlamStrength > SLAM_MIN_G && dyn.maxSlamSpeed > SLAM_MIN_SPEED && this.slamCooldown <= 0) {
      const p = dyn.maxSlamPoint;
      events.push({ type: 'slam', boatId: this.id, x: p.x, y: p.y, z: p.z, strength: dyn.maxSlamSpeed });
      this.lastSlam = dyn.maxSlamSpeed;
      this.slamCooldown = SLAM_INTERVAL;
      dyn.maxSlamStrength = 0;
      dyn.maxSlamSpeed = 0;
    } else if (this.slamCooldown <= 0) {
      dyn.maxSlamStrength = 0;
      dyn.maxSlamSpeed = 0;
    }
    this.lastSlam *= Math.exp(-dt / 0.5);

    // Capsize: the heel (or the inverted attitude) beyond the AVS, held, or rolled upside down.
    qRotate(up, body.orientation, UP);
    const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
    if (tilt > this.capsizeHeel) {
      this.overAvs += dt;
      this.underAvs = 0;
      this.inverted = tilt > ROLLED_OVER ? this.inverted + dt : 0;
      if (!this.capsized && (this.overAvs > CAPSIZE_HOLD || this.inverted > ROLL_OVER_HOLD)) {
        this.capsized = true;
        this.dyn.setRiderAboard(false);
        // A hydroplane's driver stays in his capsule, and its kill switch cuts the turbine (it ran on
        // upside down); Recover relights it (place → the modules' reset).
        this.dyn.setKillSwitch(true);
        events.push({ type: 'capsized', boatId: this.id });
      }
    } else {
      this.overAvs = 0;
      this.inverted = 0;
      this.underAvs += dt;
      // Rolled back up by itself (a knock-down the keel recovered from).
      if (this.capsized && tilt < 0.5 * this.capsizeHeel && this.underAvs > 3) this.capsized = false;
    }

    // Sinking: the whole boat well under for a while.
    body.getOrigin(origin);
    this.water.sample(origin.x, origin.y, origin.z, time, this.originSample);
    const spec = dyn.model.spec;
    const freeboard = spec.dimensions.depth - spec.dimensions.draft;
    if (this.originSample.pressureHead > freeboard + 2 && !this.sunk) {
      this.underwater += dt;
      if (this.underwater > SINK_HOLD) {
        this.sunk = true;
        this.respawnIn = RESPAWN_DELAY;
        events.push({ type: 'sunk', boatId: this.id });
      }
    } else this.underwater = 0;

    this.safe.x = origin.x;
    this.safe.z = origin.z;
    const us = (performance.now() - started) * 1000;
    this.cpuUs += (us - this.cpuUs) * 0.02;
  }

  writeTelemetry(): Record<string, number> {
    const t = this.telemetry;
    const dyn = this.dyn;
    dyn.writeTelemetry(t);
    const speed = t['speedThroughWater'] ?? 0;
    t['onPlane'] = speed > this.planingSpeed && (t['immersion'] ?? 1) < 0.9 ? 1 : 0;
    t['slam'] = this.lastSlam;
    t['capsized'] = this.capsized ? 1 : 0;
    t['sunk'] = this.sunk ? 1 : 0;
    t['avs'] = this.avs;
    Object.assign(t, this.loadTelemetry);
    let fsm = 0;
    for (const tank of this.deckWater?.wells ?? []) fsm += tank.tank.freeSurfaceMoment;
    for (const tank of this.flooding?.tanks ?? []) fsm += tank.freeSurfaceMoment;
    t['gmEffective'] = dyn.model.gm - fsm / dyn.body.mass;
    t['cpuUs'] = this.cpuUs;
    t['autopilot'] = this.autopilot ? AUTOPILOT_CODES[this.autopilot.setting.mode] : AUTOPILOT_CODES.none;
    return t;
  }

  snapshot(): BoatSnapshot {
    const b = this.dyn.body;
    b.getOrigin(origin);
    return {
      id: this.id,
      kind: this.kind,
      position: { x: origin.x, y: origin.y, z: origin.z },
      orientation: { x: b.orientation.x, y: b.orientation.y, z: b.orientation.z, w: b.orientation.w },
      velocity: { x: b.velocity.x, y: b.velocity.y, z: b.velocity.z },
      angularVelocity: { x: b.angularVelocity.x, y: b.angularVelocity.y, z: b.angularVelocity.z },
      telemetry: { ...this.writeTelemetry() },
    };
  }
}
