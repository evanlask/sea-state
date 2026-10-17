// Engine exhaust: funnel smoke from the ships and a faint idle wisp from the center console's
// outboards. The plan (which stacks smoke, how much and how dark, from the engine load) is pure;
// ExhaustSmoke turns it into smoke particles every frame.
//
// Ships burn marine diesel: the plume is warm grey-brown, thicker and darker under load and
// darkest for a while after the load rises (the turbocharger lags the fuel), thin and light at
// idle. The cruise ship's diesel-electric plant runs clean, with scrubbers: a light haze. Outboards
// exhaust through the propeller hub, under water, so under way there is nothing to see; at idle a
// little escapes from the relief port above the waterline. The jet ski exhausts into the pump
// stream and the sailboat is under sail: neither smokes.
import { Quaternion, Vector3 } from 'three/webgpu';

import type { BoatKind, BoatSnapshot } from '../../sim/world/protocol';
import type { SpawnRequest, Vec3Like } from './emissionQueue';
import { RateCarry } from './emitters';
import type { ParticleSystem } from './ParticleSystem';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export interface SmokeStack {
  local: Vec3Like; // body frame, the centre of the exhaust outlet
  radius: number; // m, the outlet (the plume's starting radius)
  aux?: boolean; // generators / boilers: a steady trickle whatever the main engine does
}

export interface SmokeProfile {
  stacks: readonly SmokeStack[];
  rate: readonly [number, number]; // puffs per second per stack, idle → full load
  exit: readonly [number, number]; // m/s, gas exit speed, idle → full load
  tone: readonly [number, number]; // soot 0 (light haze) … 1 (dark brown-grey), idle → full load
  surgeTone: number; // extra tone per unit of the load-rise surge
  life: readonly [number, number]; // s
  // Outboards: smoke only near idle, from the relief port (none under way).
  idleOnly?: boolean;
}

// Outlets from the models (render/boats/models/*.ts).
export const SMOKE_PROFILES: Partial<Record<BoatKind, SmokeProfile>> = {
  cargo: {
    stacks: [
      { local: { x: -1.5, y: 45.8, z: 87.5 }, radius: 0.7 }, // main engine uptake
      { local: { x: 1.4, y: 45.8, z: 88.2 }, radius: 0.5, aux: true }, // generators
    ],
    rate: [5, 12],
    exit: [8, 24],
    tone: [0.02, 0.55],
    surgeTone: 0.45,
    life: [24, 34],
  },
  cruise: {
    // Each raked funnel's long top, as two outlets.
    stacks: [-1, 1].flatMap((side) =>
      [-2.5, 2.5].map((dz) => ({ local: { x: side * 3.3, y: 58.4, z: 50.8 + dz }, radius: 1.2 })),
    ),
    rate: [2.5, 5],
    exit: [5, 14],
    tone: [0.01, 0.12],
    surgeTone: 0.15,
    life: [18, 26],
  },
  crab: {
    stacks: [-1, 1].map((side) => ({ local: { x: side * 1.1, y: 10.2, z: -6.15 }, radius: 0.14 })),
    rate: [7, 16],
    exit: [6, 18],
    tone: [0.02, 0.7],
    surgeTone: 0.5,
    life: [9, 14],
  },
  powerboat: {
    stacks: [-1, 1].map((side) => ({ local: { x: side * 0.45, y: 0.12, z: 5.5 }, radius: 0.04 })),
    rate: [8, 8],
    exit: [0.5, 0.5],
    tone: [0.1, 0.1],
    surgeTone: 0,
    life: [2.5, 4],
    idleOnly: true,
  },
};

// Opacity of a fresh smoke puff by its tone: an idling engine's light haze is barely there, a
// loaded diesel's soot is dense (the particle shader thins it as the puff spreads).
export const SMOKE_OPACITY = [0.025, 0.9] as const;

export function smokePuffOpacity(tone: number): number {
  return SMOKE_OPACITY[0] + (SMOKE_OPACITY[1] - SMOKE_OPACITY[0]) * clamp01(tone);
}

export interface StackOutput {
  rate: number; // puffs/s
  exit: number; // m/s
  tone: number; // 0..1
  life: number; // × the profile's life
  size: number; // × the outlet's radius, the puffs' starting radius
}

const MAX_PUFFS = 80; // per second per stack
const PUFF_SPACING = 0.7; // × the puffs' mean starting radius: each point of the plume is in ~3 puffs

const tel = (t: Readonly<Record<string, number>>, key: string): number => t[key] ?? 0;

// Outboard idle wisp: full at idle rpm and standing still, gone by ~1,500 rpm or 3 m/s.
export function idleWisp(rpm: number, idleRpm: number, speed: number): number {
  const idle = clamp01(1 - (rpm - idleRpm) / Math.max(1500 - idleRpm, 1));
  return rpm > 50 ? idle * clamp01(1 - speed / 3) : 0;
}

// Smoothed engine load and the surge after it rises (dimensionless, decays over a few seconds).
export class LoadTracker {
  load = -1;
  surge = 0;

  update(load: number, dt: number): void {
    if (this.load < 0 || dt <= 0) {
      this.load = load;
      return;
    }
    const previous = this.load;
    this.load += (load - this.load) * Math.min(1, dt / 1.5);
    const rise = Math.max(0, this.load - previous) / dt; // load fraction per second
    this.surge = Math.min(1, this.surge * Math.exp(-dt / 6) + rise * dt * 4);
  }
}

// One stack's smoke at a smoothed load and surge, in an apparent wind (m/s, the air past the
// stack); idle (0..1) scales the outboards' wisp. Puffs are spaced by the distance the gas travels
// between them, PUFF_SPACING × their radius, so the plume is continuous at any wind. A stronger
// wind mixes the gas into more air at once (bigger, thinner puffs) and tears the plume apart
// sooner, so a gale's plume is a low, short smear.
export function stackOutput(
  profile: SmokeProfile,
  stack: SmokeStack,
  load: number,
  surge: number,
  idle = 1,
  apparentWind = 0,
): StackOutput {
  const l = stack.aux ? 0.3 : clamp01(load);
  const s = stack.aux ? 0 : clamp01(surge);
  const lerp = (range: readonly [number, number]): number => range[0] + (range[1] - range[0]) * l;
  const visible = profile.idleOnly ? idle : 1;
  const wind = Math.max(apparentWind, 0);
  const exit = lerp(profile.exit);
  const size = 1 + Math.min(wind / 25, 4);
  const travel = Math.hypot(wind, 0.5 * exit); // m/s, the gas leaving the stack (its jet soon slows)
  const spaced = travel / (PUFF_SPACING * 1.2 * size * stack.radius);
  // (The outboards' idle wisp stays a few separate puffs.)
  const continuous = profile.idleOnly ? 0 : Math.min(spaced, MAX_PUFFS);
  const rate = Math.max(lerp(profile.rate) * (stack.aux ? 0.6 : 1 + s), continuous);
  return {
    rate: rate * visible,
    exit,
    tone: clamp01(lerp(profile.tone) + profile.surgeTone * s),
    // An idling engine's thin exhaust is gone within a few seconds.
    life: Math.min(1, Math.max(0.35, 25 / (wind + 10))) * (0.4 + 0.6 * l),
    size,
  };
}

const q = new Quaternion();
const up = new Vector3();
const outlet = new Vector3();
// Per-engine telemetry keys (no strings built per frame).
const ENGINE_LOAD = Array.from({ length: 8 }, (_, i) => `eng${i}Load`);
const ENGINE_RPM = Array.from({ length: 8 }, (_, i) => `eng${i}Rpm`);
// The puff request, filled in per stack (the queue copies it on spawn).
const puffPath = { x: 0, y: 0, z: 0 };
const puffPosition = { x: 0, y: 0, z: 0 };
const puffVelocity = { x: 0, y: 0, z: 0 };
const puffSize: [number, number] = [0, 0];
const puffLife: [number, number] = [0, 0];
const puff: SpawnRequest = {
  kind: 'smoke',
  count: 0,
  position: puffPosition,
  positionRadius: 0,
  positionLine: puffPath,
  velocity: puffVelocity,
  velocitySpread: 0,
  size: puffSize,
  life: puffLife,
  drag: 0,
  tone: 0,
};

// One boat's exhaust.
export class ExhaustSmoke {
  private loads: LoadTracker[] = [];
  private carries: RateCarry[] = [];

  // wind: the air at 10 m (m/s, world).
  update(particles: ParticleSystem, boat: BoatSnapshot, wind: Vec3Like, dt: number, scale: number): void {
    const profile = SMOKE_PROFILES[boat.kind];
    if (!profile || dt <= 0 || tel(boat.telemetry, 'sunk') > 0.5) return;
    const t = boat.telemetry;
    const o = boat.orientation;
    q.set(o.x, o.y, o.z, o.w);
    up.set(0, 1, 0).applyQuaternion(q);
    const v = boat.velocity;
    const speed = t['speedThroughWater'] ?? Math.hypot(v.x, v.z);
    for (let i = 0; i < profile.stacks.length; i++) {
      const stack = profile.stacks[i]!;
      // Ships report one load; the outboards one per engine.
      const load = profile.idleOnly ? tel(t, ENGINE_LOAD[i] ?? `eng${i}Load`) : tel(t, 'load');
      const tracker = (this.loads[i] ??= new LoadTracker());
      tracker.update(load, dt);
      const idle = profile.idleOnly ? idleWisp(tel(t, ENGINE_RPM[i] ?? `eng${i}Rpm`), IDLE_RPM, speed) : 1;
      // The air past the stack: the wind at its height (the particles' log profile) less the boat's
      // own motion.
      const height = Math.max(stack.local.y, 0.05);
      const profileAt = Math.min(1.25, Math.max(0.35, Math.log(height / WIND_Z0) / Math.log(10 / WIND_Z0)));
      const ax = wind.x * profileAt - v.x;
      const az = wind.z * profileAt - v.z;
      const out = stackOutput(profile, stack, tracker.load, tracker.surge, idle, Math.hypot(ax, az));
      // The quality scale only thins a plume that has puffs to spare.
      const rate = Math.max(out.rate * scale, Math.min(out.rate, MAX_PUFFS / 2));
      const count = (this.carries[i] ??= new RateCarry()).take(rate, dt);
      if (count <= 0) continue;
      outlet.set(stack.local.x, stack.local.y, stack.local.z).applyQuaternion(q);
      const ex = up.x * out.exit;
      const ey = up.y * out.exit;
      const ez = up.z * out.exit;
      // Spread along the path the gas has taken since the last puff (out of the stack, then off on
      // the apparent wind), so the plume is continuous at any rate rather than a string of beads.
      const half = 0.5 * Math.min(1 / Math.max(rate, 1e-3), 0.5);
      const path = puffPath;
      path.x = (ex + ax) * half;
      path.y = ey * half;
      path.z = (ez + az) * half;
      puffPosition.x = boat.position.x + outlet.x + path.x;
      puffPosition.y = boat.position.y + outlet.y + path.y;
      puffPosition.z = boat.position.z + outlet.z + path.z;
      puffVelocity.x = v.x + ex;
      puffVelocity.y = v.y + ey;
      puffVelocity.z = v.z + ez;
      puffSize[0] = stack.radius * out.size;
      puffSize[1] = stack.radius * out.size * 1.4;
      puffLife[0] = profile.life[0] * out.life;
      puffLife[1] = profile.life[1] * out.life;
      puff.count = count;
      puff.positionRadius = stack.radius * 0.5;
      puff.velocitySpread = 0.1 * out.exit + 0.2;
      puff.drag = stack.radius; // smoke: the source radius (sets how fast the puff spreads and thins)
      puff.tone = out.tone;
      particles.spawn(puff);
    }
  }
}

// Outboard idle, crank rpm (driveConfig: idle ~650 rpm at the crank).
const IDLE_RPM = 650;
const WIND_Z0 = 0.002; // m, sea-surface roughness (as the particles' wind profile)
