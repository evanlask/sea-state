// Real light from the fleet's deck lights: a few unshadowed spot lights (FleetLightPool), lent each
// frame to the nearest fleet boats whose deck lights are on, one per boat. Each boat lights its
// surroundings with one beam standing in for its main floods (fleetBeam); which boats get one is
// ranked by camera distance with hysteresis, so two boats at about the same range don't trade the
// lights back and forth, and a boat that loses its light to a nearer one fades out before the
// newcomer fades in. Pure TS.

import type { Rgb } from './colregs';
import type { DeckMount, Vec3Like } from './mounts';

// A point-light mount on a spot light: a downward hemisphere (the point mounts are overhead cockpit
// and promenade lights, whose light that matters falls below them).
export const POINT_AS_SPOT_ANGLE = (85 * Math.PI) / 180;
export const POINT_AS_SPOT_PENUMBRA = 0.4;

// Fittings dimmer than this light nothing seen from another boat (courtesy LEDs).
const FLEET_MIN_INTENSITY = 200; // cd
// Full strength out to FLEET_FADE_NEAR from the camera, gone by FLEET_FADE_FAR (a lit deck there is a
// few pixels; the lamps and glows carry it).
export const FLEET_FADE_NEAR = 350; // m
export const FLEET_FADE_FAR = 600; // m
// A boat holding a light ranks as if this much nearer, so a challenger must be clearly closer.
const FLEET_HYSTERESIS = 0.8;
export const FLEET_FADE_TIME = 0.5; // s to fade a light out (losing it) or in (taking it over)

const MAX_ANGLE = POINT_AS_SPOT_ANGLE; // a merged pair never spreads past a hemisphere
const PAIR_TOLERANCE = 0.01; // m

// One spot light standing in for a boat's main floods, in its body frame.
export interface FleetBeam {
  position: Vec3Like;
  target: Vec3Like;
  colour: Rgb;
  intensity: number; // cd on the beam axis
  angle: number; // rad, half-angle
  penumbra: number;
  range: number; // m
}

// The boat's first fitting by priority that gets a scene light and is bright enough to matter,
// merged with its mirror-image partner (the floods come in port/starboard pairs): one beam from
// between them, as bright as both, widened to cover both aim points. null: nothing worth lighting.
export function fleetBeam(mounts: readonly DeckMount[]): FleetBeam | null {
  const lit = mounts
    .filter((m) => m.light !== 'none' && m.intensity >= FLEET_MIN_INTENSITY)
    .sort((a, b) => a.priority - b.priority);
  const main = lit[0];
  if (!main) return null;
  const beam = beamOf(main);
  const partner = lit.find(
    (m) =>
      m !== main &&
      m.light === main.light &&
      Math.abs(main.position.x) > PAIR_TOLERANCE &&
      Math.abs(m.position.x + main.position.x) < PAIR_TOLERANCE &&
      Math.abs(m.position.y - main.position.y) < PAIR_TOLERANCE &&
      Math.abs(m.position.z - main.position.z) < PAIR_TOLERANCE,
  );
  if (!partner) return beam;
  const other = beamOf(partner);
  const mid = (a: Vec3Like, b: Vec3Like): Vec3Like => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: (a.z + b.z) / 2,
  });
  const position = mid(beam.position, other.position);
  const target = mid(beam.target, other.target);
  // Half the gap between the two aim points, seen from the merged lamp.
  const spread = Math.atan2(
    distance(beam.target, other.target) / 2,
    Math.max(1e-3, distance(position, target)),
  );
  return {
    position,
    target,
    colour: beam.colour,
    intensity: beam.intensity + other.intensity,
    angle: Math.min(MAX_ANGLE, Math.max(beam.angle, other.angle) + spread),
    penumbra: beam.penumbra,
    range: Math.max(beam.range, other.range),
  };
}

function beamOf(m: DeckMount): FleetBeam {
  const point = m.light === 'point';
  return {
    position: { ...m.position },
    target: point ? { x: m.position.x, y: m.position.y - 1, z: m.position.z } : { ...m.target },
    colour: m.colour,
    intensity: m.intensity,
    angle: point ? POINT_AS_SPOT_ANGLE : m.angle,
    penumbra: point ? POINT_AS_SPOT_PENUMBRA : m.penumbra,
    range: m.range,
  };
}

const distance = (a: Vec3Like, b: Vec3Like): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// 1 near the camera, easing to 0 at FLEET_FADE_FAR.
export function fleetDistanceFade(distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - FLEET_FADE_NEAR) / (FLEET_FADE_FAR - FLEET_FADE_NEAR)));
  return 1 - t * t * (3 - 2 * t);
}

// A fleet boat whose deck lights are on (and that has a beam), at this distance from the camera.
export interface FleetCandidate {
  id: string;
  distance: number; // m
}

interface FleetLightSlot {
  id: string | null; // the boat holding this light
  level: number; // 0..1 fade (handover), × fleetDistanceFade for the intensity
}

export interface FleetLightState {
  slots: FleetLightSlot[];
  eligible: Set<string>; // last update's candidates in range
}

export function createFleetLightState(count: number): FleetLightState {
  return {
    slots: Array.from({ length: Math.max(0, count) }, () => ({ id: null, level: 0 })),
    eligible: new Set(),
  };
}

// One frame: the nearest candidates (holders ranked FLEET_HYSTERESIS nearer) want the lights. A
// holder that's no longer wanted fades out and frees its light, which the waiting boat then fades
// in; a boat whose lights switched off, that left or went out of range lets go at once. A boat that
// wasn't a candidate last frame (its lights just came on) takes a free light at full level, so the
// fleet's lights come on with the switch rather than fading up after it.
export function updateFleetLights(
  state: FleetLightState,
  candidates: readonly FleetCandidate[],
  dt: number,
): void {
  const inRange = candidates.filter((c) => c.distance < FLEET_FADE_FAR);
  const ids = new Set(inRange.map((c) => c.id));
  const held = new Set<string>();
  for (const slot of state.slots) {
    if (slot.id !== null && !ids.has(slot.id)) {
      slot.id = null;
      slot.level = 0;
    }
    if (slot.id !== null) held.add(slot.id);
  }
  const rank = (c: FleetCandidate): number => (held.has(c.id) ? c.distance * FLEET_HYSTERESIS : c.distance);
  const wanted = new Set(
    [...inRange]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, state.slots.length)
      .map((c) => c.id),
  );
  const step = dt / FLEET_FADE_TIME;
  for (const slot of state.slots) {
    if (slot.id === null) continue;
    if (wanted.has(slot.id)) {
      slot.level = Math.min(1, slot.level + step);
      continue;
    }
    slot.level -= step;
    if (slot.level <= 0) {
      held.delete(slot.id);
      slot.id = null;
      slot.level = 0;
    }
  }
  for (const id of wanted) {
    if (held.has(id)) continue;
    const free = state.slots.find((s) => s.id === null);
    if (!free) break;
    free.id = id;
    free.level = state.eligible.has(id) ? Math.min(1, step) : 1;
  }
  state.eligible = ids;
}
