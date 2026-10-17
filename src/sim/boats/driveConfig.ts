// Static drive-train data for each boat: engine, propeller/pump geometry and
// placement, rudder interaction factors, thrusters. The propeller curves (and
// the jet pump constant) are sized by scripts/calibrate.ts so that full power
// reaches the documented top speed; the results live in calibration/*.json.
// Body frame: x starboard, y up (0 = design waterline), z aft.

import { DEG } from '../core/conventions';
import { MPH } from '../core/units';
import type { FoilSpec } from '../physics/foils';
import type { EngineSpec } from '../physics/propulsion/propeller';
import type { RudderInteraction } from '../physics/propulsion/ship';
import type { TurbineSpec } from '../physics/propulsion/surfaceProp';
import type { BoatKind } from '../world/protocol';

interface ShaftConfig {
  kind: 'shaft';
  engine: EngineSpec;
  diameter: number;
  position: { x: number; y: number; z: number };
  wake: number;
  thrustDeduction: number;
  rudder: RudderInteraction | null;
  thruster: { position: { x: number; y: number; z: number }; maxThrust: number; rampTime: number } | null;
}

interface PodConfig {
  kind: 'pods';
  engine: EngineSpec; // per pod
  diameter: number;
  positions: { x: number; y: number; z: number }[];
  wake: number;
  thrustDeduction: number;
  maxAngle: number;
  rate: number;
  housing: Omit<FoilSpec, 'centre'>;
  thruster: { position: { x: number; y: number; z: number }; maxThrust: number; rampTime: number };
}

interface OutboardConfig {
  kind: 'outboards';
  engine: EngineSpec; // per engine, propeller-shaft rpm
  gearRatio: number;
  diameter: number;
  positions: { x: number; y: number; z: number }[];
  wake: number;
  thrustDeduction: number;
  maxSteer: number;
  steerRate: number;
  trimMin: number;
  trimMax: number;
  trimRate: number;
}

interface JetConfig {
  kind: 'jet';
  intake: { x: number; y: number; z: number };
  nozzle: { x: number; y: number; z: number };
  nozzleArea: number;
  pumpEfficiency: number;
  power: number;
  maxRpm: number;
  idleRpm: number;
  inertia: number;
  spoolTime: number;
  intakeWake: number;
  maxNozzle: number;
  nozzleRate: number;
  reverseEfficiency: number;
  speedLimit: number;
  brakeRpm: number;
}

interface SurfacePropConfig {
  kind: 'surfaceProp';
  turbine: TurbineSpec;
  diameter: number;
  position: { x: number; y: number; z: number };
  shaftAngle: number;
  verticalForce: number;
  wake: number;
  thrustDeduction: number;
  rudder: FoilSpec;
}

interface SailConfig {
  kind: 'sail';
}

export type DriveConfig =
  | ShaftConfig
  | PodConfig
  | OutboardConfig
  | JetConfig
  | SurfacePropConfig
  | SailConfig;

// KCS rudder–hull interaction [V] (SIMMAN KCS MMG data).
const KCS_RUDDER: RudderInteraction = {
  tR: 0.258,
  aH: 0.361,
  xH: -0.436,
  gammaPlus: 0.492,
  gammaMinus: 0.338,
  lR: -0.755,
  epsilon: 0.956,
  kappa: 0.633,
  eta: 0.7979,
};

export const DRIVE_CONFIGS = {
  cargo: {
    kind: 'shaft',
    engine: {
      power: 36e6 * 0.98, // [E] MCR less shaft losses
      ratedRpm: 104, // [E] KCS-like long-stroke 2-stroke
      idleRpm: 25,
      asternRpm: 0.8,
      torqueFactor: 1.15, // [E] overload margin of the load diagram
      inertia: 6e5, // [E] engine, shafting, propeller + entrained water
      rampTime: 90, // [E] manoeuvring load programme Stop → Full
      reversal: 'direct',
      reversalDelay: 25, // [E] stop on braking air, re-start astern
      brakeTorque: 0.3,
    },
    diameter: 7.9, // [V]
    position: { x: 0, y: -6.75, z: 109 },
    wake: 0.3, // [E] (KCS w_P0 0.355 at model scale)
    thrustDeduction: 0.207, // [V]
    rudder: KCS_RUDDER,
    thruster: { position: { x: 0, y: -6, z: -105 }, maxThrust: 250e3, rampTime: 8 }, // [E] 2 MW tunnel
  },
  crab: {
    kind: 'shaft',
    engine: {
      power: 1.2e6 * 0.96, // [E] through the reduction gear
      ratedRpm: 230, // [E] propeller rpm
      idleRpm: 60,
      asternRpm: 0.7,
      torqueFactor: 1.1,
      inertia: 3000,
      rampTime: 12,
      reversal: 'gearbox',
      reversalDelay: 4,
      brakeTorque: 0.2,
    },
    diameter: 2.2,
    position: { x: 0, y: -2.7, z: 15.6 },
    wake: 0.25,
    thrustDeduction: 0.18,
    rudder: { ...KCS_RUDDER, aH: 0.25, xH: -0.45, gammaPlus: 0.45, gammaMinus: 0.4, lR: -0.9, eta: 0.85 },
    thruster: { position: { x: 0, y: -2.5, z: -14 }, maxThrust: 19e3, rampTime: 3 }, // [E] 150 kW hydraulic
  },
  cruise: {
    kind: 'pods',
    engine: {
      power: 20.5e6 * 0.97, // [K] 2 × 20.5 MW Azipods
      ratedRpm: 145, // [E]
      idleRpm: 5,
      asternRpm: 1,
      torqueFactor: 1.2,
      inertia: 1.5e5,
      rampTime: 30, // [E] electric: quick reversal
      reversal: 'electric',
      reversalDelay: 0,
      brakeTorque: 0,
    },
    diameter: 5.8, // [E]
    positions: [
      { x: -7, y: -5, z: 131 },
      { x: 7, y: -5, z: 131 },
    ],
    wake: 0.1,
    thrustDeduction: 0.1,
    maxAngle: 35 * DEG,
    rate: 5 * DEG, // [E]
    housing: {
      name: 'pod housing',
      kind: 'rudder',
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 5,
      area: 28, // [E] strut + pod body
      effectiveAspectRatio: 1.6,
      stallAngle: 30 * DEG,
      zeroLiftDrag: 0.02,
    },
    thruster: { position: { x: 0, y: -5, z: -135 }, maxThrust: 400e3, rampTime: 8 }, // [E] 3 × ~1 MW
  },
  powerboat: {
    kind: 'outboards',
    engine: {
      power: 224e3 * 0.95, // [E] 300 hp at the propshaft
      ratedRpm: 6000 / 1.85,
      idleRpm: 650 / 1.85,
      asternRpm: 0.6,
      torqueFactor: 1.4, // high-revving: torque peak well below max rpm
      inertia: 1.0,
      rampTime: 0.6,
      reversal: 'gearbox',
      reversalDelay: 0.6,
      brakeTorque: 0.1,
    },
    gearRatio: 1.85,
    diameter: 0.39, // [E] 15.5 in
    positions: [
      { x: -0.45, y: -0.78, z: 5.6 },
      { x: 0.45, y: -0.78, z: 5.6 },
    ],
    wake: 0.05,
    thrustDeduction: 0.06,
    maxSteer: 30 * DEG,
    steerRate: 60 * DEG,
    trimMin: -6 * DEG,
    trimMax: 14 * DEG,
    trimRate: 3 * DEG,
  },
  pwc: {
    kind: 'jet',
    intake: { x: 0, y: -0.29, z: 1.0 },
    nozzle: { x: 0, y: -0.14, z: 1.75 },
    nozzleArea: 0.0065, // [E] ~90 mm nozzle exit
    pumpEfficiency: 0.75,
    power: 242e3, // [K]
    maxRpm: 8000,
    idleRpm: 1700,
    inertia: 0.25,
    spoolTime: 0.3,
    intakeWake: 0.1,
    maxNozzle: 20 * DEG,
    nozzleRate: 120 * DEG,
    reverseEfficiency: 0.45,
    speedLimit: 67 * MPH, // [K] US governed
    brakeRpm: 0.55,
  },
  hydro: {
    kind: 'surfaceProp',
    turbine: {
      power: 2.24e6 * 0.97, // [E] ~3,000 shp less the gearbox
      ratedRpm: 9500, // [E] propeller
      gearRatio: 16000 / 9500, // [E] T55 power turbine ~16,000 rpm
      idle: 0.04,
      spoolUp: 3.5, // [E] turboshaft acceleration idle → full
      spoolDown: 2,
      inertia: 0.6, // [E] power turbine, gearbox and propeller at the propeller shaft
      overspeed: 1.08,
    },
    diameter: 0.41, // [E] ~16 in surface-piercing
    // [E] Hub on a strut behind the transom, 9 cm under its bottom: at rest nine tenths of the disc
    // is in the water (the boat creeps on its idle), on the plane at speed about a quarter of it is
    // out (deeper still, its thrust under the CG lifts the bow toward a blow-over and it trips in a
    // chop; higher, it sticks out at rest and ventilates in every chop). The extra lift of the deeper
    // disc (verticalForce) keeps the stern's running height.
    position: { x: 0, y: -0.16, z: 5.05 },
    shaftAngle: 2 * DEG, // [E]
    verticalForce: 0.2, // [E] surface-piercing lift per unit thrust
    // [E] Behind the propeller, on the centreline (offset, the boat's roll in a turn lifts it out or
    // digs it in). Surface-piercing too: about half of it in the water at speed.
    wake: 0,
    thrustDeduction: 0,
    rudder: {
      name: 'rudder',
      kind: 'rudder',
      centre: { x: 0, y: -0.3, z: 5.3 },
      spanAxis: { x: 0, y: -1, z: 0 },
      chordAxis: { x: 0, y: 0, z: 1 },
      span: 0.35,
      area: 0.045,
      stallAngle: 20 * DEG,
    },
  },
  sail: { kind: 'sail' },
} satisfies Record<BoatKind, DriveConfig>;
