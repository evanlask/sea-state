// Committed calibration results by boat kind (regenerate with
// `node scripts/calibrate.ts`), plus the stability data the HUD needs.

import type { BoatKind } from '../../world/protocol';
import cargo from './cargo.json';
import crab from './crab.json';
import cruise from './cruise.json';
import hydro from './hydro.json';
import powerboat from './powerboat.json';
import pwc from './pwc.json';
import sail from './sail.json';
import type { BoatCalibration } from './types';

export const CALIBRATION: Readonly<Record<BoatKind, BoatCalibration>> = {
  cargo: cargo as BoatCalibration,
  cruise: cruise as BoatCalibration,
  crab: crab as BoatCalibration,
  sail: sail as BoatCalibration,
  powerboat: powerboat as BoatCalibration,
  pwc: pwc as BoatCalibration,
  hydro: hydro as BoatCalibration,
};

export interface StabilityCurve {
  curve: { heel: number; gz: number }[];
  avs: number;
  downflooding: number;
}

// GZ curve (free trim, intact, design load), AVS and downflooding angle.
export function stabilityCurve(kind: BoatKind): StabilityCurve {
  const s = CALIBRATION[kind].stability;
  return {
    curve: s.heel.map((heel, i) => ({ heel, gz: s.gz[i] ?? 0 })),
    avs: s.avs,
    downflooding: s.downflooding,
  };
}

export type { BoatCalibration } from './types';
