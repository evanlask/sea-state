// AO bakes in workers (ao.worker.ts), so building a boat model doesn't block the page for the
// 100–400 ms the bake takes, and several models bake in parallel. Falls back to baking inline where
// workers aren't available (tests) or fail to start.

import { type AoBakeInput, type AoVolumeData, bakeAoVolume } from './ao';

interface BakeReply {
  id: number;
  data?: AoVolumeData;
  error?: string;
}

interface Pending {
  resolve: (data: AoVolumeData) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  pending: Map<number, Pending>;
}

let pool: PoolWorker[] | null = null;
let disabled = typeof Worker === 'undefined';
let nextId = 1;

const poolSize = (): number =>
  Math.max(1, Math.min(3, ((globalThis.navigator?.hardwareConcurrency ?? 4) as number) - 2));

function spawn(): PoolWorker | null {
  try {
    const worker = new Worker(new URL('./ao.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ao-bake',
    });
    const entry: PoolWorker = { worker, pending: new Map() };
    worker.addEventListener('message', (event: MessageEvent<BakeReply>) => {
      const request = entry.pending.get(event.data.id);
      if (!request) return;
      entry.pending.delete(event.data.id);
      if (event.data.data) request.resolve(event.data.data);
      else request.reject(new Error(event.data.error ?? 'AO bake failed'));
    });
    worker.addEventListener('error', () => {
      // A worker that can't start (CSP, old browser): bake inline from now on.
      disabled = true;
      for (const request of entry.pending.values()) request.reject(new Error('AO worker failed'));
      entry.pending.clear();
      worker.terminate();
    });
    return entry;
  } catch {
    disabled = true;
    return null;
  }
}

function leastBusy(): PoolWorker | null {
  if (disabled) return null;
  pool ??= [];
  const idle = pool.find((entry) => entry.pending.size === 0);
  if (idle) return idle;
  if (pool.length < poolSize()) {
    const entry = spawn();
    if (entry) pool.push(entry);
    return entry;
  }
  return pool.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
}

export async function bakeAoVolumeAsync(input: AoBakeInput): Promise<AoVolumeData> {
  const target = leastBusy();
  if (!target) return bakeAoVolume(input);
  const id = nextId++;
  try {
    return await new Promise<AoVolumeData>((resolve, reject) => {
      target.pending.set(id, { resolve, reject });
      // Copied, not transferred: the draft keeps its geometry.
      target.worker.postMessage({ id, input });
    });
  } catch {
    // A request that never reached the worker (or one it dropped) would keep the worker "busy".
    target.pending.delete(id);
    return bakeAoVolume(input);
  }
}
