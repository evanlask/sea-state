// Solar position tests against NOAA-derived ground truth.
//
// Reference vectors: JPL Horizons (apparent topocentric, refracted) and USNO
// one-day rise/set tables, as collected in mourner/suncalc test/fixtures.json
// (commit 21449f34820c3c80a27a78cdc940747ff19ca1e3, BSD-2-Clause). Equinox and
// solstice instants are from the USNO "Earth's Seasons" table for 2026.

import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { atmosphericRefraction, solarEphemeris, solarPosition, SUNRISE_ALTITUDE, sunTimes } from './solar';
import { julianDay, SECONDS_PER_DAY } from './time';

// Longitude (radians) where the Sun is on the meridian at a given instant.
function subsolarLongitude(date: Date): number {
  const eph = solarEphemeris(julianDay(date));
  const utcSeconds = (date.getTime() / 1000) % SECONDS_PER_DAY;
  return ((SECONDS_PER_DAY / 2 - utcSeconds - eph.equationOfTime) / SECONDS_PER_DAY) * 2 * Math.PI;
}

const angleDiffDeg = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('solar position', () => {
  it('puts the Sun overhead at the subsolar point on the equinox', () => {
    const equinox = new Date('2026-03-20T14:46:00Z');
    const pos = solarPosition(equinox, 0, subsolarLongitude(equinox));
    expect(pos.declination / DEG).toBeCloseTo(0, 1);
    expect(pos.elevation / DEG).toBeGreaterThan(89.8);
  });

  it('puts the Sun overhead on the Tropic of Cancer at the June solstice', () => {
    const solstice = new Date('2026-06-21T08:24:00Z');
    const pos = solarPosition(solstice, 23.436 * DEG, subsolarLongitude(solstice));
    expect(pos.declination / DEG).toBeCloseTo(23.436, 2);
    expect(pos.elevation / DEG).toBeGreaterThan(89.8);
  });

  it('matches JPL Horizons azimuth and elevation to 0.02°', () => {
    const cases = [
      { lat: 50.45466, lon: 30.5238, iso: '2026-03-20T12:00:00Z', az: 215.314768, el: 33.943617 }, // Kyiv
      { lat: 31.22222, lon: 121.45806, iso: '2026-06-21T06:00:00Z', az: 261.8818, el: 61.481435 }, // Shanghai
      { lat: -37.814, lon: 144.96332, iso: '2026-12-21T00:00:00Z', az: 73.951166, el: 57.282758 }, // Melbourne
      { lat: 4.60971, lon: -74.08175, iso: '2026-09-23T18:00:00Z', az: 255.099324, el: 71.514638 }, // Bogotá
      { lat: 59.32938, lon: 18.06871, iso: '2026-01-10T12:00:00Z', az: 195.132846, el: 7.783489 }, // Stockholm
    ];
    for (const c of cases) {
      const pos = solarPosition(new Date(c.iso), c.lat * DEG, c.lon * DEG);
      expect(angleDiffDeg(pos.azimuth / DEG, c.az)).toBeLessThan(0.02);
      expect(Math.abs(pos.elevation / DEG - c.el)).toBeLessThan(0.02);
    }
  });

  it('measures azimuth clockwise from north: east in the morning, west in the afternoon', () => {
    const lat = 50.45 * DEG;
    const lon = 30.52 * DEG; // local solar noon ≈ 10:05 UTC
    const morning = solarPosition(new Date('2026-03-20T06:00:00Z'), lat, lon);
    const afternoon = solarPosition(new Date('2026-03-20T14:00:00Z'), lat, lon);
    expect(morning.azimuth / DEG).toBeGreaterThan(90);
    expect(morning.azimuth / DEG).toBeLessThan(150);
    expect(morning.hourAngle).toBeLessThan(0);
    expect(afternoon.azimuth / DEG).toBeGreaterThan(210);
    expect(afternoon.azimuth / DEG).toBeLessThan(270);
    expect(afternoon.hourAngle).toBeGreaterThan(0);
  });

  it('keeps the equation of time within its known ±16.5 minute envelope', () => {
    // Early November maximum ≈ +16.4 min, mid-February minimum ≈ −14.2 min.
    expect(solarEphemeris(julianDay(new Date('2026-11-03T12:00:00Z'))).equationOfTime / 60).toBeCloseTo(
      16.4,
      0,
    );
    expect(solarEphemeris(julianDay(new Date('2026-02-11T12:00:00Z'))).equationOfTime / 60).toBeCloseTo(
      -14.2,
      0,
    );
  });

  it('applies the NOAA refraction model', () => {
    // ~29′ at the horizon, ~1′ at 45°, none near the zenith.
    expect(atmosphericRefraction(0) / DEG).toBeCloseTo(1735 / 3600, 4);
    expect((atmosphericRefraction(45 * DEG) / DEG) * 60).toBeCloseTo(0.97, 1);
    expect(atmosphericRefraction(88 * DEG)).toBe(0);
    // At USNO sunrise the Sun's centre is geometrically ~0.83° below the horizon.
    const pos = solarPosition(new Date('2026-03-20T04:01:00Z'), 50.45466 * DEG, 30.5238 * DEG);
    expect(pos.geometricElevation / DEG).toBeCloseTo(-0.83, 0);
    expect(pos.elevation).toBeGreaterThan(pos.geometricElevation);
  });
});

describe('sun times', () => {
  const minutesFrom = (date: Date | null, iso: string): number =>
    date ? Math.abs(date.getTime() - Date.parse(iso)) / 60000 : Infinity;

  // USNO times are rounded to the minute; NOAA is good to about a minute.
  const cases = [
    // Kyiv, local solar date ≈ UTC date (longitude +30.5°).
    { lat: 50.45466, lon: 30.5238, date: [2026, 3, 20], rise: '2026-03-20T04:01Z', set: '2026-03-20T16:11Z' },
    { lat: 50.45466, lon: 30.5238, date: [2026, 6, 21], rise: '2026-06-21T01:46Z', set: '2026-06-21T18:13Z' },
    {
      lat: 50.45466,
      lon: 30.5238,
      date: [2026, 12, 21],
      rise: '2026-12-21T05:56Z',
      set: '2026-12-21T13:56Z',
    },
    // Bogotá, equatorial.
    {
      lat: 4.60971,
      lon: -74.08175,
      date: [2026, 6, 21],
      rise: '2026-06-21T10:47Z',
      set: '2026-06-21T23:10Z',
    },
    // Ushuaia, southern winter.
    {
      lat: -54.81084,
      lon: -68.31591,
      date: [2026, 6, 21],
      rise: '2026-06-21T12:59Z',
      set: '2026-06-21T20:11Z',
    },
  ] as const;

  it('matches USNO sunrise and sunset within 2 minutes', () => {
    for (const c of cases) {
      const [y, m, d] = c.date;
      const t = sunTimes(y, m, d, c.lat * DEG, c.lon * DEG);
      expect(t.polar).toBeNull();
      expect(minutesFrom(t.sunrise, c.rise)).toBeLessThan(2);
      expect(minutesFrom(t.sunset, c.set)).toBeLessThan(2);
    }
  });

  it('uses the local solar date far from Greenwich', () => {
    // Melbourne (145° E): local solar 21 March starts at 14:20 UTC on the 20th,
    // so its sunrise falls on the previous UTC calendar day.
    const melbourne = { lat: -37.814 * DEG, lon: 144.96332 * DEG };
    expect(
      minutesFrom(sunTimes(2026, 3, 21, melbourne.lat, melbourne.lon).sunrise, '2026-03-20T20:24Z'),
    ).toBeLessThan(2);
    expect(
      minutesFrom(sunTimes(2026, 3, 20, melbourne.lat, melbourne.lon).sunset, '2026-03-20T08:32Z'),
    ).toBeLessThan(2);
  });

  it('matches the USNO solar transit', () => {
    const t = sunTimes(2026, 3, 20, 50.45466 * DEG, 30.5238 * DEG);
    expect(minutesFrom(t.solarNoon, '2026-03-20T10:05Z')).toBeLessThan(1);
  });

  it('reports polar day and polar night with null times', () => {
    const longyearbyen = { lat: 78.22334 * DEG, lon: 15.64689 * DEG };
    const summer = sunTimes(2026, 6, 21, longyearbyen.lat, longyearbyen.lon);
    expect(summer.polar).toBe('polar-day');
    expect(summer.sunrise).toBeNull();
    expect(summer.sunset).toBeNull();
    const winter = sunTimes(2026, 12, 21, longyearbyen.lat, longyearbyen.lon);
    expect(winter.polar).toBe('polar-night');
    expect(winter.sunrise).toBeNull();

    const mcmurdo = { lat: -77.846 * DEG, lon: 166.676 * DEG };
    expect(sunTimes(2026, 6, 21, mcmurdo.lat, mcmurdo.lon).polar).toBe('polar-night');
    expect(sunTimes(2026, 12, 21, mcmurdo.lat, mcmurdo.lon).polar).toBe('polar-day');
  });

  it('gives roughly 12-hour days at the equator and supports twilight altitudes', () => {
    const t = sunTimes(2026, 3, 20, 0, 0, SUNRISE_ALTITUDE);
    const hours = (t.sunset!.getTime() - t.sunrise!.getTime()) / 3_600_000;
    expect(hours).toBeGreaterThan(12);
    expect(hours).toBeLessThan(12.2);
    const civil = sunTimes(2026, 3, 20, 0, 0, -6 * DEG);
    expect(civil.sunrise!.getTime()).toBeLessThan(t.sunrise!.getTime() - 20 * 60_000);
  });
});
