// Where each boat starts, so the player has a chance before touching anything: its heading against the
// wind and the seas, and the sailboat's sails (reef, genoa furl and sheets). Pure; scenarioConfig turns
// it into the voyage's spawns, and the fleet forms up on the player's heading.
//
// Measured with scripts/spawn-sweep.ts (the real FFT ocean and wind of each rough preset, every boat with
// nobody at the helm for 60 s, and with a helm holding the spawn heading at 40% power, 3–10 seeds):
// - The ships and the crab boat roll least, and the crab boat capsizes least in hurricanes, bow-on to the
//   seas: in a Category 1–5 hurricane the cruise ship rolls at most 4–6° bow-on, 18–23° with the seas 20°
//   off the bow and about 30° from 45° to the beam; the crab boat at most 24–54° bow-on, 90–150° beam-on or 45° off.
// - The center console is the exception: lying stopped bow-on it backflips or broaches off big crests (6
//   of 9 hurricane runs capsize), against 1 of 9 with the seas 45° on the bow (with 135°, the fewest).
// - The jet ski is at the sea's mercy in a hurricane whatever its heading (6–7 of 9 runs at rest; 2–4 of
//   9 under way, no heading clearly better); up to a Storm it rides out the first minute at any heading.
// - Left alone the small boats don't stay put: the center console and the jet ski blow round to lie with
//   the wind on the quarter within 10–30 s, so a heading only matters for the first seconds anyway.
// - Steerage way at spawn changes nothing measurable for the powered boats, so they start at rest (the
//   throttle the player holds is zero).
// - With a swell across the wind sea, the steeper of the two is the one to face: bow-on to a 5 m, 10 s wind
//   sea with a 6 m, 14 s swell on the beam the ships roll a third as much as bow-on to the swell.
// - The sailboat head to wind is in irons. Reefed for the wind (the HUD's reef advice) with the genoa part
//   furled and the sheets trimmed, it sails off from a beam reach: in Arcade it settles at a close reach
//   (~60°) by itself from any start; in Realistic, unattended with the helm centred, it holds a reach
//   from a Gale up but rounds up into irons after 6–20 s in lighter winds whatever the start or the
//   sheets (weather helm: the player has those seconds to take the wheel). Full sail in a storm lies
//   pinned on its side (mean heel 65–85° in hurricanes). From storm force, the third reef, ⅔ furl and the
//   main feathered 20° past trim on a beam reach capsized least (3 in 48 Hurricane 3 and 5 runs, against
//   9 trimmed, at a beam or a broad reach) and heels least; the rest is the luck of the first crest.

import { DEG, normalizeHeading, signedAngle } from '../sim/core/conventions';
import { msToKnots } from '../sim/core/units';
import { polarSpeed } from '../sim/sail/orcPolar';
import { CC115_RIG } from '../sim/sail/rig';
import { trimmedSheets } from '../sim/sail/SailRig';
import { resolveSeaState, type SeaStateSettings } from '../sim/weather/seaState';
import { MAX_WIND_ANGLE, MIN_WIND_ANGLE } from '../sim/world/autopilot';
import type { BoatKind, PhysicsMode, SailSetup, WindConfig } from '../sim/world/protocol';
import { reefAdvice } from '../ui/hud/sailing';

export interface SpawnPlan {
  heading: number; // rad
  speed: number; // m/s ahead, engines stopped
  sail?: SailSetup;
}

// Seas lower than this don't threaten anyone: face into the wind.
const CALM_HS = 1; // m
// Where each powered boat starts with the dominant seas: off the bow to starboard, rad.
export const SEAS_OFF_BOW: Record<Exclude<BoatKind, 'sail'>, number> = {
  cargo: 0,
  cruise: 0,
  crab: 0,
  powerboat: 45 * DEG,
  pwc: 0,
  hydro: 0, // calm water is the only water it races on; bow-on to whatever sea there is
};
// The sailboat's true wind angle at spawn, on starboard tack (right of way): a beam reach.
export const SAIL_TWA = 90 * DEG;
// From storm force the main starts feathered, eased this far past trim.
const SAIL_STORM_KN = 45;
const STORM_MAIN_EASE = 20 * DEG;
// Genoa furl by reef: a third rolled away with the first reef, two thirds from the second.
export const FURL_BY_REEF: readonly number[] = [0, 1 / 3, 2 / 3, 2 / 3];
// Manual sheets are set for the boat part-way up to its polar speed (Realistic): sailing off, the
// apparent wind draws forward and the sails come into trim instead of stalling.
export const SHEET_SPEED = 0.5;

// The direction ("from", rad) of the seas to face: the steeper (Hs / Tp²) of the wind sea and the swell
// among those at least CALM_HS high; null when both are lower.
export function dominantSeasFrom(wind: WindConfig, sea: SeaStateSettings): number | null {
  const s = resolveSeaState(sea, wind.speed, wind.from);
  const steepness = (hs: number, tp: number): number => (hs >= CALM_HS ? hs / Math.max(1, tp * tp) : 0);
  const windSea = steepness(s.hs, s.tp);
  const swell = s.swell ? steepness(s.swell.height, s.swell.period) : 0;
  if (windSea === 0 && swell === 0) return null;
  return s.swell && swell > windSea ? s.swell.from : s.windSeaFrom;
}

// The sailboat's sails for a true wind of `tws` (m/s) at `twa` (rad, + from starboard): reefed as the
// HUD advises, the genoa furled to match, the sheets where a trimmer sailing off would set them (the
// main feathered from storm force).
export function sailSetupFor(tws: number, twa: number): SailSetup {
  // A hair over the mean, so a preset right on a threshold (Squalls' 24 kn) takes that reef.
  const reef = reefAdvice(tws + 1e-6, 0, 0).recommended;
  const furl = FURL_BY_REEF[reef] ?? 2 / 3;
  const sheets = trimmedSheets(tws, twa, SHEET_SPEED * polarSpeed(tws, twa), reef, furl);
  const ease = msToKnots(tws) >= SAIL_STORM_KN ? STORM_MAIN_EASE : 0;
  return { reef, furl, mainSheet: Math.min(sheets.main + ease, CC115_RIG.boomMaxOut), jibSheet: sheets.jib };
}

// The player's boat.
export function spawnPlan(
  kind: BoatKind,
  wind: WindConfig,
  sea: SeaStateSettings,
  _mode: PhysicsMode,
): SpawnPlan {
  if (kind === 'sail') {
    return {
      heading: normalizeHeading(wind.from - SAIL_TWA),
      speed: 0,
      sail: sailSetupFor(wind.speed, SAIL_TWA),
    };
  }
  const seas = dominantSeasFrom(wind, sea);
  // Calm: bow into the wind for the opening shot.
  return { heading: normalizeHeading(seas === null ? wind.from : seas - SEAS_OFF_BOW[kind]), speed: 0 };
}

// A fleet boat forming up on a leader heading `leaderHeading`: powered boats take its heading (their
// autopilots keep station on it); a sailboat takes it too if it can sail it, else the nearest heading it
// can hold on the leader's side of the wind (out of irons, off a dead run), sails set for that.
export function followerPlan(kind: BoatKind, leaderHeading: number, wind: WindConfig): SpawnPlan {
  if (kind !== 'sail') return { heading: leaderHeading, speed: 0 };
  const twa = signedAngle(wind.from - leaderHeading);
  const side = twa < 0 ? -1 : 1;
  const holdable =
    side * Math.min(Math.max(Math.abs(twa), MIN_WIND_ANGLE + 10 * DEG), MAX_WIND_ANGLE - 20 * DEG);
  const heading = holdable === twa ? leaderHeading : normalizeHeading(wind.from - holdable);
  return { heading, speed: 0, sail: sailSetupFor(wind.speed, holdable) };
}
