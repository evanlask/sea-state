// Render-time bookkeeping: buffers recent simulation snapshots and produces a
// smoothed render time that trails the newest snapshot, so poses can be
// interpolated without the 8.3 ms judder of the fixed physics step or the
// jitter of worker message timing.

export interface Timed {
  time: number;
}

export interface Bracket<T extends Timed> {
  a: T;
  b: T;
  alpha: number; // 0 → a, 1 → b
}

export class SnapshotBuffer<T extends Timed> {
  private items: T[] = [];
  private capacity: number;

  constructor(capacity = 6) {
    this.capacity = capacity;
  }

  push(item: T): void {
    const last = this.items.at(-1);
    if (last && item.time < last.time) this.items = []; // time went backwards: scenario reset
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }

  get latest(): T | undefined {
    return this.items.at(-1);
  }

  clear(): void {
    this.items = [];
  }

  // The pair of snapshots around `time`, clamped to the buffered range.
  bracket(time: number): Bracket<T> | null {
    const items = this.items;
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return null;
    if (time <= first.time) return { a: first, b: first, alpha: 0 };
    if (time >= last.time) return { a: last, b: last, alpha: 0 };
    for (let i = items.length - 1; i > 0; i--) {
      const a = items[i - 1];
      const b = items[i];
      if (a && b && time >= a.time) {
        const span = b.time - a.time;
        return { a, b, alpha: span > 0 ? (time - a.time) / span : 0 };
      }
    }
    return { a: first, b: first, alpha: 0 };
  }
}

export class RenderClock {
  time = 0;
  private initialized = false;
  private readonly delay: number;
  private readonly snapThreshold: number;
  private readonly gain: number;

  // delay: how far behind the newest snapshot to render (≈1.5 physics steps).
  constructor({ delay = 1.5 / 120, snapThreshold = 0.25, gain = 4 } = {}) {
    this.delay = delay;
    this.snapThreshold = snapThreshold;
    this.gain = gain;
  }

  // Advances by the frame's real dt, then eases toward (latest - delay).
  update(frameDt: number, latestSnapshotTime: number): number {
    const target = latestSnapshotTime - this.delay;
    if (!this.initialized || Math.abs(target - this.time) > this.snapThreshold) {
      this.time = target;
      this.initialized = true;
      return this.time;
    }
    const advanced = this.time + frameDt;
    const corrected = advanced + (target - advanced) * Math.min(1, this.gain * frameDt);
    // Never step backwards and never run past the newest data.
    this.time = Math.min(Math.max(this.time, corrected), latestSnapshotTime);
    return this.time;
  }

  reset(): void {
    this.initialized = false;
  }
}
