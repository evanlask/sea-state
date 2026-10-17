import { describe, expect, it } from 'vite-plus/test';

import { ProbeCrossfade, type ProbeFrameInput, ProbeSchedule, probeBlendWeight } from './probeSchedule';

const DEG = Math.PI / 180;

const sunAt = (elevation: number): { x: number; y: number; z: number } => ({
  x: 0,
  y: Math.sin(elevation * DEG),
  z: -Math.cos(elevation * DEG),
});

const frame = (time: number, elevation: number, version = 0): ProbeFrameInput => ({
  time,
  sunDirection: sunAt(elevation),
  moonDirection: { x: 0, y: -1, z: 0 },
  contentVersion: version,
});

describe('ProbeSchedule', () => {
  it('captures everything on the first frame', () => {
    const schedule = new ProbeSchedule();
    expect(schedule.plan(frame(0, 30))).toEqual({
      beginCycle: true,
      faces: [0, 1, 2, 3, 4, 5],
      convolve: true,
    });
  });

  it('stays idle while nothing changes', () => {
    const schedule = new ProbeSchedule({ maxInterval: 100 });
    schedule.plan(frame(0, 30));
    for (let i = 1; i < 30; i++) expect(schedule.plan(frame(i / 60, 30)).faces).toEqual([]);
  });

  it('amortises a refresh over six frames, then convolves once', () => {
    const schedule = new ProbeSchedule({ facesPerFrame: 1, refreshAngle: 0.25 * DEG });
    schedule.plan(frame(0, 30));
    const plans = [1, 2, 3, 4, 5, 6].map((i) => schedule.plan(frame(i / 60, 30.5)));
    expect(plans.map((p) => p.faces)).toEqual([[0], [1], [2], [3], [4], [5]]);
    expect(plans.map((p) => p.convolve)).toEqual([false, false, false, false, false, true]);
    expect(plans.map((p) => p.beginCycle)).toEqual([true, false, false, false, false, false]);
    expect(schedule.busy).toBe(false);
    expect(schedule.plan(frame(0.2, 30.5)).faces).toEqual([]);
  });

  it('renders several faces per frame when asked', () => {
    const schedule = new ProbeSchedule({ facesPerFrame: 2 });
    schedule.plan(frame(0, 30));
    const a = schedule.plan(frame(1 / 60, 31));
    const b = schedule.plan(frame(2 / 60, 31));
    const c = schedule.plan(frame(3 / 60, 31));
    expect([a.faces, b.faces, c.faces]).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
    expect(c.convolve).toBe(true);
  });

  it('refreshes immediately after a large jump (time skip, teleport)', () => {
    const schedule = new ProbeSchedule();
    schedule.plan(frame(0, 30));
    expect(schedule.plan(frame(1, 60)).faces).toHaveLength(6);
  });

  it('starts a cycle when the content version changes or the probe is stale', () => {
    const schedule = new ProbeSchedule({ maxInterval: 5 });
    schedule.plan(frame(0, 30));
    expect(schedule.plan(frame(0.1, 30, 1)).beginCycle).toBe(true);
    const stale = new ProbeSchedule({ maxInterval: 5 });
    stale.plan(frame(0, 30));
    expect(stale.plan(frame(4, 30)).faces).toEqual([]);
    expect(stale.plan(frame(5.1, 30)).beginCycle).toBe(true);
  });

  it('honours invalidate()', () => {
    const schedule = new ProbeSchedule();
    schedule.plan(frame(0, 30));
    schedule.invalidate();
    expect(schedule.plan(frame(0.1, 30)).faces).toHaveLength(6);
  });
});

describe('probeBlendWeight', () => {
  it('is frame-rate independent', () => {
    const tau = 0.8;
    const one = 1 - probeBlendWeight(1 / 30, tau);
    const two = (1 - probeBlendWeight(1 / 60, tau)) ** 2;
    expect(two).toBeCloseTo(one, 12);
    expect(probeBlendWeight(0, tau)).toBe(0);
    expect(probeBlendWeight(-1, tau)).toBe(0);
    expect(probeBlendWeight(0.1, 0)).toBe(1);
  });
});

describe('ProbeCrossfade', () => {
  it('does nothing until a convolution arrives', () => {
    const fade = new ProbeCrossfade();
    expect(fade.step(1 / 60)).toBe(0);
    expect(fade.blending).toBe(false);
  });

  it('snaps to a forced capture in one frame', () => {
    const fade = new ProbeCrossfade();
    fade.fresh(true);
    expect(fade.step(1 / 60)).toBe(1);
    expect(fade.blending).toBe(false);
    expect(fade.step(1 / 60)).toBe(0);
  });

  it('eases toward a routine refresh and then stops', () => {
    const tau = 0.5;
    const fade = new ProbeCrossfade(tau);
    fade.fresh(false);
    // What the display shows of a step from 0 to 1.
    let shown = 0;
    let frames = 0;
    let halfSecond = 0;
    while (fade.blending && frames < 1000) {
      shown += (1 - shown) * fade.step(1 / 60);
      frames++;
      if (frames === 30) halfSecond = shown;
    }
    expect(halfSecond).toBeCloseTo(1 - Math.exp(-0.5 / tau), 6);
    expect(shown).toBe(1);
    // Within 1% after ln(100) time constants.
    expect(frames / 60).toBeCloseTo(tau * Math.log(100), 1);
    expect(fade.step(1 / 60)).toBe(0);
  });

  it('restarts the ease when a refresh lands mid-blend', () => {
    const fade = new ProbeCrossfade(1);
    fade.fresh(false);
    for (let i = 0; i < 30; i++) fade.step(1 / 60);
    fade.fresh(false);
    expect(fade.step(1 / 60)).toBeCloseTo(probeBlendWeight(1 / 60, 1), 12);
    expect(fade.blending).toBe(true);
  });
});
