import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AdvanceRequest, SimToMain } from './protocol';
import { WorkerSimHost } from './SimHost';

// A stand-in for the browser Worker that records what the host posts and lets a test answer it.
class FakeWorker {
  static last: FakeWorker;
  posted: unknown[] = [];
  private readonly listeners = new Map<string, ((event: never) => void)[]>();

  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(type: string, listener: (event: never) => void, options?: { once?: boolean }): void {
    const wrapped = options?.once
      ? (event: never): void => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }
  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {}
  reply(message: SimToMain): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: message } as never);
  }
}

const request = (): AdvanceRequest => ({
  type: 'advance',
  targetTime: 1,
  controls: {},
  commands: [],
  probes: new Float64Array(2),
});

const advances = (worker: FakeWorker): number =>
  worker.posted.filter((m) => (m as { type: string }).type === 'advance').length;

describe('WorkerSimHost', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops counting a failed advance as in flight, so one error does not stall the sim', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = new WorkerSimHost();
    const ready = host.init({} as never);
    const worker = FakeWorker.last;
    worker.reply({ type: 'ready', time: 0 });
    await ready;

    for (let i = 0; i < 3; i++) host.advance(request());
    expect(advances(worker)).toBe(3);
    host.advance(request()); // three unanswered: skipped
    expect(advances(worker)).toBe(3);

    worker.reply({ type: 'error', message: 'boom' });
    host.advance(request());
    expect(advances(worker)).toBe(4);
    host.dispose();
  });
});
