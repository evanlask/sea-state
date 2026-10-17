// Three-seat performance personal watercraft modelled on the Sea-Doo RXP-X
// 325 class, fictional name. Mass includes rider and fuel.

import { DEG } from '../../core/conventions';
import { knotsToMs, MPH } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 3.3; // [K]
const B = 1.25; // [K]
const T = 0.32; // [E] keel at the transom, rider aboard
const D = 0.62; // [E] keel to gunwale at the transom

export const pwcSpec: BoatSpec = {
  kind: 'pwc',
  name: 'Sea Dart RX',
  modelledOn: 'Sea-Doo RXP-X 325 class jet ski',
  dimensions: { loa: LOA, lwl: 2.9, beam: B, draft: T, overallDraft: T, depth: D }, // LWL [E]
  mass: 505, // [K/E] with rider and fuel
  gmTarget: 0.08, // [E] rider sits high: tippy at rest
  gyration: { roll: 0.42, pitch: 0.85, yaw: 0.88 }, // [E]
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'planing',
    length: LOA,
    chineBeam: 1.05, // [E]
    beamDeck: B,
    draft: T,
    depth: D,
    deadrise: 22 * DEG, // [E]
    deadriseBow: 40 * DEG,
    maxChineStation: 0.35,
    keelRiseStart: 0.35,
    transomChineRatio: 0.95,
    transomDeckRatio: 0.9,
    entranceExponent: 1.6, // solved
    deckFullness: 1.0,
    sheerBow: 0.15,
    flareExponent: 1.3,
    stations: 14,
    girthBottom: 3,
    girthTopsides: 3,
  },
  superstructures: [
    { name: 'seat', z: 0.35, length: 1.4, width: 0.55, height: 0.3 }, // [E] sealed upper deck/seat
  ],
  openVolumes: [],
  // Steering is the jet nozzle; the keel strake and intake grate give the directional
  // stability a planing hull needs at speed, and the sponsons (fins on the aft chines)
  // take over in a banked turn, when the keel lifts and the inside sponson digs in. [E]
  // Their aspect ratio is the default for a fin under a hull, 2·span²/area: such
  // stubby fins have a low lift slope and a high induced drag, so a hard-over turn
  // swings the stern out into a slide instead of carving a wide arc.
  foils: [
    {
      name: 'keel strake and intake grate',
      kind: 'skeg',
      centre: { x: 0, y: -0.3, z: 1.25 },
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.1,
      area: 0.06,
      stallAngle: 35 * DEG,
    },
    ...[-1, 1].map((side) => ({
      name: side < 0 ? 'port sponson' : 'starboard sponson',
      kind: 'skeg' as const,
      centre: { x: side * 0.55, y: -0.1, z: 1.35 },
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.1,
      area: 0.03,
      stallAngle: 30 * DEG,
    })),
  ],
  windage: {
    type: 'speedBoat',
    lateralArea: 2.6, // [E] hull + rider
    frontalArea: 1.15, // [E]
    length: LOA,
    lateralCentreHeight: 0.55,
    lateralCentreForward: 0,
    frontalCentreHeight: 0.6,
  },
  rollDamping: { zeta: 0.05 }, // [E]
  // [E] Carves banked up to about its deadrise (rider leaning in); stiffness tuned so a
  // full-lock turn at top speed rolls in to ~15° at ~1 g (physics/planingCarve.ts), easing
  // to ~5° once the slide has bled the speed (the carve's stiffness scales with q).
  carve: {
    maxBank: 25 * DEG,
    stiffness: 0.025,
    damping: 1.2,
    maxMoment: 4000,
    beam: 1.05,
    planingSpeed: [3, 10],
  },
  // [E] Sliding in a hard-over turn (physics/planingSlip.ts): at full lock from top speed
  // the craft swings into a ~25° slide and bleeds to ~13 m/s within 2 s, then circles at
  // ~55°/s; from a 30 kn cruise at part throttle it circles in under five lengths. The
  // spray and lateral-lift drag of a slide is a planing effect (Fn_∇ ≳ 3, from ~8 m/s);
  // off the plane the hull's cross-flow (kerner.crossFlowDrag) carries it.
  slip: { coefficient: 0.4, planingSpeed: [8, 17] },
  // [E] Heave and porpoising damping, scaled with the wetted surface (physics/damping.ts):
  // planing at top speed about a third of the design wetted area is in the water, so this
  // keeps ~0.5 of critical in heave and ~0.3 in pitch there. Weaker, the hull would follow every
  // crest of a Fair-weather chop (Tp ≈ 3 s, met twice a second at 58 kn) up its face and be
  // thrown clear of the next trough, ventilating the jet.
  heavePitchDamping: { heave: 1.5, pitch: 1, wetted: true },
  // [E] Engine-compartment air intakes under the seat, through baffled ducts into the closed hull:
  // under water (the craft upside down) the air trapped in the hull only gets out as fast as the
  // water gets in, a fraction of a litre a second, so a capsized ski takes a few tens of litres in
  // the minutes it lies inverted. Flooding at the open vents' rate (12 L/s) would sink it to its deck
  // within a minute and lose the stability that keeps it upside down.
  openings: [-1, 1].map((side) => ({
    name: side < 0 ? 'engine air intake (port)' : 'engine air intake (stbd)',
    position: { x: side * 0.3, y: 0.32, z: 0.3 },
    area: 0.004,
    inflow: 0.03,
    compartment: 0,
  })),
  compartments: [
    { name: 'hull', z: 0.1, length: 2.2, width: 0.9, floorY: -0.25, height: 0.5, pumpRate: 0.0005 }, // [E]
  ],
  // [E] Seated, hips on the seat (render/boats/rider/pose.ts) and feet in the footwells: his CG a little
  // above the hips and forward of them. Without him the craft (415 kg) sits stern down a little, with
  // its CG ~0.4 m above the keel (the engine low in the hull) and an AVS of ~110°: upside down it
  // floats on its deck and seat and stays there (manufacturers mark which way to roll it back).
  rider: {
    mass: 90,
    position: { x: 0, y: 0.85, z: 0.15 },
    gyration: 0.3,
    lateralArea: 0.6,
    frontalArea: 0.45,
    windageHeight: 1.0,
  },
  kerner: {
    referenceSpeed: 15,
    pressureDragLinear: 0.15,
    pressureDragQuadratic: 0.3, // calibrated: planing lift so the wetted length is near Savitsky
    pressureFalloff: 1.0,
    suctionDragLinear: 0.02, // [E] trailing faces and the transom ventilate at speed
    suctionDragQuadratic: 0.04,
    suctionFalloff: 1.0,
    slamGammaMax: 60,
    slamExponent: 2,
    slamStopTime: 0.5,
    waterlineLength: 2.9,
    frictionFormFactor: 1.0,
    crossFlowDrag: 0.5, // [E] sliding V-bottom, on top of the panels' own normal force
    airDragCoefficient: 0,
    horizontalVelocityTerms: true,
  },
  substeps: 4,
  helmEye: { x: 0, y: 1.5, z: -LOA / 2 + 1.5 }, // [E]
  propulsion: {
    type: 'jet',
    power: 242e3, // [K] supercharged
    units: 1,
    topSpeed: 67 * MPH, // [K] governed ≈ 58 kn
    serviceSpeed: knotsToMs(30),
    steeringMaxAngle: 20 * DEG, // [E] nozzle
    steeringRate: 120 * DEG,
    notes: '0–30 mph ~1.8 s [K]; reverse bucket; no steering without thrust',
  },
};
