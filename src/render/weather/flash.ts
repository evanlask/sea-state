// Lightning timing: the flash envelope of one strike (a faint stepped leader,
// then several return strokes down the same channel over ~0.2–0.5 s) and a
// Poisson scheduler that places strikes at random around a centre.
import { Rng } from '../../sim/core/rng';

interface ReturnStroke {
  time: number; // s after the strike begins
  peak: number; // relative brightness
  decay: number; // e-folding time, s
}

export interface FlashEnvelope {
  leader: number; // duration of the dim stepped leader before the first stroke, s
  strokes: ReturnStroke[];
  duration: number; // after this the flash is dark
}

const RISE = 0.002; // return strokes peak within a couple of milliseconds

export function createFlashEnvelope(seed: number): FlashEnvelope {
  const rng = new Rng(seed);
  const leader = rng.range(0.015, 0.05);
  // Real flashes average 3–4 strokes; 2–5 keeps the flicker readable.
  const count = 2 + Math.min(3, Math.floor(-Math.log(1 - rng.next()) * 1.6));
  const span = rng.range(0.2, 0.45);
  const strokes: ReturnStroke[] = [];
  // Interstroke gaps of tens of ms, scaled so the strokes fill the span.
  const gaps = Array.from({ length: count - 1 }, () => rng.range(0.6, 1.4));
  const gapTotal = gaps.reduce((sum, g) => sum + g, 0) || 1;
  let time = leader;
  for (let i = 0; i < count; i++) {
    strokes.push({
      time,
      peak: i === 0 ? 1 : rng.range(0.45, 0.95),
      // Some strokes carry continuing current and glow for longer.
      decay: rng.next() < 0.25 ? rng.range(0.06, 0.1) : rng.range(0.015, 0.035),
    });
    time += ((gaps[i] ?? 0) / gapTotal) * span;
  }
  const last = strokes[strokes.length - 1] ?? { time: leader, decay: 0.03 };
  return { leader, strokes, duration: last.time + last.decay * 6 };
}

// Relative flash brightness at time t (s since the strike began), 0..~1.
export function flashIntensity(envelope: FlashEnvelope, t: number): number {
  if (t < 0 || t > envelope.duration) return 0;
  let value = t < envelope.leader ? 0.04 * (t / envelope.leader) : 0;
  for (const stroke of envelope.strokes) {
    const dt = t - stroke.time;
    if (dt < 0) continue;
    value += dt < RISE ? stroke.peak * (dt / RISE) : stroke.peak * Math.exp(-(dt - RISE) / stroke.decay);
  }
  return Math.min(value, 1.5);
}

export interface Strike {
  x: number; // world position of the strike point, m
  z: number;
  seed: number;
  cloudToGround: boolean; // false: an in-cloud flash with no visible channel
}

export interface SchedulerOptions {
  seed: number;
  radius?: number; // strikes land within this distance of the centre, m
  minDistance?: number; // and no closer than this
  cloudToGroundFraction?: number;
}

export class LightningScheduler {
  rate = 0; // strikes per minute
  radius: number;
  minDistance: number;
  cloudToGroundFraction: number;
  private rng: Rng;
  private untilNext = Infinity;
  private scheduledRate = 0;

  constructor(options: SchedulerOptions) {
    this.rng = new Rng(options.seed);
    this.radius = options.radius ?? 8000;
    this.minDistance = options.minDistance ?? 600;
    this.cloudToGroundFraction = options.cloudToGroundFraction ?? 0.7;
  }

  // Seconds until the next strike of a Poisson process with this rate.
  private interval(): number {
    const perSecond = this.rate / 60;
    return perSecond > 0 ? -Math.log(1 - this.rng.next()) / perSecond : Infinity;
  }

  // Advances the clock; returns the strikes that happen during dt.
  update(dt: number, centreX: number, centreZ: number, out: Strike[] = []): Strike[] {
    out.length = 0;
    // The process is memoryless, so a rate change simply redraws the wait.
    if (this.rate !== this.scheduledRate) {
      this.scheduledRate = this.rate;
      this.untilNext = this.interval();
    }
    let remaining = dt;
    while (this.untilNext <= remaining) {
      remaining -= this.untilNext;
      out.push(this.place(centreX, centreZ));
      this.untilNext = this.interval();
    }
    this.untilNext -= remaining;
    return out;
  }

  // A strike uniformly distributed by area over the annulus around the centre.
  place(centreX: number, centreZ: number): Strike {
    const r0 = Math.min(this.minDistance, this.radius);
    const r = Math.sqrt(this.rng.next() * (this.radius ** 2 - r0 ** 2) + r0 ** 2);
    const angle = this.rng.range(0, Math.PI * 2);
    return {
      x: centreX + Math.cos(angle) * r,
      z: centreZ + Math.sin(angle) * r,
      seed: Math.floor(this.rng.next() * 2 ** 31),
      cloudToGround: this.rng.next() < this.cloudToGroundFraction,
    };
  }
}
