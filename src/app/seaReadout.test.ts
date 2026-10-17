import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../sim/core/conventions';
import type { SpectrumMessage, WindConfig } from '../sim/world/protocol';
import { blendSeaReadout, foamWindVelocity, type SeaReadout, seaReadoutOf } from './seaReadout';

const spectrum = (wind: WindConfig, hs: number, activationTime = 10, duration = 4): SpectrumMessage => ({
  type: 'spectrum',
  version: 2,
  activationTime,
  transitionDuration: duration,
  cascades: [],
  significantHeight: hs,
  peakPeriod: 2 * hs + 3,
  douglas: 4,
  wind,
});

const calm: SeaReadout = { hs: 0.5, tp: 4, wind: { speed: 4, from: 350 * DEG, gustFactor: 1 } };
const gale = { speed: 20, from: 10 * DEG, gustFactor: 1.4 };

describe('sea readout', () => {
  it('a spectrum on its own reads fully blended in', () => {
    expect(seaReadoutOf(spectrum(gale, 6))).toEqual({ hs: 6, tp: 15, wind: gale });
  });

  it('keeps the old sea and foam wind until the crossfade starts, and the new after it ends', () => {
    const s = spectrum(gale, 6);
    expect(blendSeaReadout(calm, s, 9.9)).toEqual(calm);
    expect(blendSeaReadout(calm, s, 14)).toEqual({ hs: 6, tp: 15, wind: gale });
  });

  it('moves the foam wind with the waves: the same weight as Hs, veering the short way', () => {
    const s = spectrum(gale, 6);
    const mid = blendSeaReadout(calm, s, 12);
    // Smoothstep halfway is exactly ½ for both.
    expect(mid.hs).toBeCloseTo(3.25);
    expect(mid.wind.speed).toBeCloseTo(12);
    expect(mid.wind.from).toBeCloseTo(360 * DEG); // through north, not back round through south
    const early = blendSeaReadout(calm, s, 11);
    const w = (early.hs - calm.hs) / (6 - calm.hs);
    expect(w).toBeGreaterThan(0.1);
    expect(w).toBeLessThan(0.5);
    expect((early.wind.speed - calm.wind.speed) / (gale.speed - calm.wind.speed)).toBeCloseTo(w, 9);
  });

  it('stands still while simulation time does (paused), however long the sky has been blending', () => {
    const s = spectrum(gale, 6);
    const paused = blendSeaReadout(calm, s, 11.3);
    for (let frame = 0; frame < 600; frame++) expect(blendSeaReadout(calm, s, 11.3)).toEqual(paused);
    expect(blendSeaReadout(calm, s, 11.4).wind.speed).toBeGreaterThan(paused.wind.speed);
  });

  it('re-targets from wherever it was when a newer spectrum arrives', () => {
    const partWay = blendSeaReadout(calm, spectrum(gale, 6), 11);
    const second = spectrum(calm.wind, calm.hs, 11.25);
    expect(blendSeaReadout(partWay, second, 11.2)).toEqual(partWay);
    expect(blendSeaReadout(partWay, second, 20).wind.speed).toBeCloseTo(calm.wind.speed);
  });

  it('gives the foam wind as a velocity toward where it blows', () => {
    const north = foamWindVelocity({ ...calm, wind: { speed: 10, from: 0, gustFactor: 1 } });
    expect(north.x).toBeCloseTo(0);
    expect(north.y).toBe(0);
    expect(north.z).toBeCloseTo(10); // from the north, so toward the south (+z)
    const east = foamWindVelocity({ ...calm, wind: { speed: 5, from: 90 * DEG, gustFactor: 1 } });
    expect(east.x).toBeCloseTo(-5);
  });
});
