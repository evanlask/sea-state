// Weather presets: wind, sea state, sky and precipitation for each named
// scenario. Directions are meteorological "from".

import { DEG } from '../core/conventions';
import { knotsToMs } from '../core/units';
import { DEFAULT_FETCH, type SeaStateSettings } from './seaState';

export type CloudType =
  | 'clear'
  | 'cirrus'
  | 'cumulus'
  | 'stratocumulus'
  | 'stratus'
  | 'nimbostratus'
  | 'cumulonimbus';

export interface WeatherPreset {
  id: string;
  name: string;
  description: string;
  windSpeed: number; // m/s at 10 m
  gustFactor: number; // peak gust / mean
  windFrom: number; // radians
  seaState: SeaStateSettings;
  clouds: { type: CloudType; coverage: number; base: number }; // coverage 0..1, base m
  precipitation: number; // 0 dry .. 1 torrential
  visibility: number; // m
  lightningPerMinute: number;
  fog: number; // 0..1 extra near-surface fog density
  oneMinuteKnots?: number; // hurricanes: the category's 1-minute sustained wind, for display
}

// The wind model takes 10-minute means; the Saffir-Simpson scale is defined on 1-minute sustained winds.
// At sea the 10-minute mean is about 0.93 of the 1-minute wind (WMO; Harper et al. 2010).
export const TEN_MINUTE_PER_ONE_MINUTE = 0.93;
// Cross Seas: the leftover swell comes from this far to the right of the new wind, degrees.
export const CROSS_SEAS_ANGLE_DEG = 75;

const HURRICANE_FETCH = 250_000; // m: storm-relative effective fetch keeps Hs realistic

const auto = (fetch = DEFAULT_FETCH, swell: SeaStateSettings['swell'] = null): SeaStateSettings => ({
  mode: 'auto',
  fetch,
  fullyDeveloped: false,
  swell,
});

const preset = (p: Omit<WeatherPreset, 'windSpeed'> & { windKnots: number }): WeatherPreset => {
  const { windKnots, ...rest } = p;
  return { ...rest, windSpeed: knotsToMs(windKnots) };
};

// A hurricane's 10-minute mean wind from its category's 1-minute sustained wind (knots).
const hurricaneWind = (oneMinuteKnots: number): { windKnots: number; oneMinuteKnots: number } => ({
  windKnots: oneMinuteKnots * TEN_MINUTE_PER_ONE_MINUTE,
  oneMinuteKnots,
});

// By strength, then the specials.
export const WEATHER_PRESETS: readonly WeatherPreset[] = [
  preset({
    id: 'glassy-calm',
    name: 'Glassy Calm',
    description: 'Barely a breath of wind; the sea is a mirror.',
    windKnots: 1.5,
    gustFactor: 1.1,
    windFrom: 200 * DEG,
    seaState: auto(DEFAULT_FETCH, { height: 0.3, period: 11, from: 250 * DEG }),
    clouds: { type: 'cirrus', coverage: 0.1, base: 9000 },
    precipitation: 0,
    visibility: 40_000,
    lightningPerMinute: 0,
    fog: 0,
  }),
  preset({
    id: 'fair',
    name: 'Fair',
    description: 'Gentle breeze, scattered fair-weather cumulus. Force 3.',
    windKnots: 8,
    gustFactor: 1.2,
    windFrom: 225 * DEG,
    seaState: auto(),
    clouds: { type: 'cumulus', coverage: 0.25, base: 900 },
    precipitation: 0,
    visibility: 30_000,
    lightningPerMinute: 0,
    fog: 0,
  }),
  preset({
    id: 'breezy',
    name: 'Breezy',
    description: 'Fresh breeze with white horses everywhere. Force 5.',
    windKnots: 18,
    gustFactor: 1.3,
    windFrom: 240 * DEG,
    seaState: auto(),
    clouds: { type: 'cumulus', coverage: 0.5, base: 800 },
    precipitation: 0,
    visibility: 25_000,
    lightningPerMinute: 0,
    fog: 0,
  }),
  preset({
    id: 'near-gale',
    name: 'Near Gale',
    description: 'Near gale force 7: sea heaps up, foam begins to streak; passing showers.',
    windKnots: 30,
    gustFactor: 1.35,
    windFrom: 245 * DEG,
    seaState: auto(),
    clouds: { type: 'stratocumulus', coverage: 0.75, base: 600 },
    precipitation: 0.3,
    visibility: 8000,
    lightningPerMinute: 0,
    fog: 0.1,
  }),
  preset({
    id: 'gale',
    name: 'Gale',
    description: 'Gale force 8: spray streaks, breaking crests, steady rain.',
    windKnots: 38,
    gustFactor: 1.35,
    windFrom: 250 * DEG,
    seaState: auto(),
    clouds: { type: 'nimbostratus', coverage: 1, base: 450 },
    precipitation: 0.6,
    visibility: 2000,
    lightningPerMinute: 0,
    fog: 0.3,
  }),
  preset({
    id: 'storm',
    name: 'Storm',
    description: 'Storm force 10: very high seas and heavy rain.',
    windKnots: 52,
    gustFactor: 1.35,
    windFrom: 260 * DEG,
    seaState: auto(),
    clouds: { type: 'nimbostratus', coverage: 1, base: 350 },
    precipitation: 0.8,
    visibility: 1000,
    // Mid-latitude storms rain from nimbostratus and rarely flash.
    lightningPerMinute: 0,
    fog: 0.45,
  }),
  preset({
    id: 'hurricane-1',
    name: 'Hurricane Category 1',
    description: 'Category 1 hurricane: 1-minute sustained winds of 70 knots. Spume fills the air.',
    ...hurricaneWind(70),
    gustFactor: 1.3,
    windFrom: 110 * DEG,
    seaState: auto(HURRICANE_FETCH),
    clouds: { type: 'cumulonimbus', coverage: 1, base: 400 },
    precipitation: 0.9,
    visibility: 500,
    lightningPerMinute: 2,
    fog: 0.6,
  }),
  preset({
    id: 'hurricane-3',
    name: 'Hurricane Category 3',
    description: 'Category 3 hurricane: 1-minute sustained winds of 105 knots. Few boats survive this.',
    ...hurricaneWind(105),
    gustFactor: 1.3,
    windFrom: 110 * DEG,
    seaState: auto(HURRICANE_FETCH),
    clouds: { type: 'cumulonimbus', coverage: 1, base: 350 },
    precipitation: 1,
    visibility: 300,
    lightningPerMinute: 3,
    fog: 0.75,
  }),
  preset({
    id: 'hurricane-5',
    name: 'Hurricane Category 5',
    description: 'Category 5 hurricane: 1-minute sustained winds of 145 knots. Utterly catastrophic.',
    ...hurricaneWind(145),
    gustFactor: 1.3,
    windFrom: 110 * DEG,
    seaState: auto(HURRICANE_FETCH),
    clouds: { type: 'cumulonimbus', coverage: 1, base: 300 },
    precipitation: 1,
    visibility: 150,
    lightningPerMinute: 4,
    fog: 0.9,
  }),
  preset({
    id: 'overcast-drizzle',
    name: 'Overcast Drizzle',
    description: 'Low grey stratus and a steady drizzle. Force 4.',
    windKnots: 12,
    gustFactor: 1.2,
    windFrom: 200 * DEG,
    seaState: auto(),
    clouds: { type: 'stratus', coverage: 0.95, base: 350 },
    precipitation: 0.2,
    visibility: 5000,
    lightningPerMinute: 0,
    fog: 0.2,
  }),
  preset({
    id: 'fog-bank',
    name: 'Fog Bank',
    description: 'Light air and thick sea fog. Listen for other vessels.',
    windKnots: 4,
    gustFactor: 1.1,
    windFrom: 180 * DEG,
    seaState: auto(DEFAULT_FETCH, { height: 0.6, period: 9, from: 220 * DEG }),
    clouds: { type: 'stratus', coverage: 1, base: 80 },
    precipitation: 0,
    visibility: 220,
    lightningPerMinute: 0,
    fog: 1,
  }),
  preset({
    id: 'long-swell',
    name: 'Long Ocean Swell',
    description: 'Light wind over a big 14-second swell from a distant storm.',
    windKnots: 6,
    gustFactor: 1.15,
    windFrom: 160 * DEG,
    seaState: auto(DEFAULT_FETCH, { height: 3, period: 14, from: 250 * DEG }),
    clouds: { type: 'cumulus', coverage: 0.2, base: 1000 },
    precipitation: 0,
    visibility: 30_000,
    lightningPerMinute: 0,
    fog: 0,
  }),
  preset({
    id: 'cross-seas',
    name: 'Cross Seas',
    description:
      'After a storm, a big old swell runs across the new wind sea: meet the sets carefully. Force 5.',
    windKnots: 17,
    gustFactor: 1.25,
    windFrom: 230 * DEG,
    // The storm's 4.5 m, 12 s swell arrives 75° to the right of the new wind.
    seaState: auto(DEFAULT_FETCH, { height: 4.5, period: 12, from: (230 + CROSS_SEAS_ANGLE_DEG) * DEG }),
    clouds: { type: 'cumulus', coverage: 0.45, base: 900 },
    precipitation: 0,
    visibility: 30_000,
    lightningPerMinute: 0,
    fog: 0,
  }),
  preset({
    id: 'squalls',
    name: 'Squalls',
    description: 'Towering shower clouds and sudden gusts to 35 knots. Force 6–7.',
    windKnots: 24,
    gustFactor: 1.45,
    windFrom: 290 * DEG,
    seaState: auto(),
    clouds: { type: 'cumulonimbus', coverage: 0.6, base: 700 },
    precipitation: 0.5,
    visibility: 6000,
    lightningPerMinute: 0.5,
    fog: 0,
  }),
  preset({
    id: 'night-thunderstorm',
    name: 'Night Thunderstorm',
    description: 'A squall line at night: gusts to 45 knots, lightning all around.',
    windKnots: 25,
    gustFactor: 1.8,
    windFrom: 300 * DEG,
    seaState: auto(),
    clouds: { type: 'cumulonimbus', coverage: 0.9, base: 600 },
    precipitation: 0.85,
    visibility: 2500,
    lightningPerMinute: 6,
    fog: 0.1,
  }),
];

const FALLBACK_PRESET = WEATHER_PRESETS.find((p) => p.id === 'fair') as WeatherPreset;

// Unknown ids fall back to Fair.
export function getWeatherPreset(id: string): WeatherPreset {
  return WEATHER_PRESETS.find((p) => p.id === id) ?? FALLBACK_PRESET;
}
