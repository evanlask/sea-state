// Container ship modelled on the KRISO Container Ship (KCS, 3,600 TEU Panamax
// benchmark), fictional name. [V] values from the SIMMAN/KCS benchmark data.

import { DEG } from '../../core/conventions';
import { knotsToMs } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LPP = 230; // [V]
const LWL = 232.5; // [V]
const B = 32.2; // [V]
const T = 10.8; // [V]
const D = 19.0; // [V]

export const cargoSpec: BoatSpec = {
  kind: 'cargo',
  name: 'MV Meridian Trader',
  modelledOn: 'KCS 3,600 TEU Panamax container ship benchmark',
  dimensions: {
    loa: 243.5, // [E] LWL + overhangs
    lwl: LWL,
    beam: B,
    draft: T,
    overallDraft: T, // [V] propeller and rudder within the draft
    depth: D,
  },
  mass: 53_330_000, // [V] ∇ 52,030 m³ (Cb 0.651 on Lpp)
  gmTarget: 1.0, // [E] (KCS SIMMAN loading lists GM 0.60 m [K])
  gyration: {
    roll: 0.35 * B, // [E] 0.35 B (SIMMAN uses 0.40 B [K])
    pitch: 0.25 * LPP, // [K] 0.25 Lpp
    yaw: 0.25 * LPP, // [V] k_zz = 0.25 Lpp
  },
  // [V] ratios from KCS/S175 hydrodynamic data, rounded.
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 },
  hull: {
    family: 'ship',
    lwl: LWL,
    beamWaterline: B,
    beamDeck: B, // [V] wall-sided amidships
    draft: T,
    depth: D,
    midshipCoefficient: 0.985, // [V]
    endSectionExponent: 1.6, // [E]
    parallelMidbodyForward: 0.25, // [E]
    parallelMidbodyAft: 0.15, // [E]
    entranceExponent: 2.2, // solved from the displacement
    runExponentRatio: 0.8, // [E] finer run than entrance
    deckFullness: 2.5, // [E] strong bow flare
    bowOverhang: 5, // [E]
    sternOverhang: 6, // [E]
    forefootLength: 0.02, // [E] bulbous bow: keel runs almost to the stem
    runLength: 0.2, // [E]
    transomKeelHeight: T + 1.0, // [E] dry transom at the design draft
    transomBeamRatio: 0.65, // [E]
    keelDrag: 0, // [V] even keel
    sheerBow: 2.0, // [E]
    sheerStern: 0.5, // [E]
    flareExponent: 1.6, // [E]
    bulbRadius: 3.0, // [E]
  },
  superstructures: [
    // [E] accommodation block and bridge aft (eye ~35 m above WL, ~190 m aft of the bow).
    { name: 'deckhouse', z: 69, length: 18, width: 26, height: 22 },
    { name: 'forecastle', z: -112, length: 12, width: 20, height: 2.5 },
  ],
  openVolumes: [],
  foils: [
    {
      name: 'rudder',
      kind: 'rudder',
      centre: { x: 0, y: -5.4, z: LPP / 2 + 0.8 }, // [E] quarter chord, mid span, at the AP
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 9.9, // [K]
      area: 45, // [V] plan value
      effectiveAspectRatio: 3.6, // [E] hull end plate; with it the KCS turning circle comes out at ~3.3 L
      stallAngle: 35 * DEG,
      maxDeflection: 35 * DEG,
    },
  ],
  windage: {
    type: 'containerShipLoaded',
    lateralArea: 5800, // [E]
    frontalArea: 900, // [E]
    length: 243.5,
    lateralCentreHeight: 13, // [E] containers 6 high above an 8.2 m freeboard
    lateralCentreForward: -10, // [E] accommodation aft
    frontalCentreHeight: 15, // [E]
  },
  rollDamping: { zeta: 0.05 }, // [E] bilge keels
  heavePitchDamping: { heave: 0.2, pitch: 0.2 }, // [E] radiation damping the pressure model lacks
  openings: [
    // [E] engine-room ventilators on the deckhouse sides.
    { name: 'engine room vent (port)', position: { x: -13, y: 10.7, z: 78 }, area: 2, compartment: 0 },
    { name: 'engine room vent (stbd)', position: { x: 13, y: 10.7, z: 78 }, area: 2, compartment: 0 },
  ],
  compartments: [
    { name: 'engine room', z: 85, length: 30, width: 30, floorY: -9.3, height: 17, pumpRate: 0.3 }, // [E]
  ],
  kerner: {
    referenceSpeed: knotsToMs(24),
    pressureDragLinear: 0.4, // [E] calibrated
    pressureDragQuadratic: 0.3,
    pressureFalloff: 0.5,
    suctionDragLinear: 0.2,
    suctionDragQuadratic: 0.2,
    suctionFalloff: 0.5,
    slamGammaMax: 20,
    slamExponent: 2,
    slamStopTime: 2,
    waterlineLength: LWL,
    frictionFormFactor: 1.1, // [E] (1 + k) for a full hull
    airDragCoefficient: 0,
    horizontalVelocityTerms: false, // MMG model drives surge/sway/yaw
  },
  substeps: 1,
  helmEye: { x: 0, y: 35, z: 69 }, // [E]
  propulsion: {
    type: 'fppDiesel',
    power: 36e6, // [E]
    units: 1,
    propellerDiameter: 7.9, // [V]
    topSpeed: knotsToMs(24), // [V]
    serviceSpeed: knotsToMs(24),
    steeringMaxAngle: 35 * DEG, // [V]
    steeringRate: 2.3 * DEG, // [V]
    bowThrusterPower: 2e6, // [E]
    notes: 'Tactical diameter 3–3.5 L; crash stop 10–15 L in 6–9 min [E]',
  },
  loadingConditions: [
    // [E] 18,000 t of cargo off (centre ~4 m above the WL): she rises ~3 m (+700 m² of topsides)
    // and carries empties two high on deck instead of six (−1,700 m² of boxes).
    { name: 'ballast', extraMass: -18_000_000, extraMassHeight: 4, extraLateralArea: -1000 },
  ],
};
