// FpsMeter: interval counting, smoothing, stall handling and formatting.

import { describe, expect, it } from 'vite-plus/test';

import { formatFps, FpsMeter } from './fpsMeter';

// Feeds `count` frames `stepMs` apart starting at `from`; returns the readings and the last time.
function run(
  meter: FpsMeter,
  from: number,
  stepMs: number,
  count: number,
): { readings: number[]; end: number } {
  const readings: number[] = [];
  let end = from;
  for (let i = 0; i < count; i++) {
    end = from + i * stepMs;
    const fps = meter.frame(end);
    if (fps !== null) readings.push(fps);
  }
  return { readings, end };
}

describe('FpsMeter', () => {
  it('reports a steady frame rate about four times a second', () => {
    const { readings } = run(new FpsMeter(), 0, 10, 101);
    expect(readings).toHaveLength(4);
    for (const fps of readings) expect(fps).toBeCloseTo(100, 6);
  });

  it('eases toward a new frame rate instead of jumping', () => {
    const meter = new FpsMeter({ smoothing: 0.5 });
    const { end } = run(meter, 0, 10, 101);
    const { readings } = run(meter, end + 20, 20, 101);
    expect(readings[0]).toBeGreaterThan(50);
    expect(readings[0]).toBeLessThan(100);
    expect(readings.at(-1)).toBeLessThan(readings[0]!);
    expect(readings.at(-1)).toBeCloseTo(50, 0);
  });

  it('starts the interval over after a stall rather than reporting it', () => {
    const meter = new FpsMeter();
    const { end } = run(meter, 0, 10, 10);
    expect(meter.frame(end + 5000)).toBeNull();
    const { readings } = run(meter, end + 5010, 10, 26);
    expect(readings[0]).toBeCloseTo(100, 6);
  });

  it('forgets the previous rate on reset', () => {
    const meter = new FpsMeter();
    const { end } = run(meter, 0, 20, 31);
    meter.reset();
    const { readings } = run(meter, end + 10, 8, 40);
    expect(readings[0]).toBeCloseTo(125, 6);
  });
});

describe('formatFps', () => {
  it('rounds to a whole number of frames', () => {
    expect(formatFps(59.6)).toBe('60 FPS');
    expect(formatFps(143.2)).toBe('143 FPS');
  });

  it('shows a dash before the first reading', () => {
    expect(formatFps(null)).toBe('– FPS');
    expect(formatFps(Number.NaN)).toBe('– FPS');
  });
});
