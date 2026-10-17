import { describe, expect, it } from 'vite-plus/test';

import { RebuildScheduler, type RebuildTimers } from './graphicsRebuild';

function fakeTimers() {
  const queue = new Map<number, () => void>();
  let id = 0;
  const timers: RebuildTimers = {
    set: (fn) => {
      queue.set(++id, fn);
      return id;
    },
    clear: (handle) => void queue.delete(handle as number),
  };
  const fire = (): void => {
    const fns = [...queue.values()];
    queue.clear();
    for (const fn of fns) fn();
  };
  return {
    timers,
    fire,
    get size() {
      return queue.size;
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('RebuildScheduler', () => {
  it('applies once after rapid changes settle', async () => {
    const clock = fakeTimers();
    let runs = 0;
    const scheduler = new RebuildScheduler(async () => void runs++, 300, clock.timers);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(clock.size).toBe(1);
    expect(runs).toBe(0);
    clock.fire();
    await settle();
    expect(runs).toBe(1);
  });

  it('flushes straight away, and does nothing with nothing pending', async () => {
    const clock = fakeTimers();
    let runs = 0;
    const scheduler = new RebuildScheduler(async () => void runs++, 300, clock.timers);
    await scheduler.flush();
    expect(runs).toBe(0);
    scheduler.schedule();
    await scheduler.flush();
    expect(runs).toBe(1);
    expect(clock.size).toBe(0);
  });

  it('queues one more run for changes made while running', async () => {
    const clock = fakeTimers();
    let runs = 0;
    let release: () => void = () => undefined;
    const scheduler = new RebuildScheduler(
      () =>
        new Promise<void>((resolve) => {
          runs++;
          release = resolve;
        }),
      300,
      clock.timers,
    );
    scheduler.schedule();
    const first = scheduler.flush();
    expect(scheduler.busy).toBe(true);
    scheduler.schedule();
    scheduler.schedule();
    const second = scheduler.flush();
    release();
    await settle();
    expect(runs).toBe(2);
    release();
    await Promise.all([first, second]);
    await settle();
    expect(runs).toBe(2);
    expect(scheduler.busy).toBe(false);
  });

  it('cancel drops a pending change', async () => {
    const clock = fakeTimers();
    let runs = 0;
    const scheduler = new RebuildScheduler(async () => void runs++, 300, clock.timers);
    scheduler.schedule();
    scheduler.cancel();
    clock.fire();
    await scheduler.flush();
    expect(runs).toBe(0);
  });
});
