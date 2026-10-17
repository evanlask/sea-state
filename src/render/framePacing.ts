// Frame pacing, pure: the dynamic-resolution controller (graphics.dynamicResolution / targetFps) and
// the FPS cap (graphics.fpsCap). The app feeds them timings; they never touch the renderer.

export interface DynamicResolutionOptions {
  targetFps: number;
  maxScale: number; // the preset's render scale
  minScale?: number; // default 0.7 (below that, a lower preset looks better than a blurrier image)
}

export interface FrameSample {
  now: number; // ms
  frameMs: number; // rAF interval (vsync-limited)
}

const STEP = 0.05; // render scales are quantised so small swings don't resize every target
const WINDOW_MS = 1000; // frames judged together
const HITCH_MS = 250; // longer frames are hitches (a shader build, GC, a tab switch), not load
const LATE = 1.25; // a frame this far over budget is late
const DOWN_SHARE = 0.3; // step down once this share of a full window is late…
const DOWN_HOLD = 1000; // …for this long
const UP_HOLD = 3000; // ms with (almost) no late frames before probing up
const UP_HOLD_MAX = 20_000; // the wait after failed probes grows to this
const PROBE_WINDOW = 2500; // a probe that turns late within this long failed
const FORGET_FAILURE = 60_000; // a failed scale may be tried again at the normal pace after this
const MIN_GAP = 900; // ms between changes (resizes reallocate render targets)

const quantise = (scale: number): number => Math.round(scale / STEP) * STEP;

// Steps the render scale between minScale and maxScale to hold the target frame rate, judged on the
// vsync-limited frame interval. (On Apple GPUs WebGPU's timestamp queries overstate GPU time, so
// they can't be trusted to steer.) Robust to hitches: it looks at the share of late frames over a
// second and ignores single long frames, so a shader build or a menu doesn't throw resolution away.
// It probes back up after a quiet spell, backing off (but not forever) when a probe fails.
export class DynamicResolution {
  scale: number;
  private options: Required<DynamicResolutionOptions>;
  private frames: { at: number; late: boolean }[] = [];
  private overSince: number | null = null;
  private underSince: number | null = null;
  private lastChange = -Infinity;
  private upHold = UP_HOLD;
  private failedScale = Infinity;
  private failedAt = -Infinity;
  private probeAt: number | null = null; // when the last upward step happened, until it holds

  constructor(options: DynamicResolutionOptions) {
    this.options = { minScale: 0.7, ...options };
    this.scale = this.clamp(options.maxScale);
  }

  get budgetMs(): number {
    return 1000 / Math.max(1, this.options.targetFps);
  }

  configure(options: Partial<DynamicResolutionOptions>): void {
    this.options = { ...this.options, ...options };
    this.scale = this.clamp(this.scale);
  }

  reset(scale = this.options.maxScale): void {
    this.scale = this.clamp(scale);
    this.frames = [];
    this.overSince = this.underSince = this.probeAt = null;
    this.upHold = UP_HOLD;
    this.failedScale = Infinity;
  }

  // Returns the new scale when it changes, else null.
  update(sample: FrameSample): number | null {
    const { now, frameMs } = sample;
    if (!(frameMs > 0) || frameMs > HITCH_MS) return null;
    const budget = this.budgetMs;
    this.frames.push({ at: now, late: frameMs > budget * LATE });
    while (this.frames.length && this.frames[0]!.at < now - WINDOW_MS) this.frames.shift();
    // Judge only a full window of frames since the last change.
    if (now - this.lastChange < WINDOW_MS || this.frames[0]!.at > now - WINDOW_MS * 0.9) return null;
    const lateShare = this.frames.filter((f) => f.late).length / this.frames.length;
    const over = lateShare >= DOWN_SHARE;
    const under = lateShare <= 0.05;
    this.overSince = over ? (this.overSince ?? now) : null;
    this.underSince = under ? (this.underSince ?? now) : null;
    if (now - this.failedAt > FORGET_FAILURE) {
      this.failedScale = Infinity;
      this.upHold = UP_HOLD;
    }
    if (now - this.lastChange < MIN_GAP) return null;

    if (this.overSince !== null && now - this.overSince >= DOWN_HOLD) {
      if (this.probeAt !== null && now - this.probeAt < PROBE_WINDOW + DOWN_HOLD) {
        // The probe failed: back to the last good size and wait longer before trying it again.
        this.failedScale = Math.min(this.failedScale, this.scale);
        this.failedAt = now;
        this.upHold = Math.min(this.upHold * 2, UP_HOLD_MAX);
        this.probeAt = null;
        return this.change(this.scale - STEP, now);
      }
      this.probeAt = null;
      // More late frames, a bigger step (pixel cost goes with scale²).
      const factor = Math.max(0.8, Math.min(0.95, 1 - lateShare * 0.3));
      return this.change(Math.min(this.scale - STEP, quantise(this.scale * factor)), now);
    }
    if (this.probeAt !== null && now - this.probeAt >= PROBE_WINDOW + DOWN_HOLD) this.probeAt = null; // it held
    const up = this.scale + STEP;
    const hold = up >= this.failedScale - 1e-6 ? this.upHold : UP_HOLD;
    if (this.underSince !== null && now - this.underSince >= hold && this.scale < this.options.maxScale) {
      this.probeAt = now;
      return this.change(up, now);
    }
    return null;
  }

  private change(next: number, now: number): number | null {
    const scale = this.clamp(next);
    if (Math.abs(scale - this.scale) < 1e-6) return null;
    this.scale = scale;
    this.lastChange = now;
    this.overSince = this.underSince = null;
    this.frames = []; // fresh measurements at the new size
    return scale;
  }

  private clamp(scale: number): number {
    const { minScale, maxScale } = this.options;
    const lo = Math.min(minScale, maxScale);
    return Math.min(maxScale, Math.max(lo, Number.isFinite(scale) ? scale : maxScale));
  }
}

// The frame rate dynamic resolution aims for: graphics.targetFps, but never above the FPS cap, whose
// frame intervals would otherwise all look late and drag the render scale to its floor.
export function dynamicTargetFps(targetFps: number, fpsCap: number): number {
  return fpsCap > 0 ? Math.min(targetFps, fpsCap) : targetFps;
}

// graphics.fpsCap: decides which rAF callbacks render. 0 = every one.
export class FrameLimiter {
  cap: number;
  private last = -Infinity;

  constructor(cap = 0) {
    this.cap = cap;
  }

  shouldRender(now: number): boolean {
    if (!(this.cap > 0)) return true;
    const interval = 1000 / this.cap;
    const elapsed = now - this.last;
    // rAF timestamps jitter by a fraction of a millisecond; 1 ms of slack keeps a 60 cap on a 60 Hz
    // display from dropping every other frame.
    if (elapsed < interval - 1) return false;
    // Keep the phase (so 40 on a 120 Hz display alternates 3/3 frames) unless we fell far behind.
    this.last = elapsed < 2 * interval ? this.last + interval : now;
    if (this.last > now) this.last = now;
    return true;
  }
}
