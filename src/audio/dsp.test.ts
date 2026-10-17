import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../sim/core/rng';
import {
  Biquad,
  harmonicTables,
  noiseLoop,
  peakOf,
  renderCrack,
  renderCreak,
  renderCrest,
  renderDrops,
  renderFlogSnap,
  renderLap,
  renderSlam,
  renderSplash,
  renderWinch,
  rmsOf,
} from './dsp';

const SR = 48000;

const meanStep = (d: Float32Array): number => {
  let s = 0;
  for (let i = 1; i < d.length; i++) s += Math.abs((d[i] ?? 0) - (d[i - 1] ?? 0));
  return s / (d.length - 1);
};

describe('noise loops', () => {
  for (const color of ['white', 'pink', 'brown'] as const) {
    it(`${color} noise is normalized, finite and loops without a jump`, () => {
      const data = noiseLoop(color, SR, new Rng(1));
      expect(data.length).toBe(SR);
      expect(peakOf(data)).toBeCloseTo(0.9, 5);
      expect(data.every(Number.isFinite)).toBe(true);
      // The wrap-around step is no bigger than an ordinary sample-to-sample step.
      const wrap = Math.abs((data[0] ?? 0) - (data[data.length - 1] ?? 0));
      expect(wrap).toBeLessThan(meanStep(data) * 6);
    });
  }

  it('brown noise is darker than white', () => {
    const white = noiseLoop('white', SR, new Rng(2));
    const brown = noiseLoop('brown', SR, new Rng(2));
    expect(meanStep(brown)).toBeLessThan(meanStep(white) / 5);
  });
});

describe('one-shot renderers', () => {
  const renderers: Record<string, (sr: number, rng: Rng) => Float32Array> = {
    slam: renderSlam,
    splash: renderSplash,
    creak: renderCreak,
    winch: (sr, rng) => renderWinch(sr, rng),
    crack: renderCrack,
    crest: renderCrest,
    lap: renderLap,
    snap: renderFlogSnap,
  };
  for (const [name, render] of Object.entries(renderers)) {
    it(`${name} renders finite audio below full scale`, () => {
      const data = render(SR, new Rng(3));
      expect(data.length).toBeGreaterThan(SR * 0.1);
      expect(data.every(Number.isFinite)).toBe(true);
      expect(peakOf(data)).toBeLessThanOrEqual(0.95 + 1e-6);
      expect(rmsOf(data)).toBeGreaterThan(0.005);
    });
  }

  it('rain drop loops are seeded and bounded', () => {
    const sparse = renderDrops(SR, new Rng(4), 1, 20, 'deck');
    const dense = renderDrops(SR, new Rng(4), 1, 150, 'water');
    expect(peakOf(dense)).toBeLessThanOrEqual(0.8 + 1e-6);
    expect(rmsOf(dense)).toBeGreaterThan(0);
    expect(renderDrops(SR, new Rng(4), 1, 20, 'deck')).toEqual(sparse);
  });
});

describe('Biquad', () => {
  it('low-pass passes DC and blocks Nyquist', () => {
    const lp = Biquad.lowpass(1000, 0.707, SR);
    let y = 0;
    for (let i = 0; i < 2000; i++) y = lp.process(1);
    expect(y).toBeCloseTo(1, 3);
    const lp2 = Biquad.lowpass(1000, 0.707, SR);
    let peak = 0;
    for (let i = 0; i < 2000; i++) {
      const out = lp2.process(i % 2 ? 1 : -1);
      if (i > 1000) peak = Math.max(peak, Math.abs(out));
    }
    expect(peak).toBeLessThan(0.01);
  });

  it('band-pass peaks at 0 dB at its centre', () => {
    const bp = Biquad.bandpass(1000, 2, SR);
    let peak = 0;
    for (let i = 0; i < SR / 2; i++) {
      const out = bp.process(Math.sin((2 * Math.PI * 1000 * i) / SR));
      if (i > SR / 4) peak = Math.max(peak, Math.abs(out));
    }
    expect(peak).toBeCloseTo(1, 2);
  });
});

describe('harmonicTables', () => {
  it('puts each amplitude on its harmonic with no DC', () => {
    const { real, imag } = harmonicTables([1, 0.5, 0.25], 1);
    expect(real.length).toBe(4);
    expect(real[0]).toBe(0);
    expect(imag[0]).toBe(0);
    expect(Math.hypot(real[2] ?? 0, imag[2] ?? 0)).toBeCloseTo(0.5, 6);
  });
});
