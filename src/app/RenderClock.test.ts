import { describe, expect, it } from 'vite-plus/test';

import { RenderClock, SnapshotBuffer } from './RenderClock';

describe('SnapshotBuffer', () => {
  it('brackets a time between two snapshots', () => {
    const buffer = new SnapshotBuffer<{ time: number }>();
    for (const time of [0, 0.1, 0.2, 0.3]) buffer.push({ time });
    const bracket = buffer.bracket(0.25);
    expect(bracket?.a.time).toBeCloseTo(0.2);
    expect(bracket?.b.time).toBeCloseTo(0.3);
    expect(bracket?.alpha).toBeCloseTo(0.5);
  });

  it('clamps outside the buffered range', () => {
    const buffer = new SnapshotBuffer<{ time: number }>();
    buffer.push({ time: 1 });
    buffer.push({ time: 2 });
    expect(buffer.bracket(0)?.a.time).toBe(1);
    expect(buffer.bracket(5)?.a.time).toBe(2);
  });

  it('drops old data when time goes backwards', () => {
    const buffer = new SnapshotBuffer<{ time: number }>();
    buffer.push({ time: 5 });
    buffer.push({ time: 1 });
    expect(buffer.bracket(3)?.a.time).toBe(1);
  });
});

describe('RenderClock', () => {
  it('stays monotonic and behind the newest snapshot under jittery delivery', () => {
    const clock = new RenderClock();
    const step = 1 / 120;
    let simTime = 0;
    let previous = -Infinity;
    let latest = 0;
    // 144 Hz display with snapshots quantized to the physics step and random message delay.
    for (let frame = 0; frame < 2000; frame++) {
      const dt = 1 / 144;
      simTime += dt;
      if (Math.sin(frame * 12.9898) > -0.6) latest = Math.floor(simTime / step) * step;
      const time = clock.update(dt, latest);
      expect(time).toBeGreaterThanOrEqual(previous);
      expect(time).toBeLessThanOrEqual(latest + 1e-12);
      previous = time;
    }
    // Over the run it tracks real time closely.
    expect(simTime - previous).toBeLessThan(0.05);
  });

  it('advances smoothly at a steady rate', () => {
    const clock = new RenderClock();
    let latest = 0;
    const times: number[] = [];
    for (let frame = 0; frame < 600; frame++) {
      latest += 1 / 60;
      times.push(clock.update(1 / 60, latest));
    }
    const deltas = times.slice(400).map((t, i, all) => (i === 0 ? 1 / 60 : t - (all[i - 1] ?? t)));
    for (const delta of deltas) expect(delta).toBeCloseTo(1 / 60, 3);
  });

  it('snaps after a long stall', () => {
    const clock = new RenderClock();
    clock.update(1 / 60, 1);
    expect(clock.update(1 / 60, 10)).toBeCloseTo(10 - 1.5 / 120);
  });
});
