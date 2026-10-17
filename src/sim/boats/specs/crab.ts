// Bering Sea crab boat modelled on 125 ft crabbers (e.g. F/V Northwestern),
// fictional name.

import { DEG } from '../../core/conventions';
import { knotsToMs } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 38.1; // [V] 125 ft (F/V Northwestern, Wikipedia)
const LWL = 34; // [E]
const B = 8.8; // [V] 28.92 ft
const T = 4.0; // [V] 13 ft
const D = 5.0; // [E] keel to main deck amidships (1.0 m freeboard)

export const crabSpec: BoatSpec = {
  kind: 'crab',
  name: 'F/V Northern Reach',
  modelledOn: '125 ft Bering Sea crab boat',
  dimensions: { loa: LOA, lwl: LWL, beam: B, draft: T, overallDraft: T + 0.5, depth: D },
  mass: 700_000, // [E] departure condition without pots
  // [E] Departure with fuel full and the crab tanks flooded as ballast, as crabbers run out to the
  // grounds with their pots: a low KG (2.8 m), so that the default 120 pots still meet the
  // fishing-vessel criteria (IMO / 46 CFR 28.570: GM ≥ 0.35 m, GZ ≥ 0.2 m at 30°, areas to 30°/40°)
  // with GM ≈ 0.97 m and an AVS near 100°. A full 200 is an overload (GZ at 30° ≈ 0.15 m, AVS ≈ 50°).
  gmTarget: 1.2,
  gyration: { roll: 0.38 * B, pitch: 0.25 * LOA, yaw: 0.25 * LOA }, // [E]
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'fishing',
    lwl: LWL,
    beamWaterline: 8.6, // [E]
    beamDeck: B,
    draft: T,
    depth: D,
    midshipCoefficient: 0.85, // [E]
    endSectionExponent: 1.4, // [E]
    parallelMidbodyForward: 0.1,
    parallelMidbodyAft: 0.1,
    entranceExponent: 2, // solved
    runExponentRatio: 0.9,
    deckFullness: 1.0, // [E]
    bowOverhang: 3.1, // [E] raked stem
    sternOverhang: 1.0, // [E]
    forefootLength: 0.12, // [E]
    runLength: 0.3, // [E]
    transomKeelHeight: T - 0.3, // [E] slightly immersed transom
    transomBeamRatio: 0.75, // [E]
    keelDrag: 1.0, // [E] deeper aft
    sheerBow: 1.6, // [E] high bow
    sheerStern: 0.3,
    flareExponent: 1.8,
  },
  superstructures: [
    // [E] Only the closed whaleback/forecastle counts as buoyant: the house and
    // wheelhouse have doors and windows, and the AVS target is 60–80° [E].
    { name: 'whaleback', z: -13, length: 7, width: 6.5, height: 1.6 },
  ],
  openVolumes: [
    // [E] aft working deck inside 1.1 m bulwarks.
    // ICLL: 0.7 + 0.035·l m² of freeing ports per side. [E] Their non-return flaps, hinged at the top,
    // let a fifth of that back in when the sea stands higher outside.
    {
      name: 'deck well',
      z: 7,
      length: 20,
      width: 8.4,
      depth: 1.1,
      recessed: false,
      drainArea: 2.8,
      drainBackflow: 0.2,
    },
  ],
  foils: [
    {
      name: 'rudder',
      kind: 'rudder',
      centre: { x: 0, y: -2.7, z: LWL / 2 + 0.6 }, // [E]
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 2.6, // [E]
      area: 4.5, // [E]
      effectiveAspectRatio: 2.8,
      stallAngle: 35 * DEG,
      maxDeflection: 35 * DEG,
    },
    {
      name: 'keel skeg',
      kind: 'skeg',
      centre: { x: 0, y: -T - 0.2, z: 6 }, // [E] bar keel / skeg aft
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.5,
      area: 6, // [E]
      effectiveAspectRatio: 0.3,
      stallAngle: 40 * DEG,
    },
  ],
  windage: {
    type: 'fishingVessel',
    lateralArea: 225, // [E]
    frontalArea: 80, // [E]
    length: LOA,
    lateralCentreHeight: 3.5, // [E]
    lateralCentreForward: 4, // [E] house forward
    frontalCentreHeight: 4, // [E]
  },
  rollDamping: { zeta: 0.06 }, // [E] bilge keels
  heavePitchDamping: { heave: 0.15, pitch: 0.15 }, // [E]
  openings: [
    // [E] the house doors on the main deck (weathertight, dogged shut at sea: they only weep when a sea
    // buries them), and the engine-room vents, the real downflooding points.
    {
      name: 'house door (port)',
      position: { x: -2.5, y: 1.9, z: -4 },
      area: 1.4,
      compartment: 0,
      weathertight: true,
    },
    {
      name: 'house door (stbd)',
      position: { x: 2.5, y: 1.9, z: -4 },
      area: 1.4,
      compartment: 0,
      weathertight: true,
    },
    { name: 'engine room vent (port)', position: { x: -2, y: 4.2, z: 2 }, area: 0.4, compartment: 1 },
    { name: 'engine room vent (stbd)', position: { x: 2, y: 4.2, z: 2 }, area: 0.4, compartment: 1 },
  ],
  compartments: [
    { name: 'house and galley', z: -4, length: 9, width: 6, floorY: 1.0, height: 2.4, pumpRate: 0.01 }, // [E]
    { name: 'engine room', z: 2, length: 9, width: 7.5, floorY: -3.3, height: 4.2, pumpRate: 0.03 }, // [E]
  ],
  kerner: {
    referenceSpeed: knotsToMs(10.5),
    pressureDragLinear: 0.4,
    pressureDragQuadratic: 0.3,
    pressureFalloff: 0.5,
    suctionDragLinear: 0.2,
    suctionDragQuadratic: 0.2,
    suctionFalloff: 0.5,
    slamGammaMax: 30,
    slamExponent: 2,
    slamStopTime: 1,
    waterlineLength: LWL,
    frictionFormFactor: 1.2,
    airDragCoefficient: 0,
    horizontalVelocityTerms: false, // MMG (Kijima regressions)
  },
  substeps: 2,
  helmEye: { x: 0, y: 7.5, z: -LWL / 2 - 3.1 + 9 }, // [E] ~9 m aft of the bow
  propulsion: {
    type: 'fppDiesel',
    power: 950e3, // [V] Caterpillar 3512, 1,280 hp
    units: 1,
    propellerDiameter: 2.2, // [E]
    topSpeed: knotsToMs(12), // [V]
    serviceSpeed: knotsToMs(10.5), // [E]
    steeringMaxAngle: 35 * DEG,
    steeringRate: 4 * DEG, // [E]
    bowThrusterPower: 150e3, // [E] hydraulic
  },
  // [E] 7×7×3 ft pots at ~340 kg, 3 across × 8 along the working deck aft of the house, stacked as
  // high as the load needs (200 pots ≈ 9 tiers, taller than the wheelhouse as on real crabbers). The
  // design condition (mass above) carries none.
  potStack: {
    potMass: 340,
    perTier: 24,
    tierHeight: 0.924, // 3 ft pot + 1 cm
    deckHeight: D - T,
    bulwark: 1.1,
    length: 17.5,
    solidity: 0.7, // webbing several pots deep
    maxPots: 200,
  },
};
