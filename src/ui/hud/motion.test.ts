import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../../sim/core/conventions';
import { approach, approachAngle, classifyRide, dangerZoneFromGz, PeakHold, RideMeter } from './motion';

describe('PeakHold', () => {
  it('holds the highest and lowest values over the window', () => {
    const peak = new PeakHold(60, 1);
    peak.add(10, 0.1);
    peak.add(-4, 0.1);
    peak.add(3, 0.1);
    expect(peak.high).toBe(10);
    expect(peak.low).toBe(-4);
  });

  it('forgets a peak once it is older than the window', () => {
    const peak = new PeakHold(60, 1);
    peak.add(20, 0.5);
    for (let t = 0; t < 59; t += 0.5) peak.add(1, 0.5);
    expect(peak.high).toBe(20);
    for (let t = 0; t < 2; t += 0.5) peak.add(1, 0.5);
    expect(peak.high).toBe(1);
  });

  it('keeps the session maximum after the window expires', () => {
    const peak = new PeakHold(10, 1);
    peak.add(-25, 0.1);
    peak.add(0, 30);
    expect(peak.low).toBe(0);
    expect(peak.sessionMaxAbs).toBe(25);
    peak.reset();
    expect(peak.sessionMaxAbs).toBe(0);
  });

  it('survives a long pause and ignores non-finite samples', () => {
    const peak = new PeakHold(60, 1);
    peak.add(5, 0.1);
    peak.add(Number.NaN, 3600);
    expect(peak.high).toBe(0);
  });
});

describe('ride meter', () => {
  it('classifies the vertical-acceleration envelope', () => {
    expect(classifyRide(0.05)).toBe('calm');
    expect(classifyRide(0.15)).toBe('lively');
    expect(classifyRide(0.6)).toBe('violent');
  });

  it('jumps up on a slam and decays back to calm', () => {
    const ride = new RideMeter(1.5);
    expect(ride.update(1.02, 0.05)).toBe('calm');
    expect(ride.update(1.7, 0.05)).toBe('violent');
    let level = ride.level;
    for (let i = 0; i < 10; i++) level = ride.update(1, 0.1);
    expect(level).toBe('lively');
    for (let i = 0; i < 40; i++) level = ride.update(1, 0.1);
    expect(level).toBe('calm');
  });

  it('counts negative g (falling off a crest) as rough too', () => {
    const ride = new RideMeter();
    expect(ride.update(0.3, 0.05)).toBe('violent');
  });
});

describe('dangerZoneFromGz', () => {
  // YD-41-like curve: peak 1.12 m at 50°, vanishing just before 120°.
  const curve = [0, 0.4, 0.72, 0.95, 1.1, 1.12, 1.05, 0.92, 0.75, 0.55, 0.35, 0.16, -0.02, -0.2].map(
    (gz, i) => ({
      heel: i * 10 * DEG,
      gz,
    }),
  );

  it('finds the AVS at the zero crossing after the peak', () => {
    expect(dangerZoneFromGz(curve).avs / DEG).toBeCloseTo(118.9, 1);
  });

  it('starts the danger zone where GZ has halved, or at downflooding', () => {
    expect(dangerZoneFromGz(curve).dangerHeel / DEG).toBeCloseTo(89.5, 1);
    expect(dangerZoneFromGz(curve, 70 * DEG).dangerHeel / DEG).toBeCloseTo(70);
  });

  it('uses the last point when the curve never vanishes, and copes with no data', () => {
    const stiff = [0, 1, 2, 2.5].map((gz, i) => ({ heel: i * 30 * DEG, gz }));
    expect(dangerZoneFromGz(stiff).avs / DEG).toBeCloseTo(90);
    expect(dangerZoneFromGz([]).avs).toBeCloseTo(Math.PI / 2);
  });
});

describe('needle smoothing', () => {
  it('approaches the target independent of frame rate', () => {
    let fast = 0;
    for (let i = 0; i < 10; i++) fast = approach(fast, 1, 0.01, 0.1);
    expect(approach(0, 1, 0.1, 0.1)).toBeCloseTo(fast, 10);
    expect(approach(Number.NaN, 5, 0.01, 0.1)).toBe(5);
  });

  it('takes the short way round for angles', () => {
    const next = approachAngle(350 * DEG, 10 * DEG, 0.1, 0.1);
    expect(next).toBeGreaterThan(350 * DEG);
  });
});
