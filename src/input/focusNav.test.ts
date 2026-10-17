import { describe, expect, it } from 'vite-plus/test';

import { directionOf, pickNext, type RectLike, RepeatTimer } from './focusNav';

const r = (left: number, top: number, width = 100, height = 40): RectLike => ({ left, top, width, height });

describe('pickNext', () => {
  // A 2×2 grid with a wide button below.
  const grid = [r(0, 0), r(200, 0), r(0, 100), r(200, 100), r(0, 200, 300)];

  it('moves within rows and columns', () => {
    expect(pickNext(grid, 0, 'right')).toBe(1);
    expect(pickNext(grid, 0, 'down')).toBe(2);
    expect(pickNext(grid, 3, 'left')).toBe(2);
    expect(pickNext(grid, 3, 'up')).toBe(1);
    expect(pickNext(grid, 3, 'down')).toBe(4);
  });

  it('returns -1 at an edge', () => {
    expect(pickNext(grid, 1, 'right')).toBe(-1);
    expect(pickNext(grid, 0, 'up')).toBe(-1);
  });

  it('prefers the aligned item over a nearer diagonal one', () => {
    const rects = [r(0, 0), r(250, 60), r(0, 160)];
    expect(pickNext(rects, 0, 'down')).toBe(2);
  });

  it('starts at the top-left when nothing is focused', () => {
    expect(pickNext([r(200, 0), r(0, 100), r(0, 0)], -1, 'down')).toBe(2);
    expect(pickNext([], -1, 'down')).toBe(-1);
  });
});

describe('directionOf', () => {
  it('picks the dominant axis past the threshold', () => {
    expect(directionOf(0.2, 0.1)).toBeNull();
    expect(directionOf(0.9, 0.3)).toBe('right');
    expect(directionOf(-0.2, -0.8)).toBe('up');
  });
});

describe('RepeatTimer', () => {
  it('moves once, waits, then repeats', () => {
    const t = new RepeatTimer(0.5, 0.25);
    const moves: (string | null)[] = [];
    moves.push(t.update('down', 0.125));
    for (let i = 0; i < 10; i++) moves.push(t.update('down', 0.125));
    expect(moves.filter(Boolean).length).toBe(5); // at 0, then 0.5, 0.75, 1 and 1.25 s
    expect(t.update(null, 0.05)).toBeNull();
    expect(t.update('down', 0.05)).toBe('down');
  });
});
