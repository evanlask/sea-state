import { describe, expect, it } from 'vite-plus/test';

import {
  copiedRow,
  historyShift,
  recentre,
  rowsForFrame,
  seaLevelFootprint,
  SHADOW_EXTENT,
  SHADOW_SNAP,
  type ShadowMapLayout,
  shadowTexelToWorld,
  texelSize,
  worldToShadowUv,
} from './shadowLayout';

const layout: ShadowMapLayout = { size: 256, extent: SHADOW_EXTENT, centerX: 2000, centerZ: -3000 };

describe('shadow map texel ↔ world', () => {
  it('round-trips texel centres through world space', () => {
    for (const [ix, iz] of [
      [0, 0],
      [127, 200],
      [255, 255],
    ] as const) {
      const w = shadowTexelToWorld(layout, ix, iz);
      const uv = worldToShadowUv(layout, w.x, w.z);
      expect(uv.u * layout.size - 0.5).toBeCloseTo(ix, 6);
      expect(uv.v * layout.size - 0.5).toBeCloseTo(iz, 6);
    }
  });

  it('centres the map on its centre and spans its extent', () => {
    expect(worldToShadowUv(layout, 2000, -3000)).toEqual({ u: 0.5, v: 0.5 });
    const first = shadowTexelToWorld(layout, 0, 0);
    const last = shadowTexelToWorld(layout, 255, 255);
    expect(last.x - first.x).toBeCloseTo(SHADOW_EXTENT - texelSize(layout));
    expect(texelSize(layout)).toBe(125);
  });

  it('traces raised points back along the light to the sea', () => {
    const light = { x: 0.6, y: 0.8, z: 0 };
    const p = seaLevelFootprint(100, 40, 50, light);
    expect(p.x).toBeCloseTo(100 - 0.6 * 50);
    expect(p.z).toBe(50);
    expect(seaLevelFootprint(1, 0, 2, light)).toEqual({ x: 1, z: 2 });
  });
});

describe('recentring and incremental refresh', () => {
  it('stays put near the centre and snaps when the focus wanders off', () => {
    expect(recentre(layout, 2500, -2500)).toBeNull();
    const moved = recentre(layout, 7400, -3100);
    expect(moved).toEqual({ centerX: 7000, centerZ: -3000 });
    expect((moved?.centerX ?? 0) % SHADOW_SNAP).toBe(0);
    const fresh = { ...layout, centerX: Number.NaN, centerZ: Number.NaN };
    expect(recentre(fresh, 10, 10)).toEqual({ centerX: 0, centerZ: 0 });
  });

  it('refreshes every row exactly once per cycle of slices', () => {
    const counts = Array.from({ length: 64 }, () => 0);
    for (let f = 0; f < 4; f++) for (const r of rowsForFrame(64, f, 4)) counts[r] = (counts[r] ?? 0) + 1;
    expect(counts.every((c) => c === 1)).toBe(true);
    expect(rowsForFrame(64, 5, 4)).toEqual(rowsForFrame(64, 1, 4));
  });
});

describe('shadow map history', () => {
  it('shifts the history by whole texels when the centre moves on the snap grid', () => {
    for (const size of [192, 256, 512]) {
      const l = { size, extent: SHADOW_EXTENT };
      const shift = historyShift(l, { x: 0, z: 0 }, { x: SHADOW_SNAP, z: -3 * SHADOW_SNAP });
      expect(shift.x * texelSize({ ...l, centerX: 0, centerZ: 0 })).toBeCloseTo(SHADOW_SNAP, 6);
      expect(shift.z).toBe(-3 * shift.x);
      expect(Number.isInteger(SHADOW_SNAP / (SHADOW_EXTENT / size))).toBe(true);
    }
  });

  it('copies exactly the rows the march skips, each once', () => {
    for (const [size, slices] of [
      [192, 6],
      [256, 4],
      [512, 8],
    ] as const) {
      for (const phase of [0, 3, slices - 1]) {
        const marched = new Set(rowsForFrame(size, phase, slices));
        const copied = new Set<number>();
        for (let j = 0; j < size - size / slices; j++) copied.add(copiedRow(j, slices, phase));
        expect(copied.size).toBe(size - marched.size);
        for (const r of copied) {
          expect(marched.has(r)).toBe(false);
          expect(r).toBeLessThan(size);
        }
      }
    }
  });
});
