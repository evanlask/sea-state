// 33 ft center console with twin 300 hp outboards, fictional name.

import { DEG } from '../../core/conventions';
import { knotsToMs } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 10.1; // [E]
const B = 3.2; // [E]
const T = 0.65; // [E] hull draft at rest (engines up), keel at the transom
const D = 1.55; // [E] keel to sheer at the transom

export const powerboatSpec: BoatSpec = {
  kind: 'powerboat',
  name: 'Tidewater 33',
  modelledOn: '33 ft center console, twin 300 hp outboards',
  dimensions: { loa: LOA, lwl: 8.8, beam: B, draft: T, overallDraft: 0.95, depth: D }, // LWL [E]
  mass: 6000, // [E] wet, with crew
  gmTarget: 1.0, // [E]
  gyration: { roll: 0.38 * B, pitch: 0.25 * LOA, yaw: 0.26 * LOA }, // [E]
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'planing',
    length: LOA,
    chineBeam: 2.9, // [E]
    beamDeck: B,
    draft: T,
    depth: D,
    deadrise: 22 * DEG, // [E]
    deadriseBow: 48 * DEG, // [E] fine entry
    maxChineStation: 0.35,
    keelRiseStart: 0.42,
    transomChineRatio: 0.92,
    transomDeckRatio: 0.9,
    entranceExponent: 1.6, // solved
    deckFullness: 1.0,
    sheerBow: 0.55, // [E]
    flareExponent: 1.5,
  },
  superstructures: [
    { name: 'console', z: -0.4, length: 1.4, width: 1.3, height: 1.1 }, // [E]
  ],
  openVolumes: [
    { name: 'cockpit', z: 2.2, length: 4.5, width: 2.8, depth: 0.6, recessed: true, drainArea: 0.03 }, // [E]
    // [E] The bow seating well ahead of the console, inside the bow coaming: a bow buried in the back of
    // a sea fills it (green water on the foredeck), and its weight holds the bow down.
    { name: 'bow well', z: -2.3, length: 2.2, width: 1.5, depth: 0.5, recessed: true, drainArea: 0.01 },
  ],
  // The outboard lower units are the steered fins (with the propulsion). The canoe mesh has
  // no keel or lifting strakes and, planing, its side force acts ahead of the CG, so without
  // this lateral plane aft a hard-over turn at speed spins the boat out. [E] Its skin
  // friction is already in the hull's, hence no zero-lift drag.
  foils: [
    {
      name: 'keel and strakes',
      kind: 'skeg',
      centre: { x: 0, y: -0.55, z: 3.5 },
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.15,
      area: 1.2,
      effectiveAspectRatio: 0.5,
      stallAngle: 35 * DEG,
      zeroLiftDrag: 0,
    },
  ],
  windage: {
    type: 'speedBoat',
    lateralArea: 16, // [E] hull, console, T-top
    frontalArea: 5, // [E]
    length: LOA,
    lateralCentreHeight: 0.9, // [E]
    lateralCentreForward: 0.3,
    frontalCentreHeight: 1.0,
  },
  rollDamping: { zeta: 0.05 }, // [E] chines
  // [E] Deep-V center consoles bank into a hard turn by ~5–15° (physics/planingCarve.ts).
  carve: {
    maxBank: 12 * DEG,
    stiffness: 0.08,
    damping: 1.2,
    maxMoment: 60000,
    beam: 2.9,
    planingSpeed: [4, 12],
    onWater: true, // it planes on the sea, not the horizon (planingCarve.ts)
  },
  // [E] Sliding in a hard-over turn (physics/planingSlip.ts), as the jet ski but milder: the
  // lateral plane keeps the drift to ~15°. Planing from Fn_∇ ≈ 3 (~12 m/s).
  slip: { coefficient: 0.25, planingSpeed: [12, 26] },
  openings: [
    { name: 'console door', position: { x: 0, y: 1.35, z: -0.1 }, area: 0.3, compartment: 0 }, // [E]
  ],
  compartments: [
    { name: 'bilge and console', z: 0.5, length: 6, width: 2.4, floorY: -0.45, height: 1.2, pumpRate: 0.004 }, // [E]
  ],
  kerner: {
    referenceSpeed: 12,
    pressureDragLinear: 0.15, // [E] calibrated to Savitsky
    pressureDragQuadratic: 0.5,
    pressureFalloff: 1.0,
    suctionDragLinear: 0.02, // [E] trailing faces and the transom ventilate at speed
    suctionDragQuadratic: 0.04,
    suctionFalloff: 1.0,
    slamGammaMax: 60,
    slamExponent: 2,
    slamStopTime: 0.5,
    waterlineLength: 8.8,
    frictionFormFactor: 1.0,
    crossFlowDrag: 0.5, // [E] sliding V-bottom, on top of the panels' own normal force
    crossFlowRollSpeed: [4, 12], // off the plane the cross-flow trips the hull at its lee chine (as the carve)
    airDragCoefficient: 0,
    horizontalVelocityTerms: true,
  },
  substeps: 4,
  helmEye: { x: 0, y: 2.5, z: -LOA / 2 + 4.8 }, // [E]
  propulsion: {
    type: 'outboards',
    power: 2 * 224e3, // [E] 2 × 300 hp
    units: 2,
    topSpeed: knotsToMs(47), // [E]
    steeringMaxAngle: 30 * DEG, // [E]
    steeringRate: 60 * DEG,
    notes: 'On plane in 3–5 s; 0–30 mph in 6–8 s [E]; outboard trim',
  },
};
