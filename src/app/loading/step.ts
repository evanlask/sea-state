// Human-readable step text for the loading screen, e.g. "Compiling ocean shaders…" or
// "Downloading container ship 12.4 / 18.0 MB". Pure so it can be tested without a DOM.

import type { TaskState } from './types';

const MB = 1_000_000;
const KB = 1_000;

// Both numbers share the larger one's unit so "0.8 / 18.0 MB" doesn't read as "800 KB / 18.0 MB".
export function formatBytePair(loaded: number, total: number | null): string {
  const scale = Math.max(loaded, total ?? 0);
  if (scale >= MB) {
    const a = (loaded / MB).toFixed(1);
    return total === null ? `${a} MB` : `${a} / ${(total / MB).toFixed(1)} MB`;
  }
  const a = Math.round(loaded / KB).toString();
  return total === null ? `${a} KB` : `${a} / ${Math.round(total / KB)} KB`;
}

function withEllipsis(text: string): string {
  return /(…|\.\.\.)$/.test(text) ? text : `${text}…`;
}

export function describeStep(tasks: readonly TaskState[]): string {
  const running = tasks.filter((task) => task.status === 'running');
  if (running.length === 0) {
    const failed = tasks.find((task) => task.status === 'failed');
    if (failed) return `${failed.label} failed`;
    return tasks.length > 0 && tasks.every((task) => task.status === 'done') ? 'Ready' : 'Loading…';
  }

  const downloads = running.filter((task) => task.kind === 'download');
  // Several parallel downloads read better as one line than as a flickering pick of one.
  if (downloads.length > 1 && downloads.length === running.length) {
    const loaded = downloads.reduce((sum, task) => sum + task.loadedBytes, 0);
    const sizes = downloads.map((task) => task.totalBytes);
    const total = sizes.every((size) => size !== null)
      ? sizes.reduce<number>((s, b) => s + (b ?? 0), 0)
      : null;
    return `Downloading ${downloads.length} files ${formatBytePair(loaded, total)}`;
  }

  const current = running[0];
  if (current.kind === 'download' && (current.loadedBytes > 0 || current.totalBytes !== null)) {
    return `${current.label} ${formatBytePair(current.loadedBytes, current.totalBytes)}`;
  }
  return withEllipsis(current.label);
}
