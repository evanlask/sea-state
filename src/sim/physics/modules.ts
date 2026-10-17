// Pluggable force modules: everything that pushes on a boat besides the hull's
// water forces (propellers, rudders, pods, outboards, jet drives, thrusters,
// sails, keels) implements this so each boat assembles its own drive train and
// the world steps them uniformly every substep.

import type { BoatControls, PhysicsMode, SimCommand } from '../world/protocol';
import type { KernerResult } from './kerner';
import type { RigidBody } from './RigidBody';
import type { PhysicsTuning } from './tuning';
import type { WaterSampler } from './water';
import type { WindSampler } from './windage';

export interface ForceContext {
  body: RigidBody;
  water: WaterSampler; // the ocean (plus other boats' wakes) at any world point
  wind: WindSampler; // air velocity at any world point, sheared with height
  time: number; // simulation seconds
  dt: number; // this substep, s
  controls: BoatControls; // the helm, already shaped by the input layer
  physicsMode: PhysicsMode;
  // Arcade/Realistic details. Modules that make control or resistance forces
  // multiply their horizontal part by tuning.timeCompression (see tuning.ts,
  // addCompressedForce). Absent means Realistic, k = 1.
  tuning?: PhysicsTuning;
  // This substep's hull loads (wetted area, immersion), computed before the modules run.
  hull?: KernerResult;
}

export interface ForceModule {
  // Adds this module's forces and torques to ctx.body for one substep.
  apply(ctx: ForceContext): void;
  // HUD/audio readouts. Keys are module-specific; each module documents its own.
  writeTelemetry(out: Record<string, number>): void;
  // One-off commands (reef, furl, auto-trim, …). Returns true when handled.
  command?(command: SimCommand): boolean;
  // Back to a calm initial state, e.g. after a recover.
  reset?(): void;
  // Start as if the engines had long been running at this order (spawning under way).
  prime?(order: number): void;
  // A sit-on craft's rider thrown off (false) or back aboard (true): BoatDynamics.setRiderAboard.
  setRider?(aboard: boolean): void;
  // The engine's kill switch thrown (true) after a capsize, with the driver still aboard (a
  // hydroplane's capsule): the engine stops until Recover resets the module (reset() clears it).
  setKillSwitch?(killed: boolean): void;
  // Water (or other loose mass) the module currently carries, kg. The boat
  // adds it to its mass for the translational inertia; the module applies
  // the weight itself, where the water actually lies.
  readonly carriedMass?: number;
}
