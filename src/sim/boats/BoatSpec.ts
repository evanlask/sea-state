// Typed per-boat specification: real-world dimensions and masses, the
// parametric hull, deck volumes, appendage foils, windage, added mass and
// damping, plus the propulsion targets the drive train is sized to.
//
// Value tags in the spec files: [V] verified against a dataset/code,
// [K] known published figure not re-checked, [E] engineering estimate.
// Body frame: x starboard, y up (0 = design waterline), z aft (bow = −Z).

import type { Vec3 } from '../core/math';
import type { HeavePitchDampingSpec, RollDampingSpec } from '../physics/damping';
import type { FoilSpec } from '../physics/foils';
import type { HullParams, OpenVolumeSpec, SuperstructureSpec } from '../physics/hull/types';
import type { HydroAeroSpec } from '../physics/hydroAero';
import type { KernerParams } from '../physics/kerner';
import type { CarveSpec } from '../physics/planingCarve';
import type { SlipSpec } from '../physics/planingSlip';
import type { FinStabilizerSpec } from '../physics/propulsion/finStabilizers';
import type { AddedMassRatios, RadiiOfGyration } from '../physics/RigidBody';
import type { WindageSpec } from '../physics/windage';
import type { BoatKind } from '../world/protocol';

interface BoatDimensions {
  loa: number; // length overall, m
  lwl: number; // waterline length (Lpp for ships), m
  beam: number; // maximum beam, m
  draft: number; // design draft of the canoe body / hull, m
  overallDraft: number; // including keel / rudder / propeller, m
  depth: number; // keel to deck edge amidships, m
}

// A departure from the design condition (sim/boats/loading.ts applies it): the load is placed over
// the centre of buoyancy, so it changes mass, KG, draft and windage but not trim.
export interface LoadingCondition {
  name: string;
  extraMass: number; // kg added to the design condition (negative: taken off)
  extraMassHeight: number; // m above the design waterline (centre of the added load)
  extraLateralArea?: number; // m² of extra windage (e.g. stacked pots)
}

// Crab pots stacked on the working deck in tiers, filled from the deck up (the model's layout).
export interface PotStackSpec {
  potMass: number; // kg per pot
  perTier: number; // pots in one full tier
  tierHeight: number; // m
  deckHeight: number; // m, deck above the design waterline
  bulwark: number; // m, stack hidden from the wind below this
  length: number; // m, fore-and-aft length of the stack (windage)
  solidity: number; // 0..1, share of the stack's side area that catches the wind
  maxPots: number;
}

// Targets the calibrated drive train must hit (see driveConfig.ts).
interface PropulsionSpec {
  type: 'fppDiesel' | 'azipodDieselElectric' | 'outboards' | 'jet' | 'turbine' | 'sail';
  power: number; // W total (0 for the sailboat)
  units: number;
  propellerDiameter?: number; // m
  topSpeed: number; // m/s target
  serviceSpeed?: number; // m/s
  steeringMaxAngle?: number; // rad (rudder, pod or nozzle)
  steeringRate?: number; // rad/s in realistic mode
  bowThrusterPower?: number; // W
  notes?: string;
}

// Downflooding: openings (doors, vents, companionways, engine intakes) that let
// water into an internal compartment once they go under.
export interface OpeningSpec {
  name: string;
  position: Vec3; // body frame
  area: number; // m²
  compartment: number; // index into compartments
  // A weathertight door or hatch, dogged shut at sea: not a downflooding point for the intact
  // stability criteria (IMO IS Code), and under water it only weeps (flooding.ts WEATHERTIGHT_LEAK).
  weathertight?: boolean;
  // Share of the area that floods under water (default 1): a vent through a baffled duct into a closed
  // compartment, whose air can only get out against the water coming in, takes a fraction of it.
  inflow?: number;
}

// A sit-on craft's rider. He is part of the spec's mass, CG and gyration while aboard; a capsize
// throws him off (sim/world/WorldBoat.ts), and the craft loses his weight, high up, and his balance,
// and the kill-switch lanyard on his wrist stops the engine. Recover puts him back.
interface RiderSpec {
  mass: number; // kg
  position: Vec3; // his CG seated, body frame
  gyration: number; // m, his own radius of gyration about his CG
  // His share of the windage areas (WindageSpec), m², centred this high above the waterline, m.
  lateralArea: number;
  frontalArea: number;
  windageHeight: number;
}

export interface CompartmentSpec {
  name: string;
  x?: number;
  z: number; // centre, body frame
  length: number;
  width: number;
  floorY: number; // body y of the floor (tank top)
  height: number;
  permeability?: number; // floodable fraction, default 0.85
  pumpRate?: number; // bilge pumps, m³/s, default 0
}

export interface BoatSpec {
  kind: BoatKind;
  name: string; // fictional
  modelledOn: string;
  dimensions: BoatDimensions;
  mass: number; // kg, design condition (lightship + design load)
  gmTarget: number; // m; KG is solved from this at the design draft
  gyration: RadiiOfGyration; // dry radii of gyration, m
  addedMass: AddedMassRatios;
  hull: HullParams;
  superstructures: SuperstructureSpec[];
  openVolumes: OpenVolumeSpec[];
  foils: FoilSpec[];
  windage: WindageSpec;
  rollDamping: RollDampingSpec;
  heavePitchDamping?: HeavePitchDampingSpec;
  carve?: CarveSpec; // planing V-hulls: banking into a turn (physics/planingCarve.ts)
  slip?: SlipSpec; // planing V-hulls: the drag of sliding in a turn (physics/planingSlip.ts)
  finStabilizers?: FinStabilizerSpec; // active roll fins (physics/propulsion/finStabilizers.ts)
  aero?: HydroAeroSpec; // a hydroplane's lifting hull and wing (physics/hydroAero.ts)
  openings?: OpeningSpec[];
  compartments?: CompartmentSpec[];
  rider?: RiderSpec;
  kerner: KernerParams;
  substeps: number; // per 120 Hz master step
  helmEye: Vec3; // body frame
  propulsion: PropulsionSpec;
  loadingConditions?: LoadingCondition[]; // named alternatives to the design condition
  potStack?: PotStackSpec; // crab boat: the pot load is a count (sim/boats/loading.ts)
}
