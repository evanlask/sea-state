// What the player chose to sail in, plus deep-link parsing so any scenario opens from a URL, e.g.
//   ?boat=cargo&fleet=pwc,sail&weather=gale&time=18:30&cam=chase&quality=high&seed=1
import { isRegionId, REGIONS } from '../sim/astro/regions';
import { BOAT_KINDS, type BoatKind, type PhysicsMode } from '../sim/world/protocol';

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

export interface Scenario {
  seed: number;
  playerBoat: BoatKind;
  fleet: BoatKind[]; // additional boats spawned alongside the player
  weather: string; // weather preset id
  timeOfDay: number; // local solar hours, 0–24
  date: string; // YYYY-MM-DD, drives sun and moon positions
  region: string;
  physicsMode: PhysicsMode;
  camera: string;
}

export interface LaunchOptions {
  scenario: Scenario;
  quality: QualityPreset | null; // null = use saved settings
  simLocal: boolean; // run the simulation on the main thread
  debug: boolean;
  parity: boolean; // draw CPU-sampled water heights as markers on the GPU surface
  contrail: boolean; // a jet with its contrail passes overhead as the voyage starts
  skipMenu: boolean; // deep links jump straight into the scenario
}

export const defaultScenario = (): Scenario => ({
  seed: 1,
  playerBoat: 'powerboat',
  fleet: [],
  weather: 'fair',
  timeOfDay: 10.5,
  date: '2026-07-29', // full moon: a voyage that runs into the night has moonlight
  region: 'north-atlantic',
  physicsMode: 'arcade',
  camera: 'chase',
});

const isBoatKind = (value: string): value is BoatKind => (BOAT_KINDS as readonly string[]).includes(value);
const isQuality = (value: string): value is QualityPreset =>
  (QUALITY_PRESETS as readonly string[]).includes(value);

// "18:30" or "18.5" → 18.5 hours.
export function parseTimeOfDay(value: string): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  const hours = clock ? Number(clock[1]) + Number(clock[2]) / 60 : Number(value);
  return Number.isFinite(hours) && hours >= 0 && hours <= 24 ? hours : null;
}

export function parseLaunchOptions(search: string, base: Scenario = defaultScenario()): LaunchOptions {
  const params = new URLSearchParams(search);
  const scenario: Scenario = { ...base, fleet: [...base.fleet] };
  let skipMenu = false;

  const boat = params.get('boat');
  if (boat && isBoatKind(boat)) {
    scenario.playerBoat = boat;
    skipMenu = true;
  }
  const fleet = params.get('fleet');
  if (fleet) scenario.fleet = fleet.split(',').filter(isBoatKind);
  const weather = params.get('weather');
  if (weather) scenario.weather = weather;
  const time = params.get('time');
  const timeOfDay = time ? parseTimeOfDay(time) : null;
  if (timeOfDay !== null) scenario.timeOfDay = timeOfDay;
  else if (weather === 'night-thunderstorm') scenario.timeOfDay = 23;
  const date = params.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) scenario.date = date;
  const region = params.get('region');
  if (region) {
    scenario.region = region;
    // A region without a date sails in that region's season, as picking it in the menu does.
    if (isRegionId(region) && !params.has('date')) scenario.date = REGIONS[region].defaultDate;
  }
  const physics = params.get('physics');
  if (physics === 'arcade' || physics === 'realistic') scenario.physicsMode = physics;
  const camera = params.get('cam');
  if (camera) scenario.camera = camera;
  const seed = Number(params.get('seed'));
  if (params.has('seed') && Number.isInteger(seed)) scenario.seed = seed;

  const quality = params.get('quality');
  return {
    scenario,
    quality: quality && isQuality(quality) ? quality : null,
    simLocal: params.get('sim') === 'local',
    debug: params.has('debug'),
    parity: params.has('parity'),
    contrail: params.has('contrail'),
    skipMenu: skipMenu || params.has('play'),
  };
}

// The scenario's own query keys; anything else in the URL (debug, quality, sim…) is left alone.
const SCENARIO_KEYS = [
  'boat',
  'fleet',
  'weather',
  'time',
  'date',
  'region',
  'physics',
  'cam',
  'seed',
  'play',
];

// The deep link for a scenario: parseLaunchOptions(scenarioSearch(s, …)) opens the same voyage.
// Pass null to strip the scenario keys (back at the main menu). Custom weather and manual sea
// sliders aren't in the link.
export function scenarioSearch(scenario: Scenario | null, current = ''): string {
  const params = new URLSearchParams(current);
  for (const key of SCENARIO_KEYS) params.delete(key);
  if (scenario) {
    const minutes = Math.round(scenario.timeOfDay * 60) % (24 * 60);
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    params.set('boat', scenario.playerBoat);
    if (scenario.fleet.length) params.set('fleet', scenario.fleet.join(','));
    params.set('weather', scenario.weather);
    params.set('time', time);
    params.set('date', scenario.date);
    params.set('region', scenario.region);
    params.set('physics', scenario.physicsMode);
    params.set('cam', scenario.camera);
    params.set('seed', String(scenario.seed));
  }
  const search = params
    .toString()
    .replaceAll('%2C', ',')
    .replaceAll('%3A', ':')
    .replace(/=(?=&|$)/g, ''); // bare flags stay bare
  return search ? `?${search}` : '';
}

// Approximate overall lengths, used for spacing boats in a formation.
export const BOAT_LENGTH: Record<BoatKind, number> = {
  cargo: 243,
  cruise: 317,
  crab: 38,
  sail: 11.5,
  powerboat: 10.1,
  pwc: 3.3,
  hydro: 9.4,
};

// Half the room a boat takes in the line abreast, m: a quarter of its length, at least 15 m; the
// hydroplane, at 70 kn and more, gets twice that to swerve in.
const FORMATION_ROOM: Partial<Record<BoatKind, number>> = { hydro: 30 };
const halfRoom = (kind: BoatKind): number =>
  Math.max(15, BOAT_LENGTH[kind] * 0.25, FORMATION_ROOM[kind] ?? 0);

export interface FormationSlot {
  kind: BoatKind;
  x: number;
  z: number;
}

// Player at the origin on `heading` (rad, default north); companions line abreast to starboard
// then port, spaced so even the biggest ships have room to manoeuvre.
export function formation(player: BoatKind, fleet: readonly BoatKind[], heading = 0): FormationSlot[] {
  // Starboard of a boat on `heading` is (cos, sin) in world x, z.
  const sx = Math.cos(heading);
  const sz = Math.sin(heading);
  const abeam = (kind: BoatKind, starboard: number): FormationSlot => ({
    kind,
    x: starboard * sx,
    z: starboard * sz + 0, // + 0 turns −0 into 0
  });
  const slots: FormationSlot[] = [{ kind: player, x: 0, z: 0 }];
  let starboardEdge = Math.max(BOAT_LENGTH[player] * 0.25, FORMATION_ROOM[player] ?? 0);
  let portEdge = -starboardEdge;
  fleet.forEach((kind, index) => {
    const halfWidth = halfRoom(kind);
    const gap = 30 + BOAT_LENGTH[kind] * 0.2;
    if (index % 2 === 0) {
      const offset = starboardEdge + gap + halfWidth;
      starboardEdge = offset + halfWidth;
      slots.push(abeam(kind, offset));
    } else {
      const offset = portEdge - gap - halfWidth;
      portEdge = offset - halfWidth;
      slots.push(abeam(kind, offset));
    }
  });
  return slots;
}

// A boat joining mid-voyage takes the next slot of formation()'s line abreast, with the same spacing,
// outboard of whichever flank of the current line is nearer the player. Returns its offset to
// starboard (+) or port (−) of the player's centreline, m.
export interface StationedBoat {
  kind: BoatKind;
  starboard: number; // m off the player's centreline, + to starboard
}

export function joiningStation(player: BoatKind, kind: BoatKind, others: readonly StationedBoat[]): number {
  const halfOf = halfRoom;
  let starboardEdge = Math.max(BOAT_LENGTH[player] * 0.25, FORMATION_ROOM[player] ?? 0);
  let portEdge = -starboardEdge;
  for (const boat of others) {
    starboardEdge = Math.max(starboardEdge, boat.starboard + halfOf(boat.kind));
    portEdge = Math.min(portEdge, boat.starboard - halfOf(boat.kind));
  }
  const halfWidth = halfOf(kind);
  const gap = 30 + BOAT_LENGTH[kind] * 0.2;
  return starboardEdge <= -portEdge ? starboardEdge + gap + halfWidth : portEdge - gap - halfWidth;
}
