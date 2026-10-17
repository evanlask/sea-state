import { describe, expect, it } from 'vite-plus/test';

import { DEG, signedAngle } from '../core/conventions';
import { msToKnots } from '../core/units';
import {
  CROSS_SEAS_ANGLE_DEG,
  getWeatherPreset,
  TEN_MINUTE_PER_ONE_MINUTE,
  WEATHER_PRESETS,
} from './presets';
import { resolveSeaState } from './seaState';
import { beaufortFromWind, douglasFromHs, saffirSimpsonFromWind } from './tables';

const hs = (id: string): number => {
  const p = getWeatherPreset(id);
  return resolveSeaState(p.seaState, p.windSpeed, p.windFrom).totalHs;
};
const force = (id: string): number => beaufortFromWind(getWeatherPreset(id).windSpeed).force;

describe('weather presets', () => {
  it('have unique ids and fall back to fair', () => {
    const ids = WEATHER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(15);
    expect(getWeatherPreset('nope').id).toBe('fair');
  });

  it('run from calm to hurricane, then the specials', () => {
    expect(WEATHER_PRESETS.map((p) => p.id)).toEqual([
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
    ]);
    const strength = WEATHER_PRESETS.slice(0, 9).map((p) => p.windSpeed);
    for (let i = 1; i < strength.length; i++) expect(strength[i]).toBeGreaterThan(strength[i - 1]!);
  });

  it('match their Beaufort force', () => {
    expect(force('fair')).toBe(3);
    expect(force('breezy')).toBe(5);
    expect(force('near-gale')).toBe(7);
    expect(force('gale')).toBe(8);
    expect(force('storm')).toBe(10);
    expect(force('cross-seas')).toBe(5);
    for (const id of ['hurricane-1', 'hurricane-3', 'hurricane-5']) expect(force(id)).toBe(12);
  });

  it('quote the right force in their descriptions', () => {
    for (const p of WEATHER_PRESETS) {
      const quoted = /force (\d+)\b(?!–)/i.exec(p.description);
      if (quoted) expect(beaufortFromWind(p.windSpeed).force, p.id).toBe(Number(quoted[1]));
    }
  });

  it('use 10-minute mean winds for hurricanes, in the category of their 1-minute wind', () => {
    const cases: [string, number, number][] = [
      ['hurricane-1', 70, 1],
      ['hurricane-3', 105, 3],
      ['hurricane-5', 145, 5],
    ];
    for (const [id, oneMinute, category] of cases) {
      const p = getWeatherPreset(id);
      expect(p.oneMinuteKnots).toBe(oneMinute);
      expect(msToKnots(p.windSpeed)).toBeCloseTo(oneMinute * TEN_MINUTE_PER_ONE_MINUTE);
      expect(saffirSimpsonFromWind(p.windSpeed / TEN_MINUTE_PER_ONE_MINUTE)?.category).toBe(category);
      expect(p.description).toContain(`Category ${category}`);
      expect(p.description).toContain(`${oneMinute} knots`);
    }
  });

  it('produce the planned wave heights', () => {
    expect(hs('breezy')).toBeGreaterThan(1.5);
    expect(hs('breezy')).toBeLessThan(2.8);
    // Near Gale: rough to very rough (Douglas 5–6, 2.5–6 m).
    expect(douglasFromHs(hs('near-gale')).code).toBeGreaterThanOrEqual(5);
    expect(douglasFromHs(hs('near-gale')).code).toBeLessThanOrEqual(6);
    expect(hs('near-gale')).toBeGreaterThan(hs('breezy'));
    expect(hs('near-gale')).toBeLessThan(hs('gale'));
    expect(hs('gale')).toBeGreaterThan(4.5);
    expect(hs('gale')).toBeLessThan(8);
    expect(hs('hurricane-3')).toBeGreaterThan(12);
    expect(hs('hurricane-5')).toBeLessThanOrEqual(20);
    expect(hs('long-swell')).toBeGreaterThan(2.9);
  });

  it('run the Cross Seas swell across the wind sea', () => {
    const p = getWeatherPreset('cross-seas');
    const sea = resolveSeaState(p.seaState, p.windSpeed, p.windFrom);
    expect(sea.swell).not.toBeNull();
    expect(sea.swell!.height).toBeCloseTo(4.5);
    expect(sea.swell!.period).toBe(12);
    expect(signedAngle(sea.swell!.from - sea.windSeaFrom) / DEG).toBeCloseTo(CROSS_SEAS_ANGLE_DEG);
    expect(sea.swell!.height).toBeGreaterThan(2 * sea.hs);
    expect(p.precipitation).toBe(0);
  });

  it('keep lightning to cumulonimbus: none in the Storm', () => {
    expect(getWeatherPreset('storm').lightningPerMinute).toBe(0);
    for (const p of WEATHER_PRESETS) if (p.lightningPerMinute > 0) expect(p.clouds.type).toBe('cumulonimbus');
  });

  it('store wind speeds that round-trip to the table knots', () => {
    expect(msToKnots(getWeatherPreset('gale').windSpeed)).toBeCloseTo(38);
    expect(msToKnots(getWeatherPreset('near-gale').windSpeed)).toBeCloseTo(30);
  });
});
