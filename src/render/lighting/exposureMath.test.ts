import { describe, expect, it } from 'vite-plus/test';

import {
  adaptEv100,
  DEFAULT_EXPOSURE_SETTINGS,
  estimateIlluminance,
  ev100FromExposure,
  ev100FromIlluminance,
  ev100FromLuminance,
  exposureFromEv100,
  type ExposureSettings,
  HIGHLIGHT_HEADROOM_EV,
  highlightProtectedEv100,
  nightDarkening,
  targetEv100,
} from './exposureMath';
import { chooseLightSource } from './lightSource';

const DEG = Math.PI / 180;
const settings: ExposureSettings = { ...DEFAULT_EXPOSURE_SETTINGS };

const illuminance = (sun: number, moon = -30, moonLux = 0, overcast = 0): number =>
  estimateIlluminance({
    sunElevation: sun * DEG,
    moonElevation: moon * DEG,
    moonIlluminance: moonLux,
    overcast,
  });

describe('EV100 metering', () => {
  it('matches the sunny-16 rule for a sunlit scene', () => {
    expect(ev100FromIlluminance(100_000)).toBeGreaterThan(14.5);
    expect(ev100FromIlluminance(100_000)).toBeLessThan(15.5);
  });

  it('round-trips exposure and EV', () => {
    for (const ev of [-6, 0, 7.5, 15]) expect(ev100FromExposure(exposureFromEv100(ev))).toBeCloseTo(ev, 9);
  });

  it('meters middle grey to roughly a tenth after exposure', () => {
    const luminance = 800;
    const exposed = luminance * exposureFromEv100(ev100FromLuminance(luminance));
    expect(exposed).toBeCloseTo(12.5 / 120, 6);
  });
});

describe('illuminance model', () => {
  it('spans daylight, twilight, moonlight and starlight', () => {
    expect(illuminance(60)).toBeGreaterThan(80_000);
    expect(illuminance(0)).toBeGreaterThan(300);
    expect(illuminance(0)).toBeLessThan(1500);
    expect(illuminance(-6)).toBeGreaterThan(1);
    expect(illuminance(-6)).toBeLessThan(10);
    expect(illuminance(-30, 60, 0.26)).toBeGreaterThan(0.15);
    expect(illuminance(-30, 60, 0.26)).toBeLessThan(0.35);
    expect(illuminance(-30)).toBeLessThan(0.003);
  });

  it('is monotonic in sun elevation and cut by overcast', () => {
    let previous = 0;
    for (let e = -20; e <= 90; e += 1) {
      const lux = illuminance(e);
      expect(lux).toBeGreaterThanOrEqual(previous);
      previous = lux;
    }
    expect(illuminance(30, -30, 0, 1)).toBeLessThan(illuminance(30) * 0.15);
  });
});

describe('exposure targets', () => {
  it('darkens dusk and night progressively', () => {
    expect(nightDarkening(30 * DEG)).toBe(0);
    expect(nightDarkening(-3 * DEG)).toBeGreaterThan(nightDarkening(1 * DEG));
    expect(nightDarkening(-12 * DEG)).toBeGreaterThan(nightDarkening(-6 * DEG));
    expect(nightDarkening(-30 * DEG)).toBe(2.5);
  });

  it('keeps night darker than day after clamping', () => {
    const moonless = targetEv100(ev100FromIlluminance(illuminance(-30)), -30 * DEG, settings);
    const moonlit = targetEv100(ev100FromIlluminance(illuminance(-30, 50, 0.26)), -30 * DEG, settings);
    const day = targetEv100(ev100FromIlluminance(illuminance(50)), 50 * DEG, settings);
    // A white lambertian surface under moonlight still exposes far darker than in daylight.
    const white = (lux: number, ev: number): number => (lux / Math.PI) * exposureFromEv100(ev);
    expect(white(illuminance(-30, 50, 0.26), moonlit)).toBeLessThan(white(illuminance(50), day) * 0.5);
    expect(moonless).toBeGreaterThanOrEqual(settings.minEv100);
    expect(moonless).toBeLessThan(day);
  });

  it('honours manual mode and user bias', () => {
    expect(targetEv100(3, 0, { ...settings, mode: 'manual', manualEv100: 11 })).toBe(11);
    const base = targetEv100(12, 40 * DEG, settings);
    expect(targetEv100(12, 40 * DEG, { ...settings, compensation: 1 })).toBeCloseTo(base - 1, 9);
  });
});

describe('eye adaptation', () => {
  it('converges, faster toward brighter scenes than darker ones', () => {
    const step = (from: number, to: number): number => adaptEv100(from, to, 0.5, settings);
    const brighten = step(5, 10) - 5;
    const darken = 10 - step(10, 5);
    expect(brighten).toBeGreaterThan(darken);
    let ev = 0;
    for (let i = 0; i < 600; i++) ev = adaptEv100(ev, 12, 1 / 60, settings);
    expect(ev).toBeCloseTo(12, 2);
  });

  it('is frame-rate independent', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 60; i++) a = adaptEv100(a, 10, 1 / 60, settings);
    for (let i = 0; i < 120; i++) b = adaptEv100(b, 10, 1 / 120, settings);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe('light source choice', () => {
  it('follows the sun by day and the moon once the sun is well down', () => {
    expect(chooseLightSource(10 * DEG, 50_000, 0.2)).toEqual({ source: 'sun', weight: 1 });
    expect(chooseLightSource(-10 * DEG, 0, 0.2)).toEqual({ source: 'moon', weight: 1 });
    expect(chooseLightSource(-10 * DEG, 0, 0).source).toBe('none');
    const twilight = chooseLightSource(-2 * DEG, 0, 0.2);
    expect(twilight.source).toBe('moon');
    expect(twilight.weight).toBeGreaterThan(0);
    expect(twilight.weight).toBeLessThan(1);
  });
});

describe('highlightProtectedEv100', () => {
  it('leaves ordinary scenes on the log average', () => {
    expect(highlightProtectedEv100(10, 11.5)).toBe(10);
  });

  it('keeps a bright patch within the headroom above mid-grey', () => {
    // Dark wheelhouse (log average EV −5) with a flood-lit deck pulling the mean to EV 4.
    expect(highlightProtectedEv100(-5, 4)).toBe(4 - HIGHLIGHT_HEADROOM_EV);
  });
});
