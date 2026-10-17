// Cruise ship modelled on the Celebrity Solstice class, fictional name.

import { DEG } from '../../core/conventions';
import { knotsToMs } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 317.2; // [K] Celebrity's 1,041 ft; Wikipedia gives 314.86 m
const LWL = 293; // [E]
const B = 36.8; // [V] 36.88 m (Wikipedia)
const T = 8.3; // [V] 8.23 m
const D = 14.0; // [E] keel to bulkhead deck

export const cruiseSpec: BoatSpec = {
  kind: 'cruise',
  name: 'MS Celestine',
  modelledOn: 'Celebrity Solstice-class cruise ship',
  dimensions: { loa: LOA, lwl: LWL, beam: B, draft: T, overallDraft: T, depth: D },
  mass: 57_000_000, // [E] Cb ≈ 0.62
  // [E] Wide modern cruise ships carry GM ≈ 2–3 m (natural roll period ~19 s here); 2.0 sat at the
  // bottom and let a 52 kn beam wind heel her 6–7°, against the 3–5° such ships show in a gale.
  gmTarget: 2.5,
  gyration: { roll: 0.38 * B, pitch: 0.25 * LWL, yaw: 0.25 * LWL }, // [E]
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'ship',
    lwl: LWL,
    beamWaterline: B,
    beamDeck: B,
    draft: T,
    depth: D,
    midshipCoefficient: 0.97, // [E]
    endSectionExponent: 1.6, // [E]
    parallelMidbodyForward: 0.2, // [E]
    parallelMidbodyAft: 0.2, // [E]
    entranceExponent: 2, // solved
    runExponentRatio: 0.9, // [E]
    deckFullness: 3.0, // [E] fine entrance, full flared decks
    bowOverhang: 12, // [E] raked stem
    sternOverhang: 12.2, // [E] LOA = LWL + overhangs
    forefootLength: 0.03, // [E] bulb
    runLength: 0.25, // [E]
    transomKeelHeight: T + 1.5, // [E]
    transomBeamRatio: 0.7, // [E]
    keelDrag: 0,
    sheerBow: 1.5, // [E]
    sheerStern: 0,
    flareExponent: 1.5,
    bulbRadius: 2.5, // [E]
  },
  superstructures: [
    // [E] enclosed passenger decks: weathertight and buoyant at large heel. Three blocks so that each
    // can be nearly as wide as the deck under it (a block is no wider than its narrowest deck point);
    // one long block would be squeezed to the narrow bow deck and reach the water only at extreme heel.
    {
      name: 'superstructure forward',
      z: -77.5,
      length: 55,
      width: 26,
      height: 38,
      topLength: 40,
      topWidth: 22,
      topShiftZ: 7.5,
    },
    { name: 'superstructure', z: 20, length: 140, width: 34, height: 38, topWidth: 30 },
    {
      name: 'superstructure aft',
      z: 107.5,
      length: 35,
      width: 30,
      height: 38,
      topLength: 20,
      topWidth: 26,
      topShiftZ: -7.5,
    },
  ],
  openVolumes: [],
  foils: [
    {
      name: 'centre skeg',
      kind: 'skeg',
      centre: { x: 0, y: -T + 1.5, z: LWL / 2 - 20 }, // [E]
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 3,
      area: 40, // [E]
      effectiveAspectRatio: 0.6,
      stallAngle: 40 * DEG,
    },
  ],
  windage: {
    type: 'passengerLiner',
    lateralArea: 13_000, // [E]
    frontalArea: 1600, // [E]
    length: LOA,
    lateralCentreHeight: 22, // [E]
    lateralCentreForward: 0, // [E]
    frontalCentreHeight: 25, // [E]
  },
  // [E] Bilge keels and hull form; their eddy making grows with the roll (Ikeda), 0.12 of critical in
  // all at a 20° roll. The fins below add their own under way.
  rollDamping: { zeta: 0.06, quadraticZeta: 0.06 },
  // [E] Two retractable fin stabilisers at the turn of the bilge, ~30 m forward of midships, 15 m² each
  // with flaps (Solstice-class ships carry one pair; Rolls-Royce Neptune / Fincantieri class figures).
  finStabilizers: {
    area: 15,
    position: { x: 16, y: -6, z: -30 },
    maxAngle: 25 * DEG,
    rate: 15 * DEG,
    liftSlope: 4,
    maxLift: 1.4,
    rollGain: 3,
    rateGain: 8,
  },
  heavePitchDamping: { heave: 0.2, pitch: 0.2 }, // [E]
  openings: [
    { name: 'mooring deck door (port)', position: { x: -17.5, y: 14, z: 120 }, area: 3, compartment: 0 }, // [E]
    { name: 'mooring deck door (stbd)', position: { x: 17.5, y: 14, z: 120 }, area: 3, compartment: 0 },
  ],
  compartments: [
    { name: 'aft machinery spaces', z: 105, length: 50, width: 34, floorY: -6.8, height: 20, pumpRate: 0.3 }, // [E]
  ],
  kerner: {
    referenceSpeed: knotsToMs(21.5),
    pressureDragLinear: 0.4,
    pressureDragQuadratic: 0.3,
    pressureFalloff: 0.5,
    suctionDragLinear: 0.2,
    suctionDragQuadratic: 0.2,
    suctionFalloff: 0.5,
    slamGammaMax: 20,
    slamExponent: 2,
    slamStopTime: 2,
    waterlineLength: LWL,
    frictionFormFactor: 1.1,
    airDragCoefficient: 0,
    horizontalVelocityTerms: false,
  },
  substeps: 1,
  helmEye: { x: 0, y: 33, z: -LWL / 2 - 12 + 28 }, // [E] ~28 m aft of the bow
  propulsion: {
    type: 'azipodDieselElectric',
    power: 67.2e6, // [V] 4 × Wärtsilä 16V46 installed
    units: 2, // [V] 2 × 20.5 MW Azipods
    topSpeed: knotsToMs(24), // [V]
    serviceSpeed: knotsToMs(21.5), // [K]
    steeringMaxAngle: 35 * DEG, // [E]
    steeringRate: 5 * DEG, // [E]
    bowThrusterPower: 3.2e6, // [E] three tunnels
    notes: 'Tactical diameter 2.5–3.5 L; crash stop 4–6 L [E]',
  },
};
