import { describe, expect, it } from 'vite-plus/test';

import { PerfStats, formatReadout } from './perfStats';

describe('PerfStats', () => {
  it('measures fps and frame-time average and max over the window', () => {
    const stats = new PerfStats({ windowMs: 1000, fpsSmoothing: 1 });
    let t = 0;
    stats.frame(t);
    for (let i = 0; i < 59; i++) stats.frame((t += 16));
    stats.frame((t += 40)); // one hitch
    const readout = stats.read(t);
    expect(readout.frameMaxMs).toBe(40);
    expect(readout.frameAvgMs).toBeCloseTo((59 * 16 + 40) / 60);
    expect(readout.fps).toBeCloseTo(1000 / readout.frameAvgMs);
  });

  it('forgets frames older than the window', () => {
    const stats = new PerfStats({ windowMs: 1000, fpsSmoothing: 1 });
    let t = 0;
    stats.frame(t);
    stats.frame((t += 200)); // slow start
    for (let i = 0; i < 110; i++) stats.frame((t += 10));
    const readout = stats.read(t);
    expect(readout.frameMaxMs).toBe(10);
    expect(readout.fps).toBeCloseTo(100);
  });

  it('smooths fps between reads', () => {
    const stats = new PerfStats({ windowMs: 500, fpsSmoothing: 0.5 });
    let t = 0;
    stats.frame(t);
    for (let i = 0; i < 60; i++) stats.frame((t += 1000 / 60));
    expect(stats.read(t).fps).toBeCloseTo(60);
    for (let i = 0; i < 30; i++) stats.frame((t += 1000 / 30));
    expect(stats.read(t).fps).toBeCloseTo(45);
  });

  it('ignores giant gaps such as a hidden tab', () => {
    const stats = new PerfStats({ fpsSmoothing: 1 });
    stats.frame(0);
    stats.frame(16);
    stats.frame(5000);
    stats.frame(5016);
    expect(stats.read(5016).frameMaxMs).toBe(16);
  });

  it('averages fed-in sim and gpu numbers and keeps the latest render counts', () => {
    const stats = new PerfStats({ windowMs: 1000 });
    let t = 0;
    stats.frame(t);
    for (let i = 0; i < 10; i++) {
      t += 16;
      stats.frame(t);
      stats.sim(t, i % 2 === 0 ? 1 : 3, i % 2);
      stats.gpu(t, 4);
      stats.render(120 + i, 2_000_000);
    }
    const readout = stats.read(t);
    expect(readout.simStepMs).toBeCloseTo(2);
    expect(readout.stepsPerFrame).toBeCloseTo(0.5);
    expect(readout.gpuMs).toBe(4);
    expect(readout.drawCalls).toBe(129);
    expect(readout.heapUsedMB).toBeNull();
  });
});

describe('formatReadout', () => {
  it('only lists what is available', () => {
    const stats = new PerfStats({ fpsSmoothing: 1 });
    stats.frame(0);
    stats.frame(16);
    expect(formatReadout(stats.read(16))).toHaveLength(2);
    stats.render(140, 1_234_567);
    stats.heap(64 * 1048576, 4096 * 1048576);
    const lines = formatReadout(stats.read(16));
    expect(lines.some((line) => line.includes('1.23 M'))).toBe(true);
    expect(lines.at(-1)).toBe('heap     64 / 4096 MB');
  });
});
