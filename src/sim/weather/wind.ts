// Surface wind: mean 10 m wind, deterministic gusts as frozen turbulence advected with the mean flow
// (so a gust sweeps across a fleet from upwind), and a logarithmic boundary-layer profile.

import type { Vec3 } from '../core/math';
import { hash4, hashToUnit } from '../ocean/hash';
import type { WindConfig } from '../world/protocol';

// Roughness length over open sea. Charnock gives 1e-4–5e-4 m for moderate to strong winds.
const SEA_ROUGHNESS = 2e-4;
const MIN_PROFILE_HEIGHT = 0.5; // m; the log law is meaningless at the very surface

// Two octaves of value noise; the long one carries the gusts and lulls, the short one the flutter.
const GUST_PERIOD_LONG = 8; // s between independent knots
const GUST_PERIOD_SHORT = 2.3;
const GUST_WEIGHT_LONG = 0.75;
const GUST_WEIGHT_SHORT = 0.25;
// Typical 10-minute maximum of the normalized noise; dividing by it makes the expected peak gust over a
// 10-minute window equal the gust factor, which is how the factor is defined (3-s gust / 10-min mean).
const GUST_PEAK_NORM = 0.74;
// Gusts veer: the direction wanders by this many radians per unit of (gustFactor − 1).
const GUST_VEER = 0.3;
// Gusts are patches, not walls: across the wind the pattern changes over about U·GUST_WIDTH_TIME metres
// (for the long octave; the short one in proportion). [E] The lateral coherence of gusts falls as
// exp(−C_y·f·Δy/U) with C_y ≈ 10 (Davenport), e^−1 across ≈ U·1 s for the 8–16 s gusts. A boat meets one
// patch at a time; a 300 m ship lying beam-on to the wind spans several, and its windage averages them.
const GUST_WIDTH_TIME = 1; // s
const GUST_MIN_WIDTH = 5; // m
// Below this the advection speed is clamped so frozen-turbulence time stays finite in near calm.
const MIN_ADVECTION_SPEED = 0.5;

const CHANNEL_SPEED_LONG = 1;
const CHANNEL_SPEED_SHORT = 2;
const CHANNEL_VEER = 3;

// Mean wind part-way (w, 0..1) through a change: speed and gust factor blend, the direction veers
// the short way round. The simulation's wind transitions and the foam's sea-following wind use it.
export function blendWind(from: WindConfig, to: WindConfig, w: number): WindConfig {
  if (w >= 1) return { ...to };
  if (w <= 0) return { ...from };
  let turn = (to.from - from.from) % (2 * Math.PI);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  return {
    speed: from.speed + (to.speed - from.speed) * w,
    from: from.from + turn * w,
    gustFactor: from.gustFactor + (to.gustFactor - from.gustFactor) * w,
  };
}

export class WindField {
  speed = 0; // mean U10, m/s
  from = 0; // meteorological, radians
  gustFactor = 1;
  readonly z0: number;
  private seed: number;
  private dirX = 0; // unit vector the air moves toward
  private dirZ = 1;
  private profileNorm: number;

  constructor(config: WindConfig, seed: number, z0 = SEA_ROUGHNESS) {
    this.seed = seed >>> 0;
    this.z0 = z0;
    this.profileNorm = 1 / Math.log(10 / z0);
    this.set(config);
  }

  set(config: WindConfig): void {
    this.speed = Math.max(0, config.speed);
    this.from = config.from;
    this.gustFactor = Math.max(1, config.gustFactor);
    this.dirX = -Math.sin(config.from);
    this.dirZ = Math.cos(config.from);
  }

  // Mean-speed multiplier at height y: ln(z/z0)/ln(10/z0).
  shear(y: number): number {
    const z = y > MIN_PROFILE_HEIGHT ? y : MIN_PROFILE_HEIGHT;
    return Math.log(z / this.z0) * this.profileNorm;
  }

  // Frozen turbulence: the gust pattern at a point is the pattern upwind of it, earlier.
  private gustTime(x: number, z: number, t: number): number {
    const u = this.speed > MIN_ADVECTION_SPEED ? this.speed : MIN_ADVECTION_SPEED;
    return t - (x * this.dirX + z * this.dirZ) / u;
  }

  // Relative speed fluctuation: 1 at the mean; expected 10-minute peak ≈ gustFactor.
  gustMultiplier(x: number, z: number, t: number): number {
    if (this.gustFactor === 1) return 1;
    const tau = this.gustTime(x, z, t);
    // Across the wind, in gust widths of the long octave.
    const width = Math.max(GUST_MIN_WIDTH, this.speed * GUST_WIDTH_TIME);
    const across = (z * this.dirX - x * this.dirZ) / width;
    const n =
      GUST_WEIGHT_LONG * this.patch(CHANNEL_SPEED_LONG, tau / GUST_PERIOD_LONG, across) +
      GUST_WEIGHT_SHORT *
        this.patch(
          CHANNEL_SPEED_SHORT,
          tau / GUST_PERIOD_SHORT,
          (across * GUST_PERIOD_LONG) / GUST_PERIOD_SHORT,
        );
    return Math.max(0, 1 + ((this.gustFactor - 1) * n) / GUST_PEAK_NORM);
  }

  // One octave's noise at time u (in knot spacings) and cross-wind position c (in gust widths): independent
  // patterns in neighbouring strips, blended with the variance kept.
  private patch(channel: number, u: number, c: number): number {
    const i = Math.floor(c);
    const f = c - i;
    const w = f * f * (3 - 2 * f);
    const a = valueNoise(this.seed, channel + 16 * i, u);
    if (w <= 0) return a;
    const b = valueNoise(this.seed, channel + 16 * (i + 1), u);
    return ((1 - w) * a + w * b) / Math.sqrt((1 - w) * (1 - w) + w * w);
  }

  // Air velocity (toward which it blows) at a world point; writes into out, allocation-free.
  velocityAt(x: number, y: number, z: number, t: number, out: Vec3): Vec3 {
    const speed = this.speed * this.shear(y) * this.gustMultiplier(x, z, t);
    let dirX = this.dirX;
    let dirZ = this.dirZ;
    if (this.gustFactor > 1) {
      const tau = this.gustTime(x, z, t);
      const veer =
        GUST_VEER * (this.gustFactor - 1) * valueNoise(this.seed, CHANNEL_VEER, tau / GUST_PERIOD_LONG);
      const c = Math.cos(veer);
      const s = Math.sin(veer);
      // Clockwise (positive heading) rotation in the x-east, z-south plane.
      const rx = dirX * c - dirZ * s;
      dirZ = dirX * s + dirZ * c;
      dirX = rx;
    }
    out.x = dirX * speed;
    out.y = 0;
    out.z = dirZ * speed;
    return out;
  }

  // Wind speed at height y over the world origin.
  speedAt(y: number, t: number): number {
    return this.speed * this.shear(y) * this.gustMultiplier(0, 0, t);
  }
}

// Smooth 1D value noise in [-1, 1] with zero mean: triangular-distributed knots joined by a quintic
// fade, addressed by hash so any time (including negative) is valid without a table.
function valueNoise(seed: number, channel: number, u: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const a = knot(seed, channel, i);
  const b = knot(seed, channel, i + 1);
  const w = f * f * f * (f * (f * 6 - 15) + 10);
  return a + (b - a) * w;
}

function knot(seed: number, channel: number, i: number): number {
  return (
    hashToUnit(hash4(seed, channel, i | 0, 0x51ed270b)) +
    hashToUnit(hash4(seed, channel, i | 0, 0x2545f491)) -
    1
  );
}
