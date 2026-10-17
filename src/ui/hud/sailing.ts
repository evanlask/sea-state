// Sailing classification for the HUD: point of sail, the no-go and gybe zones, ideal sheet
// angles for an apparent wind, reef advice and the trim / manoeuvre hints. Pure functions.

import { DEG, signedAngle } from '../../sim/core/conventions';
import { msToKnots } from '../../sim/core/units';
import type { PointOfSail, SailingState, TrimState } from './model';

// Half-width of the no-go zone either side of the true wind.
export const NO_GO_HALF_ANGLE = 40 * DEG;
// Within this of dead downwind the boom may cross on its own.
export const GYBE_ZONE_HALF_ANGLE = 15 * DEG;
// The heel range where a keelboat like the C&C 115 is fastest.
export const FAST_HEEL_BAND: readonly [number, number] = [15 * DEG, 25 * DEG];
// Past this sustained heel the boat is overpowered whatever the wind speed.
const OVERPOWERED_HEEL = 25 * DEG;
// True wind (knots) at which to take in reefs 1, 2 and 3.
export const REEF_WIND_KN: readonly number[] = [18, 24, 30];

// Upper TWA limit of each point of sail (degrees off the true wind).
const POINTS: readonly [number, PointOfSail][] = [
  [40, 'in-irons'],
  [55, 'close-hauled'],
  [80, 'close-reach'],
  [110, 'beam-reach'],
  [155, 'broad-reach'],
  [181, 'run'],
];

export function pointOfSail(twa: number): PointOfSail {
  const deg = Math.abs(signedAngle(twa)) / DEG;
  for (const [limit, point] of POINTS) if (deg < limit) return point;
  return 'run';
}

export const POINT_OF_SAIL_LABEL: Record<PointOfSail, string> = {
  'in-irons': 'In irons',
  'close-hauled': 'Close-hauled',
  'close-reach': 'Close reach',
  'beam-reach': 'Beam reach',
  'broad-reach': 'Broad reach',
  run: 'Run',
};

export const isNoGo = (twa: number, halfAngle = NO_GO_HALF_ANGLE): boolean =>
  Math.abs(signedAngle(twa)) < halfAngle;

export const isGybeZone = (twa: number, halfAngle = GYBE_ZONE_HALF_ANGLE): boolean =>
  Math.abs(signedAngle(twa)) > Math.PI - halfAngle;

// Wind over the starboard side is starboard tack.
export const tackOf = (twa: number): 'starboard' | 'port' => (signedAngle(twa) >= 0 ? 'starboard' : 'port');

// Ideal sheeting angles from the centreline for an apparent wind angle, on the leeward side
// (opposite sign to the AWA). A sail wants ~15–20° angle of attack until it is squared off;
// the jib also can't sheet inside its track.
export function idealSheetAngles(awa: number): { boom: number; jib: number } {
  const a = Math.abs(signedAngle(awa)) / DEG;
  const boom = clamp((a - 15) * 0.6, 3, 85);
  const jib = clamp(8 + (a - 25) * 0.5, 8, 70);
  const side = signedAngle(awa) >= 0 ? -1 : 1;
  return { boom: side * boom * DEG, jib: side * jib * DEG };
}

export interface ReefAdvice {
  recommended: number; // reef level for this true wind (0–3)
  overpowered: boolean; // heel past the threshold or fewer reefs in than advised
  shakeOut: boolean; // more reefs in than the wind needs
}

export function reefAdvice(tws: number, heel: number, reef: number): ReefAdvice {
  const kn = msToKnots(tws);
  let recommended = 0;
  for (const limit of REEF_WIND_KN) if (kn >= limit) recommended++;
  const heavyHeel = Math.abs(heel) > OVERPOWERED_HEEL;
  // Shaking out wants some margin under the threshold, or the advice flips in every gust.
  const calmer = REEF_WIND_KN[reef - 1] !== undefined && kn < REEF_WIND_KN[reef - 1] - 3;
  return {
    recommended,
    overpowered: heavyHeel || recommended > reef,
    shakeOut: reef > recommended && calmer && !heavyHeel,
  };
}

export type TrimAdvice = 'trim' | 'ease' | 'hold';

// A luffing sail wants sheeting in; a stalled one wants easing.
export const trimAdvice = (state: TrimState): TrimAdvice =>
  state === 'luffing' ? 'trim' : state === 'stalled' ? 'ease' : 'hold';

export interface ManoeuvreHint {
  text: string;
  tone: 'info' | 'warning' | 'danger';
}

export function manoeuvreHint(s: SailingState): ManoeuvreHint | null {
  if (s.inIrons) return { text: 'In irons — steer away from the wind to fill the sails', tone: 'danger' };
  if (s.gybeDanger)
    return { text: 'Gybe danger — wind nearly dead astern: head up or gybe now', tone: 'warning' };
  const point = pointOfSail(s.twa);
  if (point === 'in-irons')
    return { text: 'Too close to the wind — steer away to fill the sails', tone: 'warning' };
  if (point === 'close-hauled') return { text: 'Tack: turn through the wind', tone: 'info' };
  if (point === 'run') return { text: 'Gybe: turn the stern through the wind', tone: 'info' };
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
