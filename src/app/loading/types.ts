// Shared loading-task types, kept apart from LoadingManager so the ETA estimator and the
// loading-screen helpers can depend on them without importing the manager.

export type TaskKind = 'download' | 'decode' | 'compile' | 'compute' | 'warmup';

// Display order of the progress-bar segments, which is also the usual order of a load.
export const TASK_KINDS: readonly TaskKind[] = ['download', 'decode', 'compile', 'compute', 'warmup'];

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

export interface TaskSpec {
  id: string;
  // Imperative phrase without an ellipsis, e.g. 'Compiling ocean shaders' or 'Downloading container ship'.
  label: string;
  kind: TaskKind;
  // Relative share of the overall bar. Defaults to the expected seconds: remembered, else a per-kind
  // guess, or bytes over the measured throughput for downloads with known size.
  weight?: number;
  // Expected size of a download (from the asset manifest), used for progress and ETA before headers arrive.
  bytes?: number;
}

export interface TaskState {
  readonly id: string;
  readonly label: string;
  readonly kind: TaskKind;
  readonly weight: number;
  readonly status: TaskStatus;
  // 0..1, or null while the task can't say how far along it is.
  readonly progress: number | null;
  readonly loadedBytes: number;
  // Null when neither the manifest nor Content-Length gave a size.
  readonly totalBytes: number | null;
  // Seconds on the manager's clock; null until started / finished.
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly error: unknown;
}
