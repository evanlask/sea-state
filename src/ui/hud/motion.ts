// Motion bookkeeping behind the attitude gauge and ride meter: 60 s peak-hold, the ride
// classification, the stability danger zone from a GZ curve, and needle smoothing.

import { signedAngle } from '../../sim/core/conventions';
import type { StabilityInfo } from './model';

// Highest and lowest value over a sliding window, kept in fixed buckets so updates are O(1)
// amortised and memory doesn't grow. high is never below 0 and low never above, which suits
// signed quantities like roll (starboard / port peaks).
export class PeakHold {
  private readonly bucketSec: number;
  private readonly hi: Float64Array;
  private readonly lo: Float64Array;
  private index = 0;
  private elapsed = 0;
  sessionMaxAbs = 0;

  constructor(windowSec = 60, bucketSec = 1) {
    this.bucketSec = bucketSec;
    const count = Math.max(1, Math.ceil(windowSec / bucketSec));
    this.hi = new Float64Array(count);
    this.lo = new Float64Array(count);
  }

  add(value: number, dt: number): void {
    this.elapsed += dt;
    // A long pause (tab hidden) clears at most one full window's worth of buckets.
    let steps = 0;
    while (this.elapsed >= this.bucketSec && steps < this.hi.length) {
      this.elapsed -= this.bucketSec;
      this.index = (this.index + 1) % this.hi.length;
      this.hi[this.index] = 0;
      this.lo[this.index] = 0;
      steps++;
    }
    if (this.elapsed >= this.bucketSec) this.elapsed %= this.bucketSec;
    if (!Number.isFinite(value)) return;
    if (value > this.hi[this.index]) this.hi[this.index] = value;
    if (value < this.lo[this.index]) this.lo[this.index] = value;
    const abs = Math.abs(value);
    if (abs > this.sessionMaxAbs) this.sessionMaxAbs = abs;
  }

  get high(): number {
    let best = 0;
    for (const v of this.hi) if (v > best) best = v;
    return best;
  }

  get low(): number {
    let best = 0;
    for (const v of this.lo) if (v < best) best = v;
    return best;
  }

  reset(session = true): void {
    this.hi.fill(0);
    this.lo.fill(0);
    this.elapsed = 0;
    if (session) this.sessionMaxAbs = 0;
  }
}

export type RideLevel = 'calm' | 'lively' | 'violent';

// Thresholds on the vertical-acceleration envelope |g − 1|, in g. A big ship in a gale stays
// around 0.1 g; a centre console slamming off crests easily passes 0.5 g.
const RIDE_THRESHOLDS = { lively: 0.15, violent: 0.45 } as const;

export function classifyRide(envelope: number): RideLevel {
  if (envelope >= RIDE_THRESHOLDS.violent) return 'violent';
  if (envelope >= RIDE_THRESHOLDS.lively) return 'lively';
  return 'calm';
}

// Peak envelope of the vertical-acceleration deviation: jumps up instantly, decays slowly,
// so one slam keeps the meter up long enough to read.
export class RideMeter {
  envelope = 0;
  private readonly decaySec: number;

  constructor(decaySec = 1.5) {
    this.decaySec = decaySec;
  }

  update(verticalG: number, dt: number): RideLevel {
    const deviation = Number.isFinite(verticalG) ? Math.abs(verticalG - 1) : 0;
    this.envelope = Math.max(deviation, this.envelope * Math.exp(-dt / this.decaySec));
    return classifyRide(this.envelope);
  }

  get level(): RideLevel {
    return classifyRide(this.envelope);
  }

  reset(): void {
    this.envelope = 0;
  }
}

export interface GzPoint {
  heel: number; // rad
  gz: number; // m, righting arm
}

// Fraction of the peak righting arm below which the margin counts as "low".
const GZ_LOW_FRACTION = 0.5;

// Danger zone for the attitude gauge from a GZ curve (ascending heel): the AVS is the zero
// crossing after the peak; the danger heel is where GZ has fallen to half its peak, or the
// downflooding angle if that comes first.
export function dangerZoneFromGz(curve: readonly GzPoint[], downflooding = Infinity): StabilityInfo {
  if (curve.length < 2) return { dangerHeel: Math.min(downflooding, Math.PI / 4), avs: Math.PI / 2 };
  let peak = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i].gz > curve[peak].gz) peak = i;
  const last = curve[curve.length - 1];
  const crossing = (level: number): number | null => {
    for (let i = peak + 1; i < curve.length; i++) {
      const a = curve[i - 1];
      const b = curve[i];
      if (b.gz <= level) {
        const t = a.gz === b.gz ? 0 : (a.gz - level) / (a.gz - b.gz);
        return a.heel + (b.heel - a.heel) * t;
      }
    }
    return null;
  };
  const avs = crossing(0) ?? last.heel;
  const low = crossing(curve[peak].gz * GZ_LOW_FRACTION) ?? avs;
  return { dangerHeel: Math.min(low, downflooding, avs), avs };
}

// Exponential smoothing that is frame-rate independent.
export function approach(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current)) return target;
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

// As approach(), but takes the short way round for angles.
export function approachAngle(current: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(current)) return target;
  return current + signedAngle(target - current) * (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
}
