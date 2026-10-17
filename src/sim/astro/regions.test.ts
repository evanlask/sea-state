// Region preset sanity tests, and the Arctic region's polar day and night.

import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { WEATHER_PRESETS } from '../weather/presets';
import { parseIsoDate } from './clock';
import { moonIllumination } from './lunar';
import { getRegion, isRegionId, REGION_IDS, REGIONS } from './regions';
import { CIVIL_TWILIGHT_ALTITUDE, SUNRISE_ALTITUDE, solarPosition, sunTimes } from './solar';

// UTC instant of a local mean solar time at a region (local = UTC + longitude / 15 h).
const localInstant = (date: string, hours: number, longitudeDeg: number): Date =>
  new Date(Date.parse(`${date}T00:00:00Z`) + (hours - longitudeDeg / 15) * 3.6e6);

describe('regions', () => {
  it('lists regions alphabetically by name, Arctic first', () => {
    const names = REGION_IDS.map((id) => REGIONS[id].name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(REGION_IDS[0]).toBe('arctic');
    expect(Object.keys(REGIONS).sort()).toEqual([...REGION_IDS].sort());
  });

  it('defines every region with a valid location, date, swell and typical weather', () => {
    for (const id of REGION_IDS) {
      const region = REGIONS[id];
      expect(region.id).toBe(id);
      expect(Math.abs(region.latitudeDeg)).toBeLessThanOrEqual(90);
      expect(Math.abs(region.longitudeDeg)).toBeLessThanOrEqual(180);
      expect(parseIsoDate(region.defaultDate)).not.toBeNull();
      for (const channel of [...region.water.absorption, ...region.water.scattering]) {
        expect(channel).toBeGreaterThan(0);
      }
      // Seawater absorbs red far more than blue everywhere.
      expect(region.water.absorption[0]).toBeGreaterThan(region.water.absorption[2]);
      // Background swell: present everywhere, never a storm sea of its own.
      expect(region.swell.height).toBeGreaterThan(0);
      expect(region.swell.height).toBeLessThanOrEqual(4);
      expect(region.swell.period).toBeGreaterThanOrEqual(6);
      expect(region.swell.period).toBeLessThanOrEqual(16);
      expect(region.swell.fromDeg).toBeGreaterThanOrEqual(0);
      expect(region.swell.fromDeg).toBeLessThan(360);
      expect(region.swell.label).not.toBe('');
      expect(
        WEATHER_PRESETS.some((p) => p.id === region.typicalWeather),
        `${id} weather`,
      ).toBe(true);
    }
  });

  it('gives the big oceans bigger, longer swell than the enclosed seas', () => {
    const swell = (id: keyof typeof REGIONS) => REGIONS[id].swell;
    expect(swell('southern-ocean').height).toBeGreaterThan(swell('north-atlantic').height);
    expect(swell('north-atlantic').height).toBeGreaterThan(swell('caribbean').height);
    expect(swell('caribbean').height).toBeGreaterThan(swell('mediterranean').height);
    expect(swell('southern-ocean').period).toBeGreaterThan(swell('mediterranean').period);
  });

  it('makes tropical water bluer and clearer than high-latitude productive water', () => {
    const tropical = REGIONS.caribbean.water;
    const bering = REGIONS['bering-sea'].water;
    const blueGreen = (c: readonly number[]): number => c[2] / c[1];
    expect(blueGreen(tropical.deepColor)).toBeGreaterThan(2);
    expect(blueGreen(bering.deepColor)).toBeLessThan(1);
    expect(tropical.absorption[2]).toBeLessThan(bering.absorption[2]);
    expect(tropical.scattering[1]).toBeLessThan(bering.scattering[1]);
  });

  it('makes the Norwegian Sea dark and greenish, a little clearer than the Bering Sea', () => {
    const arctic = REGIONS.arctic.water;
    const bering = REGIONS['bering-sea'].water;
    const atlantic = REGIONS['north-atlantic'].water;
    expect(arctic.deepColor[2] / arctic.deepColor[1]).toBeLessThanOrEqual(1.05);
    expect(arctic.absorption[2]).toBeLessThan(bering.absorption[2]);
    expect(arctic.scattering[1]).toBeLessThan(bering.scattering[1]);
    expect(arctic.absorption[2]).toBeGreaterThan(atlantic.absorption[2]);
  });

  it('falls back to the North Atlantic for unknown ids', () => {
    expect(isRegionId('mediterranean')).toBe(true);
    expect(isRegionId('arctic')).toBe(true);
    expect(isRegionId('atlantis')).toBe(false);
    expect(getRegion('atlantis').id).toBe('north-atlantic');
  });
});

describe('the Arctic region: polar day and night at 70°N', () => {
  const arctic = REGIONS.arctic;
  const lat = arctic.latitudeDeg * DEG;
  const lon = arctic.longitudeDeg * DEG;
  const elevationAt = (date: string, hours: number): number =>
    solarPosition(localInstant(date, hours, arctic.longitudeDeg), lat, lon).elevation / DEG;

  it('keeps the sun up all day at midsummer, local midnight included', () => {
    const times = sunTimes(2026, 6, 21, lat, lon);
    expect(times.polar).toBe('polar-day');
    expect(times.sunrise).toBeNull();
    expect(times.sunset).toBeNull();
    for (let h = 0; h < 24; h += 0.5) expect(elevationAt('2026-06-21', h)).toBeGreaterThan(0);
    // Midnight sun: lowest due north at about 90 − 70 − (90 − 23.4) ≈ 3.4° (plus refraction).
    const midnight = solarPosition(localInstant('2026-06-21', 0, arctic.longitudeDeg), lat, lon);
    expect(midnight.elevation / DEG).toBeGreaterThan(3);
    expect(midnight.elevation / DEG).toBeLessThan(5);
    expect(Math.min(midnight.azimuth, 2 * Math.PI - midnight.azimuth) / DEG).toBeLessThan(5);
    expect(elevationAt('2026-06-21', 12)).toBeCloseTo(43.4, 0);
  });

  it('never raises the sun at midwinter, with civil twilight round noon', () => {
    const times = sunTimes(2026, 12, 21, lat, lon);
    expect(times.polar).toBe('polar-night');
    expect(times.sunrise).toBeNull();
    expect(times.sunset).toBeNull();
    for (let h = 0; h < 24; h += 0.5)
      expect(elevationAt('2026-12-21', h)).toBeLessThan(SUNRISE_ALTITUDE / DEG);
    const noon = elevationAt('2026-12-21', 12);
    expect(noon).toBeGreaterThan(CIVIL_TWILIGHT_ALTITUDE / DEG);
    expect(noon).toBeLessThan(-2);
    // Civil twilight has real times that day: a few hours of blue light either side of noon.
    const civil = sunTimes(2026, 12, 21, lat, lon, CIVIL_TWILIGHT_ALTITUDE);
    expect(civil.polar).toBeNull();
    expect(civil.sunrise).not.toBeNull();
    expect(civil.sunset).not.toBeNull();
  });

  it('defaults to a full moon in the midnight-sun season', () => {
    const [y, m, d] = arctic.defaultDate.split('-').map(Number) as [number, number, number];
    expect(sunTimes(y, m, d, lat, lon).polar).toBe('polar-day');
    const moon = moonIllumination(localInstant(arctic.defaultDate, 24, arctic.longitudeDeg));
    expect(moon.fraction).toBeGreaterThan(0.97);
  });
});
