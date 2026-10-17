// Pure display formatting for the HUD: unit conversion, bearings, clock times and the
// Beaufort / Douglas tables. No DOM, so it is unit-tested directly.

import type { HudSettings, WindUnit } from '../../settings/schema';
import { DEG, normalizeHeading, signedAngle } from '../../sim/core/conventions';
import {
  convertLength,
  convertSpeed,
  type LengthUnit,
  NAUTICAL_MILE,
  type SpeedUnit,
} from '../../sim/core/units';

export type HudUnits = HudSettings['units'];

export const DEFAULT_UNITS: HudUnits = { speed: 'kn', length: 'm', wind: 'kn' };

const STATUTE_MILE = 1609.344;

export const SPEED_UNIT_LABEL: Readonly<Record<SpeedUnit, string>> = { kn: 'kn', mph: 'mph', kmh: 'km/h' };
const SPEED_LABEL = SPEED_UNIT_LABEL;

export interface Reading {
  value: string;
  unit: string;
}

export const joinReading = (r: Reading): string => (r.unit ? `${r.value} ${r.unit}` : r.value);

// One decimal below 100 so a slow ship still shows movement; whole numbers above.
export function speedReading(ms: number, unit: SpeedUnit): Reading {
  const v = Math.abs(convertSpeed(ms, unit));
  const value = v < 99.95 ? v.toFixed(1) : Math.round(v).toString();
  return { value: ms < 0 && v >= 0.05 ? `-${value}` : value, unit: SPEED_LABEL[unit] };
}

export const formatSpeed = (ms: number, unit: SpeedUnit): string => joinReading(speedReading(ms, unit));

// WMO upper limits of Beaufort forces 0–11 in m/s (10 m wind).
const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];

const BEAUFORT_NAMES: readonly string[] = [
  'Calm',
  'Light air',
  'Light breeze',
  'Gentle breeze',
  'Moderate breeze',
  'Fresh breeze',
  'Strong breeze',
  'Near gale',
  'Gale',
  'Strong gale',
  'Storm',
  'Violent storm',
  'Hurricane force',
];

export function beaufortFromMs(ms: number): number {
  const index = BEAUFORT_LIMITS.findIndex((limit) => ms < limit);
  return index === -1 ? 12 : index;
}

// The weather system names the force; the table only fills in when it sends none.
export function beaufortName(force: number, name = ''): string {
  return name || BEAUFORT_NAMES[clampIndex(force, BEAUFORT_NAMES.length)];
}

export const beaufortLabel = (force: number, name = ''): string =>
  `Force ${Math.round(force)} — ${beaufortName(force, name)}`;

// WMO sea-state code (Douglas sea scale): upper limits of Hs in metres for codes 0–8.
const DOUGLAS_LIMITS = [0.0001, 0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14];

const DOUGLAS_NAMES: readonly string[] = [
  'Calm (glassy)',
  'Calm (rippled)',
  'Smooth',
  'Slight',
  'Moderate',
  'Rough',
  'Very rough',
  'High',
  'Very high',
  'Phenomenal',
];

export function douglasFromHs(hs: number): number {
  const index = DOUGLAS_LIMITS.findIndex((limit) => hs < limit);
  return index === -1 ? 9 : index;
}

export function douglasName(code: number, name = ''): string {
  return name || DOUGLAS_NAMES[clampIndex(code, DOUGLAS_NAMES.length)];
}

function clampIndex(value: number, length: number): number {
  return Math.max(0, Math.min(length - 1, Math.round(value)));
}

export function windReading(ms: number, unit: WindUnit): Reading {
  switch (unit) {
    case 'kn':
      return { value: Math.round(convertSpeed(ms, 'kn')).toString(), unit: 'kn' };
    case 'ms':
      return { value: ms < 9.95 ? ms.toFixed(1) : Math.round(ms).toString(), unit: 'm/s' };
    case 'beaufort':
      return { value: `F${beaufortFromMs(ms)}`, unit: '' };
  }
}

export const formatWind = (ms: number, unit: WindUnit): string => joinReading(windReading(ms, unit));

export function formatLength(meters: number, unit: LengthUnit, decimals = 1): string {
  const v = convertLength(meters, unit);
  return `${v.toFixed(Math.abs(v) >= 100 ? 0 : decimals)} ${unit}`;
}

// Ranges follow the speed unit's family: nautical miles with knots, statute miles with mph,
// kilometres with km/h; close in they drop to the length unit.
export function formatRange(meters: number, units: HudUnits): string {
  const m = Math.max(0, meters);
  const big = (value: number, label: string): string =>
    `${value < 9.95 ? value.toFixed(1) : Math.round(value)} ${label}`;
  if (units.speed === 'kn' && m >= 0.2 * NAUTICAL_MILE) return big(m / NAUTICAL_MILE, 'nm');
  if (units.speed === 'mph' && m >= 0.2 * STATUTE_MILE) return big(m / STATUTE_MILE, 'mi');
  if (units.speed === 'kmh' && m >= 1000) return big(m / 1000, 'km');
  const short = convertLength(m, units.length);
  return `${Math.round(short / 10) * 10 || Math.round(short)} ${units.length}`;
}

export function formatVisibility(meters: number, units: HudUnits): string {
  if (meters >= 10_000) return units.speed === 'kn' ? '> 5 nm' : units.speed === 'mph' ? '> 6 mi' : '> 10 km';
  return formatRange(meters, units);
}

// Three-digit true bearing, '045°'. 359.6° rounds to '000°', not '360°'.
export function formatBearing(rad: number): string {
  const deg = Math.round(normalizeHeading(rad) / DEG) % 360;
  return `${deg.toString().padStart(3, '0')}°`;
}

// Relative angle with a side: '35° S', '120° P', '0°'.
export function formatSide(rad: number, decimals = 0): string {
  const deg = signedAngle(rad) / DEG;
  const text = Math.abs(deg).toFixed(decimals);
  if (Number(text) === 0) return `${(0).toFixed(decimals)}°`;
  return `${text}° ${deg > 0 ? 'S' : 'P'}`;
}

export function formatDegrees(rad: number, decimals = 0): string {
  const text = (rad / DEG).toFixed(decimals);
  return `${Number(text) === 0 ? (0).toFixed(decimals) : text}°`;
}

// Rate of turn in degrees per minute, as on a ship's ROT indicator.
export function formatRateOfTurn(radPerSec: number): string {
  const perMin = (radPerSec / DEG) * 60;
  const rounded = Math.round(Math.abs(perMin));
  if (rounded === 0) return '0°/min';
  return `${rounded}°/min ${perMin > 0 ? 'S' : 'P'}`;
}

export const formatPercent = (fraction: number): string => `${Math.round(fraction * 100)}%`;

// 'HH:MM' from minutes after midnight; wraps past midnight.
export function formatClock(minutes: number): string {
  const total = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

// '45 s' under a minute, else 'M:SS', for TCPA readouts.
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

const CARDINALS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

export function cardinal(rad: number): string {
  return CARDINALS[Math.round(normalizeHeading(rad) / (Math.PI / 8)) % 16];
}

// Where a target lies relative to the bow, in the words a lookout would use.
export function relativeSector(relative: number): string {
  const deg = signedAngle(relative) / DEG;
  const a = Math.abs(deg);
  const side = deg > 0 ? 'starboard' : 'port';
  if (a <= 10) return 'ahead';
  if (a < 67.5) return `${side} bow`;
  if (a <= 112.5) return `${side} beam`;
  if (a < 170) return `${side} quarter`;
  return 'astern';
}

const MOON_NAMES = [
  'New moon',
  'Waxing crescent',
  'First quarter',
  'Waxing gibbous',
  'Full moon',
  'Waning gibbous',
  'Last quarter',
  'Waning crescent',
];

export function moonPhaseName(phase: number): string {
  const p = ((phase % 1) + 1) % 1;
  return MOON_NAMES[Math.round(p * 8) % 8];
}

// Convenience for wave periods and other small, positive quantities.
export const formatSeconds = (s: number): string => `${s < 9.95 ? s.toFixed(1) : Math.round(s)} s`;
