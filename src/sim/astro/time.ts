// Julian-day helpers shared by the astronomy modules.
//
// Everything here is UT (UTC with leap seconds ignored, which is far below the
// accuracy of the low-precision theories that use it). Angles are radians.

import { TWO_PI } from '../core/conventions';

export const MS_PER_DAY = 86_400_000;
export const SECONDS_PER_DAY = 86_400;
// Julian day of the Unix epoch, 1970-01-01T00:00Z.
export const JD_UNIX_EPOCH = 2_440_587.5;
// Julian day of J2000.0, 2000-01-01T12:00 TT.
export const JD_J2000 = 2_451_545;
const DAYS_PER_CENTURY = 36_525;
// TT − UT, seconds. Roughly constant at 69 s through the 2020s; the Moon moves
// ~0.01° in that time, so a constant is plenty for these theories.
export const DELTA_T_SECONDS = 69;

export const julianDayFromMs = (utcMs: number): number => utcMs / MS_PER_DAY + JD_UNIX_EPOCH;
export const julianDay = (date: Date): number => julianDayFromMs(date.getTime());
const msFromJulianDay = (jd: number): number => (jd - JD_UNIX_EPOCH) * MS_PER_DAY;
export const dateFromJulianDay = (jd: number): Date => new Date(msFromJulianDay(jd));

// Julian centuries since J2000.0.
export const julianCentury = (jd: number): number => (jd - JD_J2000) / DAYS_PER_CENTURY;

// Accepts either form so callers holding a Julian day avoid allocating Dates.
export type JulianInput = Date | number;
export const toJulianDay = (time: JulianInput): number => (typeof time === 'number' ? time : julianDay(time));

// Degrees → radians wrapped into [0, 2π). The published series are in degrees
// with huge linear rates, so wrap in degrees first to keep float precision.
export function degToRadWrapped(degrees: number): number {
  const r = ((degrees % 360) * Math.PI) / 180;
  return r < 0 ? r + TWO_PI : r;
}
