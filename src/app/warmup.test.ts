// The incremental warm-up: one part of the scene per frame, every boat drawn, then whole frames.

import { describe, expect, it } from 'vite-plus/test';

import type { WarmupView } from '../render/SeaScene';
import { beginWarmUp, warmUp } from './warmup';

function fakeScene(arrivals: number[]) {
  const log: string[] = [];
  let view: WarmupView | null = null;
  let frame = 0;
  const scene = {
    boatCount: 0,
    setWarmup(on: boolean) {
      log.push(`warmup ${on}`);
      if (!on) view = null;
    },
    setWarmupView(next: WarmupView | null) {
      view = next;
    },
  };
  const tick = (): void => {
    scene.boatCount = arrivals[Math.min(frame, arrivals.length - 1)] ?? 0;
    frame++;
    log.push(view ? `${view.ocean ? 'O' : '-'}${view.effects ? 'F' : '-'}${view.boats}` : 'all');
  };
  let now = 0;
  const nextFrame = (): Promise<number> => Promise.resolve((now += 16));
  return { scene, tick, nextFrame, log };
}

describe('warm-up', () => {
  it('reveals sky, ocean, effects, then one boat per frame, then whole frames', async () => {
    const { scene, tick, nextFrame, log } = fakeScene([0, 1, 3]);
    await warmUp({ scene, boats: 3, tick, nextFrame });
    expect(log).toEqual([
      'warmup true',
      '--0',
      'O-0',
      'OF0', // boats 1..3 arrived meanwhile, still hidden
      'OF1',
      'OF2',
      'OF3',
      'all',
      'all',
      'all',
      'warmup false',
    ]);
  });

  it('waits (drawing no boats) until every boat is in, and reports progress up to 1', async () => {
    const { scene, tick, nextFrame, log } = fakeScene([0, 0, 0, 0, 0, 2]);
    const warm = beginWarmUp({ scene, boats: 2, tick, nextFrame, frames: 1 });
    const progress: number[] = [];
    const context = { progress: (f: number) => progress.push(f) } as never;
    await warm.scene(context);
    await warm.boats(context);
    warm.end();
    warm.end();
    expect(log.slice(4, 7)).toEqual(['OF0', 'OF0', 'OF0']);
    expect(log.filter((entry) => entry === 'warmup false')).toHaveLength(1);
    expect(progress.at(-1)).toBeCloseTo(1);
    for (let i = 1; i < progress.length; i++) {
      if (i !== 3) expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
  });

  it('gives up waiting for boats after the timeout', async () => {
    const { scene, tick, nextFrame, log } = fakeScene([0]);
    await warmUp({ scene, boats: 2, tick, nextFrame, timeoutMs: 100, frames: 1 });
    expect(log.at(-2)).toBe('all');
    expect(log.length).toBeLessThan(20);
  });
});
