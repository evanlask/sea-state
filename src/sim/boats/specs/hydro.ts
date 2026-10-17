// Unlimited hydroplane (H1 Unlimited class), fictional name and race number: a three-point racer
// that rides on its two sponsons and its surface-piercing propeller at about 200 mph, its hull half
// carried by the air, driven by a Lycoming T55 helicopter turboshaft. Mass with driver and fuel.
//
// Sources: the class figures as published (H1 Unlimited rules and team material: hull about 30 ft
// by 14 ft, 6,750 lb minimum race weight, Lycoming T55-L-7 turbines, straightaways near 200 mph,
// lap averages about 160 mph, the 220 mph kilo record of 2004), not re-checked [K];
// everything else is an engineering estimate [E]. Physics: hull/hydroplane.ts
// (the sponsons, tunnel and after-planing hull), hydroAero.ts (the flying hull, blow-over),
// propulsion/surfaceProp.ts (turbine, surface-piercing propeller, rudder).

import { DEG } from '../../core/conventions';
import { MPH } from '../../core/units';
import type { BoatSpec } from '../BoatSpec';

const LOA = 9.4; // [K] about 30–31 ft
const B = 4.3; // [K] about 14 ft over the sponsons
const D = 0.85; // [E] pad line to the deck
const FIN_TOE = 0.6 * DEG; // [E] the skid fin's toe-in (see foils)
const FIN_CANT = 20 * DEG; // [E] its tip swung outboard (see foils)

export const hydroSpec: BoatSpec = {
  kind: 'hydro',
  name: 'U-7 Sea Fury',
  modelledOn: 'H1 Unlimited hydroplane, Lycoming T55 turbine',
  // Draft: the pads under the waterline at rest (solved); overall, the propeller's tip.
  dimensions: { loa: LOA, lwl: 8.6, beam: B, draft: 0.27, overallDraft: 0.6, depth: D },
  mass: 3062, // [K] 6,750 lb class minimum, with driver and fuel
  // [E] KG about 0.5 m over the pads (engine and gearbox low in the after-body); the sponsons' wide
  // waterplane makes the GM huge, and upside down the shallow, sealed hull floats as well (AVS ~88°).
  gmTarget: 9.9,
  gyration: { roll: 0.32 * B, pitch: 0.26 * LOA, yaw: 0.27 * LOA }, // [E]
  addedMass: { surge: 0.03, sway: 0.8, heave: 1.0, roll: 0.2, pitch: 0.8, yaw: 0.8 }, // [V] generic
  hull: {
    family: 'hydroplane',
    length: LOA,
    beam: B,
    draft: 0.27, // solved
    depth: D,
    sponsonWidth: 0.6, // [E]
    sponsonLength: 3.6, // [E] the pads end about 40% of the length from the noses
    noseLength: 1.6, // [E]
    noseBeamRatio: 0.8, // [E]
    tunnelHeight: 0.42, // [E] the tunnel roof over the pads
    // [E] The after-planing bottom: low enough to float the boat level at rest, high enough to clear
    // the water at the running trim (~2°), so at speed only the pads and the propeller are in it.
    afterPlaneStep: 0.06,
    afterPlaneTransom: 0.2,
    transomBeam: 2.4, // [E]
  },
  superstructures: [
    // [E] The cabover capsule ahead of the engine and the turbine's cowling: sealed, buoyant inverted.
    {
      name: 'cockpit capsule',
      z: -2.4,
      length: 2.0,
      width: 1.0,
      height: 0.55,
      topLength: 1.2,
      topWidth: 0.8,
    },
    { name: 'engine cowling', z: 1.8, length: 4.0, width: 1.3, height: 0.6, topWidth: 0.9 },
  ],
  openVolumes: [],
  foils: [
    // [E] The skid fin that grips in the turns, under the right sponson (inboard edge) as on the real
    // boats, which race left-hand courses: up to 160 mph the boat heels out onto that sponson in a
    // left turn and the fin carries it. It hangs just aft of the step, close ahead of the CG, its
    // root a hair under the pads and only 0.2 m deep, so it is fully in the water whenever the pads
    // are and heeling out buries no more of it: further forward or deeper, the heel buried more fin
    // ahead of the CG, which yawed the boat harder into the turn, heeled it further, and spun it
    // over. The model (render/boats/models/hydro.ts) draws it here too.
    {
      name: 'skid fin',
      kind: 'skeg',
      centre: { x: 1.63, y: -0.27 - 0.11, z: -0.6 },
      // Raked outboard 20° at the tip: in a left turn its grip pulls the right sponson down into the
      // water it is riding on, and the boat carries the turn on that sponson and the fin; in a right
      // turn the same lift pulls the sponson up and the fin half out, and it skids wide.
      spanAxis: { x: Math.sin(FIN_CANT), y: -Math.cos(FIN_CANT), z: 0 },
      // Toed in 0.6°, leading edge to port: its side force ahead of the CG balances the
      // pull of its own drag off the centreline, so with the wheel centred it runs straight.
      chordAxis: { x: Math.sin(FIN_TOE), y: 0, z: Math.cos(FIN_TOE) },
      span: 0.2,
      area: 0.07,
      stallAngle: 25 * DEG,
    },
    // [E] The propeller's strut and gearcase behind the transom: the lateral plane aft that keeps the
    // boat running straight (the skid fin is ahead of the CG).
    {
      name: 'propeller strut and gearcase',
      kind: 'skeg',
      centre: { x: 0, y: -0.15, z: 4.85 },
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.3,
      area: 0.05,
      stallAngle: 25 * DEG,
      zeroLiftDrag: 0.012,
    },
    // [E] The right sponson's outboard chine: the edge of its pad, which digs in when the boat slides
    // outward in a left turn and grips the water sideways along with the fin (a planing hull gets
    // most of its turning force from its chine). Down and inboard along the 45° chine flat, at the
    // pad line where the sponson rides; a flat, low-aspect strip, so it grips only once it slides.
    {
      name: 'right sponson chine',
      kind: 'skeg',
      centre: { x: 2.1, y: -0.27, z: -1.6 },
      spanAxis: { x: -Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.14,
      area: 0.2,
      stallAngle: 25 * DEG,
      zeroLiftDrag: 0.001, // its skin friction is the hull's (Kerner)
    },
  ],
  // [E] The bluff-body drag and side force; with `aero` it meets the air of its own speed even in a
  // calm (BoatDynamics), and Arcade keeps it whole (tuning.ts). C_d·A ≈ 1.65 m²: 8 kN at 200 mph.
  windage: {
    type: 'speedBoat',
    lateralArea: 10,
    frontalArea: 3,
    length: LOA,
    lateralCentreHeight: 0.6,
    lateralCentreForward: 0,
    frontalCentreHeight: 0.5,
  },
  // [E] The flying hull (physics/hydroAero.ts). At 200 mph it carries about half the weight. Running
  // straight it rides out the bounces of a swell or a chop (bow-up kicks up to 1.6 rad/s die out),
  // but let the bow climb past ~4° and the tunnel's lift moves forward and blows it over (a kick of
  // 2 rad/s does it at 200 mph; at 100 mph the air has a third of the grip).
  aero: {
    surfaces: [
      {
        // Ram air between the sponsons, which act as end plates, over the water. At its running
        // angle (~3°) its lift acts a little ahead of the CG, so a bounce off a swell or a ripple
        // doesn't throw the bow up; past 4.5° the ram air under a climbing bow carries the centre
        // of pressure forward (0.8 m a degree, up to 3 m), and from there the lift takes it over.
        // (With the centre 3 m forward at every angle, a 0.3 m swell blew it over within 30 s.)
        name: 'tunnel',
        centre: { x: 0, y: 0.18, z: 0 },
        cpTravel: { from: 4.5 * DEG, perRad: 0.8 / DEG, max: 3 },
        area: 9,
        aspectRatio: 2,
        incidence: 1 * DEG,
        stallAngle: 15 * DEG,
        zeroLiftDrag: 0.01,
        groundEffect: { chord: 3.6, gain: 1 },
      },
      {
        name: 'after-body', // deck, cowling and the after-planing bottom
        centre: { x: 0, y: 0.3, z: 1.5 },
        area: 13,
        aspectRatio: 1,
        incidence: 0,
        stallAngle: 20 * DEG,
        zeroLiftDrag: 0.01,
        groundEffect: { chord: 5.8, gain: 0.3 },
      },
      {
        name: 'wing', // the adjustable horizontal stabiliser on its struts above the transom
        centre: { x: 0, y: 1.45, z: 4.6 },
        area: 2,
        aspectRatio: 4.5, // end plates (its fins)
        incidence: 0,
        stallAngle: 14 * DEG,
        zeroLiftDrag: 0.02,
        trim: { min: -10 * DEG, max: 2 * DEG, rate: 4 * DEG, initial: -3 * DEG },
      },
    ],
  },
  rollDamping: { zeta: 0.05 }, // [E]
  // [E] Heave and pitch damping of the bottom slapping the water, scaled by the wetted surface
  // (physics/damping.ts): nothing at speed in calm water (a few tenths of a m² wet), but it takes
  // the bounce out of a chop, where crests slap the after-planing bottom.
  heavePitchDamping: { heave: 1, pitch: 0.5, wetted: true },
  // [E] The turbine's air intake on the cowling, through its plenum into the engine bay: the only way
  // in for water (the capsule and the hull are sealed). Upside down it takes a few litres a second;
  // the hull's 20 m³ keep her afloat however long she lies there.
  openings: [
    {
      name: 'turbine air intake',
      position: { x: 0, y: 1.1, z: 0.4 },
      area: 0.05,
      inflow: 0.05,
      compartment: 0,
    },
  ],
  compartments: [{ name: 'engine bay', z: 1.8, length: 3.5, width: 1.4, floorY: -0.1, height: 0.6 }],
  // [E] The pads plane at λ < 1 wetted beams, where a flat plate's lift per wetted area is about twice
  // what it is at λ ≈ 2 (Savitsky), hence the higher C_PD2 than the V-hulls'. The sponson transoms
  // ventilate at speed (little suction). No residuary table: the calibration (scripts/calibrate.ts)
  // runs the whole boat, and this model is its resistance.
  kerner: {
    referenceSpeed: 15,
    pressureDragLinear: 0.15,
    pressureDragQuadratic: 0.8,
    pressureFalloff: 1.0,
    suctionDragLinear: 0.01,
    suctionDragQuadratic: 0.01,
    suctionFalloff: 1.0,
    slamGammaMax: 60,
    slamExponent: 2,
    slamStopTime: 0.5,
    waterlineLength: 8.6,
    frictionFormFactor: 1.0,
    airDragCoefficient: 0,
    horizontalVelocityTerms: true,
  },
  // At 90 m/s a 960 Hz substep moves it 9 cm; the pads' heave stiffness (~1 MN/m) wants ≥ 4.
  substeps: 8,
  helmEye: { x: 0, y: 1.0, z: -2.3 }, // [E] in the cabover capsule
  propulsion: {
    type: 'turbine',
    power: 2.24e6, // [K/E] ~3,000 shp (estimates for the class run 2,650–3,500)
    units: 1,
    propellerDiameter: 0.41, // [E] ~16 in, surface-piercing
    topSpeed: 200 * MPH, // [K] straightaway speed
    serviceSpeed: 160 * MPH, // [K] race lap average
    // [E] A small transom rudder, slowed to 8°/s so the yaw doesn't overshoot into a trip. To the
    // left, on the skid fin and the right sponson's chine, full lock holds 2.25 g at 160 mph (19°/s)
    // and 1.75 g at 140; to the right the fin lifts and it skids wide at 1.2 g. More lock trips it
    // over the right sponson (the sideways pull at the water outweighs what's left of its weight);
    // from 180 mph full lock to the left trips it, half lock either way holds.
    steeringMaxAngle: 17 * DEG,
    steeringRate: 8 * DEG,
  },
};
