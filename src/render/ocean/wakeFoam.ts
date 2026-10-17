// How much white water a boat leaves on the sea (pure, Node-testable; WakeLayer stamps it into its
// foam trail). Foam is air entrained by breaking or turbulent flow, so each source follows what
// actually breaks, not the size of the hull:
//
//  - Hull: the bow and stern waves breaking along and astern of the hull, by the length Froude
//    number Fn = V/√(g·L). Below Fn ≈ 0.26 nothing breaks (a smooth, faint turbulent strip at
//    most; a yacht at hull speed, Fn ≈ 0.4, only scatters bubbles); it grows to the hump (Fn ≈ 0.6,
//    the hull dragging its stern wave, transom immersed) and eases off on the plane, where the
//    hull rides on its spray roots. Full-bodied
//    ships also break their bow wave at service speed (the draft Froude number V/√(g·T) past ~1
//    for a block coefficient over ~0.5): foam along the hull and in the trail.
//  - Wash: the propeller or jet's churn, by the shaft energy it dissipates per area of wake,
//    E = P_delivered / (b·(V + V₀)) (J/m²), saturating past a few kJ/m², and by how much of that air
//    reaches the surface white: a surface jet or outboard all of it, a ship's propeller 10 m down
//    a few percent (its bubbles rise as the turquoise band, the white mostly gone).
//  - Persistence: bubbles injected deep take long to rise and dissolve, so a ship's wake lingers
//    for minutes (and kilometres) while a small boat's turbulence fades within tens of metres; the
//    trail keeps a fast and a slow channel, split by hull draft (PERSIST_DEPTH).
//
// Amounts are trail foam a texel on the track receives as the boat passes (centreline); the ocean
// shows 0.2 as scattered bubbles, 0.6 as aerated lace, 1+ as thick white still keeping its cells.

import type { BoatSpec } from '../../sim/boats/BoatSpec';
import { GRAVITY, RHO_SEAWATER } from '../../sim/core/units';

// Hull wave breaking, by the length Froude number.
const HULL_BREAK_FN = [0.26, 0.65] as const;
const HULL_FOAM = 1.2;
// Small waves break without entraining much air (a dinghy's ripples spill, they don't go white):
// the hull's breaking scales by 1 − exp(−H/this), H = V²/2g the height of its bow wave.
const BREAK_HEIGHT = 0.4; // m
// On the plane the hull's own breaking eases off by this much.
const PLANING_FN = [0.8, 2] as const;
const PLANING_RELIEF = 0.4;
// Ships' bow wave breaking: block coefficient and draft Froude number ramps.
const BOW_BLOCK = [0.45, 0.6] as const;
const BOW_FN_DRAFT = [0.7, 1.2] as const;
const BOW_FOAM = 0.25;
// Propeller / jet wash.
const WASH_FOAM = 1;
const WASH_ENERGY = 3000; // J/m² for 1 − 1/e of full aeration
const WASH_SPEED = 3; // m/s, V₀: at rest the churn spreads like a slow wake
const WASH_IDLE = 0.1; // share of rated power below which the wash does not aerate
const WASH_DEPTH = 2.5; // m, e-folding of the white that reaches the surface with prop depth
// Persistence: slow share = draft / (draft + this).
const PERSIST_DEPTH = 4; // m
export const TRAIL_TAU_FAST = 10; // s
export const TRAIL_TAU_SLOW = 150; // s
export const TRAIL_MAX = 1.5;
// Wake wave crests from the eWave splat whiten only near breaking steepness (|∇η| ≈ ka; real
// wake waves break from ka ≈ 0.3, the grids smooth their peaks a little).
export const WAKE_CREST_SLOPE = [0.2, 0.35] as const;

export interface WakeFoamHull {
  lwl: number; // m
  beam: number; // m
  draft: number; // hull draft, m
  propDepth: number; // overall draft (propeller, jet intake), m
  blockCoefficient: number;
  power: number; // W rated
}

export interface WakeFoam {
  hull: number; // trail foam deposited by the hull's white water
  wash: number; // and by the propeller or jet wash
  hullWidth: number; // half-widths of the two strips, m
  washWidth: number;
  persistent: number; // share of both that goes to the slow channel
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export function wakeFoamHull(spec: BoatSpec): WakeFoamHull {
  const { lwl, beam, draft, overallDraft } = spec.dimensions;
  const beamWaterline = 'beamWaterline' in spec.hull ? spec.hull.beamWaterline : 0.85 * beam;
  return {
    lwl,
    beam,
    draft,
    propDepth: overallDraft,
    blockCoefficient: spec.mass / (RHO_SEAWATER * lwl * beamWaterline * Math.max(draft, 0.05)),
    power: spec.propulsion.power,
  };
}

// Delivered share of rated power from a snapshot's telemetry (0 for the sailboat), less what the
// propeller loses out of the water.
export function deliveredPower(telemetry: Readonly<Record<string, number>>): number {
  const load = Math.min(1, Math.max(0, telemetry['load'] ?? 0));
  return load * (1 - Math.min(1, Math.max(0, telemetry['propEmersion'] ?? 0)));
}

// The hull's breaking, as a share of HULL_FOAM, at speed V (m/s) on waterline length L (m).
export function hullBreaking(speed: number, lwl: number): number {
  const fn = speed / Math.sqrt(GRAVITY * lwl);
  const height = (speed * speed) / (2 * GRAVITY);
  return (
    smoothstep(HULL_BREAK_FN[0], HULL_BREAK_FN[1], fn) *
    (1 - PLANING_RELIEF * smoothstep(PLANING_FN[0], PLANING_FN[1], fn)) *
    (1 - Math.exp(-height / BREAK_HEIGHT))
  );
}

export function wakeFoam(
  hull: WakeFoamHull,
  speed: number,
  power: number,
  airborne: boolean,
  out: WakeFoam = { hull: 0, wash: 0, hullWidth: 0, washWidth: 0, persistent: 0 },
): WakeFoam {
  const v = Math.max(0, speed);
  const fn = v / Math.sqrt(GRAVITY * hull.lwl);
  const fnDraft = v / Math.sqrt(GRAVITY * Math.max(hull.draft, 0.05));
  out.hullWidth = 0.6 * hull.beam;
  out.washWidth = 0.45 * hull.beam * (1 + 0.6 * smoothstep(0.3, 1, fn));
  out.persistent = hull.draft / (hull.draft + PERSIST_DEPTH);
  if (airborne) {
    out.hull = out.wash = 0;
    return out;
  }
  const bow =
    BOW_FOAM *
    smoothstep(BOW_BLOCK[0], BOW_BLOCK[1], hull.blockCoefficient) *
    smoothstep(BOW_FN_DRAFT[0], BOW_FN_DRAFT[1], fnDraft);
  out.hull = HULL_FOAM * hullBreaking(v, hull.lwl) + bow;
  const shaft = (hull.power * Math.max(0, Math.min(1, power) - WASH_IDLE)) / (1 - WASH_IDLE);
  const energy = shaft / (2 * out.washWidth * (v + WASH_SPEED));
  const surfacing = Math.exp(-hull.propDepth / WASH_DEPTH);
  out.wash = WASH_FOAM * (1 - Math.exp((-surfacing * energy) / WASH_ENERGY));
  return out;
}

// Stamp rate (trail foam per second at a stamp's centreline) that leaves `deposit` on a texel the
// boat passes at `speed`: a texel spends (length + 1.4·width)/V inside a capsule stamp `length`
// long (in the boat's frame) whose profile falls off from 0.4 to 1 × its half-width. Below
// `minSpeed` the stamp churns in place at the rate it would have at that speed.
export function stampRate(
  deposit: number,
  speed: number,
  length: number,
  width: number,
  minSpeed = 0,
): number {
  return (deposit * Math.max(speed, minSpeed)) / Math.max(length + 1.4 * width, 1e-3);
}
