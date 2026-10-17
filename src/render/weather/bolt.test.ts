// Procedural bolt geometry: determinism, structure, branch counts and bounds.
import { describe, expect, it } from 'vite-plus/test';

import { type BoltSegment, generateBolt } from './bolt';

const start = { x: 100, y: 2000, z: -50 };
const end = { x: 300, y: 0, z: 250 };
const mainOf = (segments: BoltSegment[]): BoltSegment[] => segments.filter((s) => s.branch === 0);

describe('generateBolt', () => {
  it('is deterministic for a seed', () => {
    expect(generateBolt({ start, end, seed: 9 })).toEqual(generateBolt({ start, end, seed: 9 }));
    expect(generateBolt({ start, end, seed: 9 }).segments).not.toEqual(
      generateBolt({ start, end, seed: 10 }).segments,
    );
  });

  it('subdivides the main channel into a connected chain from cloud to sea', () => {
    const generations = 6;
    const main = mainOf(generateBolt({ start, end, seed: 3, generations }).segments);
    expect(main).toHaveLength(2 ** generations);
    expect([main[0]?.ax, main[0]?.ay, main[0]?.az]).toEqual([start.x, start.y, start.z]);
    const last = main[main.length - 1];
    expect([last?.bx, last?.by, last?.bz]).toEqual([end.x, end.y, end.z]);
    for (let i = 1; i < main.length; i++) {
      expect(main[i]?.ax).toBe(main[i - 1]?.bx);
      expect(main[i]?.ay).toBe(main[i - 1]?.by);
      expect(main[i]?.az).toBe(main[i - 1]?.bz);
    }
  });

  it('respects the branch limit and usually branches', () => {
    let total = 0;
    for (let seed = 0; seed < 50; seed++) {
      const bolt = generateBolt({ start, end, seed, maxBranches: 5 });
      expect(bolt.branchCount).toBeLessThanOrEqual(5);
      const ids = new Set(bolt.segments.filter((s) => s.branch > 0).map((s) => s.branch));
      expect(ids.size).toBe(bolt.branchCount);
      total += bolt.branchCount;
    }
    expect(total / 50).toBeGreaterThan(2);
    expect(generateBolt({ start, end, seed: 1, maxBranches: 0 }).branchCount).toBe(0);
  });

  it('draws branches dimmer and thinner than the main channel', () => {
    const bolt = generateBolt({ start, end, seed: 4, width: 2 });
    for (const segment of bolt.segments) {
      if (segment.branch === 0) {
        expect(segment.width).toBe(2);
        expect(segment.intensity).toBe(1);
      } else {
        expect(segment.width).toBeLessThan(2);
        expect(segment.intensity).toBeLessThan(1);
      }
    }
  });

  it('stays between cloud and sea, near the channel, inside its reported bounds', () => {
    const length = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
    for (let seed = 0; seed < 30; seed++) {
      const bolt = generateBolt({ start, end, seed });
      expect(bolt.min.y).toBeGreaterThanOrEqual(end.y);
      expect(bolt.max.y).toBeLessThanOrEqual(start.y);
      for (const s of bolt.segments) {
        for (const [x, y, z] of [
          [s.ax, s.ay, s.az],
          [s.bx, s.by, s.bz],
        ] as const) {
          expect(x).toBeGreaterThanOrEqual(bolt.min.x);
          expect(x).toBeLessThanOrEqual(bolt.max.x);
          expect(y).toBeGreaterThanOrEqual(bolt.min.y);
          expect(z).toBeLessThanOrEqual(bolt.max.z);
        }
      }
      expect(bolt.max.x - bolt.min.x).toBeLessThan(length * 1.6);
      expect(bolt.max.z - bolt.min.z).toBeLessThan(length * 1.6);
    }
  });
});
