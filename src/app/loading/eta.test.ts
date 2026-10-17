import { describe, expect, it } from 'vite-plus/test';

import {
  EtaSmoother,
  ThroughputMeter,
  TimingHistory,
  TIMINGS_KEY,
  DEFAULT_DURATIONS,
  estimateRemainingSeconds,
  formatEta,
  type KeyValueStorage,
  defaultStorage,
} from './eta';
import type { TaskState } from './types';

class FakeStorage implements KeyValueStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function task(patch: Partial<TaskState> & Pick<TaskState, 'id' | 'kind'>): TaskState {
  return {
    label: patch.id,
    weight: 1,
    status: 'pending',
    progress: null,
    loadedBytes: 0,
    totalBytes: null,
    startedAt: null,
    finishedAt: null,
    error: null,
    ...patch,
  };
}

describe('TimingHistory', () => {
  it('falls back to per-kind defaults and remembers an exponential average', () => {
    const storage = new FakeStorage();
    const history = new TimingHistory(storage, { alpha: 0.5 });
    expect(history.duration('ocean-shaders', 'compile')).toBe(DEFAULT_DURATIONS.compile);
    history.record('ocean-shaders', 4);
    expect(history.duration('ocean-shaders', 'compile')).toBe(4);
    history.record('ocean-shaders', 2);
    expect(history.duration('ocean-shaders', 'compile')).toBe(3);
  });

  it('persists across instances under the shared key', () => {
    const storage = new FakeStorage();
    new TimingHistory(storage).record('sky-luts', 1.25);
    new TimingHistory(storage).recordThroughput(5_000_000);
    expect(storage.data.has(TIMINGS_KEY)).toBe(true);
    const reloaded = new TimingHistory(storage);
    expect(reloaded.has('sky-luts')).toBe(true);
    expect(reloaded.duration('sky-luts', 'compute')).toBe(1.25);
    expect(reloaded.throughput()).toBe(5_000_000);
  });

  it('ignores corrupt storage and storage that throws', () => {
    const storage = new FakeStorage();
    storage.setItem(TIMINGS_KEY, '{not json');
    expect(new TimingHistory(storage).has('x')).toBe(false);
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const history = new TimingHistory(throwing);
    expect(() => history.record('x', 1)).not.toThrow();
    expect(new TimingHistory(null).duration('x', 'decode')).toBe(DEFAULT_DURATIONS.decode);
  });
});

describe('ThroughputMeter', () => {
  it('averages bytes over time and stays null until it has enough data', () => {
    const meter = new ThroughputMeter(3);
    meter.add(0, 0);
    meter.add(0.1, 100_000);
    expect(meter.bytesPerSecond).toBeNull();
    for (let t = 0.2; t <= 2.0001; t += 0.1) meter.add(t, 100_000);
    expect(meter.bytesPerSecond).toBeCloseTo(1_000_000, -3);
  });

  it('restarts the window after an idle gap but keeps the previous rate meanwhile', () => {
    const meter = new ThroughputMeter(3);
    for (let t = 0; t <= 1.0001; t += 0.1) meter.add(t, 50_000);
    const before = meter.bytesPerSecond;
    meter.add(10, 1_000);
    expect(meter.bytesPerSecond).toBe(before);
  });
});

describe('estimateRemainingSeconds', () => {
  const history = new TimingHistory(new FakeStorage());

  it('divides remaining bytes by measured throughput', () => {
    const tasks = [
      task({
        id: 'ship',
        kind: 'download',
        status: 'running',
        startedAt: 0,
        loadedBytes: 2e6,
        totalBytes: 10e6,
      }),
    ];
    expect(estimateRemainingSeconds(tasks, 1, 2e6, history)).toBeCloseTo(4);
  });

  it('is unknown while a download runs with no throughput measured', () => {
    const tasks = [task({ id: 'ship', kind: 'download', status: 'running', startedAt: 0, totalBytes: 1e6 })];
    expect(estimateRemainingSeconds(tasks, 0.1, null, history)).toBeNull();
  });

  it('uses remembered durations for pending and indeterminate tasks', () => {
    const remembered = new TimingHistory(new FakeStorage());
    remembered.record('ocean-shaders', 6);
    remembered.record('clouds', 2);
    const tasks = [
      task({ id: 'ocean-shaders', kind: 'compile', status: 'running', startedAt: 10 }),
      task({ id: 'clouds', kind: 'compute' }),
      task({ id: 'done', kind: 'compute', status: 'done' }),
    ];
    expect(estimateRemainingSeconds(tasks, 12, null, remembered)).toBeCloseTo(4 + 2);
    // Running long past the remembered time still leaves a little rather than claiming zero.
    expect(estimateRemainingSeconds(tasks, 30, null, remembered)).toBeCloseTo(6 * 0.15 + 2);
  });

  it('blends the observed rate in for tasks that report progress', () => {
    const tasks = [task({ id: 'fft', kind: 'compute', status: 'running', startedAt: 0, progress: 0.5 })];
    const fresh = new TimingHistory(new FakeStorage());
    fresh.record('fft', 2);
    // Half done after 4 s: history says 1 s left, the rate says 4 s; equal weights at p = 0.5.
    expect(estimateRemainingSeconds(tasks, 4, null, fresh)).toBeCloseTo(0.5 * 1 + 0.5 * 4);
  });
});

describe('EtaSmoother', () => {
  it('never increases without new information and never goes negative', () => {
    const smoother = new EtaSmoother(1.5);
    let previous = smoother.update(10, 0) ?? 0;
    const noisy = [12, 9, 14, 8, 11, 7, 20, 3, 2, 5, 0, -1, 4];
    for (let i = 0; i < noisy.length; i++) {
      const shown = smoother.update(noisy[i], (i + 1) * 0.25) ?? 0;
      expect(shown).toBeLessThanOrEqual(previous);
      expect(shown).toBeGreaterThanOrEqual(0);
      previous = shown;
    }
  });

  it('counts down at real time when the estimate is accurate', () => {
    const smoother = new EtaSmoother();
    smoother.update(10, 0);
    expect(smoother.update(8, 2)).toBeCloseTo(8);
  });

  it('jumps up when told the inputs genuinely changed', () => {
    const smoother = new EtaSmoother();
    smoother.update(5, 0);
    expect(smoother.update(15, 0.25)).toBeLessThanOrEqual(5);
    expect(smoother.update(15, 0.5, true)).toBe(15);
  });

  it('keeps counting down through a gap in the estimate', () => {
    const smoother = new EtaSmoother();
    expect(smoother.update(null, 0)).toBeNull();
    smoother.update(6, 1);
    expect(smoother.update(null, 2)).toBeCloseTo(5);
  });
});

describe('formatEta', () => {
  it('formats the ranges', () => {
    expect(formatEta(null)).toBe('Estimating…');
    expect(formatEta(1.2)).toBe('Almost there…');
    expect(formatEta(8.4)).toBe('About 8 s remaining');
    expect(formatEta(23)).toBe('About 25 s remaining');
    expect(formatEta(130)).toBe('About 2 min remaining');
  });
});

describe('defaultStorage', () => {
  it('is null where reading localStorage throws (sandboxed iframes, blocked cookies)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(defaultStorage()).toBeNull();
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
