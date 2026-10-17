// ORC VPP polar of the C&C 115 (certificate AUS 6584, jieter/orc-data [V]): boat speed by true wind
// speed and angle, plus the optimum beat and run angles. Feeds the HUD's target speed, % of polar and
// best-VMG markers, and the sail-model validation. Note the downwind ORC numbers (TWA ≥ 110°) assume a
// spinnaker; this boat only carries main and genoa.

import { DEG, signedAngle } from '../core/conventions';
import { KNOT } from '../core/units';

export const ORC_TWS_KN: readonly number[] = [4, 6, 8, 10, 12, 14, 16, 20, 24];
export const ORC_TWA_DEG: readonly number[] = [52, 60, 75, 90, 110, 120, 135, 150];

// Boat speed in knots, ORC_SPEED_KN[twaIndex][twsIndex].
export const ORC_SPEED_KN: readonly (readonly number[])[] = [
  [4.36, 5.83, 6.8, 7.29, 7.48, 7.57, 7.64, 7.71, 7.68],
  [4.67, 6.12, 7.02, 7.46, 7.67, 7.77, 7.85, 7.94, 7.92],
  [4.89, 6.33, 7.16, 7.6, 7.88, 8.07, 8.19, 8.36, 8.44],
  [4.86, 6.38, 7.3, 7.77, 8.04, 8.24, 8.48, 8.81, 9.01],
  [4.66, 6.2, 7.23, 7.83, 8.29, 8.67, 9.0, 9.54, 10.04],
  [4.37, 5.96, 7.11, 7.74, 8.24, 8.71, 9.19, 10.16, 11.14],
  [3.82, 5.36, 6.6, 7.4, 7.93, 8.44, 8.96, 10.27, 12.55],
  [3.16, 4.51, 5.71, 6.73, 7.45, 7.95, 8.43, 9.51, 11.18],
];
const ORC_BEAT_ANGLE_DEG: readonly number[] = [43, 43, 40.8, 38.8, 37.7, 37.3, 37.3, 37.4, 39];
const ORC_BEAT_VMG_KN: readonly number[] = [2.78, 3.83, 4.64, 5.14, 5.34, 5.45, 5.51, 5.55, 5.43];
const ORC_RUN_ANGLE_DEG: readonly number[] = [141.9, 141.9, 148.2, 152.3, 158.3, 165.7, 170, 169.1, 146.2];
const ORC_RUN_VMG_KN: readonly number[] = [2.73, 3.9, 4.94, 5.84, 6.58, 7.18, 7.65, 8.53, 9.69];

// Fractional index of x in an ascending table, clamped to its ends.
function locate(table: readonly number[], x: number): { i: number; t: number } {
  const n = table.length;
  if (x <= table[0]!) return { i: 0, t: 0 };
  if (x >= table[n - 1]!) return { i: n - 2, t: 1 };
  let i = 0;
  while (x > table[i + 1]!) i++;
  return { i, t: (x - table[i]!) / (table[i + 1]! - table[i]!) };
}

const lerpTable = (table: readonly number[], i: number, t: number): number =>
  table[i]! + (table[i + 1]! - table[i]!) * t;

export interface PolarAngles {
  beatTwa: number; // rad, unsigned
  beatSpeed: number; // m/s at the beat angle
  runTwa: number;
  runSpeed: number;
}

// Optimum VMG angles and the speeds at them, interpolated in TWS (m/s).
export function polarAngles(tws: number): PolarAngles {
  const { i, t } = locate(ORC_TWS_KN, tws / KNOT);
  const beat = lerpTable(ORC_BEAT_ANGLE_DEG, i, t) * DEG;
  const run = lerpTable(ORC_RUN_ANGLE_DEG, i, t) * DEG;
  return {
    beatTwa: beat,
    beatSpeed: (lerpTable(ORC_BEAT_VMG_KN, i, t) * KNOT) / Math.cos(beat),
    runTwa: run,
    runSpeed: (lerpTable(ORC_RUN_VMG_KN, i, t) * KNOT) / -Math.cos(run),
  };
}

// Polar boat speed (m/s) for a true wind speed (m/s) and angle (rad, either sign). Below the beat
// angle the target falls off toward zero head to wind; past the table it holds the run value. Below
// the lowest tabulated wind it scales linearly to zero.
export function polarSpeed(tws: number, twa: number): number {
  const a = Math.abs(signedAngle(twa));
  const kn = tws / KNOT;
  const scale = kn < ORC_TWS_KN[0]! ? Math.max(0, kn) / ORC_TWS_KN[0]! : 1;
  const ws = locate(ORC_TWS_KN, kn);
  const angles = polarAngles(tws);
  const deg = a / DEG;
  let speedKn: number;
  if (deg < ORC_TWA_DEG[0]!) {
    const s52 = speedAtRow(0, ws.i, ws.t);
    const beatKn = angles.beatSpeed / KNOT;
    const beatDeg = angles.beatTwa / DEG;
    if (deg >= beatDeg) speedKn = beatKn + ((s52 - beatKn) * (deg - beatDeg)) / (ORC_TWA_DEG[0]! - beatDeg);
    else speedKn = beatKn * Math.max(0, Math.sin((deg / beatDeg) * (Math.PI / 2))) ** 2;
  } else if (deg > ORC_TWA_DEG[ORC_TWA_DEG.length - 1]!) {
    speedKn = speedAtRow(ORC_TWA_DEG.length - 1, ws.i, ws.t);
  } else {
    const as = locate(ORC_TWA_DEG, deg);
    const lo = speedAtRow(as.i, ws.i, ws.t);
    const hi = speedAtRow(as.i + 1, ws.i, ws.t);
    speedKn = lo + (hi - lo) * as.t;
  }
  return speedKn * KNOT * scale;
}

const speedAtRow = (row: number, i: number, t: number): number => lerpTable(ORC_SPEED_KN[row]!, i, t);
