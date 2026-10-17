import { describe, expect, it } from 'vite-plus/test';

import { AUREOLE_SIGMA, aureoleLobe, aureoleWeight, DISK_T_CUTOFF, diskVisibility } from './diskOcclusion';

// Moon disk vs the moonlit cloud in front of it (cd/m², full moon): ~2500 vs ~0.05.
const MOON_DISK = 2500;
const MOONLIT_CLOUD = 0.05;

describe('diskVisibility', () => {
  it('hides the disk completely behind thick cloud, including the march’s leftover 1%', () => {
    expect(diskVisibility(0)).toBe(0);
    expect(diskVisibility(0.01)).toBe(0); // the march stops below T = 0.01
    expect(diskVisibility(DISK_T_CUTOFF)).toBe(0);
    // A cumulus a few hundred metres thick (τ ≈ 10): no trace of the moon on it.
    expect(MOON_DISK * diskVisibility(Math.exp(-10))).toBeLessThan(MOONLIT_CLOUD * 0.01);
  });

  it('dims the disk through thin cloud, faster than the transmittance', () => {
    for (const t of [0.1, 0.3, 0.5, 0.8]) {
      expect(diskVisibility(t)).toBeGreaterThan(0);
      expect(diskVisibility(t)).toBeLessThan(t);
    }
    expect(diskVisibility(0.6)).toBeGreaterThan(diskVisibility(0.3));
    expect(diskVisibility(1)).toBe(1);
  });
});

describe('aureole', () => {
  it('is zero in clear sky and behind thick cloud, strongest through thin cloud (τ = 1)', () => {
    expect(aureoleWeight(1)).toBe(0);
    expect(aureoleWeight(Math.exp(-12))).toBeLessThan(1e-3);
    const peak = aureoleWeight(Math.exp(-1));
    expect(aureoleWeight(Math.exp(-0.3))).toBeLessThan(peak);
    expect(aureoleWeight(Math.exp(-3))).toBeLessThan(peak);
    expect(peak).toBeCloseTo(0.5 / Math.E);
  });

  it('spreads the scattered light over a normalised lobe a few degrees wide', () => {
    // ∫ lobe dΩ ≈ Σ lobe(θ) 2π sin θ dθ (small angles).
    let sum = 0;
    const dt = AUREOLE_SIGMA / 200;
    for (let a = dt / 2; a < AUREOLE_SIGMA * 8; a += dt)
      sum += aureoleLobe(a) * 2 * Math.PI * Math.sin(a) * dt;
    expect(sum).toBeCloseTo(1, 2);
    expect(aureoleLobe(AUREOLE_SIGMA * 4)).toBeLessThan(aureoleLobe(0) * 1e-3);
  });
});
