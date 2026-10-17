import { describe, expect, it } from 'vite-plus/test';

import { CloudReadout } from './cloudReadout';

describe('CloudReadout', () => {
  it('takes the first readout as is', () => {
    const readout = new CloudReadout(0.3);
    expect(readout.update({ through: 0.4, direct: 0.2, air: 0.7 }, 1 / 60)).toEqual({
      through: 0.4,
      direct: 0.2,
      air: 0.7,
    });
  });

  it('eases a stepped readback instead of following the step', () => {
    const readout = new CloudReadout(0.3);
    readout.update({ through: 1, direct: 1, air: 1 }, 1 / 60);
    const step = { through: 0.2, direct: 0.1, air: 0.5 };
    const first = readout.update(step, 1 / 60).direct;
    expect(first).toBeGreaterThan(0.9);
    let t = 1 / 60;
    while (t < 0.3 - 1e-9) {
      readout.update(step, 1 / 60);
      t += 1 / 60;
    }
    // One time constant: 1 − 1/e of the way there.
    expect(readout.value.direct).toBeCloseTo(1 - 0.9 * (1 - Math.exp(-1)), 6);
    for (let i = 0; i < 600; i++) readout.update(step, 1 / 60);
    expect(readout.value.through).toBeCloseTo(0.2, 6);
    expect(readout.value.air).toBeCloseTo(0.5, 6);
  });

  it('holds still for a zero or negative step', () => {
    const readout = new CloudReadout(0.3);
    readout.update({ through: 1, direct: 1, air: 1 }, 1 / 60);
    expect(readout.update({ through: 0, direct: 0, air: 0 }, 0).through).toBe(1);
    expect(readout.update({ through: 0, direct: 0, air: 0 }, -1).through).toBe(1);
  });
});
