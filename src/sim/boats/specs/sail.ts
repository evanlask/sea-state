// 38 ft cruiser-racer modelled on the C&C 115, fictional name. No engine.

import { DEG } from '../../core/conventions';
import { knotsToMs } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 11.5; // [V]
const LWL = 10.0; // [E]
const B = 3.65; // [V]
const T_CANOE = 0.5; // [E] canoe-body draft
const D = 1.45; // [E] canoe bottom to sheer amidships

export const sailSpec: BoatSpec = {
  kind: 'sail',
  name: 'Kittiwake',
  modelledOn: 'C&C 115 cruiser-racer',
  dimensions: { loa: LOA, lwl: LWL, beam: B, draft: T_CANOE, overallDraft: 2.0, depth: D }, // draft 2.0 [V]
  mass: 5572, // [V]; the canoe body is sized to displace all of it (fin buoyancy ignored)
  gmTarget: 1.9, // [E] GZ ≈ 0.40 m at 10°, YD-41-like curve [V shape]
  gyration: { roll: 1.55, pitch: 0.25 * LOA, yaw: 0.25 * LOA }, // [E] rig raises k_xx
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'sailing',
    lwl: LWL,
    beamWaterline: 3.25, // [E]
    beamDeck: B,
    draft: T_CANOE,
    depth: D,
    midshipCoefficient: 0.72, // [E] shallow U/V body
    endSectionExponent: 1.3,
    parallelMidbodyForward: 0,
    parallelMidbodyAft: 0,
    entranceExponent: 2, // solved
    runExponentRatio: 1.4, // [E] broad modern stern
    deckFullness: 1.4,
    bowOverhang: 0.9, // [E]
    sternOverhang: 0.6, // [E]
    forefootLength: 0.35, // [E] rocker
    runLength: 0.45,
    transomKeelHeight: T_CANOE + 0.12, // [E] transom just clear of the water
    transomBeamRatio: 0.8,
    keelDrag: 0,
    sheerBow: 0.25,
    sheerStern: 0,
    flareExponent: 1.3,
    girthBelow: 5,
    girthAbove: 3,
  },
  superstructures: [
    { name: 'cabin trunk', z: -0.6, length: 4.5, width: 2.3, height: 0.45, topWidth: 2.0, topLength: 4.2 }, // [E]
  ],
  openVolumes: [
    { name: 'cockpit', z: 3.0, length: 2.4, width: 2.2, depth: 0.45, recessed: true, drainArea: 0.02 }, // [E]
  ],
  foils: [
    {
      name: 'fin keel',
      kind: 'keel',
      centre: { x: 0, y: -1.15, z: -0.3 }, // [E] quarter chord, mid span
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 1.45, // [E] canoe bottom (−0.5) to the bulb (−2.0)
      area: 1.5, // [E]
      effectiveAspectRatio: 2.8, // [E] hull end plate + bulb
      stallAngle: 30 * DEG,
      ballast: { mass: 2100, centre: { x: 0, y: -1.85, z: -0.2 } }, // [K] lead bulb
    },
    {
      name: 'spade rudder',
      kind: 'rudder',
      centre: { x: 0, y: -0.95, z: 4.1 }, // [E]
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 1.4, // [E]
      area: 0.62, // [E]
      effectiveAspectRatio: 4.5,
      stallAngle: 32 * DEG,
      maxDeflection: 35 * DEG,
    },
  ],
  windage: {
    type: 'speedBoat', // [E] closest Blendermann class for hull + bare rig
    lateralArea: 16.5, // [E] hull, cabin, mast
    frontalArea: 5, // [E]
    length: LOA,
    lateralCentreHeight: 2.5, // [E]
    lateralCentreForward: 0.3,
    frontalCentreHeight: 2.0,
  },
  rollDamping: { zeta: 0.03 }, // [E] the keel foil adds its own
  heavePitchDamping: { heave: 0.12, pitch: 0.12 }, // [E] the low-drag canoe body needs it
  openings: [
    { name: 'companionway', position: { x: 0, y: 1.05, z: 1.6 }, area: 0.35, compartment: 0 }, // [E] washboards out
  ],
  compartments: [
    { name: 'saloon', z: -0.5, length: 6.5, width: 3.0, floorY: -0.35, height: 1.7, pumpRate: 0.002 }, // [E]
  ],
  kerner: {
    referenceSpeed: knotsToMs(7.5),
    // Calibrated: the canoe body's pressure drag stays below the ITTC/DSYHS target,
    // the residual table supplies the wave-making rise toward hull speed.
    pressureDragLinear: 0.02,
    pressureDragQuadratic: 0.05,
    pressureFalloff: 1,
    suctionDragLinear: 0.01,
    suctionDragQuadratic: 0.02,
    suctionFalloff: 1,
    slamGammaMax: 40,
    slamExponent: 2,
    slamStopTime: 0.6,
    waterlineLength: LWL,
    frictionFormFactor: 1.08,
    airDragCoefficient: 0,
    horizontalVelocityTerms: true,
  },
  substeps: 2,
  helmEye: { x: 0, y: 2.2, z: -LWL / 2 - 0.9 + 9.5 }, // [E]
  propulsion: {
    type: 'sail',
    power: 0,
    units: 0,
    topSpeed: knotsToMs(9), // [E] hull speed region
    steeringMaxAngle: 35 * DEG,
    steeringRate: 30 * DEG,
    notes: 'Main 45.97 m², genoa 38.09 m² [V]; I/J/P/E ≈ 15.0/4.5/14.3/5.0 m [E]; ORC polar targets [V]',
  },
};
