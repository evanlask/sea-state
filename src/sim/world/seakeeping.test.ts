import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { getWeatherPreset } from '../weather/presets';
import { neutralControls, type PhysicsMode, type SimConfig } from './protocol';
import { SimWorld } from './SimWorld';

// The jet ski flat out, nozzle centred, in a Fair-weather chop (8 kn, Hs ≈ 0.4 m,
// Tp ≈ 3 s wavelets) on the real FFT ocean, measured after 5 s of spin-up.
function fullThrottleInFair(mode: PhysicsMode) {
  const p = getWeatherPreset('fair');
  const config: SimConfig = {
    seed: 1,
    physicsMode: mode,
    boats: [{ id: 'ski', kind: 'pwc', x: 0, z: 0, heading: 0 }],
    wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
    seaState: p.seaState,
    oceanQuality: 'low',
  };
  const world = new SimWorld(config);
  const att = { heading: 0, pitch: 0, roll: 0 };
  const dt = 1 / 30;
  const rolls: number[] = [];
  const headings: number[] = [];
  let ventilated = 0;
  let speed = 0;
  for (let i = 1; i <= 15 / dt; i++) {
    const s = world.advance({
      type: 'advance',
      targetTime: i * dt,
      controls: { ski: { ...neutralControls(), throttle: 1 } },
      commands: [],
      probes: new Float64Array(),
    });
    if (i * dt < 5) continue;
    const b = s.boats[0]!;
    attitudeFromQuat(b.orientation, att);
    rolls.push(att.roll / DEG);
    headings.push(Math.atan2(Math.sin(att.heading), Math.cos(att.heading)) / DEG);
    if ((b.telemetry['ventilated'] ?? 0) > 0.5) ventilated++;
    speed += Math.hypot(b.velocity.x, b.velocity.z);
  }
  const n = rolls.length;
  // Heading wander about the mean course change (a steady drift of the course
  // under the wind and sea is the rider's to trim with the bars).
  const mx = (n - 1) / 2;
  const my = headings.reduce((a, h) => a + h, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let j = 0; j < n; j++) {
    sxy += (j - mx) * (headings[j]! - my);
    sxx += (j - mx) ** 2;
  }
  const slope = sxy / sxx;
  return {
    rollRms: Math.sqrt(rolls.reduce((a, r) => a + r * r, 0) / n),
    maxRoll: Math.max(...rolls.map(Math.abs)),
    wander: Math.max(...headings.map((h, j) => Math.abs(h - my - slope * (j - mx)))),
    ventilated: ventilated / n,
    speed: speed / n,
  };
}

describe('jet ski at full throttle in a Fair-weather chop', () => {
  for (const mode of ['arcade', 'realistic'] as const) {
    it(`(${mode}) skips but stays level, tracks straight, keeps its jet in the water and its speed`, () => {
      const r = fullThrottleInFair(mode);
      expect(r.rollRms).toBeLessThan(5);
      expect(r.maxRoll).toBeLessThan(15);
      expect(r.wander).toBeLessThan(8);
      expect(r.ventilated).toBeLessThan(0.2);
      expect(r.speed).toBeGreaterThan(26);
    }, 30_000);
  }
});

// The jet ski at full throttle and full lock in a Breezy sea (Hs ≈ 2 m) on the
// real FFT ocean, after `runUp` s straight. Returns whether it flipped (rolled
// past 100° or capsized) and its mean yaw rate over the turn, deg/s.
function fullLockInBreezy(mode: PhysicsMode, seed: number, runUp: number, seconds: number) {
  const p = getWeatherPreset('breezy');
  const config: SimConfig = {
    seed,
    physicsMode: mode,
    boats: [{ id: 'ski', kind: 'pwc', x: 0, z: 0, heading: 0 }],
    wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
    seaState: p.seaState,
    oceanQuality: 'low',
  };
  const world = new SimWorld(config);
  const att = { heading: 0, pitch: 0, roll: 0 };
  const dt = 1 / 10;
  let yaw = 0;
  let n = 0;
  for (let i = 1; i <= (runUp + seconds) / dt; i++) {
    const turning = i * dt > runUp;
    const s = world.advance({
      type: 'advance',
      targetTime: i * dt,
      controls: { ski: { ...neutralControls(), throttle: 1, steer: turning ? 1 : 0 } },
      commands: [],
      probes: new Float64Array(),
    });
    const b = s.boats[0]!;
    attitudeFromQuat(b.orientation, att);
    if (s.events.some((e) => e.type === 'capsized') || Math.abs(att.roll) > 100 * DEG) {
      return { flipped: true, yawRate: yaw / Math.max(1, n) };
    }
    if (turning && i * dt > runUp + 3) {
      yaw += Math.abs(b.telemetry['yawRate'] ?? 0) / DEG;
      n++;
    }
  }
  return { flipped: false, yawRate: yaw / n };
}

// Cases that flip if the carve's planing load (physics/planingCarve.ts) comes from the surge alone:
// from rest the stern swings out into a slide at a few m/s and trips over the outer chine; from top
// speed a crest unloads the hull, it slides out, and trips as it bites again.
describe('jet ski at full throttle and full lock in a Breezy sea', () => {
  for (const [mode, runUp, seeds] of [
    ['arcade', 0, [2, 4]],
    ['realistic', 8, [3, 4]],
  ] as const) {
    it(`(${mode}, ${runUp ? 'from top speed' : 'from rest'}) carves circles without flipping or spinning out`, () => {
      for (const seed of seeds) {
        const r = fullLockInBreezy(mode, seed, runUp, 16);
        expect(r.flipped, `seed ${seed}`).toBe(false);
        expect(r.yawRate, `seed ${seed}`).toBeGreaterThan(30);
        expect(r.yawRate, `seed ${seed}`).toBeLessThan(100);
      }
    }, 60_000);
  }
});
