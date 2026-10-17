// Weather preset metadata for the menus, the custom-weather input model with its
// validation, and the auto sea-state estimate shown next to the sea-state controls. Pure: the
// simulation owns the real weather model; this only describes and sanitizes choices.

import { knotsToMs, msToKnots } from '../../sim/core/units';
import { getWeatherPreset } from '../../sim/weather/presets';
import { autoSeaBulk, HS_CAP, resolveSeaState } from '../../sim/weather/seaState';
import {
  BEAUFORT,
  beaufortFromWind,
  DOUGLAS as SIM_DOUGLAS,
  douglasFromHs,
  douglasRepresentativeHs,
} from '../../sim/weather/tables';

export const WEATHER_PRESET_IDS = [
  'glassy-calm',
  'fair',
  'breezy',
  'near-gale',
  'gale',
  'storm',
  'hurricane-1',
  'hurricane-3',
  'hurricane-5',
  'overcast-drizzle',
  'fog-bank',
  'long-swell',
  'cross-seas',
  'squalls',
  'night-thunderstorm',
  'custom',
] as const;
export type WeatherPresetId = (typeof WEATHER_PRESET_IDS)[number];

export const isWeatherPresetId = (value: unknown): value is WeatherPresetId =>
  typeof value === 'string' && (WEATHER_PRESET_IDS as readonly string[]).includes(value);

export interface WeatherPresetInfo {
  id: WeatherPresetId;
  name: string;
  windKn: number;
  gustKn?: number;
  hsM: number; // typical significant wave height
  swell?: string;
  sky: string;
  visibility?: string;
  storm: boolean; // eligible for Storm Survival
  oneMinuteKn?: number; // hurricanes: the category's 1-minute sustained wind (windKn is the 10-minute mean)
}

// Descriptive copy per preset; wind, gust and Hs are filled in from the simulation's presets below so
// the cards always show what the ocean will actually do.
const PRESET_COPY: Readonly<Record<WeatherPresetId, WeatherPresetInfo>> = {
  'glassy-calm': {
    id: 'glassy-calm',
    name: 'Glassy Calm',
    windKn: 1,
    hsM: 0.1,
    sky: 'Clear, a few cirrus',
    storm: false,
  },
  fair: { id: 'fair', name: 'Fair', windKn: 8, hsM: 0.6, sky: 'Scattered cumulus', storm: false },
  breezy: { id: 'breezy', name: 'Breezy', windKn: 18, hsM: 2, sky: 'Broken cumulus', storm: false },
  'overcast-drizzle': {
    id: 'overcast-drizzle',
    name: 'Overcast Drizzle',
    windKn: 12,
    hsM: 1,
    sky: 'Stratus and drizzle',
    visibility: '5 km',
    storm: false,
  },
  squalls: {
    id: 'squalls',
    name: 'Squalls',
    windKn: 24,
    gustKn: 35,
    hsM: 3,
    sky: 'Cumulonimbus cells, showers',
    storm: true,
  },
  'near-gale': {
    id: 'near-gale',
    name: 'Near Gale',
    windKn: 30,
    hsM: 5,
    sky: 'Broken stratocumulus, showers',
    visibility: '8 km',
    storm: true,
  },
  gale: {
    id: 'gale',
    name: 'Gale',
    windKn: 38,
    hsM: 5.5,
    sky: 'Nimbostratus, rain',
    visibility: '2 km',
    storm: true,
  },
  storm: {
    id: 'storm',
    name: 'Storm',
    windKn: 52,
    hsM: 9,
    sky: 'Nimbostratus, heavy rain',
    visibility: '1 km',
    storm: true,
  },
  'hurricane-1': {
    id: 'hurricane-1',
    name: 'Hurricane · Cat 1',
    windKn: 65,
    hsM: 8.5,
    sky: 'Torrential rain, spume',
    visibility: '500 m',
    storm: true,
  },
  'hurricane-3': {
    id: 'hurricane-3',
    name: 'Hurricane · Cat 3',
    windKn: 98,
    hsM: 13,
    sky: 'Torrential rain, spume',
    visibility: '300 m',
    storm: true,
  },
  'hurricane-5': {
    id: 'hurricane-5',
    name: 'Hurricane · Cat 5',
    windKn: 135,
    hsM: 17.5,
    sky: 'Torrential rain, white-out spume',
    visibility: '150 m',
    storm: true,
  },
  'fog-bank': {
    id: 'fog-bank',
    name: 'Fog Bank',
    windKn: 4,
    hsM: 0.2,
    swell: 'low swell',
    sky: 'Thick fog',
    visibility: '150–300 m',
    storm: false,
  },
  'long-swell': {
    id: 'long-swell',
    name: 'Long Ocean Swell',
    windKn: 6,
    hsM: 3,
    swell: '3 m swell, 14 s',
    sky: 'Fair',
    storm: false,
  },
  'cross-seas': {
    id: 'cross-seas',
    name: 'Cross Seas',
    windKn: 17,
    hsM: 4.8,
    swell: '4.5 m swell, 12 s, 75° to the wind',
    sky: 'Clearing cumulus',
    storm: false,
  },
  'night-thunderstorm': {
    id: 'night-thunderstorm',
    name: 'Night Thunderstorm',
    windKn: 25,
    gustKn: 45,
    hsM: 3.5,
    sky: 'Cumulonimbus with lightning',
    storm: true,
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    windKn: 0,
    hsM: 0,
    sky: 'Set every parameter yourself',
    storm: false,
  },
};

function withSimNumbers(info: WeatherPresetInfo): WeatherPresetInfo {
  if (info.id === 'custom') return info;
  const preset = getWeatherPreset(info.id);
  const windKn = msToKnots(preset.windSpeed);
  const sea = resolveSeaState(preset.seaState, preset.windSpeed, preset.windFrom);
  const gustKn = preset.gustFactor >= 1.4 ? Math.round(windKn * preset.gustFactor) : undefined;
  return {
    ...info,
    windKn,
    ...(gustKn === undefined ? {} : { gustKn }),
    ...(preset.oneMinuteKnots === undefined ? {} : { oneMinuteKn: preset.oneMinuteKnots }),
    hsM: sea.totalHs,
  };
}

export const WEATHER_PRESETS: Readonly<Record<WeatherPresetId, WeatherPresetInfo>> = Object.fromEntries(
  WEATHER_PRESET_IDS.map((id) => [id, withSimNumbers(PRESET_COPY[id])]),
) as Record<WeatherPresetId, WeatherPresetInfo>;

export const weatherPresets = (): WeatherPresetInfo[] => WEATHER_PRESET_IDS.map((id) => WEATHER_PRESETS[id]);
export const stormPresets = (): WeatherPresetInfo[] => weatherPresets().filter((preset) => preset.storm);

export function beaufort(windKn: number): number {
  return beaufortFromWind(knotsToMs(Math.max(0, windKn))).force;
}

export const beaufortName = (force: number): string =>
  BEAUFORT[Math.max(0, Math.min(12, Math.round(force)))]?.name ?? 'Hurricane force';

const fmtKn = (kn: number): string => (kn < 3 ? '0–2' : String(Math.round(kn)));
const fmtHs = (hs: number): string => (hs < 1 ? hs.toFixed(1) : String(Math.round(hs * 2) / 2));

// One-line summary for preset cards, e.g. "18 kn (F5) · Hs ~2 m".
export function describePreset(preset: WeatherPresetInfo): string {
  if (preset.id === 'custom') return 'Wind, cloud, rain, visibility and lightning sliders';
  const gust = preset.gustKn ? ` gusting ${preset.gustKn}` : '';
  // Non-breaking spaces keep each value with its unit when the card text wraps.
  const wind = `${fmtKn(preset.windKn)}\u00a0kn${gust} (F${beaufort(preset.windKn)})`;
  return `${wind} · Hs\u00a0~${fmtHs(preset.hsM)}\u00a0m`;
}

export function presetDetail(preset: WeatherPresetInfo): string {
  return [
    preset.oneMinuteKn ? `1-min sustained ${preset.oneMinuteKn}\u00a0kn` : '',
    preset.sky,
    preset.swell,
    preset.visibility ? `visibility ${preset.visibility}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Custom weather

export const CLOUD_TYPES = [
  'clear',
  'cirrus',
  'cumulus',
  'stratocumulus',
  'stratus',
  'nimbostratus',
  'cumulonimbus',
] as const;
export type CloudType = (typeof CLOUD_TYPES)[number];

export interface CustomWeather {
  windKn: number; // mean at 10 m
  windFromDeg: number; // direction the wind blows from, °T
  gustKn: number; // peak gust, ≥ mean
  cloudCover: number; // 0–1
  cloudType: CloudType;
  rain: number; // 0 none … 1 torrential
  visibilityKm: number;
  lightning: number; // 0 none … 1 continuous
}

export const CUSTOM_LIMITS = {
  windKn: { min: 0, max: 160, step: 1 },
  windFromDeg: { min: 0, max: 359, step: 5 },
  gustKn: { min: 0, max: 200, step: 1 },
  cloudCover: { min: 0, max: 1, step: 0.05 },
  rain: { min: 0, max: 1, step: 0.05 },
  visibilityKm: { min: 0.05, max: 50, step: 0.05 },
  lightning: { min: 0, max: 1, step: 0.05 },
} as const;

export const defaultCustomWeather = (): CustomWeather => ({
  windKn: 15,
  windFromDeg: 225,
  gustKn: 20,
  cloudCover: 0.4,
  cloudType: 'cumulus',
  rain: 0,
  visibilityKm: 20,
  lightning: 0,
});

export interface Validated<T> {
  value: T;
  issues: string[]; // human-readable notes about anything that was corrected
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

function readNumber(
  source: Record<string, unknown>,
  key: keyof typeof CUSTOM_LIMITS,
  fallback: number,
): number {
  const raw = source[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Corrects rather than rejects: the sliders can't produce bad values, but saved setups and
// URL params can. Physically inconsistent combinations are fixed and reported.
export function validateCustomWeather(input: unknown): Validated<CustomWeather> {
  const base = defaultCustomWeather();
  const source = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const issues: string[] = [];
  const out = { ...base };
  for (const key of Object.keys(CUSTOM_LIMITS) as (keyof typeof CUSTOM_LIMITS)[]) {
    const limits = CUSTOM_LIMITS[key];
    const raw = readNumber(source, key, base[key]);
    const value = clamp(raw, limits.min, limits.max);
    if (value !== raw) issues.push(`${key} limited to ${limits.min}–${limits.max}`);
    out[key] = value;
  }
  out.windFromDeg = ((Math.round(out.windFromDeg) % 360) + 360) % 360;
  const cloud = source.cloudType;
  if (typeof cloud === 'string' && (CLOUD_TYPES as readonly string[]).includes(cloud))
    out.cloudType = cloud as CloudType;
  if (out.gustKn < out.windKn) {
    out.gustKn = out.windKn;
    if (source.gustKn !== undefined) issues.push('Gusts raised to the mean wind');
  }
  if (out.cloudType === 'clear') {
    if (out.rain > 0 || out.lightning > 0) issues.push('Clear skies cannot rain or flash; cleared');
    out.cloudCover = 0;
    out.rain = 0;
    out.lightning = 0;
  }
  if (out.lightning > 0 && out.cloudType !== 'cumulonimbus') {
    out.cloudType = 'cumulonimbus';
    issues.push('Lightning needs cumulonimbus; cloud type changed');
  }
  if (out.cloudCover === 0 && out.cloudType !== 'clear') out.cloudType = 'clear';
  return { value: out, issues };
}

// ---------------------------------------------------------------------------------------------
// Sea state

// Douglas / WMO 3700 sea state codes with their Hs ranges (m), from the simulation's table.
export const DOUGLAS: readonly { code: number; name: string; min: number; max: number }[] = SIM_DOUGLAS.map(
  (d) => ({ code: d.code, name: d.name, min: d.minHs, max: Number.isFinite(d.maxHs) ? d.maxHs : 20 }),
);

export function douglasCode(hs: number): number {
  return douglasFromHs(hs).code;
}

// Representative Hs for a Douglas code, as the simulation uses it.
export function hsForDouglas(code: number): number {
  return douglasRepresentativeHs(Math.max(0, Math.min(9, Math.round(code))));
}

// Hurricane seas top out around 18–20 m (Ivan 17.9 m); the simulation soft-caps at this height.
export const HS_CAP_M = HS_CAP;

export interface SeaEstimate {
  hs: number;
  tp: number;
  douglas: number;
}

// The simulation's own auto sea state: the smaller of Pierson-Moskowitz (fully developed) and JONSWAP
// (fetch-limited), soft-capped for hurricane winds.
export function estimateSea(windKn: number, fetchKm: number, fullyDeveloped: boolean): SeaEstimate {
  const bulk = autoSeaBulk(knotsToMs(Math.max(0, windKn)), Math.max(1, fetchKm) * 1000, fullyDeveloped);
  return { hs: bulk.hs, tp: bulk.tp, douglas: douglasCode(bulk.hs) };
}
