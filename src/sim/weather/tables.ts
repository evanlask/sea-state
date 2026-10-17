// Reference tables for wind and sea: Beaufort (WMO / Met Office), Douglas sea state (WMO code 3700)
// and Saffir-Simpson hurricane categories, plus lookups from SI values.

import { KNOT } from '../core/units';

export interface BeaufortEntry {
  force: number;
  name: string;
  minMs: number; // lower bound of the published range (inclusive, 0.1 m/s resolution)
  maxMs: number; // upper bound of the published range; Infinity for force 12
  minKn: number;
  maxKn: number;
  sea: string;
  probableWaveHeight: number; // m
  maxWaveHeight: number | null; // m; null where the table gives none (force 12)
}

export const BEAUFORT: readonly BeaufortEntry[] = [
  entry(0, 'Calm', 0, 0.2, 0, 0, 'Sea like a mirror', 0, 0),
  entry(1, 'Light air', 0.3, 1.5, 1, 3, 'Ripples with the appearance of scales; no foam crests', 0.1, 0.1),
  entry(
    2,
    'Light breeze',
    1.6,
    3.3,
    4,
    6,
    'Small wavelets, still short but more pronounced; crests have a glassy appearance and do not break',
    0.2,
    0.3,
  ),
  entry(
    3,
    'Gentle breeze',
    3.4,
    5.4,
    7,
    10,
    'Large wavelets; crests begin to break; foam of glassy appearance; perhaps scattered white horses',
    0.6,
    1.0,
  ),
  entry(
    4,
    'Moderate breeze',
    5.5,
    7.9,
    11,
    16,
    'Small waves, becoming longer; fairly frequent white horses',
    1,
    1.5,
  ),
  entry(
    5,
    'Fresh breeze',
    8.0,
    10.7,
    17,
    21,
    'Moderate waves taking a more pronounced long form; many white horses; chance of some spray',
    2,
    2.5,
  ),
  entry(
    6,
    'Strong breeze',
    10.8,
    13.8,
    22,
    27,
    'Large waves begin to form; white foam crests are more extensive everywhere; probably some spray',
    3,
    4,
  ),
  entry(
    7,
    'Near gale',
    13.9,
    17.1,
    28,
    33,
    'Sea heaps up and white foam from breaking waves begins to be blown in streaks along the wind',
    4,
    5.5,
  ),
  entry(
    8,
    'Gale',
    17.2,
    20.7,
    34,
    40,
    'Moderately high waves of greater length; crest edges break into spindrift; foam in well-marked streaks',
    5.5,
    7.5,
  ),
  entry(
    9,
    'Strong gale',
    20.8,
    24.4,
    41,
    47,
    'High waves; dense streaks of foam; crests begin to topple, tumble and roll over; spray may affect visibility',
    7,
    10,
  ),
  entry(
    10,
    'Storm',
    24.5,
    28.4,
    48,
    55,
    'Very high waves with long overhanging crests; sea takes on a white appearance; tumbling is heavy and shock-like',
    9,
    12.5,
  ),
  entry(
    11,
    'Violent storm',
    28.5,
    32.6,
    56,
    63,
    'Exceptionally high waves; sea completely covered with long white patches of foam; visibility affected',
    11.5,
    16,
  ),
  entry(
    12,
    'Hurricane force',
    32.7,
    Infinity,
    64,
    Infinity,
    'Air filled with foam and spray; sea completely white with driving spray; visibility very seriously affected',
    14,
    null,
  ),
];

function entry(
  force: number,
  name: string,
  minMs: number,
  maxMs: number,
  minKn: number,
  maxKn: number,
  sea: string,
  probableWaveHeight: number,
  maxWaveHeight: number | null,
): BeaufortEntry {
  return { force, name, minMs, maxMs, minKn, maxKn, sea, probableWaveHeight, maxWaveHeight };
}

// Published ranges have 0.1 m/s resolution, so split continuous values halfway between ranges.
export function beaufortFromWind(ms: number): BeaufortEntry {
  for (let force = BEAUFORT.length - 1; force > 0; force--) {
    const candidate = BEAUFORT[force];
    if (candidate !== undefined && ms >= candidate.minMs - 0.05) return candidate;
  }
  return BEAUFORT[0] as BeaufortEntry;
}

export interface DouglasEntry {
  code: number;
  name: string;
  minHs: number; // m, exclusive (except code 0)
  maxHs: number; // m, inclusive; Infinity for code 9
}

export const DOUGLAS: readonly DouglasEntry[] = [
  { code: 0, name: 'Calm (glassy)', minHs: 0, maxHs: 0 },
  { code: 1, name: 'Calm (rippled)', minHs: 0, maxHs: 0.1 },
  { code: 2, name: 'Smooth (wavelets)', minHs: 0.1, maxHs: 0.5 },
  { code: 3, name: 'Slight', minHs: 0.5, maxHs: 1.25 },
  { code: 4, name: 'Moderate', minHs: 1.25, maxHs: 2.5 },
  { code: 5, name: 'Rough', minHs: 2.5, maxHs: 4 },
  { code: 6, name: 'Very rough', minHs: 4, maxHs: 6 },
  { code: 7, name: 'High', minHs: 6, maxHs: 9 },
  { code: 8, name: 'Very high', minHs: 9, maxHs: 14 },
  { code: 9, name: 'Phenomenal', minHs: 14, maxHs: Infinity },
];

// Below this the sea counts as glassy: a centimetre of significant height is invisible from a boat.
const GLASSY_HS = 0.01;

export function douglasFromHs(hs: number): DouglasEntry {
  if (hs < GLASSY_HS) return DOUGLAS[0] as DouglasEntry;
  for (let code = 1; code < DOUGLAS.length - 1; code++) {
    const candidate = DOUGLAS[code] as DouglasEntry;
    if (hs <= candidate.maxHs) return candidate;
  }
  return DOUGLAS[DOUGLAS.length - 1] as DouglasEntry;
}

// A representative Hs for a Douglas code (manual sea-state by code): the middle of the range, with
// code 9 set to the ~16 m of the most severe recorded hurricane seas.
export function douglasRepresentativeHs(code: number): number {
  const index = Math.min(DOUGLAS.length - 1, Math.max(0, Math.round(code)));
  if (index === 0) return 0;
  if (index === DOUGLAS.length - 1) return 16;
  const candidate = DOUGLAS[index] as DouglasEntry;
  return (candidate.minHs + candidate.maxHs) / 2;
}

export interface SaffirSimpsonEntry {
  category: number;
  minKn: number; // 1-minute sustained wind, inclusive
  maxKn: number; // inclusive; Infinity for category 5
}

const SAFFIR_SIMPSON: readonly SaffirSimpsonEntry[] = [
  { category: 1, minKn: 64, maxKn: 82 },
  { category: 2, minKn: 83, maxKn: 95 },
  { category: 3, minKn: 96, maxKn: 112 },
  { category: 4, minKn: 113, maxKn: 136 },
  { category: 5, minKn: 137, maxKn: Infinity },
];

// The scale is defined on whole knots, so round first. Null below hurricane force.
export function saffirSimpsonFromWind(ms: number): SaffirSimpsonEntry | null {
  const kn = Math.round(ms / KNOT);
  for (let i = SAFFIR_SIMPSON.length - 1; i >= 0; i--) {
    const candidate = SAFFIR_SIMPSON[i] as SaffirSimpsonEntry;
    if (kn >= candidate.minKn) return candidate;
  }
  return null;
}
