import { describe, expect, it } from 'vite-plus/test';

import { PanoramaExposures, panoramaSlice } from './envPanorama';

describe('panoramaSlice', () => {
  it('cycles through the slices, covering every column once per cycle', () => {
    const width = 10;
    const seen = Array.from({ length: width }, () => 0);
    for (let frame = 0; frame < 4; frame++) {
      const slice = panoramaSlice(frame, width, 4, false);
      expect(slice.phase).toBe(frame);
      expect(slice.stride).toBe(4);
      for (let i = 0; i < slice.columns; i++) {
        const x = i * slice.stride + slice.phase;
        if (x < width) seen[x]!++;
      }
    }
    expect(seen).toEqual(Array.from({ length: width }, () => 1));
  });

  it('marches every column on a full refresh', () => {
    expect(panoramaSlice(7, 384, 4, true)).toEqual({ phase: 0, stride: 1, columns: 384 });
    expect(panoramaSlice(7, 384, 1, false)).toEqual({ phase: 0, stride: 1, columns: 384 });
  });
});

describe('PanoramaExposures', () => {
  it('remembers the exposure each slice was marched at', () => {
    const exposures = new PanoramaExposures(4, 1);
    exposures.record(panoramaSlice(0, 16, 4, false), 2);
    exposures.record(panoramaSlice(1, 16, 4, false), 3);
    expect(exposures.at(0)).toBe(2);
    expect(exposures.at(4)).toBe(2);
    expect(exposures.at(5)).toBe(3);
    expect(exposures.at(2)).toBe(1);
    expect(exposures.at(-1)).toBe(1); // column 15 (wraps)
  });

  it('resets every slice on a full refresh', () => {
    const exposures = new PanoramaExposures(4, 1);
    exposures.record(panoramaSlice(2, 16, 4, false), 5);
    exposures.record(panoramaSlice(3, 16, 4, true), 0.5);
    expect(exposures.values).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it('keeps neighbouring columns consistent while the exposure adapts', () => {
    // Radiance L marched at each frame's exposure, read back at a capture exposure: dividing by the
    // column's own exposure gives the same value everywhere (a single shared exposure would not).
    const L = 10;
    const slices = 4;
    const exposures = new PanoramaExposures(slices);
    const stored: number[] = [];
    let exposure = 1;
    for (let frame = 0; frame < 8; frame++) {
      exposure *= 1.25; // adapting after the start
      const slice = panoramaSlice(frame, 8, slices, frame === 0);
      exposures.record(slice, exposure);
      for (let i = 0; i < slice.columns; i++) stored[i * slice.stride + slice.phase] = L * exposure;
    }
    const capture = 3;
    const fixed = stored.map((value, x) => (value / exposures.at(x)) * capture);
    for (const value of fixed) expect(value).toBeCloseTo(L * capture, 9);
    const old = stored.map((value) => (value / exposure) * capture);
    expect(Math.max(...old) / Math.min(...old)).toBeGreaterThan(1.9);
  });
});
