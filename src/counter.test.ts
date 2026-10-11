// Import from 'vite-plus/test', not 'vitest' — Vite+ bundles Vitest and
// re-exports it here. The prefer-vite-plus-imports lint rule enforces this.
import { describe, expect, it } from 'vite-plus/test';

import { add } from './counter';

describe('add', () => {
  it('adds two positive numbers', () => {
    expect(add(1, 2)).toBe(3);
  });

  it('handles negatives', () => {
    expect(add(-1, 1)).toBe(0);
  });
});
