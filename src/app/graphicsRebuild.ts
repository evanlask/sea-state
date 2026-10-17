// Batches graphics changes that rebuild pipelines: clicking through several options applies once,
// after the player settles (a short debounce) or straight away on leaving the settings screen. A
// change made while a rebuild runs queues one more afterwards. Pure apart from the injected timers.

export interface RebuildTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: RebuildTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RebuildScheduler {
  private readonly run: () => Promise<void>;
  private readonly delayMs: number;
  private readonly timers: RebuildTimers;
  private timer: unknown = null;
  private pending = false;
  private running: Promise<void> | null = null;

  constructor(run: () => Promise<void>, delayMs = 300, timers: RebuildTimers = browserTimers) {
    this.run = run;
    this.delayMs = delayMs;
    this.timers = timers;
  }

  // A rebuild setting changed: apply once things settle.
  schedule(): void {
    this.pending = true;
    this.clearTimer();
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  // Apply now if anything is waiting (leaving the settings screen); resolves when applied.
  flush(): Promise<void> {
    this.clearTimer();
    if (!this.pending) return this.idle();
    if (this.running) return this.running.then(() => this.flush());
    this.pending = false;
    this.running = this.run()
      .catch((error: unknown) => console.error('Applying graphics settings failed', error))
      .finally(() => {
        this.running = null;
      });
    // A change made meanwhile (without a timer, e.g. flushed early) runs after this one.
    return this.running.then(() => (this.pending && this.timer === null ? this.flush() : undefined));
  }

  // Drop anything waiting (a new voyage is built with the current settings anyway).
  cancel(): void {
    this.clearTimer();
    this.pending = false;
  }

  // Resolves once no rebuild is running.
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  get busy(): boolean {
    return this.running !== null;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }
}
