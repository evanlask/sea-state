// Shape of the committed calibration results (scripts/calibrate.ts writes
// src/sim/boats/calibration/<kind>.json).

import type { BoatKind } from '../../world/protocol';

interface PropellerSizing {
  diameter: number;
  kt0: number;
  j0: number;
  kq0: number;
  j0q: number;
  jDesign: number;
  efficiency: number; // open-water η₀ at the design point
}

export interface BoatCalibration {
  kind: BoatKind;
  method: string; // resistance target used
  topSpeed: number; // m/s target
  speeds: number[]; // m/s
  modelResistance: number[]; // N, hull model alone in the tank
  targetResistance: number[]; // N
  wettedArea: number[]; // m², in the tank
  sinkage: number[]; // m
  trim: number[]; // rad
  residualPerArea: number[]; // N/m²
  airDragAtTop: number; // N, still air at top speed
  propeller: PropellerSizing | null; // per propeller
  jetPumpConstant: number | null; // m (jet speed per rev/s)
  stability: {
    heel: number[]; // rad
    gz: number[]; // m
    avs: number; // rad
    maxGz: number;
    gm: number;
    downflooding: number; // rad, first opening under (π if none)
  };
}
