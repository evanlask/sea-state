// Pure thunder planning: when a strike's sound arrives (distance / 343 m/s), how loud it is, whether
// it starts with a crack, how long it rolls and how dull it sounds, plus the granular "rolling"
// envelope the voice plays back. Tested without Web Audio.

import { Rng } from '../sim/core/rng';
import { clamp, clamp01, lerp, smoothstep, SPEED_OF_SOUND } from './curves';

export interface ThunderStrike {
  x: number; // strike point, world m
  y: number;
  z: number;
  time: number; // simulation time of the flash, s
  intensity: number; // 0..1 at the source
  cloudToGround: boolean;
}

export interface ThunderPlan {
  distance: number; // m
  delay: number; // s from the flash until the sound arrives
  gain: number; // peak rumble gain
  crackGain: number; // 0 = no crack (distant or cloud-to-cloud)
  duration: number; // s of rolling rumble
  cutoffStart: number; // Hz, low-pass at the start of the rumble
  cutoffEnd: number; // Hz, at the end
}

export const thunderDelay = (distance: number): number => Math.max(0, distance) / SPEED_OF_SOUND;

// Thunder is a long line source: it falls off slower than 1/r. Beyond ~20 km it's inaudible.
export function thunderAttenuation(distance: number): number {
  const d = Math.max(distance, 1);
  return Math.min(1, Math.pow(1000 / d, 0.75)) * (1 - smoothstep(15000, 25000, d));
}

export function planThunder(
  strike: ThunderStrike,
  listenerX: number,
  listenerY: number,
  listenerZ: number,
): ThunderPlan {
  const dx = strike.x - listenerX;
  const dy = strike.y - listenerY;
  const dz = strike.z - listenerZ;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const intensity = clamp01(strike.intensity);
  return {
    distance,
    delay: thunderDelay(distance),
    gain: 0.8 * intensity * thunderAttenuation(distance) * (strike.cloudToGround ? 1 : 0.65),
    // Only close cloud-to-ground strikes give the sharp ripping crack.
    crackGain: strike.cloudToGround ? 0.9 * intensity * (1 - smoothstep(500, 2500, distance)) : 0,
    // The channel spans kilometres, so far strikes spread over a longer, softer roll.
    duration: clamp(4 + distance / 1000, 4, 15),
    // Air absorbs the highs over distance; the tail of the roll is always dark.
    cutoffStart: clamp(lerp(5000, 300, smoothstep(300, 12000, distance)), 200, 6000),
    cutoffEnd: lerp(260, 110, smoothstep(1000, 12000, distance)),
  };
}

// Envelope samples per second of rumble.
const THUNDER_ENVELOPE_RATE = 60;

// The rolling envelope: a rise, then a handful of randomly timed swells ("rolls") of decaying size
// over a long exponential tail. Peak-normalized to `gain` and faded to 0 at the end.
export function thunderEnvelope(plan: ThunderPlan, seed: number): Float32Array {
  const rng = new Rng(seed);
  const n = Math.max(8, Math.round(plan.duration * THUNDER_ENVELOPE_RATE));
  const env = new Float32Array(n);
  const rolls = 3 + Math.floor(rng.next() * 5);
  const rollTime = new Float32Array(rolls);
  const rollSize = new Float32Array(rolls);
  const rollWidth = new Float32Array(rolls);
  // Distant thunder builds slowly: its first sound comes from the nearest part of the channel.
  const rise = lerp(0.03, 0.6, smoothstep(500, 10000, plan.distance));
  for (let i = 0; i < rolls; i++) {
    const t = rise + rng.next() * plan.duration * 0.6;
    rollTime[i] = t;
    rollSize[i] = (0.4 + 0.6 * rng.next()) * Math.exp(-t / (plan.duration * 0.35));
    rollWidth[i] = 0.15 + rng.next() * 0.6;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / THUNDER_ENVELOPE_RATE;
    let v = Math.min(1, t / rise) * Math.exp(-t / (plan.duration * 0.28));
    for (let r = 0; r < rolls; r++) {
      const u = (t - (rollTime[r] ?? 0)) / (rollWidth[r] ?? 1);
      v += (rollSize[r] ?? 0) * Math.exp(-u * u);
    }
    // Fine granular flutter: many channel segments arriving at slightly different times.
    v *= 0.8 + 0.2 * rng.next();
    env[i] = v;
    if (v > peak) peak = v;
  }
  const fade = Math.min(n, Math.round(0.4 * THUNDER_ENVELOPE_RATE));
  for (let i = 0; i < n; i++) {
    const tail = i >= n - fade ? (n - 1 - i) / Math.max(1, fade - 1) : 1;
    env[i] = ((env[i] ?? 0) / (peak || 1)) * plan.gain * tail;
  }
  return env;
}
