// Tracks the tasks of one load (startup or a scenario change): weighted overall progress,
// the current step, a smoothed time-remaining estimate, cancellation and retry-on-error.
// Tasks can be added at any time, so scenario loading only adds what is still missing.

import {
  EtaSmoother,
  ThroughputMeter,
  TimingHistory,
  DEFAULT_THROUGHPUT,
  estimateRemainingSeconds,
  formatEta,
  type KeyValueStorage,
} from './eta';
import { fetchWithProgress, type FetchWithProgressOptions } from './fetch';
import { describeStep } from './step';
import type { TaskSpec, TaskState, TaskStatus } from './types';

export type { TaskSpec, TaskState } from './types';

export type LoadingPhase = 'idle' | 'loading' | 'error' | 'done' | 'cancelled';

export interface TaskContext {
  readonly signal: AbortSignal;
  // 0..1 for tasks that can tell how far along they are.
  progress(fraction: number): void;
  // For downloads: bytes so far, and the size if it became known.
  bytes(loaded: number, total?: number | null): void;
  // Back to "can't tell" (e.g. a new sub-step started).
  indeterminate(): void;
  // Gives the browser a chance to paint between heavy chunks of work.
  yield(): Promise<void>;
}

export interface RunOptions {
  // 'wait' (default): show the error and wait for retry() or cancel(). 'throw': reject, so the caller
  // can fall back (e.g. to the procedural model).
  onError?: 'wait' | 'throw';
}

export interface LoadingSnapshot {
  readonly phase: LoadingPhase;
  readonly tasks: readonly TaskState[];
  // Weighted 0..1; indeterminate running tasks count as 0 until they finish.
  readonly progress: number;
  readonly current: TaskState | null;
  readonly stepText: string;
  readonly etaSeconds: number | null;
  readonly etaText: string;
  readonly error: unknown;
  readonly failedTask: TaskState | null;
  // Bumps whenever the task list changes shape (added, reset).
  readonly revision: number;
}

export interface LoadingManagerOptions {
  // Seconds; injectable for tests.
  now?: () => number;
  history?: TimingHistory;
  storage?: KeyValueStorage | null;
}

export class LoadCancelledError extends Error {
  constructor(message = 'Loading was cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

type MutableTask = { -readonly [K in keyof TaskState]: TaskState[K] };

async function yieldToBrowser(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class LoadingManager {
  readonly history: TimingHistory;
  private readonly now: () => number;
  private tasks = new Map<string, MutableTask>();
  private listeners = new Set<(snapshot: LoadingSnapshot) => void>();
  private phase: LoadingPhase = 'idle';
  private error: unknown = null;
  private revision = 0;
  private etaRevision = -1;
  private hadThroughput = false;
  private controller = new AbortController();
  private meter = new ThroughputMeter();
  private smoother = new EtaSmoother();
  private retryWaiters: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  private notifyQueued = false;

  constructor(options: LoadingManagerOptions = {}) {
    this.now = options.now ?? (() => performance.now() / 1000);
    this.history = options.history ?? new TimingHistory(options.storage);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get currentPhase(): LoadingPhase {
    return this.phase;
  }

  has(id: string): boolean {
    return this.tasks.has(id);
  }

  // Registers a task up front so the bar and estimate know about it before it runs. Idempotent.
  add(spec: TaskSpec): TaskState {
    const existing = this.tasks.get(spec.id);
    if (existing) return existing;
    const task: MutableTask = {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      weight: Math.max(0, spec.weight ?? this.defaultWeight(spec)),
      status: 'pending',
      progress: spec.kind === 'download' && spec.bytes ? 0 : null,
      loadedBytes: 0,
      totalBytes: spec.bytes ?? null,
      startedAt: null,
      finishedAt: null,
      error: null,
    };
    this.tasks.set(spec.id, task);
    this.revision++;
    if (this.phase === 'idle' || this.phase === 'done') this.phase = 'loading';
    this.queueNotify();
    return task;
  }

  addAll(specs: readonly TaskSpec[]): void {
    for (const spec of specs) this.add(spec);
  }

  // Runs fn as the given task, reporting through the context. On failure (with onError 'wait') the task
  // shows as failed and fn is re-run when retry() is called; cancel() rejects with LoadCancelledError.
  async run<T>(
    specOrId: TaskSpec | string,
    fn: (context: TaskContext) => Promise<T> | T,
    options: RunOptions = {},
  ): Promise<T> {
    const id = typeof specOrId === 'string' ? specOrId : specOrId.id;
    const task = typeof specOrId === 'string' ? this.tasks.get(id) : this.add(specOrId);
    if (!task) throw new Error(`Unknown loading task '${id}'`);
    for (;;) {
      this.throwIfCancelled();
      this.start(task);
      try {
        const result = await fn(this.contextFor(task));
        this.throwIfCancelled();
        this.complete(task);
        return result;
      } catch (error) {
        if (this.controller.signal.aborted) throw new LoadCancelledError();
        this.update(task, { status: 'failed', error });
        if (options.onError === 'throw') throw error;
        this.phase = 'error';
        this.error = error;
        this.queueNotify();
        await this.waitForRetry();
      }
    }
  }

  // Streams a URL as a download task, using the manifest size for progress.
  download(
    spec: TaskSpec & { url: string },
    options: Omit<FetchWithProgressOptions, 'signal'> & RunOptions = {},
  ): Promise<ArrayBuffer> {
    const { onError, ...fetchOptions } = options;
    return this.run(
      spec,
      (context) =>
        fetchWithProgress(spec.url, {
          expectedBytes: spec.bytes,
          ...fetchOptions,
          signal: context.signal,
          onProgress: (progress) => {
            context.bytes(progress.loaded, progress.total);
            fetchOptions.onProgress?.(progress);
          },
        }),
      { onError },
    );
  }

  // Marks the load complete; remembers the measured throughput for next time.
  finish(): void {
    if (this.phase === 'cancelled') return;
    const rate = this.meter.bytesPerSecond;
    if (rate !== null) this.history.recordThroughput(rate);
    this.phase = 'done';
    this.queueNotify();
  }

  retry(): void {
    if (this.phase !== 'error') return;
    this.phase = 'loading';
    this.error = null;
    // A retry restarts the clock on the failed work, so the estimate may legitimately rise.
    this.revision++;
    const waiters = this.retryWaiters;
    this.retryWaiters = [];
    for (const waiter of waiters) waiter.resolve();
    this.queueNotify();
  }

  // Aborts running tasks and rejects anything waiting on retry.
  cancel(): void {
    if (this.phase === 'cancelled') return;
    this.phase = 'cancelled';
    this.controller.abort(new LoadCancelledError());
    const waiters = this.retryWaiters;
    this.retryWaiters = [];
    for (const waiter of waiters) waiter.reject(new LoadCancelledError());
    this.queueNotify();
  }

  // Starts a fresh load (e.g. the next scenario). Remembered timings are kept.
  reset(): void {
    if (this.phase === 'loading' || this.phase === 'error') this.cancel();
    this.tasks.clear();
    this.controller = new AbortController();
    this.phase = 'idle';
    this.error = null;
    this.revision++;
    this.smoother.reset();
    this.queueNotify();
  }

  subscribe(listener: (snapshot: LoadingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): LoadingSnapshot {
    const now = this.now();
    const tasks = [...this.tasks.values()].map((task) => ({ ...task }));
    let total = 0;
    let done = 0;
    for (const task of tasks) {
      total += task.weight;
      done += task.weight * progressOf(task.status, task.progress);
    }
    const measured = this.meter.bytesPerSecond;
    const newInformation = this.revision !== this.etaRevision || (measured !== null && !this.hadThroughput);
    this.etaRevision = this.revision;
    this.hadThroughput ||= measured !== null;

    let etaSeconds: number | null = null;
    if (this.phase === 'loading' || this.phase === 'error') {
      const raw = estimateRemainingSeconds(tasks, now, measured, this.history);
      etaSeconds = this.smoother.update(raw, now, newInformation);
    } else if (this.phase === 'done') {
      etaSeconds = 0;
    }

    const current = tasks.find((task) => task.status === 'running') ?? null;
    const failedTask = tasks.find((task) => task.status === 'failed') ?? null;
    return {
      phase: this.phase,
      tasks,
      progress: this.phase === 'done' ? 1 : total > 0 ? Math.min(1, done / total) : 0,
      current,
      stepText: this.phase === 'cancelled' ? 'Cancelled' : describeStep(tasks),
      etaSeconds,
      etaText: this.phase === 'done' ? 'Ready' : this.phase === 'error' ? '' : formatEta(etaSeconds),
      error: this.error,
      failedTask: this.phase === 'error' ? failedTask : null,
      revision: this.revision,
    };
  }

  private defaultWeight(spec: TaskSpec): number {
    // Weight by expected time, so the bar fills at a roughly steady rate.
    if (spec.kind === 'download' && spec.bytes) {
      return spec.bytes / (this.history.throughput() ?? DEFAULT_THROUGHPUT);
    }
    return this.history.duration(spec.id, spec.kind);
  }

  private start(task: MutableTask): void {
    const restart = task.status === 'failed';
    this.update(task, {
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      progress: task.kind === 'download' && task.totalBytes ? 0 : null,
      loadedBytes: 0,
    });
    if (restart) this.revision++;
    if (this.phase === 'idle' || this.phase === 'done') this.phase = 'loading';
  }

  private complete(task: MutableTask): void {
    const finishedAt = this.now();
    this.update(task, { status: 'done', progress: 1, finishedAt });
    if (task.startedAt !== null) {
      const seconds = finishedAt - task.startedAt;
      // Sized downloads are estimated from throughput; everything else learns its duration.
      if (task.kind !== 'download' || task.totalBytes === null) this.history.record(task.id, seconds);
    }
  }

  private contextFor(task: MutableTask): TaskContext {
    const signal = this.controller.signal;
    return {
      signal,
      progress: (fraction) => this.update(task, { progress: clamp01(fraction) }),
      bytes: (loaded, total) => {
        const size = total === undefined ? task.totalBytes : total;
        const delta = loaded - task.loadedBytes;
        // A retry restarts from zero; that isn't negative throughput.
        if (delta > 0) this.meter.add(this.now(), delta);
        this.update(task, {
          loadedBytes: loaded,
          totalBytes: size,
          progress: size ? clamp01(loaded / size) : null,
        });
      },
      indeterminate: () => this.update(task, { progress: null }),
      yield: yieldToBrowser,
    };
  }

  private update(task: MutableTask, patch: Partial<MutableTask>): void {
    Object.assign(task, patch);
    this.queueNotify();
  }

  private throwIfCancelled(): void {
    if (this.controller.signal.aborted || this.phase === 'cancelled') throw new LoadCancelledError();
  }

  private waitForRetry(): Promise<void> {
    return new Promise((resolve, reject) => this.retryWaiters.push({ resolve, reject }));
  }

  // Progress callbacks can fire per network chunk; listeners hear about it once per microtask.
  private queueNotify(): void {
    if (this.notifyQueued || this.listeners.size === 0) return;
    this.notifyQueued = true;
    queueMicrotask(() => {
      this.notifyQueued = false;
      const snapshot = this.getSnapshot();
      for (const listener of this.listeners) listener(snapshot);
    });
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function progressOf(status: TaskStatus, progress: number | null): number {
  if (status === 'done') return 1;
  if (status === 'pending') return 0;
  return progress ?? 0;
}
