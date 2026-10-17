// Time-remaining estimate for the loading screen. Downloads use a moving average of
// measured throughput; other tasks use durations remembered from earlier loads on this
// device. The displayed value is smoothed so it counts down steadily instead of jumping.

import type { TaskKind, TaskState } from './types';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TIMINGS_KEY = 'sea-state:load-timings';

// First-visit guesses (seconds) for a task we have never timed.
export const DEFAULT_DURATIONS: Readonly<Record<TaskKind, number>> = {
  download: 1,
  decode: 0.4,
  compile: 1.5,
  compute: 0.8,
  warmup: 0.5,
};

// Used for downloads that haven't started when nothing has been measured yet (~16 Mbit/s).
export const DEFAULT_THROUGHPUT = 2_000_000;

// localStorage can be missing (workers, Node) or throw on access (privacy modes).
export function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

interface StoredTimings {
  v: 1;
  tasks: Record<string, number>;
  throughput?: number;
}

// Per-task-id exponential average of how long each task took on this device.
export class TimingHistory {
  private readonly storage: KeyValueStorage | null;
  private readonly key: string;
  private readonly alpha: number;
  private data: StoredTimings;

  constructor(
    storage: KeyValueStorage | null = defaultStorage(),
    options: { key?: string; alpha?: number } = {},
  ) {
    this.storage = storage;
    this.key = options.key ?? TIMINGS_KEY;
    this.alpha = options.alpha ?? 0.4;
    this.data = this.load();
  }

  has(id: string): boolean {
    return id in this.data.tasks;
  }

  duration(id: string, kind: TaskKind): number {
    return this.data.tasks[id] ?? DEFAULT_DURATIONS[kind];
  }

  record(id: string, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const clamped = Math.min(seconds, 600);
    const previous = this.data.tasks[id];
    this.data.tasks[id] = previous === undefined ? clamped : previous + (clamped - previous) * this.alpha;
    this.save();
  }

  throughput(): number | null {
    return this.data.throughput ?? null;
  }

  recordThroughput(bytesPerSecond: number): void {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return;
    const previous = this.data.throughput;
    this.data.throughput =
      previous === undefined ? bytesPerSecond : previous + (bytesPerSecond - previous) * this.alpha;
    this.save();
  }

  private load(): StoredTimings {
    const empty: StoredTimings = { v: 1, tasks: {} };
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as Partial<StoredTimings>;
      if (parsed.v !== 1 || typeof parsed.tasks !== 'object' || parsed.tasks === null) return empty;
      const tasks: Record<string, number> = {};
      for (const [id, value] of Object.entries(parsed.tasks)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) tasks[id] = value;
      }
      const throughput =
        typeof parsed.throughput === 'number' && parsed.throughput > 0 ? parsed.throughput : undefined;
      return throughput === undefined ? { v: 1, tasks } : { v: 1, tasks, throughput };
    } catch {
      return empty;
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.data));
    } catch {
      // Quota or privacy mode: estimates just won't improve next time.
    }
  }
}

// Moving average of aggregate download throughput over a sliding time window.
export class ThroughputMeter {
  private readonly windowSeconds: number;
  private samples: { time: number; bytes: number }[] = [];
  private cumulative = 0;
  private lastRate: number | null = null;

  constructor(windowSeconds = 3) {
    this.windowSeconds = windowSeconds;
  }

  // Call with the bytes received since the previous call, while a download is active.
  add(now: number, deltaBytes: number): void {
    const last = this.samples.at(-1);
    // After an idle gap the old samples would average in time with nothing downloading.
    if (last && now - last.time > 1) {
      this.lastRate = this.bytesPerSecond ?? this.lastRate;
      this.samples = [];
    }
    if (this.samples.length === 0) this.samples.push({ time: now, bytes: this.cumulative });
    this.cumulative += Math.max(0, deltaBytes);
    this.samples.push({ time: now, bytes: this.cumulative });
    while (this.samples.length > 2 && now - this.samples[1].time > this.windowSeconds) this.samples.shift();
  }

  // Null until enough time has passed to say anything; falls back to the previous burst.
  get bytesPerSecond(): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last) return this.lastRate;
    const span = last.time - first.time;
    if (span < 0.3) return this.lastRate;
    return (last.bytes - first.bytes) / span;
  }
}

// Raw (unsmoothed) seconds remaining, or null while a running download has no measured throughput yet.
export function estimateRemainingSeconds(
  tasks: readonly TaskState[],
  now: number,
  measuredBytesPerSecond: number | null,
  history: TimingHistory,
): number | null {
  let remainingBytes = 0;
  let downloadRunning = false;
  let seconds = 0;

  for (const task of tasks) {
    if (task.status === 'done') continue;
    const expected = history.duration(task.id, task.kind);
    if (task.kind === 'download' && task.totalBytes !== null) {
      remainingBytes += Math.max(0, task.totalBytes - task.loadedBytes);
      if (task.status === 'running') downloadRunning = true;
      continue;
    }
    if (task.status !== 'running' || task.startedAt === null) {
      seconds += expected;
      continue;
    }
    const elapsed = Math.max(0, now - task.startedAt);
    const p = task.progress;
    if (p !== null && p > 0.05) {
      // Trust the observed rate more as the task gets further along.
      const fromRate = (elapsed / p) * (1 - p);
      const fromHistory = expected * (1 - p);
      seconds += fromHistory * (1 - p) + fromRate * p;
    } else {
      // Indeterminate: assume it takes as long as last time, but never claim it's finished.
      seconds += Math.max(expected - elapsed, expected * 0.15);
    }
  }

  if (remainingBytes > 0) {
    if (downloadRunning && measuredBytesPerSecond === null) return null;
    const rate = measuredBytesPerSecond ?? history.throughput() ?? DEFAULT_THROUGHPUT;
    seconds += remainingBytes / Math.max(rate, 1);
  }
  return seconds;
}

// Counts down steadily and only moves up when the caller says the inputs genuinely changed.
export class EtaSmoother {
  private readonly tau: number;
  private shown: number | null = null;
  private lastTime = 0;

  constructor(tauSeconds = 1.5) {
    this.tau = tauSeconds;
  }

  reset(): void {
    this.shown = null;
  }

  update(raw: number | null, now: number, newInformation = false): number | null {
    const dt = Math.max(0, now - this.lastTime);
    this.lastTime = now;
    const previous = this.shown;
    if (previous === null) {
      this.shown = raw === null ? null : Math.max(0, raw);
      return this.shown;
    }
    const predicted = Math.max(0, previous - dt);
    if (raw === null) {
      this.shown = predicted;
    } else if (newInformation && raw > previous) {
      this.shown = raw;
    } else {
      const k = 1 - Math.exp(-dt / this.tau);
      const candidate = predicted + (raw - predicted) * k;
      this.shown = Math.max(0, Math.min(previous, candidate));
    }
    return this.shown;
  }
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'Estimating…';
  if (seconds < 3) return 'Almost there…';
  if (seconds < 10) return `About ${Math.round(seconds)} s remaining`;
  if (seconds < 60) return `About ${Math.max(10, Math.round(seconds / 5) * 5)} s remaining`;
  return `About ${Math.max(1, Math.round(seconds / 60))} min remaining`;
}
