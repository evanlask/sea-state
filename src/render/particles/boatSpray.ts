// Per-boat spray from the interpolated boat state and its telemetry: prop wash behind every
// propeller, pod and jet, the jet ski's and the hydroplane's rooster tails, continuous bow spray
// that grows with speed and sea state (heaviest into a head sea), and exhaust smoke (exhaust.ts).
// The plan is pure; BoatSpray turns it into spawns with per-boat emitters, capping the fleet's
// continuous spray to a share of the particle budget, and tracks how much spray each boat takes
// (for its wipers).
//
// Spray leaves each hull from outside it: bow spray and slam sheets from the waterline beside the
// hull (hullVolumes.ts), prop wash astern of the transom. The particle kernels kill anything that
// still ends up inside a hull.

import { Quaternion, Vector3 } from 'three/webgpu';

import { DRIVE_CONFIGS } from '../../sim/boats/driveConfig';
import { BOAT_SPECS } from '../../sim/boats/specs/index';
import type { BoatKind, BoatSnapshot } from '../../sim/world/protocol';
import type { FxBudget } from './budgets';
import type { SpawnRequest, Vec3Like } from './emissionQueue';
import {
  HYDRO_ROOSTER_LIFE,
  HydroRoosterTail,
  PropWash,
  RateCarry,
  RoosterTail,
  roosterShape,
  type SlamSides,
  WASH_RATE,
  washRate,
} from './emitters';
import { ExhaustSmoke } from './exhaust';
import { hullHalfBreadth, hullVolume } from './hullVolumes';
import type { ParticleSystem } from './ParticleSystem';
import type { RoosterSheets } from './roosterSheet';
import { hullSprayScale } from './sprayMath';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface SpraySea {
  hs: number; // significant wave height, m
  waveFrom: number; // rad, where the waves come from (the wind sea)
  wind?: Vec3Like; // m/s, the air at 10 m (exhaust plumes); default calm
}

interface WashSource {
  local: Vec3Like; // body frame, at the surface above the propulsor (astern of the transom)
  throttle: number; // 0..1
  beam: number; // m, width of the churned strip
}

export interface SprayPlan {
  // Particles/s at scale 1; the root of the spray sheet on the waterline (body z), its speed (m/s).
  bow: { rate: number; z: number; sheet: number; intensity: number };
  wash: WashSource[];
  // The jet ski's plume from its nozzle, or (prop) a hydroplane's rooster tail from its propeller.
  rooster: { local: Vec3Like; thrust: number; prop: boolean; speedShare: number } | null;
  spray: number; // the hull's spray scale (sprayMath.hullSprayScale)
}

// Particles per second at full spray, before the quality scale.
const BOW_RATE = 900;
const ROOSTER_RATE = 2500; // RoosterTail default, plus 6 % mist
const BOW_SHEET = 0.35; // of the bow spray's droplets, as coherent sheet water
const BOW_MIST = 0.1; // mist puffs per bow droplet
const ROOSTER_MIST = 0.06;
const MEAN_LIFE = 1.6; // s, the continuous emitters' particles
const POOL_SHARE = 0.3; // of the particle pool the fleet's continuous spray may keep alive
const EMIT_SHARE = 0.3; // of the per-frame spawn budget
const SIDE_MARGIN = 0.05; // m (plus 2 % of the beam) outside the hull side spray starts from

const tel = (t: Readonly<Record<string, number>>, key: string): number => t[key] ?? 0;

// Per-propulsor telemetry keys (no strings built per frame).
const POD_THRUST = Array.from({ length: 8 }, (_, i) => `pod${i}Thrust`);
const ENGINE_THROTTLE = Array.from({ length: 8 }, (_, i) => `eng${i}Throttle`);

// Source i of `out` (reused), at the surface above p but no further forward than `aft`.
function putWash(
  out: WashSource[],
  i: number,
  p: Vec3Like,
  aft: number,
  throttle: number,
  beam: number,
): void {
  const source = (out[i] ??= { local: { x: 0, y: 0, z: 0 }, throttle: 0, beam: 0 });
  const local = source.local as { x: number; y: number; z: number };
  local.x = p.x;
  local.y = 0;
  local.z = Math.max(p.z, aft);
  source.throttle = throttle;
  source.beam = beam;
}

// The wash sources into `out` (its entries reused), which is returned.
function washSources(kind: BoatKind, t: Readonly<Record<string, number>>, out: WashSource[]): WashSource[] {
  const cfg = DRIVE_CONFIGS[kind];
  // A ship's propeller turns under its counter: its race boils up astern of the transom.
  const aft = hullVolume(kind).zStern + 0.3;
  const prop = BOAT_SPECS[kind].propulsion.propellerDiameter ?? 1;
  switch (cfg.kind) {
    case 'shaft':
      putWash(out, 0, cfg.position, aft, clamp01(Math.abs(tel(t, 'telegraphResponse'))), prop);
      out.length = 1;
      break;
    case 'pods':
      for (let i = 0; i < cfg.positions.length; i++) {
        const key = POD_THRUST[i] ?? `pod${i}Thrust`;
        putWash(out, i, cfg.positions[i]!, aft, clamp01(Math.abs(tel(t, key))), prop);
      }
      out.length = cfg.positions.length;
      break;
    case 'outboards': {
      const emersion = 1 - clamp01(tel(t, 'propEmersion'));
      for (let i = 0; i < cfg.positions.length; i++) {
        const key = ENGINE_THROTTLE[i] ?? `eng${i}Throttle`;
        putWash(out, i, cfg.positions[i]!, aft, clamp01(Math.abs(tel(t, key))) * emersion, 0.7);
      }
      out.length = cfg.positions.length;
      break;
    }
    case 'jet': {
      const throttle = clamp01(tel(t, 'throttle')) * (1 - clamp01(tel(t, 'ventilated')));
      putWash(out, 0, cfg.nozzle, aft, throttle, 0.6);
      out.length = 1;
      break;
    }
    case 'surfaceProp': {
      const throttle = clamp01(tel(t, 'throttle')) * (1 - clamp01(tel(t, 'propEmersion')));
      putWash(out, 0, cfg.position, aft, throttle, 0.6);
      out.length = 1;
      break;
    }
    case 'sail':
      out.length = 0;
      break;
  }
  return out;
}

const emptyPlan = (): SprayPlan => ({
  bow: { rate: 0, z: 0, sheet: 0, intensity: 0 },
  wash: [],
  rooster: null,
  spray: 0,
});

// What one boat throws this frame; `out` (a plan to overwrite, its parts reused) saves allocating.
export function sprayPlan(
  boat: BoatSnapshot,
  heading: number,
  sea: SpraySea,
  out: SprayPlan = emptyPlan(),
): SprayPlan {
  const spec = BOAT_SPECS[boat.kind];
  const t = boat.telemetry;
  const d = spec.dimensions;
  const speed = t['speedThroughWater'] ?? Math.hypot(boat.velocity.x, boat.velocity.z);
  const airborne = tel(t, 'airborne') > 0.5 || tel(t, 'capsized') > 0.5;
  // Bow spray: from speed (relative to the boat's own top speed) and from the sea relative to its
  // size, heaviest punching into a head sea.
  const fast = clamp01(speed / spec.propulsion.topSpeed) ** 1.5;
  const rough = clamp01(sea.hs / (0.06 * d.lwl + 0.3));
  const head = 0.5 + 0.5 * Math.cos(sea.waveFrom - heading);
  // A hydroplane's sponsons throw sheets off their pads' outer chines even in flat water.
  const hull = spec.hull;
  const sponsons = hull.family === 'hydroplane';
  const calmSpray = sponsons ? 0.6 : 0.3;
  const intensity = airborne ? 0 : clamp01(fast * (calmSpray + rough * (0.4 + 0.6 * head)) * 1.6);
  const size = Math.min(3, Math.max(0.5, d.beam / 3));
  // A displacement bow throws its sheet off the stem; a planing hull's spray root runs aft with speed;
  // the sponsons' runs from the wetted aft ends of the pads, just ahead of the step.
  const root = hull.family === 'planing' ? 0.08 + 0.22 * fast : 0.03;
  const bow = out.bow;
  bow.rate = BOW_RATE * size * intensity;
  bow.z = sponsons ? -hull.length / 2 + hull.sponsonLength - 0.35 : -d.lwl / 2 + root * d.lwl;
  bow.sheet = Math.min(12, 2 + 0.3 * speed + 2 * rough);
  bow.intensity = intensity;
  if (airborne) out.wash.length = 0;
  else washSources(boat.kind, t, out.wash);
  const cfg = DRIVE_CONFIGS[boat.kind];
  if (cfg.kind === 'jet') {
    // Bucket ahead throws the plume aft; neutral, brake and reverse blow it about under the hull.
    const ahead = Math.round(tel(t, 'bucket')) === 0 ? 1 : 0.3;
    const thrust = clamp01(tel(t, 'throttle')) * (1 - clamp01(tel(t, 'ventilated'))) * ahead;
    const rooster = (out.rooster ??= { local: cfg.nozzle, thrust: 0, prop: false, speedShare: 0 });
    rooster.local = cfg.nozzle;
    rooster.thrust = airborne ? 0 : thrust;
    rooster.prop = false;
  } else if (cfg.kind === 'surfaceProp') {
    // The hydroplane's rooster tail, thrown up by the half-immersed propeller (emitters.ts
    // HydroRoosterTail): as tall as the boat is fast and the blades bite. Out of the water (the
    // stern flying, a blow-over) the propeller throws nothing: its thrust is gone.
    const thrust = clamp01(tel(t, 'thrust') / (0.25 * spec.mass * 9.81));
    const rooster = (out.rooster ??= { local: cfg.position, thrust: 0, prop: true, speedShare: 0 });
    rooster.local = cfg.position;
    rooster.thrust = tel(t, 'capsized') > 0.5 ? 0 : thrust;
    rooster.prop = true;
    rooster.speedShare = clamp01(speed / spec.propulsion.topSpeed);
  } else {
    out.rooster = null;
  }
  out.spray = hullSprayScale(d.lwl);
  return out;
}

// Particles per second a plan asks for at scale 1.
export function planRate(plan: SprayPlan, speed: number): number {
  let rate = plan.bow.rate;
  rate *= 1 + BOW_MIST;
  for (const w of plan.wash) rate += WASH_RATE * washRate(w.beam, w.throttle, speed);
  const r = plan.rooster;
  // The hydroplane's tail hangs in the air longer than the other spray: counted at its life.
  if (r?.prop) rate += roosterShape(r.speedShare, r.thrust).rate * (HYDRO_ROOSTER_LIFE / MEAN_LIFE);
  else if (r) rate += ROOSTER_RATE * (1 + ROOSTER_MIST) * r.thrust;
  return rate;
}

// Scale for the fleet's continuous spray: the quality scale, cut back so that what it keeps alive
// stays within its share of the pool and of the per-frame spawn budget.
export function sprayScale(requested: number, budget: FxBudget, emitScale: number): number {
  const asked = requested * emitScale;
  if (asked <= 0) return emitScale;
  const cap = Math.min((POOL_SHARE * budget.particles) / MEAN_LIFE, EMIT_SHARE * budget.emitPerFrame * 60);
  return emitScale * Math.min(1, cap / asked);
}

// Wipers run in rain or heavy spray, with some hysteresis so they don't flicker on and off.
export function wipersWanted(on: boolean, rain: number, spray: number): boolean {
  const level = Math.max(rain * 2.5, spray);
  return on ? level > 0.2 : level > 0.35;
}

// Body-frame point on the waterline just outside the hull side at body z (side −1 port, +1 starboard).
export function hullSidePoint(kind: BoatKind, z: number, side: number, out: Vector3): Vector3 {
  const volume = hullVolume(kind);
  const lo = volume.zBow + 0.02 * (volume.zStern - volume.zBow);
  const zc = Math.min(Math.max(z, lo), volume.zStern);
  const margin = SIDE_MARGIN + 0.02 * BOAT_SPECS[kind].dimensions.beam;
  return out.set(side * (hullHalfBreadth(volume, zc, 0.05) + margin), 0.05, zc);
}

const CALM: Vec3Like = { x: 0, y: 0, z: 0 };
const q = new Quaternion();
const tmp = new Vector3();
const bowDir = new Vector3();
const right = new Vector3();
const origin = new Vector3();
const sideA = new Vector3();
const sideB = new Vector3();

interface Stretch {
  at: { x: number; y: number; z: number };
  line: { x: number; y: number; z: number };
  local: number;
}

const newStretch = (): Stretch => ({ at: { x: 0, y: 0, z: 0 }, line: { x: 0, y: 0, z: 0 }, local: 0 });

// Spawn points for spray off a stretch of hull side, world frame: the stretch's middle and half-extent.
function sideStretch(
  boat: BoatSnapshot,
  z: number,
  halfLength: number,
  side: number,
  out: Stretch = newStretch(),
): Stretch {
  const o = boat.orientation;
  q.set(o.x, o.y, o.z, o.w);
  const sideLocalA = hullSidePoint(boat.kind, z - halfLength, side, sideA).x;
  const sideLocalB = hullSidePoint(boat.kind, z + halfLength, side, sideB).x;
  sideA.applyQuaternion(q);
  sideB.applyQuaternion(q);
  const p = boat.position;
  out.at.x = p.x + (sideA.x + sideB.x) / 2;
  out.at.y = p.y + (sideA.y + sideB.y) / 2;
  out.at.z = p.z + (sideA.z + sideB.z) / 2;
  out.line.x = (sideB.x - sideA.x) / 2;
  out.line.y = (sideB.y - sideA.y) / 2;
  out.line.z = (sideB.z - sideA.z) / 2;
  out.local = (sideLocalA + sideLocalB) / 2; // body x of the stretch's middle
  return out;
}

// The bow spray's spawn requests, filled in per side every frame (the queue copies them on spawn).
const bowStretch = newStretch();
const bowCarrier = { x: 0, y: 0, z: 0 };
const bowSheetVelocity = { x: 0, y: 0, z: 0 };
const mistPosition = { x: 0, y: 0, z: 0 };
const mistVelocity = { x: 0, y: 0, z: 0 };
const mistCarrier = { x: 0, y: 0, z: 0 };
const sheetSize: [number, number] = [0, 0];
const dropletSize: [number, number] = [0, 0];
const mistSize: [number, number] = [0, 0];
const sheetRequest: SpawnRequest = {
  kind: 'droplet',
  count: 0,
  position: bowStretch.at,
  positionRadius: 0,
  positionLine: bowStretch.line,
  velocity: bowSheetVelocity,
  velocitySpread: 0,
  speedVariation: 0.4,
  fanAxis: bowDir,
  fanAngle: 0,
  carrier: bowCarrier,
  size: sheetSize,
  sizeSkew: 0,
  life: [0.35, 0.8],
  drag: 0.05,
};
const dropletRequest: SpawnRequest = {
  kind: 'droplet',
  count: 0,
  position: bowStretch.at,
  positionRadius: 0,
  positionLine: bowStretch.line,
  velocity: bowSheetVelocity,
  velocitySpread: 0,
  speedVariation: 0.6,
  fanAxis: bowDir,
  fanAngle: 0,
  carrier: bowCarrier,
  size: dropletSize,
  life: [0.9, 1.9],
  drag: 0.15,
};
const mistRequest: SpawnRequest = {
  kind: 'mist',
  count: 0,
  position: mistPosition,
  positionRadius: 0,
  positionLine: bowStretch.line,
  velocity: mistVelocity,
  velocitySpread: 0.8,
  carrier: mistCarrier,
  size: mistSize,
  life: [1.2, 2.6],
};

// A body-frame point in the world, for the pose BoatEmitters.apply has set up (q, origin).
const toWorld = (local: Vec3Like, out: Vector3): Vector3 =>
  out.set(local.x, local.y, local.z).applyQuaternion(q).add(origin);

// Where a slam at a world point throws its sheets from: the waterline beside it, both sides.
export function slamSides(boat: BoatSnapshot, point: Vec3Like): SlamSides {
  const o = boat.orientation;
  q.set(o.x, o.y, o.z, o.w).invert();
  const local = tmp.set(point.x - boat.position.x, point.y - boat.position.y, point.z - boat.position.z);
  local.applyQuaternion(q);
  const half = 0.06 * BOAT_SPECS[boat.kind].dimensions.lwl;
  const z = local.z;
  const port = sideStretch(boat, z, half, -1);
  const starboard = sideStretch(boat, z, half, 1);
  const spray = hullSprayScale(BOAT_SPECS[boat.kind].dimensions.lwl);
  return {
    port: port.at,
    starboard: starboard.at,
    portLine: port.line,
    starboardLine: starboard.line,
    clearance: mistClearance(boat.kind, starboard.local, spray),
  };
}

// How far outboard of a point on the hull side (body x) mist must start to clear the widest beam
// as it streams aft, at most 2.5 × the spray scale (a ship's bow is far narrower than her beam).
function mistClearance(kind: BoatKind, x: number, spray: number): number {
  return Math.max(0, Math.min(BOAT_SPECS[kind].dimensions.beam / 2 - Math.abs(x), 2.5 * spray));
}

// One boat's emitters.
class BoatEmitters {
  readonly rooster = new RoosterTail();
  readonly propTail = new HydroRoosterTail();
  readonly washes: PropWash[] = [];
  readonly smoke = new ExhaustSmoke();
  private bowCarry = new RateCarry();
  private mistCarry = new RateCarry();
  slamLevel = 0; // 0..1 spray from recent slams (decays)
  sprayLevel = 0; // what the wipers see
  bowLevel = 0; // 0..1 bow spray intensity (lens droplets on a camera at the bow)

  apply(
    particles: ParticleSystem,
    boat: BoatSnapshot,
    plan: SprayPlan,
    dt: number,
    scale: number,
    smokeScale: number,
    wind: Vec3Like,
    sheets?: RoosterSheets,
  ): void {
    const o = boat.orientation;
    q.set(o.x, o.y, o.z, o.w);
    origin.set(boat.position.x, boat.position.y, boat.position.z);
    bowDir.set(0, 0, -1).applyQuaternion(q);
    bowDir.y = 0;
    if (bowDir.lengthSq() < 1e-6) bowDir.set(0, 0, -1);
    bowDir.normalize();
    right.set(-bowDir.z, 0, bowDir.x);
    const v = boat.velocity;

    while (this.washes.length < plan.wash.length) this.washes.push(new PropWash());
    this.washes.length = plan.wash.length;
    for (let i = 0; i < plan.wash.length; i++) {
      const source = plan.wash[i]!;
      const wash = this.washes[i]!;
      wash.throttle = source.throttle;
      wash.beam = source.beam;
      toWorld(source.local, wash.stern);
      wash.stern.y = boat.position.y + 0.05;
      wash.boatVelocity.set(v.x, v.y, v.z);
      wash.heading.copy(bowDir);
      wash.update(particles, dt, scale);
    }

    const r = plan.rooster;
    this.rooster.thrust = r && !r.prop ? r.thrust : 0;
    this.propTail.thrust = r?.prop ? r.thrust : 0;
    if (r?.prop) {
      toWorld(r.local, this.propTail.propeller);
      this.propTail.boatVelocity.set(v.x, v.y, v.z);
      this.propTail.heading.copy(bowDir);
      this.propTail.speedShare = r.speedShare;
      this.propTail.update(particles, dt, scale);
      const speed = Math.max(0, v.x * bowDir.x + v.z * bowDir.z);
      sheets?.push(
        boat.id,
        this.propTail.propeller,
        bowDir,
        roosterShape(r.speedShare, r.thrust).height,
        speed,
      );
    } else if (r) {
      toWorld(r.local, this.rooster.nozzle);
      this.rooster.direction.set(0, 0.12, 1).normalize().applyQuaternion(q);
      this.rooster.boatVelocity.set(v.x, v.y, v.z);
      this.rooster.mistShare = ROOSTER_MIST;
      this.rooster.update(particles, dt, scale);
    }

    const bow = plan.bow;
    if (bow.rate > 0) {
      const count = this.bowCarry.take(bow.rate * scale, dt);
      const mist = this.mistCarry.take(bow.rate * BOW_MIST * scale, dt);
      const s = bow.sheet;
      const spray = plan.spray;
      const clump = Math.sqrt(spray);
      const d = BOAT_SPECS[boat.kind].dimensions;
      const half = 0.06 * d.lwl;
      // The spray leaves with the hull's speed (less a little), so that it peels off outward and
      // aft clear of the topsides instead of falling back into them.
      bowCarrier.x = v.x * 0.8;
      bowCarrier.z = v.z * 0.8;
      mistCarrier.x = v.x * 0.5;
      mistCarrier.z = v.z * 0.5;
      sheetSize[0] = 0.025 * clump;
      sheetSize[1] = 0.08 * clump;
      dropletSize[0] = 0.004 * clump;
      dropletSize[1] = 0.035 * clump;
      mistSize[0] = 0.15 * spray;
      mistSize[1] = 0.45 * spray;
      for (let side = -1; side <= 1; side += 2) {
        const stretch = sideStretch(boat, bow.z, half, side, bowStretch);
        bowSheetVelocity.x = right.x * side * s * 0.7;
        bowSheetVelocity.y = s * 0.45;
        bowSheetVelocity.z = right.z * side * s * 0.7;
        // Sheets: coherent water off the chine, breaking up within a fraction of a second...
        sheetRequest.count = (count * BOW_SHEET) / 2;
        sheetRequest.positionRadius = 0.05 * spray;
        sheetRequest.velocitySpread = s * 0.06;
        sheetRequest.fanAngle = 0.3 * side;
        particles.spawn(sheetRequest);
        // ...into droplets, mostly fine.
        dropletRequest.count = (count * (1 - BOW_SHEET)) / 2;
        dropletRequest.positionRadius = 0.1 * spray;
        dropletRequest.velocitySpread = s * 0.12;
        dropletRequest.fanAngle = 0.4 * side;
        particles.spawn(dropletRequest);
        // Mist hangs in the air and streams aft at the boat's speed: it starts outboard of the
        // widest part of the hull so it doesn't stream into the topsides.
        const out = mistClearance(boat.kind, stretch.local, spray) + 0.3 * spray;
        mistPosition.x = stretch.at.x + right.x * side * out;
        mistPosition.y = stretch.at.y + 0.4 * spray;
        mistPosition.z = stretch.at.z + right.z * side * out;
        mistVelocity.x = right.x * side * 2;
        mistVelocity.y = 1.2;
        mistVelocity.z = right.z * side * 2;
        mistRequest.count = mist / 2;
        mistRequest.positionRadius = 0.4 * spray;
        particles.spawn(mistRequest);
      }
    }

    this.smoke.update(particles, boat, wind, dt, smokeScale);

    this.slamLevel *= Math.exp(-dt / 3);
    this.sprayLevel = Math.max(bow.intensity, this.slamLevel);
    this.bowLevel = bow.intensity;
  }
}

export class BoatSpray {
  private emitters = new Map<string, BoatEmitters>();
  private plans: SprayPlan[] = [];

  // A slam (impact speed, m/s) throws spray over the boat: it counts toward its wipers.
  slam(boatId: string, strength: number): void {
    const e = this.emitters.get(boatId);
    if (e) e.slamLevel = Math.max(e.slamLevel, clamp01((strength - 1) / 5));
  }

  sprayLevel(boatId: string): number {
    return this.emitters.get(boatId)?.sprayLevel ?? 0;
  }

  bowSpray(boatId: string): number {
    return this.emitters.get(boatId)?.bowLevel ?? 0;
  }

  update(
    particles: ParticleSystem,
    boats: readonly BoatSnapshot[],
    headings: readonly number[],
    sea: SpraySea,
    dt: number,
    budget: FxBudget,
    emitScale: number,
    sheets?: RoosterSheets, // the hydroplanes' rooster tails' sheets of water (roosterSheet.ts)
  ): void {
    const step = Math.min(Math.max(dt, 0), 0.1);
    while (this.plans.length < boats.length) this.plans.push(emptyPlan());
    let requested = 0;
    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i]!;
      const plan = sprayPlan(boat, headings[i] ?? 0, sea, this.plans[i]);
      requested += planRate(plan, Math.hypot(boat.velocity.x, boat.velocity.z));
    }
    const scale = sprayScale(requested, budget, emitScale);
    // Smoke is a few puffs a second per stack, outside the spray's share; a plume needs most of them.
    const smokeScale = Math.max(0.5, emitScale);
    for (let i = 0; i < boats.length; i++) {
      const boat = boats[i]!;
      let e = this.emitters.get(boat.id);
      if (!e) this.emitters.set(boat.id, (e = new BoatEmitters()));
      e.apply(particles, boat, this.plans[i]!, step, scale, smokeScale, sea.wind ?? CALM, sheets);
    }
    if (this.emitters.size > boats.length) {
      for (const id of this.emitters.keys()) if (!boats.some((b) => b.id === id)) this.emitters.delete(id);
    }
  }
}
