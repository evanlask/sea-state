import { describe, expect, it } from 'vite-plus/test';

import { watchPixelRatio } from './pixelRatio';

// A window whose devicePixelRatio can change, with the media queries asked of it.
function fakeWindow(ratio: number) {
  const queries: { query: string; listener: (() => void) | null }[] = [];
  const win = {
    devicePixelRatio: ratio,
    matchMedia(query: string) {
      const entry = { query, listener: null as (() => void) | null };
      queries.push(entry);
      return {
        addEventListener: (_type: 'change', listener: () => void) => {
          entry.listener = listener;
        },
        removeEventListener: (_type: 'change', listener: () => void) => {
          if (entry.listener === listener) entry.listener = null;
        },
      };
    },
  };
  // The ratio changes: the query for the old one stops matching and tells its listener.
  const change = (next: number): void => {
    const live = queries.find((q) => q.listener);
    win.devicePixelRatio = next;
    const listener = live?.listener;
    if (live) live.listener = null;
    listener?.();
  };
  return { win, queries, change };
}

describe('watchPixelRatio', () => {
  it('reports each change of the ratio and re-arms for the new one', () => {
    const { win, queries, change } = fakeWindow(2);
    let calls = 0;
    watchPixelRatio(win, () => calls++);
    expect(queries.map((q) => q.query)).toEqual(['(resolution: 2dppx)']);
    change(1);
    expect(calls).toBe(1);
    expect(queries.map((q) => q.query)).toEqual(['(resolution: 2dppx)', '(resolution: 1dppx)']);
    change(1.5);
    expect(calls).toBe(2);
    expect(queries.at(-1)?.query).toBe('(resolution: 1.5dppx)');
  });

  it('stops when asked, and does nothing without matchMedia', () => {
    const { win, queries, change } = fakeWindow(2);
    let calls = 0;
    const stop = watchPixelRatio(win, () => calls++);
    stop();
    expect(queries[0]?.listener).toBeNull();
    change(1);
    expect(calls).toBe(0);
    expect(() => watchPixelRatio({ devicePixelRatio: 1 }, () => calls++)()).not.toThrow();
  });
});
