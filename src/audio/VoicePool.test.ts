import { describe, expect, it } from 'vite-plus/test';

import { VoicePool } from './VoicePool';

describe('VoicePool', () => {
  it('hands out free slots first and reuses them once finished', () => {
    const pool = new VoicePool(2);
    expect(pool.acquire(0, 1)).toBe(0);
    expect(pool.acquire(0, 1)).toBe(1);
    expect(pool.lastStolen).toBe(false);
    expect(pool.activeCount(0.5)).toBe(2);
    expect(pool.acquire(1.5, 2)).toBe(0); // slot 0 finished at t = 1
    expect(pool.lastStolen).toBe(false);
  });

  it('steals the oldest voice of the lowest priority when full', () => {
    const pool = new VoicePool(3);
    pool.acquire(0, 10, 1); // 0
    pool.acquire(1, 10, 0); // 1, low priority
    pool.acquire(2, 10, 0); // 2, low priority, newer
    expect(pool.acquire(3, 10, 0)).toBe(1);
    expect(pool.lastStolen).toBe(true);
    expect(pool.acquire(4, 10, 0)).toBe(2);
  });

  it('drops a sound less important than everything playing', () => {
    const pool = new VoicePool(2);
    pool.acquire(0, 10, 5);
    pool.acquire(0, 10, 5);
    expect(pool.acquire(1, 10, 1)).toBe(-1);
    expect(pool.acquire(1, 10, 5)).toBe(0); // equal priority steals the oldest
  });

  it('treats future-scheduled sounds as busy until they end', () => {
    const pool = new VoicePool(1);
    pool.acquire(0, 30, 1); // e.g. thunder arriving in 20 s, rolling for 10
    expect(pool.isBusy(0, 15)).toBe(true);
    pool.release(0);
    expect(pool.isBusy(0, 15)).toBe(false);
  });

  it('rejects invalid sizes', () => {
    expect(() => new VoicePool(0)).toThrow();
  });
});
