import { describe, expect, it } from 'vite-plus/test';

import {
  axisSpec,
  nearestNotch,
  stepLever,
  stepRate,
  stepSpring,
  Telegraph,
  TELEGRAPH_NOTCHES,
  TELEGRAPH_STOP,
} from './axes';

const run = (steps: number, fn: () => void): void => {
  for (let i = 0; i < steps; i++) fn();
};

describe('spring axis', () => {
  const spec = axisSpec('spring', { riseRate: 2, returnRate: 4 });

  it('ramps toward the held key at the rise rate', () => {
    let value = 0;
    value = stepSpring(value, { digital: 1, analog: 0 }, 0.1, spec);
    expect(value).toBeCloseTo(0.2);
    run(10, () => (value = stepSpring(value, { digital: 1, analog: 0 }, 0.1, spec)));
    expect(value).toBe(1);
  });

  it('returns to centre at the return rate and stops there', () => {
    let value = 1;
    value = stepSpring(value, { digital: 0, analog: 0 }, 0.1, spec);
    expect(value).toBeCloseTo(0.6);
    run(5, () => (value = stepSpring(value, { digital: 0, analog: 0 }, 0.1, spec)));
    expect(value).toBe(0);
  });

  it('uses the faster return rate when reversing through centre', () => {
    const value = stepSpring(0.5, { digital: -1, analog: 0 }, 0.1, spec);
    expect(value).toBeCloseTo(0.1);
  });

  it('passes analog input straight through', () => {
    expect(stepSpring(0, { digital: 0, analog: 0.42 }, 0.016, spec)).toBe(0.42);
  });
});

describe('lever axis', () => {
  const spec = axisSpec('lever', { riseRate: 0.5, analogRate: 1 });

  it('moves while held and stays where it is left', () => {
    let value = 0;
    run(10, () => (value = stepLever(value, { digital: 1, analog: 0 }, 0.1, spec)));
    expect(value).toBeCloseTo(0.5);
    run(10, () => (value = stepLever(value, { digital: 0, analog: 0 }, 0.1, spec)));
    expect(value).toBeCloseTo(0.5);
  });

  it('treats analog deflection as a rate and clamps', () => {
    let value = 0.9;
    run(10, () => (value = stepLever(value, { digital: 0, analog: 1 }, 0.1, spec)));
    expect(value).toBe(1);
    value = stepLever(value, { digital: 0, analog: -0.5 }, 0.2, spec);
    expect(value).toBeCloseTo(0.9);
  });
});

describe('rate axis', () => {
  it('is the held input, analog first', () => {
    const spec = axisSpec('rate');
    expect(stepRate({ digital: 1, analog: 0 }, spec)).toBe(1);
    expect(stepRate({ digital: 1, analog: -0.3 }, spec)).toBe(-0.3);
    expect(stepRate({ digital: 0, analog: 0 }, spec)).toBe(0);
  });
});

describe('telegraph', () => {
  it('has nine notches from Full Astern to Full Ahead', () => {
    expect(TELEGRAPH_NOTCHES.map((n) => n.name)).toEqual([
      'Full Astern',
      'Half Astern',
      'Slow Astern',
      'Dead Slow Astern',
      'Stop',
      'Dead Slow Ahead',
      'Slow Ahead',
      'Half Ahead',
      'Full Ahead',
    ]);
    expect(TELEGRAPH_NOTCHES[TELEGRAPH_STOP].value).toBe(0);
  });

  it('steps one notch at a time and clamps at the ends', () => {
    const t = new Telegraph();
    t.step(1);
    expect(t.notchInfo.name).toBe('Dead Slow Ahead');
    expect(t.value).toBe(0.2);
    run(10, () => t.step(1));
    expect(t.notchInfo.name).toBe('Full Ahead');
    run(20, () => t.step(-1));
    expect(t.notchInfo.name).toBe('Full Astern');
  });

  it('sweeps continuously with a trigger and snaps on release', () => {
    const t = new Telegraph();
    run(5, () => t.update(1, 0.1, 0.8)); // 0.4 → Slow Ahead
    expect(t.value).toBeCloseTo(0.4);
    t.update(0.5, 0.1, 0.8); // 0.44, still nearest Slow Ahead
    expect(t.value).toBeCloseTo(0.44);
    t.update(0, 0.1, 0.8);
    expect(t.notchInfo.name).toBe('Slow Ahead');
    expect(t.value).toBe(0.4);
  });

  it('finds the nearest notch', () => {
    expect(nearestNotch(0.9)).toBe(8);
    expect(nearestNotch(-0.05)).toBe(TELEGRAPH_STOP);
    expect(nearestNotch(-0.55)).toBe(1);
  });
});
