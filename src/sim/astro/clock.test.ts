// SimClock tests: local solar time ↔ UTC, rollover and time scaling.

import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { formatIsoDate, MAX_TIME_SCALE, parseIsoDate, SimClock } from './clock';
import { JD_J2000 } from './time';

describe('SimClock', () => {
  it('converts local mean solar time to UTC by longitude', () => {
    // 75° W is five hours behind Greenwich.
    const clock = new SimClock({ date: '2026-03-15', timeOfDay: 12, longitude: -75 * DEG });
    expect(clock.utcDate.toISOString()).toBe('2026-03-15T17:00:00.000Z');
    // 150° E: local noon is 02:00 UTC the same day.
    clock.longitude = 150 * DEG;
    expect(clock.utcDate.toISOString()).toBe('2026-03-15T02:00:00.000Z');
    expect(clock.localSolarHours).toBe(12);
  });

  it('exposes the Julian day', () => {
    const clock = new SimClock({ date: '2000-01-01', timeOfDay: 12, longitude: 0 });
    expect(clock.julianDay).toBeCloseTo(JD_J2000, 9);
  });

  it('scales real time and clamps the scale', () => {
    const clock = new SimClock({ date: '2026-06-01', timeOfDay: 6, longitude: 0, timeScale: 60 });
    expect(clock.advance(30)).toBe(1800);
    expect(clock.localSolarHours).toBeCloseTo(6.5, 12);
    clock.timeScale = 1e6;
    expect(clock.timeScale).toBe(MAX_TIME_SCALE);
    clock.advance(1);
    expect(clock.localSolarHours).toBeCloseTo(7.5, 12);
    clock.timeScale = -5;
    expect(clock.timeScale).toBe(0);
    clock.advance(100);
    expect(clock.localSolarHours).toBeCloseTo(7.5, 12);
  });

  it('rolls the date over at midnight, across months and years', () => {
    const clock = new SimClock({ date: '2026-12-31', timeOfDay: 23.5, longitude: 0, timeScale: 3600 });
    clock.advance(1); // +1 h
    expect(clock.dateString).toBe('2027-01-01');
    expect(clock.localSolarHours).toBeCloseTo(0.5, 9);
    expect(clock.dayOfYear).toBe(1);
    clock.addSeconds(-3600);
    expect(clock.dateString).toBe('2026-12-31');
    expect(clock.localSolarHours).toBeCloseTo(23.5, 9);
    clock.addSeconds(60 * 86400);
    expect(clock.dateString).toBe('2027-03-01');
  });

  it('wraps setTimeOfDay without changing the date', () => {
    const clock = new SimClock({ date: '2026-07-15', timeOfDay: 10.5, longitude: 0 });
    clock.setTimeOfDay(25);
    expect(clock.localSolarHours).toBeCloseTo(1, 12);
    clock.setTimeOfDay(-1);
    expect(clock.localSolarHours).toBeCloseTo(23, 12);
    expect(clock.dateString).toBe('2026-07-15');
  });

  it('reports the day of year, including leap years', () => {
    const clock = new SimClock({ date: '2024-12-31', timeOfDay: 0, longitude: 0 });
    expect(clock.dayOfYear).toBe(366);
    clock.setDate('2026-03-01');
    expect(clock.dayOfYear).toBe(60);
  });

  it('rejects malformed dates', () => {
    expect(() => new SimClock({ date: '2026-02-30', timeOfDay: 0, longitude: 0 })).toThrow();
    expect(parseIsoDate('2026-7-15')).toBeNull();
    expect(parseIsoDate('2026-07-15')).toEqual({ year: 2026, month: 7, day: 15 });
    expect(formatIsoDate({ year: 987, month: 4, day: 10 })).toBe('0987-04-10');
  });
});
