// Flash envelope timing and the lightning scheduler's statistics.
import { describe, expect, it } from 'vite-plus/test';

import { createFlashEnvelope, flashIntensity, LightningScheduler, type Strike } from './flash';

describe('flash envelope', () => {
  it('has 2–5 return strokes spread over ~0.2–0.5 s', () => {
    const counts = new Set<number>();
    for (let seed = 0; seed < 200; seed++) {
      const envelope = createFlashEnvelope(seed);
      const { strokes } = envelope;
      counts.add(strokes.length);
      expect(strokes.length).toBeGreaterThanOrEqual(2);
      expect(strokes.length).toBeLessThanOrEqual(5);
      const first = strokes[0]?.time ?? 0;
      const last = strokes[strokes.length - 1]?.time ?? 0;
      expect(first).toBeCloseTo(envelope.leader);
      expect(last - first).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(last - first).toBeLessThanOrEqual(0.45 + 1e-9);
      expect(envelope.duration).toBeLessThan(1.2);
      for (let i = 1; i < strokes.length; i++) {
        expect(strokes[i]?.time).toBeGreaterThan(strokes[i - 1]?.time ?? 0);
      }
    }
    expect(counts.size).toBeGreaterThanOrEqual(3);
  });

  it('is dark outside the flash and bright just after each stroke', () => {
    const envelope = createFlashEnvelope(12);
    expect(flashIntensity(envelope, -0.01)).toBe(0);
    expect(flashIntensity(envelope, envelope.duration + 0.01)).toBe(0);
    expect(flashIntensity(envelope, envelope.leader * 0.5)).toBeLessThan(0.05);
    for (const stroke of envelope.strokes) {
      const peak = flashIntensity(envelope, stroke.time + 0.002);
      expect(peak).toBeGreaterThan(0.4);
      expect(peak).toBeGreaterThan(flashIntensity(envelope, stroke.time - 0.001));
    }
  });

  it('decays between strokes', () => {
    const envelope = createFlashEnvelope(5);
    const [a, b] = envelope.strokes;
    if (!a || !b) throw new Error('expected two strokes');
    const justAfter = flashIntensity(envelope, a.time + 0.003);
    const later = flashIntensity(envelope, a.time + (b.time - a.time) * 0.9);
    expect(later).toBeLessThan(justAfter);
  });
});

describe('LightningScheduler', () => {
  it('produces no strikes at zero rate', () => {
    const scheduler = new LightningScheduler({ seed: 1 });
    for (let i = 0; i < 1000; i++) expect(scheduler.update(0.1, 0, 0)).toHaveLength(0);
  });

  it('matches the requested rate with Poisson-like spacing', () => {
    const scheduler = new LightningScheduler({ seed: 2 });
    scheduler.rate = 6; // per minute
    const times: number[] = [];
    const dt = 1 / 60;
    for (let frame = 0; frame < 60 * 60 * 120; frame++) {
      const count = scheduler.update(dt, 0, 0).length;
      for (let i = 0; i < count; i++) times.push(frame * dt);
    }
    // 120 minutes at 6/min ≈ 720 strikes.
    expect(times.length).toBeGreaterThan(640);
    expect(times.length).toBeLessThan(800);
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? 0));
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    expect(mean).toBeGreaterThan(9);
    expect(mean).toBeLessThan(11);
    // Exponential gaps: coefficient of variation ≈ 1.
    expect(Math.sqrt(variance) / mean).toBeGreaterThan(0.85);
    expect(Math.sqrt(variance) / mean).toBeLessThan(1.15);
  });

  it('can fire several strikes in one long step', () => {
    const scheduler = new LightningScheduler({ seed: 3 });
    scheduler.rate = 600;
    expect(scheduler.update(10, 0, 0).length).toBeGreaterThan(50);
  });

  it('places strikes uniformly by area within the annulus', () => {
    const scheduler = new LightningScheduler({ seed: 4, radius: 5000, minDistance: 1000 });
    const strikes: Strike[] = [];
    for (let i = 0; i < 20_000; i++) strikes.push(scheduler.place(200, -300));
    let inner = 0;
    let groundCount = 0;
    for (const strike of strikes) {
      const r = Math.hypot(strike.x - 200, strike.z + 300);
      expect(r).toBeGreaterThanOrEqual(1000 - 1e-6);
      expect(r).toBeLessThanOrEqual(5000 + 1e-6);
      if (r < 3000) inner++;
      if (strike.cloudToGround) groundCount++;
    }
    // Area fraction inside r = 3000: (9 − 1) / (25 − 1) = 1/3.
    expect(inner / strikes.length).toBeCloseTo(1 / 3, 1);
    expect(groundCount / strikes.length).toBeCloseTo(0.7, 1);
  });
});
