// The distant jet's sound (pure): heard where the aircraft was when the sound now arriving left it,
// slant range / 343 m/s ago, so the rumble lags well behind the speck you see (half a minute for a
// jet 10 km up). Very quiet, low-passed by the air, louder only near overhead and masked by wind.

import { clamp, smoothstep, windLoudness } from './curves';
import type { ListenerPose, Vec3Like } from './types';

export const SPEED_OF_SOUND = 343; // m/s
export const JET_PEAK_GAIN = 0.02; // amplitude near overhead, as quiet as a calm day's wind rush
const REFERENCE_RANGE = 10_500; // m
const SILENT_RANGE = 60_000; // m: beyond this nothing is heard

export interface JetSource {
  position: Vec3Like; // world m, now
  velocity: Vec3Like; // m/s, constant (straight track)
}

export interface JetHearing {
  delay: number; // s since the sound now heard left the aircraft
  distance: number; // m, from where it left
  heard: Vec3Like; // world m, where it left (the apparent position)
  gain: number; // amplitude
  cutoff: number; // Hz
  pan: number; // −1 left .. 1 right
}

// Seconds τ for which the sound emitted at P − V·τ reaches the listener now: |P − V·τ − L| = c·τ.
export function jetDelay(listener: Vec3Like, source: JetSource): number {
  const rx = source.position.x - listener.x;
  const ry = source.position.y - listener.y;
  const rz = source.position.z - listener.z;
  const v = source.velocity;
  const vr = v.x * rx + v.y * ry + v.z * rz;
  const k = SPEED_OF_SOUND * SPEED_OF_SOUND - (v.x * v.x + v.y * v.y + v.z * v.z);
  const r2 = rx * rx + ry * ry + rz * rz;
  if (k <= 0) return Math.sqrt(r2) / SPEED_OF_SOUND; // supersonic: not this aircraft
  return (-vr + Math.sqrt(Math.max(0, vr * vr + k * r2))) / k;
}

// Amplitude at a slant range (m) with the wind (m/s) masking it: roughly spherical spreading plus
// the air's absorption, gone beyond SILENT_RANGE.
export function jetGain(distance: number, windSpeed: number): number {
  const d = Math.max(distance, 1000);
  const spreading = Math.min(1.5, (REFERENCE_RANGE / d) ** 1.5);
  const range = 1 - smoothstep(0.5 * SILENT_RANGE, SILENT_RANGE, d);
  const masking = 1 - 0.7 * windLoudness(windSpeed);
  return JET_PEAK_GAIN * spreading * range * masking;
}

// Low-pass cutoff (Hz): the air strips the highs over kilometres, leaving a 100–400 Hz rumble.
export const jetCutoff = (distance: number): number => clamp(4_000_000 / Math.max(distance, 1), 100, 400);

// Stereo position of a point from the listener's facing (level camera); a source overhead is
// central, and the far-off rumble never pans hard.
export function jetPan(listener: ListenerPose, at: Vec3Like): number {
  const f = listener.forward;
  const dx = at.x - listener.position.x;
  const dy = at.y - listener.position.y;
  const dz = at.z - listener.position.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  const rx = -f.z;
  const rz = f.x;
  const right = (dx * rx + dz * rz) / (distance * (Math.hypot(rx, rz) || 1));
  return clamp(right * 0.7, -1, 1);
}

// What the listener hears of one aircraft.
export function hearJet(listener: ListenerPose, source: JetSource, windSpeed: number): JetHearing {
  const delay = jetDelay(listener.position, source);
  const v = source.velocity;
  const heard = {
    x: source.position.x - v.x * delay,
    y: source.position.y - v.y * delay,
    z: source.position.z - v.z * delay,
  };
  const distance = delay * SPEED_OF_SOUND;
  return {
    delay,
    distance,
    heard,
    gain: jetGain(distance, windSpeed),
    cutoff: jetCutoff(distance),
    pan: jetPan(listener, heard),
  };
}

// The loudest aircraft (one rumble voice), or null when none is audible.
export function loudestJet(
  listener: ListenerPose,
  sources: readonly JetSource[],
  windSpeed: number,
): JetHearing | null {
  let best: JetHearing | null = null;
  for (const source of sources) {
    const heard = hearJet(listener, source, windSpeed);
    if (heard.gain > 1e-5 && (!best || heard.gain > best.gain)) best = heard;
  }
  return best;
}
