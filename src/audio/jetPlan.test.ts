import { describe, expect, it } from 'vite-plus/test';

import {
  hearJet,
  JET_PEAK_GAIN,
  jetCutoff,
  jetDelay,
  jetGain,
  jetPan,
  loudestJet,
  SPEED_OF_SOUND,
} from './jetPlan';
import type { ListenerPose } from './types';

const listener: ListenerPose = {
  position: { x: 0, y: 2, z: 0 },
  forward: { x: 0, y: 0, z: -1 }, // looking north
  up: { x: 0, y: 1, z: 0 },
};

const jet = (x: number, z: number, vx = 250, vz = 0) => ({
  position: { x, y: 10_002, z },
  velocity: { x: vx, y: 0, z: vz },
});

describe('jet sound delay', () => {
  it('lags by slant range / 343 m/s for a still source', () => {
    expect(jetDelay(listener.position, jet(0, 0, 0, 0))).toBeCloseTo(10_000 / SPEED_OF_SOUND, 6);
  });

  it('is heard from where the aircraft was when the sound left it', () => {
    const source = jet(2000, -500);
    const h = hearJet(listener, source, 0);
    const p = h.heard;
    const range = Math.hypot(p.x - listener.position.x, p.y - listener.position.y, p.z - listener.position.z);
    expect(range).toBeCloseTo(SPEED_OF_SOUND * h.delay, 3);
    expect(h.distance).toBeCloseTo(range, 3);
    // Behind the aircraft along its track: a jet overhead sounds ~7 km back.
    expect(source.position.x - p.x).toBeCloseTo(250 * h.delay, 6);
    const overhead = hearJet(listener, jet(0, 0), 0);
    expect(overhead.delay).toBeGreaterThan(29);
    expect(overhead.heard.x).toBeLessThan(-7000);
  });
});

describe('jet sound level', () => {
  it('is very quiet, loudest near overhead and silent far off', () => {
    expect(jetGain(10_000, 0)).toBeLessThanOrEqual(JET_PEAK_GAIN * 1.5);
    expect(jetGain(20_000, 0)).toBeLessThan(jetGain(10_000, 0));
    expect(jetGain(40_000, 0)).toBeLessThan(jetGain(20_000, 0));
    expect(jetGain(70_000, 0)).toBe(0);
    expect(jetGain(100, 0)).toBeLessThanOrEqual(JET_PEAK_GAIN * 1.5);
  });

  it('is masked by wind', () => {
    expect(jetGain(10_000, 20)).toBeLessThan(jetGain(10_000, 0));
    expect(jetGain(10_000, 40)).toBeGreaterThan(0);
  });

  it('keeps to a low rumble that darkens with distance', () => {
    expect(jetCutoff(10_000)).toBeLessThanOrEqual(400);
    expect(jetCutoff(40_000)).toBeLessThan(jetCutoff(10_000));
    expect(jetCutoff(1e6)).toBe(100);
    expect(jetCutoff(10)).toBe(400);
  });
});

describe('jet sound pan', () => {
  it('pans toward the apparent position, gently, and centres overhead', () => {
    expect(jetPan(listener, { x: 5000, y: 3000, z: 0 })).toBeGreaterThan(0.3);
    expect(jetPan(listener, { x: -5000, y: 3000, z: 0 })).toBeLessThan(-0.3);
    expect(Math.abs(jetPan(listener, { x: 0, y: 10_000, z: 10 }))).toBeLessThan(0.01);
    expect(Math.abs(jetPan(listener, { x: 1e6, y: 0, z: 0 }))).toBeLessThanOrEqual(0.7);
  });

  it('places the delayed sound behind the visual position', () => {
    // A jet just east of overhead flying east sounds as if still to the west: panned left.
    const h = hearJet(listener, jet(1000, 0), 0);
    expect(h.pan).toBeLessThan(0);
  });
});

describe('loudest jet', () => {
  it('picks the nearest audible aircraft, or none', () => {
    expect(loudestJet(listener, [], 0)).toBeNull();
    expect(loudestJet(listener, [jet(200_000, 0)], 0)).toBeNull();
    const near = loudestJet(listener, [jet(40_000, 0), jet(3000, 1000)], 0);
    expect(near?.distance).toBeLessThan(20_000);
  });
});
