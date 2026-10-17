// Frame-rate meter for the player-facing FPS counter (graphics.showFps): counts rendered frames
// over a short interval and eases between readings so the number doesn't flicker. Pure, so it is
// tested without a DOM; the counter feeds it the rAF timestamp of each rendered frame.

export class FpsMeter {
  private readonly intervalMs: number;
  private readonly smoothing: number;
  private start: number | null = null;
  private last = 0;
  private frames = 0;
  private smoothed: number | null = null;

  constructor(options: { intervalMs?: number; smoothing?: number } = {}) {
    this.intervalMs = options.intervalMs ?? 250;
    // Weight given to each new reading; lower is steadier.
    this.smoothing = options.smoothing ?? 0.5;
  }

  // Call once per rendered frame with its timestamp in ms. Returns a new smoothed FPS when an
  // interval completes, otherwise null.
  frame(nowMs: number): number | null {
    // A hidden tab or a breakpoint isn't a frame rate worth reporting: start the interval over.
    if (this.start === null || nowMs - this.last > 1000 || nowMs < this.last) {
      this.start = nowMs;
      this.last = nowMs;
      this.frames = 0;
      return null;
    }
    this.last = nowMs;
    this.frames++;
    const elapsed = nowMs - this.start;
    if (elapsed < this.intervalMs) return null;
    const raw = (this.frames * 1000) / elapsed;
    this.smoothed = this.smoothed === null ? raw : this.smoothed + (raw - this.smoothed) * this.smoothing;
    this.start = nowMs;
    this.frames = 0;
    return this.smoothed;
  }

  reset(): void {
    this.start = null;
    this.frames = 0;
    this.smoothed = null;
  }
}

// "60 FPS"; a dash before the first reading.
export function formatFps(fps: number | null): string {
  return fps === null || !Number.isFinite(fps) ? '– FPS' : `${Math.max(0, Math.round(fps))} FPS`;
}
