import { describe, expect, it } from 'vite-plus/test';

import type { TaskState } from '../../app/loading/types';
import { buildSegments } from './segments';
import { TIPS, TipRotator } from './tips';

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

describe('TipRotator', () => {
  it('never repeats a tip back-to-back across many passes', () => {
    for (const tips of [TIPS, TIPS.slice(0, 2), TIPS.slice(0, 3)]) {
      const rotator = new TipRotator(tips, seeded(7));
      let previous = rotator.next();
      for (let i = 0; i < 500; i++) {
        const tip = rotator.next();
        expect(tip).not.toBe(previous);
        previous = tip;
      }
    }
  });

  it('shows every tip once per pass', () => {
    const rotator = new TipRotator(TIPS, seeded(3));
    const seen = new Set(Array.from({ length: TIPS.length }, () => rotator.next()));
    expect(seen.size).toBe(TIPS.length);
  });

  it('has a healthy set of tips in every category', () => {
    expect(TIPS.length).toBeGreaterThanOrEqual(30);
    for (const category of ['controls', 'weather', 'colregs', 'sailing', 'boats'] as const) {
      expect(TIPS.some((tip) => tip.category === category)).toBe(true);
    }
  });
});

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

describe('buildSegments', () => {
  it('groups by kind in load order with weighted widths and fills', () => {
    const segments = buildSegments([
      task({ id: 'shaders', kind: 'compile', weight: 2, status: 'running' }),
      task({ id: 'ship', kind: 'download', weight: 1, status: 'done' }),
      task({ id: 'stars', kind: 'download', weight: 1, status: 'running', progress: 0.5 }),
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['download', 'compile']);
    expect(segments[0]).toMatchObject({ share: 0.5, fill: 0.75, state: 'active', indeterminate: false });
    expect(segments[1]).toMatchObject({ share: 0.5, fill: 0, state: 'active', indeterminate: true });
  });

  it('marks finished and failed segments', () => {
    const segments = buildSegments([
      task({ id: 'a', kind: 'decode', status: 'done', progress: 1 }),
      task({ id: 'b', kind: 'warmup', status: 'failed' }),
    ]);
    expect(segments.map((s) => s.state)).toEqual(['done', 'failed']);
  });
});
