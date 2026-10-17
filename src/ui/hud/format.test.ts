import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../../sim/core/conventions';
import { knotsToMs } from '../../sim/core/units';
import {
  beaufortFromMs,
  beaufortLabel,
  beaufortName,
  cardinal,
  douglasFromHs,
  douglasName,
  formatBearing,
  formatClock,
  formatDuration,
  formatLength,
  formatRange,
  formatRateOfTurn,
  formatSide,
  formatSpeed,
  formatWind,
  moonPhaseName,
  relativeSector,
  speedReading,
} from './format';

describe('speed and length', () => {
  it('formats speed in each unit with one decimal', () => {
    expect(formatSpeed(knotsToMs(12.34), 'kn')).toBe('12.3 kn');
    expect(formatSpeed(10, 'mph')).toBe('22.4 mph');
    expect(formatSpeed(10, 'kmh')).toBe('36.0 km/h');
  });

  it('drops the decimal at 100 and above, and keeps astern speeds signed', () => {
    expect(speedReading(30, 'kmh').value).toBe('108');
    expect(speedReading(-knotsToMs(2), 'kn').value).toBe('-2.0');
    expect(speedReading(-0.001, 'kn').value).toBe('0.0');
  });

  it('formats lengths in metres or feet', () => {
    expect(formatLength(2.5, 'm')).toBe('2.5 m');
    expect(formatLength(3.048, 'ft')).toBe('10.0 ft');
    expect(formatLength(150, 'm')).toBe('150 m');
  });

  it('picks the range unit from the speed unit family', () => {
    const units = { speed: 'kn', length: 'm', wind: 'kn' } as const;
    expect(formatRange(1852 * 1.24, units)).toBe('1.2 nm');
    expect(formatRange(250, units)).toBe('250 m');
    expect(formatRange(1609.344 * 2, { ...units, speed: 'mph' })).toBe('2.0 mi');
    expect(formatRange(2500, { ...units, speed: 'kmh' })).toBe('2.5 km');
    expect(formatRange(30, { ...units, length: 'ft' })).toBe('100 ft');
  });
});

describe('wind', () => {
  it('shows knots, m/s or the Beaufort force', () => {
    expect(formatWind(knotsToMs(14.4), 'kn')).toBe('14 kn');
    expect(formatWind(7.25, 'ms')).toBe('7.3 m/s');
    expect(formatWind(18, 'beaufort')).toBe('F8');
  });

  it('classifies Beaufort force on the WMO limits', () => {
    expect(beaufortFromMs(0)).toBe(0);
    expect(beaufortFromMs(0.3)).toBe(1);
    expect(beaufortFromMs(5.4)).toBe(3);
    expect(beaufortFromMs(5.5)).toBe(4);
    expect(beaufortFromMs(17.2)).toBe(8);
    expect(beaufortFromMs(32.6)).toBe(11);
    expect(beaufortFromMs(40)).toBe(12);
  });

  it('passes the weather system name through, falling back to the table', () => {
    expect(beaufortName(7, 'Near gale (moderate gale)')).toBe('Near gale (moderate gale)');
    expect(beaufortName(7)).toBe('Near gale');
    expect(beaufortName(15)).toBe('Hurricane force');
    expect(beaufortLabel(7)).toBe('Force 7 — Near gale');
  });

  it('classifies the Douglas sea state from Hs', () => {
    expect(douglasFromHs(0)).toBe(0);
    expect(douglasFromHs(0.3)).toBe(2);
    expect(douglasFromHs(3)).toBe(5);
    expect(douglasName(5)).toBe('Rough');
    expect(douglasFromHs(16)).toBe(9);
    expect(douglasName(9, 'Custom')).toBe('Custom');
  });
});

describe('angles and bearings', () => {
  it('pads bearings to three digits and never shows 360', () => {
    expect(formatBearing(45 * DEG)).toBe('045°');
    expect(formatBearing(359.6 * DEG)).toBe('000°');
    expect(formatBearing(-10 * DEG)).toBe('350°');
  });

  it('labels relative angles with the side', () => {
    expect(formatSide(35 * DEG)).toBe('35° S');
    expect(formatSide(-120 * DEG)).toBe('120° P');
    expect(formatSide(0.2 * DEG)).toBe('0°');
  });

  it('shows rate of turn per minute', () => {
    expect(formatRateOfTurn((30 / 60) * DEG)).toBe('30°/min S');
    expect(formatRateOfTurn((-12 / 60) * DEG)).toBe('12°/min P');
    expect(formatRateOfTurn(0)).toBe('0°/min');
  });

  it('names compass points and relative sectors', () => {
    expect(cardinal(0)).toBe('N');
    expect(cardinal(250 * DEG)).toBe('WSW');
    expect(cardinal(355 * DEG)).toBe('N');
    expect(relativeSector(5 * DEG)).toBe('ahead');
    expect(relativeSector(40 * DEG)).toBe('starboard bow');
    expect(relativeSector(-95 * DEG)).toBe('port beam');
    expect(relativeSector(150 * DEG)).toBe('starboard quarter');
    expect(relativeSector(178 * DEG)).toBe('astern');
  });
});

describe('time', () => {
  it('formats clock times and wraps past midnight', () => {
    expect(formatClock(6 * 60 + 5)).toBe('06:05');
    expect(formatClock(24 * 60 + 30)).toBe('00:30');
    expect(formatClock(-30)).toBe('23:30');
  });

  it('formats short durations', () => {
    expect(formatDuration(45.4)).toBe('45 s');
    expect(formatDuration(130)).toBe('2:10');
    expect(formatDuration(-3)).toBe('0 s');
  });

  it('names moon phases', () => {
    expect(moonPhaseName(0)).toBe('New moon');
    expect(moonPhaseName(0.25)).toBe('First quarter');
    expect(moonPhaseName(0.5)).toBe('Full moon');
    expect(moonPhaseName(0.62)).toBe('Waning gibbous');
    expect(moonPhaseName(0.99)).toBe('New moon');
  });
});
