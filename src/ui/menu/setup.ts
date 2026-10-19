// ScenarioSetup: everything the scenario setup screen chooses, as an extension of Scenario with
// the weather, sea-state and loading fields the integrator maps onto the simulation. Building,
// sanitizing (for "Continue" from storage) and validation live here so they're testable.

import { defaultScenario, type Scenario } from '../../app/Scenario';
import type { StorageLike } from '../../settings/store';
import { REGION_IDS, REGIONS, type RegionId } from '../../sim/astro/regions';
import { sunTimes } from '../../sim/astro/solar';
import { DEG } from '../../sim/core/conventions';
import { BOAT_KINDS, type BoatKind, type PhysicsMode } from '../../sim/world/protocol';
import { cardinal } from '../hud/format';
import {
  type CustomWeather,
  defaultCustomWeather,
  hsForDouglas,
  isWeatherPresetId,
  validateCustomWeather,
  WEATHER_PRESETS,
  type WeatherPresetId,
} from './weather';

export type GameMode = 'free-sail' | 'storm-survival';
const GAME_MODES: readonly GameMode[] = ['free-sail', 'storm-survival'];

type SeaMode = 'auto' | 'manual';
type CrestLength = 'short' | 'long';
type ManualSeaSpec = 'douglas' | 'hs';

export interface ManualSea {
  spec: ManualSeaSpec; // which of douglas / hs drives the wind-sea height
  douglas: number; // 0–9
  hs: number; // m
  tp: number; // s
  choppiness: number; // 0–1, horizontal displacement scale
  crest: CrestLength; // short = confused wind sea, long = clean swell-like crests
  directionOffsetDeg: number; // wind-sea direction relative to the wind, −90…90
  swellHeight: number; // m
  swellPeriod: number; // s
  swellFromDeg: number; // °T the swell comes from
}

export interface SeaSetup {
  mode: SeaMode;
  fetchKm: number; // auto
  fullyDeveloped: boolean; // auto: ignore fetch, use Pierson-Moskowitz
  manual: ManualSea;
}

type CargoLoad = 'laden' | 'ballast';

interface LoadingCondition {
  cargo: CargoLoad; // container ship
  crabPots: number; // crab boat, 0–200 pots at ~340 kg each
}

export interface ScenarioSetup extends Scenario {
  mode: GameMode;
  weather: WeatherPresetId;
  region: RegionId;
  customWeather: CustomWeather; // used when weather === 'custom', kept otherwise for next time
  sea: SeaSetup;
  loading: LoadingCondition;
}

// The pause-menu subset that can change without restarting.
export type Conditions = Pick<ScenarioSetup, 'weather' | 'customWeather' | 'sea' | 'timeOfDay' | 'date'>;

export const MAX_FLEET = 7; // companions, so eight boats in all
const MAX_CRAB_POTS = 200;

export const LIMITS = {
  fetchKm: { min: 10, max: 1000, step: 10 },
  douglas: { min: 0, max: 9, step: 1 },
  hs: { min: 0, max: 20, step: 0.1 },
  tp: { min: 2, max: 25, step: 0.5 },
  choppiness: { min: 0, max: 1, step: 0.05 },
  directionOffsetDeg: { min: -90, max: 90, step: 5 },
  swellHeight: { min: 0, max: 12, step: 0.1 },
  swellPeriod: { min: 6, max: 25, step: 0.5 },
  swellFromDeg: { min: 0, max: 355, step: 5 },
  crabPots: { min: 0, max: MAX_CRAB_POTS, step: 5 },
  timeOfDay: { min: 0, max: 24, step: 0.25 },
} as const;

export const defaultSea = (): SeaSetup => ({
  mode: 'auto',
  fetchKm: 400,
  fullyDeveloped: false,
  manual: {
    spec: 'douglas',
    douglas: 4,
    hs: 1.9,
    tp: 8,
    choppiness: 0.6,
    crest: 'short',
    directionOffsetDeg: 0,
    swellHeight: 1,
    swellPeriod: 12,
    swellFromDeg: 270,
  },
});

export function defaultSetup(base: Scenario = defaultScenario()): ScenarioSetup {
  const region = (REGION_IDS as readonly string[]).includes(base.region)
    ? (base.region as RegionId)
    : 'north-atlantic';
  return {
    ...base,
    fleet: [...base.fleet],
    mode: 'free-sail',
    weather: isWeatherPresetId(base.weather) ? base.weather : 'fair',
    region,
    customWeather: defaultCustomWeather(),
    sea: defaultSea(),
    loading: { cargo: 'laden', crabPots: 120 },
  };
}

// ---------------------------------------------------------------------------------------------
// Derived values

// Manual sea: the effective wind-sea Hs, whichever control drives it.
export const manualHs = (manual: ManualSea): number =>
  manual.spec === 'douglas' ? hsForDouglas(manual.douglas) : manual.hs;

export const isStormPreset = (id: WeatherPresetId): boolean => WEATHER_PRESETS[id].storm;

// Which loading controls apply to a set of boats (player + fleet).
export function loadingRelevance(boats: readonly BoatKind[]): { cargo: boolean; crabPots: boolean } {
  return { cargo: boats.includes('cargo'), crabPots: boats.includes('crab') };
}

export function formatClock(hours: number): string {
  const total = Math.round((((hours % 24) + 24) % 24) * 60);
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const parseDate = (date: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 ? d : null;
};

const isValidDate = (date: string): boolean => parseDate(date) !== null;

export function formatDate(date: string): string {
  const d = parseDate(date);
  return d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : date;
}

const DAY_MS = 86_400_000;

// Day of year (1-based) for a slider-friendly date slider.
export function dayOfYear(date: string): number {
  const d = parseDate(date) ?? new Date(Date.UTC(2026, 0, 1));
  return Math.round((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

export function dateFromDayOfYear(year: number, day: number): string {
  const clamped = Math.max(1, Math.min(daysInYear(year), Math.round(day)));
  return new Date(Date.UTC(year, 0, clamped)).toISOString().slice(0, 10);
}

export const yearOf = (date: string): number =>
  (parseDate(date) ?? new Date(Date.UTC(2026, 0, 1))).getUTCFullYear();

// ---------------------------------------------------------------------------------------------
// Sanitizing and validation

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isBoatKind = (v: unknown): v is BoatKind =>
  typeof v === 'string' && (BOAT_KINDS as readonly string[]).includes(v);

function num(
  source: Record<string, unknown>,
  key: string,
  fallback: number,
  limits: { min: number; max: number },
): number {
  const raw = source[key];
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(limits.max, Math.max(limits.min, n));
}

function pickOne<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

function sanitizeSea(input: unknown, base: SeaSetup): SeaSetup {
  const src = isObject(input) ? input : {};
  const m = isObject(src.manual) ? src.manual : {};
  const bm = base.manual;
  return {
    mode: pickOne(src.mode, ['auto', 'manual'] as const, base.mode),
    fetchKm: num(src, 'fetchKm', base.fetchKm, LIMITS.fetchKm),
    fullyDeveloped: typeof src.fullyDeveloped === 'boolean' ? src.fullyDeveloped : base.fullyDeveloped,
    manual: {
      spec: pickOne(m.spec, ['douglas', 'hs'] as const, bm.spec),
      douglas: Math.round(num(m, 'douglas', bm.douglas, LIMITS.douglas)),
      hs: num(m, 'hs', bm.hs, LIMITS.hs),
      tp: num(m, 'tp', bm.tp, LIMITS.tp),
      choppiness: num(m, 'choppiness', bm.choppiness, LIMITS.choppiness),
      crest: pickOne(m.crest, ['short', 'long'] as const, bm.crest),
      directionOffsetDeg: num(m, 'directionOffsetDeg', bm.directionOffsetDeg, LIMITS.directionOffsetDeg),
      swellHeight: num(m, 'swellHeight', bm.swellHeight, LIMITS.swellHeight),
      swellPeriod: num(m, 'swellPeriod', bm.swellPeriod, LIMITS.swellPeriod),
      swellFromDeg: num(m, 'swellFromDeg', bm.swellFromDeg, { min: 0, max: 359 }),
    },
  };
}

// Turns anything (a saved setup, a half-filled object) into a complete, valid ScenarioSetup.
export function sanitizeSetup(input: unknown, base: ScenarioSetup = defaultSetup()): ScenarioSetup {
  const src = isObject(input) ? input : {};
  const playerBoat = isBoatKind(src.playerBoat) ? src.playerBoat : base.playerBoat;
  const fleet = Array.isArray(src.fleet) ? src.fleet.filter(isBoatKind).slice(0, MAX_FLEET) : [...base.fleet];
  const loadingSrc = isObject(src.loading) ? src.loading : {};
  const date = typeof src.date === 'string' && isValidDate(src.date) ? src.date : base.date;
  const seed = typeof src.seed === 'number' && Number.isInteger(src.seed) ? src.seed : base.seed;
  return {
    seed,
    playerBoat,
    fleet,
    weather: isWeatherPresetId(src.weather) ? src.weather : base.weather,
    timeOfDay: num(src, 'timeOfDay', base.timeOfDay, LIMITS.timeOfDay),
    date,
    region: pickOne(src.region, REGION_IDS, base.region),
    physicsMode: pickOne<PhysicsMode>(src.physicsMode, ['arcade', 'realistic'], base.physicsMode),
    camera: typeof src.camera === 'string' && src.camera ? src.camera : base.camera,
    mode: pickOne(src.mode, GAME_MODES, base.mode),
    customWeather: validateCustomWeather(isObject(src.customWeather) ? src.customWeather : base.customWeather)
      .value,
    sea: sanitizeSea(src.sea, base.sea),
    loading: {
      cargo: pickOne(loadingSrc.cargo, ['laden', 'ballast'] as const, base.loading.cargo),
      crabPots: Math.round(num(loadingSrc, 'crabPots', base.loading.crabPots, LIMITS.crabPots)),
    },
  };
}

export interface SetupIssue {
  field: 'weather' | 'fleet' | 'date' | 'customWeather';
  message: string;
}

// Problems that block "Set sail" (the UI disables the button and shows the message).
export function validateSetup(setup: ScenarioSetup): SetupIssue[] {
  const issues: SetupIssue[] = [];
  if (setup.mode === 'storm-survival' && !isStormPreset(setup.weather)) {
    issues.push({
      field: 'weather',
      message: 'Storm Survival needs a storm: pick Near Gale, Squalls or worse.',
    });
  }
  if (setup.fleet.length > MAX_FLEET) {
    issues.push({ field: 'fleet', message: `At most ${MAX_FLEET} companion boats.` });
  }
  if (!isValidDate(setup.date)) issues.push({ field: 'date', message: 'Pick a valid date.' });
  if (setup.weather === 'custom') {
    for (const message of validateCustomWeather(setup.customWeather).issues) {
      issues.push({ field: 'customWeather', message });
    }
  }
  return issues;
}

// The final object handed to the integrator: sanitized (fleet capped at MAX_FLEET), and Storm
// Survival forced onto a storm preset.
export function buildScenarioSetup(draft: ScenarioSetup): ScenarioSetup {
  const setup = sanitizeSetup(structuredClone(draft));
  if (setup.mode === 'storm-survival' && !isStormPreset(setup.weather)) setup.weather = 'gale';
  return setup;
}

// The weather a region suggests for this game mode, or null to keep the current one (Storm Survival
// only takes storm presets).
export function typicalWeatherFor(region: RegionId, mode: GameMode): WeatherPresetId | null {
  const id = REGIONS[region].typicalWeather;
  if (!isWeatherPresetId(id)) return null;
  return mode === 'storm-survival' && !isStormPreset(id) ? null : id;
}

// Switching region moves the date to that region's typical season and, unless the player has
// already picked a weather this session (keepWeather), the weather to its typical weather.
export function withRegion(
  setup: ScenarioSetup,
  region: RegionId,
  options: { keepWeather?: boolean } = {},
): ScenarioSetup {
  const next = { ...setup, region, date: REGIONS[region].defaultDate };
  const typical = options.keepWeather ? null : typicalWeatherFor(region, setup.mode);
  if (typical) next.weather = typical;
  return next;
}

// The region's sea climate for its card: "Trade-wind swell 1.2 m · 8 s from ENE · usually Breezy".
export function describeRegionClimate(region: RegionId): string {
  const preset = REGIONS[region];
  const { label, height, period, fromDeg } = preset.swell;
  const typical = isWeatherPresetId(preset.typicalWeather) ? WEATHER_PRESETS[preset.typicalWeather].name : '';
  const swell = `${label} ${height.toFixed(1)} m · ${Math.round(period)} s from ${cardinal(fromDeg * DEG)}`;
  return typical ? `${swell} · usually ${typical}` : swell;
}

// The region's background swell for the sea-state readout: "2.5 m swell, 12 s from W (North Atlantic)".
export function regionSwellText(region: RegionId): string {
  const preset = REGIONS[region];
  const { height, period, fromDeg } = preset.swell;
  return `${height.toFixed(1)} m swell, ${Math.round(period)} s from ${cardinal(fromDeg * DEG)} (${preset.name})`;
}

export function conditionsOf(setup: ScenarioSetup): Conditions {
  return structuredClone({
    weather: setup.weather,
    customWeather: setup.customWeather,
    sea: setup.sea,
    timeOfDay: setup.timeOfDay,
    date: setup.date,
  });
}

// ---------------------------------------------------------------------------------------------
// "Continue": the last scenario, persisted

const LAST_SETUP_KEY = 'sea-state:last-setup';

export function saveLastSetup(storage: StorageLike | null | undefined, setup: ScenarioSetup): void {
  try {
    storage?.setItem(LAST_SETUP_KEY, JSON.stringify({ version: 1, setup }));
  } catch {
    // Storage full or disabled: Continue just won't be offered next time.
  }
}

export function loadLastSetup(storage: StorageLike | null | undefined): ScenarioSetup | null {
  try {
    const text = storage?.getItem(LAST_SETUP_KEY);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) && parsed.version === 1 && isObject(parsed.setup)
      ? sanitizeSetup(parsed.setup)
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Storm Survival local bests (filled in by the game; the menu only displays them)

export interface SurvivalResult {
  boat: BoatKind;
  weather: WeatherPresetId;
  survivedS: number;
  maxRollDeg: number;
  slams: number;
  greenWater: number;
  date: string; // when it was set
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Daylight hint for the time-of-day slider

export interface Daylight {
  sunrise: number | null; // local solar hours
  sunset: number | null;
  polar: 'polar-day' | 'polar-night' | null;
}

export function daylight(region: RegionId, date: string): Daylight {
  const d = parseDate(date);
  const preset = REGIONS[region];
  if (!d) return { sunrise: null, sunset: null, polar: null };
  const deg = Math.PI / 180;
  const times = sunTimes(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    preset.latitudeDeg * deg,
    preset.longitudeDeg * deg,
  );
  // Local mean solar time = UTC + longitude / 15 h.
  const local = (t: Date | null): number | null => {
    if (!t) return null;
    const utcHours = (t.getTime() - d.getTime()) / 3_600_000;
    return (((utcHours + preset.longitudeDeg / 15) % 24) + 24) % 24;
  };
  return { sunrise: local(times.sunrise), sunset: local(times.sunset), polar: times.polar };
}

// A dark time for presets that need one (Night Thunderstorm): the time as is if it's already over
// an hour from daylight, else two and a half hours after sunset, or the middle of the night if the
// night is shorter than five hours (23:00 when there are no sun times at all). There's no dark under
// the midnight sun, so local midnight, when the sun is lowest; polar night is dark except for the
// twilight round noon.
export function nightTimeFor(light: Daylight, timeOfDay: number): number {
  if (light.polar === 'polar-night') return Math.abs(timeOfDay - 12) > 3 ? timeOfDay : 23;
  if (light.sunrise === null || light.sunset === null) return light.polar === 'polar-day' ? 0 : 23;
  const dawn = light.sunrise - 1;
  const dusk = light.sunset + 1;
  const dark = dawn < dusk ? timeOfDay < dawn || timeOfDay > dusk : timeOfDay < dawn && timeOfDay > dusk;
  if (dark) return timeOfDay;
  const night = (((light.sunrise - light.sunset) % 24) + 24) % 24;
  const after = Math.min(2.5, night / 2);
  return (Math.round(((light.sunset + after) % 24) * 4) / 4) % 24;
}

export function describeDaylight(light: Daylight): string {
  if (light.polar === 'polar-day') return 'Midnight sun: the sun never sets';
  if (light.polar === 'polar-night') return 'Polar night: the sun never rises';
  if (light.sunrise === null || light.sunset === null) return '';
  return `Sunrise ${formatClock(light.sunrise)} · Sunset ${formatClock(light.sunset)}`;
}
