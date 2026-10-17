// Moon position and phase tests.
//
// References: Meeus, Astronomical Algorithms (2nd ed.) example 47.a; JPL
// Horizons topocentric positions and illuminated fractions as collected in
// mourner/suncalc test/fixtures.json (commit 21449f34820c3c80a27a78cdc940747ff19ca1e3);
// phase instants from the USNO "Phases of the Moon" table for 2024.

import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { moonEcliptic, moonIllumination, moonPosition, phaseDifference } from './lunar';
import { equatorialToHorizontal, localSiderealTime } from './sidereal';
import { DELTA_T_SECONDS, julianDay, SECONDS_PER_DAY } from './time';

const angleDiffDeg = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('moon position', () => {
  it('matches Meeus example 47.a', () => {
    // 1992 April 12, 0h TD; moonEcliptic takes UT and adds ΔT itself.
    const ecl = moonEcliptic(2448724.5 - DELTA_T_SECONDS / SECONDS_PER_DAY);
    expect(ecl.longitude / DEG).toBeCloseTo(133.162655, 4);
    expect(ecl.latitude / DEG).toBeCloseTo(-3.229126, 4);
    expect(ecl.distance / 1000).toBeCloseTo(368409.7, 0);
  });

  it('matches JPL Horizons topocentric azimuth and elevation within 0.05°', () => {
    const cases = [
      { lat: 50.45466, lon: 30.5238, iso: '2026-03-20T12:00:00Z', az: 198.762554, el: 48.109548 }, // Kyiv
      { lat: 31.22222, lon: 121.45806, iso: '2026-06-21T06:00:00Z', az: 111.258843, el: 32.732277 }, // Shanghai
    ];
    for (const c of cases) {
      const pos = moonPosition(new Date(c.iso), c.lat * DEG, c.lon * DEG);
      expect(angleDiffDeg(pos.azimuth / DEG, c.az)).toBeLessThan(0.05);
      expect(Math.abs(pos.elevation / DEG - c.el)).toBeLessThan(0.05);
    }
  });

  it('lowers the Moon by its horizontal parallax', () => {
    const date = new Date('2026-03-20T12:00:00Z');
    const lat = 50.45466 * DEG;
    const lon = 30.5238 * DEG;
    const pos = moonPosition(date, lat, lon);
    const lst = localSiderealTime(julianDay(date), lon);
    const geocentric = equatorialToHorizontal(pos.rightAscension, pos.declination, lst, lat);
    const parallax = (geocentric.elevation - pos.geometricElevation) / DEG;
    // Horizontal parallax is 0.9–1.0°, scaled by cos(elevation ≈ 48°).
    expect(parallax).toBeGreaterThan(0.6);
    expect(parallax).toBeLessThan(0.7);
    expect(pos.distance / 1000).toBeGreaterThan(356_000);
    expect(pos.distance / 1000).toBeLessThan(407_000);
  });
});

describe('moon illumination', () => {
  it('is full at the 2024-04-23 23:49 UTC full moon', () => {
    const il = moonIllumination(new Date('2024-04-23T23:49:00Z'));
    expect(il.fraction).toBeGreaterThan(0.995);
    expect(Math.abs(phaseDifference(il.phase, 0.5))).toBeLessThan(0.002);
  });

  it('is new at the 2024-04-08 18:21 UTC new moon (a solar eclipse)', () => {
    const il = moonIllumination(new Date('2024-04-08T18:21:00Z'));
    expect(il.fraction).toBeLessThan(0.001);
    expect(Math.abs(phaseDifference(il.phase, 0))).toBeLessThan(0.002);
  });

  it('runs through the lunation in order and flags waxing', () => {
    const firstQuarter = moonIllumination(new Date('2024-04-15T19:13:00Z'));
    expect(firstQuarter.phase).toBeCloseTo(0.25, 2);
    expect(firstQuarter.fraction).toBeCloseTo(0.5, 1);
    expect(firstQuarter.waxing).toBe(true);
    const lastQuarter = moonIllumination(new Date('2024-05-01T11:27:00Z'));
    expect(lastQuarter.phase).toBeCloseTo(0.75, 2);
    expect(lastQuarter.waxing).toBe(false);
  });

  it('points the bright limb at the Sun: west when waxing, east when waning', () => {
    // Position angle from celestial north through east; west is ~270°.
    const waxing = moonIllumination(new Date('2024-04-15T19:13:00Z')).brightLimbAngle / DEG;
    expect(waxing).toBeGreaterThan(200);
    expect(waxing).toBeLessThan(340);
    const waning = moonIllumination(new Date('2024-05-01T11:27:00Z')).brightLimbAngle / DEG;
    expect(waning).toBeGreaterThan(20);
    expect(waning).toBeLessThan(160);
  });

  it('matches JPL Horizons illuminated fraction and distance', () => {
    const cases = [
      { iso: '2026-01-03T06:00:00Z', fraction: 0.9981187, km: 361901.53 },
      { iso: '2026-01-18T18:00:00Z', fraction: 0.000962, km: 395666.43 },
      { iso: '2026-01-25T12:00:00Z', fraction: 0.422788, km: 373884.39 },
    ];
    for (const c of cases) {
      const date = new Date(c.iso);
      expect(Math.abs(moonIllumination(date).fraction - c.fraction)).toBeLessThan(0.001);
      expect(Math.abs(moonPosition(date, 0, 0).distance / 1000 - c.km)).toBeLessThan(50);
    }
  });
});
