import { describe, expect, it } from 'vite-plus/test';

import { TimingHistory, type KeyValueStorage } from './eta';
import { LoadingManager, type LoadingSnapshot } from './LoadingManager';
import { describeStep, formatBytePair } from './step';

function memoryStorage(): KeyValueStorage {
  const data = new Map<string, string>();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

function setup(): { manager: LoadingManager; clock: { t: number } } {
  const clock = { t: 0 };
  const manager = new LoadingManager({ now: () => clock.t, history: new TimingHistory(memoryStorage()) });
  return { manager, clock };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('LoadingManager progress', () => {
  it('weights tasks and counts indeterminate running tasks as zero until done', async () => {
    const { manager } = setup();
    manager.addAll([
      { id: 'a', label: 'A', kind: 'compute', weight: 1 },
      { id: 'b', label: 'B', kind: 'compile', weight: 3 },
    ]);
    const gate = deferred();
    let report = (_p: number): void => {};
    const a = manager.run('a', async (context) => {
      report = (p) => context.progress(p);
      await gate.promise;
    });
    report(0.5);
    expect(manager.getSnapshot().progress).toBeCloseTo(0.5 / 4);
    gate.resolve();
    await a;
    expect(manager.getSnapshot().progress).toBeCloseTo(1 / 4);

    const gateB = deferred();
    const b = manager.run('b', () => gateB.promise);
    expect(manager.getSnapshot().current?.id).toBe('b');
    expect(manager.getSnapshot().current?.progress).toBeNull();
    expect(manager.getSnapshot().progress).toBeCloseTo(1 / 4);
    gateB.resolve();
    await b;
    expect(manager.getSnapshot().progress).toBe(1);
  });

  it('accepts tasks added dynamically and skips ones already present', () => {
    const { manager } = setup();
    manager.add({ id: 'ocean', label: 'Ocean', kind: 'compute', weight: 1 });
    const revision = manager.getSnapshot().revision;
    manager.add({ id: 'ocean', label: 'Ocean again', kind: 'compute', weight: 9 });
    expect(manager.getSnapshot().revision).toBe(revision);
    manager.add({ id: 'ship', label: 'Downloading ship', kind: 'download', bytes: 4e6, weight: 1 });
    const snapshot = manager.getSnapshot();
    expect(snapshot.tasks.map((t) => t.id)).toEqual(['ocean', 'ship']);
    expect(snapshot.revision).toBeGreaterThan(revision);
  });

  it('turns byte reports into download progress and step text', async () => {
    const { manager, clock } = setup();
    const gate = deferred();
    const run = manager.run(
      { id: 'ship', label: 'Downloading container ship', kind: 'download', bytes: 18e6 },
      async (context) => {
        clock.t = 1;
        context.bytes(12.4e6);
        await gate.promise;
      },
    );
    const snapshot = manager.getSnapshot();
    expect(snapshot.progress).toBeCloseTo(12.4 / 18);
    expect(snapshot.stepText).toBe('Downloading container ship 12.4 / 18.0 MB');
    gate.resolve();
    await run;
  });

  it('notifies subscribers once per burst of updates', async () => {
    const { manager } = setup();
    const seen: LoadingSnapshot[] = [];
    manager.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toHaveLength(1);
    await manager.run({ id: 'x', label: 'X', kind: 'compute' }, (context) => {
      for (let i = 0; i <= 10; i++) context.progress(i / 10);
    });
    await Promise.resolve();
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen.at(-1)?.tasks[0].status).toBe('done');
  });
});

describe('LoadingManager timings and ETA', () => {
  it('remembers task durations for the next load', async () => {
    const storage = memoryStorage();
    const clock = { t: 0 };
    const first = new LoadingManager({ now: () => clock.t, storage });
    await first.run({ id: 'ocean-shaders', label: 'Compiling ocean shaders', kind: 'compile' }, () => {
      clock.t = 4;
    });
    first.finish();

    const second = new LoadingManager({ now: () => clock.t, storage });
    second.add({ id: 'ocean-shaders', label: 'Compiling ocean shaders', kind: 'compile' });
    expect(second.getSnapshot().etaSeconds).toBeCloseTo(4);
    expect(second.getSnapshot().etaText).toBe('About 4 s remaining');
  });

  it('shows Ready and full progress once finished', () => {
    const { manager } = setup();
    manager.add({ id: 'x', label: 'X', kind: 'compute' });
    manager.finish();
    const snapshot = manager.getSnapshot();
    expect(snapshot.phase).toBe('done');
    expect(snapshot.progress).toBe(1);
    expect(snapshot.etaText).toBe('Ready');
  });
});

describe('LoadingManager errors and cancellation', () => {
  it('waits in the error state and re-runs the task on retry', async () => {
    const { manager } = setup();
    let attempts = 0;
    const run = manager.run({ id: 'stars', label: 'Loading stars', kind: 'decode' }, () => {
      attempts++;
      if (attempts === 1) throw new Error('corrupt');
      return 'ok';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const failed = manager.getSnapshot();
    expect(failed.phase).toBe('error');
    expect(failed.failedTask?.id).toBe('stars');
    expect((failed.error as Error).message).toBe('corrupt');
    manager.retry();
    await expect(run).resolves.toBe('ok');
    expect(attempts).toBe(2);
    expect(manager.getSnapshot().phase).toBe('loading');
  });

  it("rejects immediately with onError 'throw' so the caller can fall back", async () => {
    const { manager } = setup();
    const run = manager.run(
      { id: 'ship', label: 'Downloading ship', kind: 'download' },
      () => Promise.reject(new Error('404')),
      { onError: 'throw' },
    );
    await expect(run).rejects.toThrow('404');
    expect(manager.getSnapshot().phase).toBe('loading');
  });

  it('cancel aborts running tasks and rejects tasks waiting on retry', async () => {
    const { manager } = setup();
    let aborted = false;
    const running = manager.run({ id: 'a', label: 'A', kind: 'compute' }, (context) => {
      return new Promise<void>((_, reject) => {
        context.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('stopped'));
        });
      });
    });
    const failing = manager.run({ id: 'b', label: 'B', kind: 'compute' }, () => {
      throw new Error('nope');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    manager.cancel();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    await expect(failing).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
    expect(manager.getSnapshot().phase).toBe('cancelled');

    manager.reset();
    expect(manager.getSnapshot().tasks).toHaveLength(0);
    await expect(manager.run({ id: 'c', label: 'C', kind: 'compute' }, () => 3)).resolves.toBe(3);
  });
});

describe('step text', () => {
  it('formats byte pairs in a shared unit', () => {
    expect(formatBytePair(12.4e6, 18e6)).toBe('12.4 / 18.0 MB');
    expect(formatBytePair(0.8e6, 18e6)).toBe('0.8 / 18.0 MB');
    expect(formatBytePair(340e3, 512e3)).toBe('340 / 512 KB');
    expect(formatBytePair(2.5e6, null)).toBe('2.5 MB');
  });

  it('adds an ellipsis and summarises parallel downloads', () => {
    const base = {
      weight: 1,
      progress: null,
      startedAt: 0,
      finishedAt: null,
      error: null,
      status: 'running' as const,
    };
    expect(
      describeStep([
        {
          ...base,
          id: 'o',
          label: 'Compiling ocean shaders',
          kind: 'compile',
          loadedBytes: 0,
          totalBytes: null,
        },
      ]),
    ).toBe('Compiling ocean shaders…');
    expect(
      describeStep([
        { ...base, id: 'a', label: 'Downloading A', kind: 'download', loadedBytes: 1e6, totalBytes: 2e6 },
        { ...base, id: 'b', label: 'Downloading B', kind: 'download', loadedBytes: 1e6, totalBytes: 3e6 },
      ]),
    ).toBe('Downloading 2 files 2.0 / 5.0 MB');
  });
});
