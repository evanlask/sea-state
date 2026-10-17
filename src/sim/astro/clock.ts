// Simulation calendar clock in local mean solar time.
//
// Scenarios specify a date and a local solar time of day at the region's
// longitude; there are no time zones. UTC = local mean solar time − longitude/15 h
// (longitude east positive). The clock is pure: it only moves when advance()
// is called with a real-time step, so it is deterministic and testable.

import { TWO_PI } from '../core/conventions';
import { JD_UNIX_EPOCH, MS_PER_DAY, SECONDS_PER_DAY } from './time';

export const MAX_TIME_SCALE = 3600;

export interface CalendarDate {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

export interface SimClockOptions {
  date: string; // YYYY-MM-DD, local solar date
  timeOfDay: number; // local solar hours, [0, 24)
  longitude: number; // radians, east positive
  timeScale?: number; // sim seconds per real second, 0–MAX_TIME_SCALE (default 1)
}

// Parses a strict YYYY-MM-DD string; null for malformed or impossible dates.
export function parseIsoDate(value: string): CalendarDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

export function formatIsoDate(date: CalendarDate): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
}

// Whole days since 1970-01-01 (proleptic Gregorian), negative before.
const dayIndexOf = (date: CalendarDate): number =>
  Math.round(Date.UTC(date.year, date.month - 1, date.day) / MS_PER_DAY);

function calendarOf(dayIndex: number): CalendarDate {
  const d = new Date(dayIndex * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export class SimClock {
  private dayIndex = 0; // local solar date, days since 1970-01-01
  private secondsOfDay = 0; // local mean solar seconds into the day, [0, 86400)
  private scale = 1;
  private lon = 0;

  constructor(options: SimClockOptions) {
    this.lon = options.longitude;
    this.setDate(options.date);
    this.setTimeOfDay(options.timeOfDay);
    this.timeScale = options.timeScale ?? 1;
  }

  get timeScale(): number {
    return this.scale;
  }

  // Clamped to [0, MAX_TIME_SCALE]; 0 freezes the sky.
  set timeScale(value: number) {
    this.scale = Number.isFinite(value) ? Math.min(MAX_TIME_SCALE, Math.max(0, value)) : 1;
  }

  get longitude(): number {
    return this.lon;
  }

  // Moving to a new region keeps the local solar date and time, so "10:30 in
  // the Caribbean" stays 10:30 after switching regions.
  set longitude(value: number) {
    this.lon = value;
  }

  // Advances by a real-time step (seconds), scaled, rolling the date over in
  // either direction. Returns the simulated seconds elapsed.
  advance(realDt: number): number {
    const simDt = realDt * this.scale;
    this.addSeconds(simDt);
    return simDt;
  }

  // Jumps by simulated seconds, ignoring the time scale.
  addSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    const total = this.secondsOfDay + seconds;
    const days = Math.floor(total / SECONDS_PER_DAY);
    this.dayIndex += days;
    this.secondsOfDay = total - days * SECONDS_PER_DAY;
    // Guard float round-off landing exactly on the next midnight.
    if (this.secondsOfDay >= SECONDS_PER_DAY) {
      this.secondsOfDay -= SECONDS_PER_DAY;
      this.dayIndex += 1;
    }
  }

  // Local solar hours; values outside [0, 24) wrap without changing the date.
  setTimeOfDay(hours: number): void {
    if (!Number.isFinite(hours)) return;
    const seconds = (((hours * 3600) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
    this.secondsOfDay = seconds;
  }

  // Throws on malformed input so bad scenario data fails loudly at load.
  setDate(value: string | CalendarDate): void {
    const date = typeof value === 'string' ? parseIsoDate(value) : value;
    if (!date) throw new Error(`Invalid date ${JSON.stringify(value)}, expected YYYY-MM-DD`);
    this.dayIndex = dayIndexOf(date);
  }

  get localSolarHours(): number {
    return this.secondsOfDay / 3600;
  }

  get date(): CalendarDate {
    return calendarOf(this.dayIndex);
  }

  get dateString(): string {
    return formatIsoDate(this.date);
  }

  // 1 on 1 January of the local solar date.
  get dayOfYear(): number {
    const { year } = this.date;
    return this.dayIndex - dayIndexOf({ year, month: 1, day: 1 }) + 1;
  }

  // Milliseconds since the Unix epoch, UTC.
  get utcMs(): number {
    const localSeconds = this.dayIndex * SECONDS_PER_DAY + this.secondsOfDay;
    return (localSeconds - (this.lon / TWO_PI) * SECONDS_PER_DAY) * 1000;
  }

  // Allocates; prefer julianDay or utcMs in per-frame code.
  get utcDate(): Date {
    return new Date(this.utcMs);
  }

  get julianDay(): number {
    return this.utcMs / MS_PER_DAY + JD_UNIX_EPOCH;
  }
}
