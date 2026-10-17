// Messages between the main thread and the simulation (worker or in-thread).
// Everything here must be structured-clone friendly.
import type { Quat, Vec3 } from '../core/math';
import type { CascadeKind, OceanQuality, VisualDetail } from '../ocean/cascades';
import type { SeaStateSettings } from '../weather/seaState';

export type BoatKind = 'cargo' | 'cruise' | 'crab' | 'sail' | 'powerboat' | 'pwc' | 'hydro';

// Smallest to largest (overall length): the order the setup cards, the fleet list and Help use.
export const BOAT_KINDS: readonly BoatKind[] = [
  'pwc',
  'hydro',
  'powerboat',
  'sail',
  'crab',
  'cargo',
  'cruise',
];

export type PhysicsMode = 'arcade' | 'realistic';

// Continuous helm commands, normalized. Each boat class reads the ones it uses.
export interface BoatControls {
  throttle: number; // -1..1: throttle, or the ship's telegraph lever
  steer: number; // -1 hard to port .. 1 hard to starboard
  thruster: number; // -1..1 bow thruster (ships)
  trim: number; // -1..1 outboard trim rate (center console)
  mainSheet: number; // -1 ease .. 1 trim, as a rate (sailboat)
  jibSheet: number; // -1 ease .. 1 trim, as a rate (sailboat)
  brake: boolean; // reverse bucket / all stop
  letFly: boolean; // sailboat: both sheets let run while held (auto-trim takes them back after)
}

export const neutralControls = (): BoatControls => ({
  throttle: 0,
  steer: 0,
  thruster: 0,
  trim: 0,
  mainSheet: 0,
  jibSheet: 0,
  brake: false,
  letFly: false,
});

// Fleet autopilots for boats nobody is helming (sim/world/autopilot.ts).
type AutopilotMode = 'drift' | 'hold' | 'follow' | 'circle' | 'windAngle';

export interface AutopilotSetting {
  mode: AutopilotMode;
  heading?: number; // hold: rad (default: the heading when engaged)
  speed?: number; // hold / follow cap: m/s (default: service speed)
  targetId?: string; // follow: boat to keep station on (default: the helm boat)
  offsetForward?: number; // follow: station ahead (+) / astern (−) of the target, m
  offsetStarboard?: number; // follow: station to starboard (+) / port (−) of the target, m
  // windAngle (sailboat): true wind angle to hold, rad, + wind from starboard (default: the angle when
  // engaged), kept between 40° and 170° on its tack. Engaging it turns the boat's auto-trim on.
  twa?: number;
}

// One-off actions.
export type SimCommand =
  | { type: 'recover'; boatId: string }
  | { type: 'reef'; boatId: string; delta: 1 | -1 }
  | { type: 'furl'; boatId: string }
  | { type: 'autoTrim'; boatId: string; enabled: boolean }
  | { type: 'setPhysicsMode'; mode: PhysicsMode }
  | { type: 'setCapsizeAssist'; enabled: boolean }
  | { type: 'setAutopilot'; boatId: string; autopilot: AutopilotSetting | null }
  // Live weather change: the wind blends to the new one over windTransition (s) and the sea
  // follows over seaTransition, keeping the seed's phases (a new SpectrumMessage, version + 1).
  | {
      type: 'setConditions';
      wind: WindConfig;
      seaState: SeaStateSettings;
      windTransition: number;
      seaTransition: number;
    }
  // Fleet changes mid-voyage. A spawned boat keeps station where it was placed on its leader
  // (default: the helm boat, i.e. the one the advance request has controls for). Boats following a
  // removed boat re-target the helm boat from where they are, or hold their course.
  | { type: 'spawnBoat'; spawn: BoatSpawn; leaderId?: string }
  | { type: 'removeBoat'; boatId: string };

export interface BoatSpawn {
  id: string;
  kind: BoatKind;
  x: number;
  z: number;
  heading: number;
  load?: BoatLoad; // loading condition (default: the design condition)
  speed?: number; // m/s ahead at spawn with the engines stopped (default 0: dead in the water)
  sail?: SailSetup; // sailboat: sails as set at spawn (default: full sail, sheets at 20°)
}

// A sailboat's sails at spawn: reef (0–3) and genoa furl (0 set .. 1 rolled away) already in, the
// sheets eased to these limits (rad off the centreline) with the sails out to leeward of the true wind.
export interface SailSetup {
  reef: number;
  furl: number;
  mainSheet: number;
  jibSheet: number;
}

// The setup screen's loading choices; each boat reads the one that applies to it
// (sim/boats/loading.ts).
export interface BoatLoad {
  cargo?: 'laden' | 'ballast'; // container ship
  crabPots?: number; // crab boat, 0–200 pots on deck (0 = an empty deck)
}

export interface WindConfig {
  speed: number; // m/s at 10 m
  from: number; // radians, meteorological
  gustFactor: number; // peak gust / mean, 1 = steady
}

export interface SimConfig {
  seed: number;
  physicsMode: PhysicsMode;
  boats: BoatSpawn[];
  wind: WindConfig;
  seaState: SeaStateSettings;
  oceanQuality: OceanQuality | VisualDetail; // which GPU-only detail cascades to build h0 for
  capsizeAssist?: boolean; // gentle righting aid, default off
  wakes?: boolean; // per-boat eWave wakes (sim/world/wakes.ts), default on
}

export interface BoatSnapshot {
  id: string;
  kind: BoatKind;
  position: Vec3; // the body origin: centreline, design waterline, amidships
  orientation: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  // Instrument readings for the HUD and audio; keys are documented in sim/world/telemetry.ts.
  telemetry: Record<string, number>;
}

// slam.strength is the impact speed of the slamming hull faces, m/s (the spray system's scale).
// collision: two hulls struck each other at (x, y, z) (world, waterline) with the normal impulse
// (N·s) and closing speed (m/s); one event per pair per impact (sim/world/collisions.ts).
export type SimEvent =
  | { type: 'slam'; boatId: string; x: number; y: number; z: number; strength: number }
  | {
      type: 'collision';
      boatId: string;
      otherId: string;
      x: number;
      y: number;
      z: number;
      impulse: number;
      speed: number;
    }
  | { type: 'capsized'; boatId: string }
  | { type: 'sunk'; boatId: string }
  | { type: 'recovered'; boatId: string };

// Each probe answers height, normal x, normal z, and vertical water velocity.
export const PROBE_STRIDE = 4;

export interface AdvanceRequest {
  type: 'advance';
  targetTime: number;
  controls: Record<string, BoatControls>;
  commands: SimCommand[];
  probes: Float64Array; // x, z pairs in world metres
  // Wake-grid buffers the renderer has copied (WakeGrid.height), sent back for reuse.
  spent?: ArrayBuffer[];
}

interface InitRequest {
  type: 'init';
  config: SimConfig;
}

export type MainToSim = InitRequest | AdvanceRequest;

export interface Snapshot {
  type: 'snapshot';
  time: number;
  boats: BoatSnapshot[];
  probes: Float32Array;
  events: SimEvent[];
  stepMs: number; // CPU time spent stepping for this request
  steps: number;
  wakes?: WakeGrid[]; // grids updated since the previous snapshot (sim/world/wakes.ts)
  wakeMs?: number; // smoothed CPU per wake update, all grids
}

// One boat's eWave wake at `time`: η_w (m) on an n×n grid of `cell` m, row-major (row ↔ z), texel
// (c, r) centred at (minX + (c + ½)·cell, minZ + (r + ½)·cell). The wake moves with the boat, so a
// renderer at another time translates it by (vx, vz)·Δt. An empty `height` clears the boat's grid.
export interface WakeGrid {
  boatId: string;
  time: number;
  minX: number;
  minZ: number;
  cell: number;
  n: number;
  vx: number;
  vz: number;
  height: Float32Array;
}

// One cascade's initial amplitudes, in the layout documented in sim/ocean/h0.ts.
export interface CascadeData {
  index: number;
  kind: CascadeKind;
  size: number; // patch length L, m
  resolution: number; // N
  h0: Float32Array; // N×N×4
  choppiness: number;
}

// The ocean spectrum both sides evolve. Sent at start-up and after each weather change; the GPU blends
// from the previous spectrum over the transition exactly as the CPU does (sim/ocean/CpuOcean
// setSpectra: an unfinished transition is frozen at activationTime and becomes the new start).
// activationTime is a little ahead of the sim time that made it, so the renderer, which draws
// behind the simulation, always receives it before its render time reaches it.
export interface SpectrumMessage {
  type: 'spectrum';
  version: number;
  activationTime: number; // simTime the transition starts
  transitionDuration: number; // s
  cascades: CascadeData[];
  significantHeight: number; // total Hs, m
  peakPeriod: number; // wind sea Tp, s
  douglas: number;
  // The mean wind this sea was built for. Whitecaps, streaks and spume follow it through the sea's
  // crossfade (in simulation time), so the foam never runs ahead of the waves.
  wind: WindConfig;
}

interface ReadyMessage {
  type: 'ready';
  time: number;
}

interface ErrorMessage {
  type: 'error';
  message: string;
}

export type SimToMain = Snapshot | ReadyMessage | SpectrumMessage | ErrorMessage;
