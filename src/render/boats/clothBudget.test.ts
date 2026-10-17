import { describe, expect, it } from 'vite-plus/test';

import { clothGrid, SailCloth } from '../../cloth/SailCloth';
import { clothBudget, ClothStepper, FULL_CLOTH } from './clothBudget';

describe('clothBudget', () => {
  it('keeps the helm boat at full rate wherever it is', () => {
    expect(clothBudget({ helm: true, visible: false, lod: 2 })).toEqual(FULL_CLOTH);
  });

  it('spends less on sails that are smaller on screen or off it', () => {
    const near = clothBudget({ helm: false, visible: true, lod: 0 });
    const mid = clothBudget({ helm: false, visible: true, lod: 1 });
    const far = clothBudget({ helm: false, visible: true, lod: 2 });
    const hidden = clothBudget({ helm: false, visible: false, lod: 0 });
    const cost = (b: { interval: number; maxSubsteps: number }): number => b.maxSubsteps / b.interval;
    expect(cost(near)).toBeLessThanOrEqual(cost(FULL_CLOTH));
    expect(cost(mid)).toBeLessThan(cost(near));
    expect(cost(far)).toBeLessThan(cost(mid));
    expect(cost(hidden)).toBeLessThanOrEqual(cost(far));
  });
});

describe('ClothStepper', () => {
  it('steps every n-th frame with the skipped time carried over', () => {
    const stepper = new ClothStepper();
    const steps: number[] = [];
    for (let i = 0; i < 8; i++) steps.push(stepper.advance(0.01, { interval: 4, maxSubsteps: 6 }));
    expect(steps.filter((s) => s > 0)).toHaveLength(2);
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(0.08, 9);
  });

  it('steps every frame at interval 1', () => {
    const stepper = new ClothStepper(3);
    for (let i = 0; i < 5; i++) expect(stepper.advance(0.016, FULL_CLOTH)).toBeCloseTo(0.016, 9);
  });
});

describe('sail cloth resolution and substeps', () => {
  it('takes graphics.sailCloth grids, clamped to something usable', () => {
    expect(new SailCloth('main', [20, 30]).cloth.count).toBe(600);
    expect(clothGrid([1, 1])).toEqual([3, 4]);
    expect(clothGrid([Number.NaN, 26])).toEqual([18, 26]);
  });

  it('stays finite with few substeps (a distant sail)', () => {
    const sail = new SailCloth('jib', 'low');
    const frame = {
      tack: { x: 0, y: 1, z: -3 },
      clew: { x: 0.5, y: 1.2, z: 2 },
      head: { x: 0, y: 14, z: 0 },
      headLeech: { x: 0, y: 14, z: 0.1 },
      air: { x: 6, y: 0, z: -8 },
      fill: 1,
      force: 2000,
      gravity: { x: 0, y: -9.81, z: 0 },
    };
    for (let i = 0; i < 60; i++) sail.update(1 / 15, frame, i / 15, 4);
    expect(sail.positions.every(Number.isFinite)).toBe(true);
    expect(sail.cloth.resets).toBe(0);
  });
});
