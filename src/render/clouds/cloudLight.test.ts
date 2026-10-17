import { describe, expect, it } from 'vite-plus/test';

import {
  beamShare,
  CLOUD_DIM_KEEP,
  cloudDimmingEv,
  DIRECT_EXTINCTION,
  directTransmittance,
  lowSunShadowFade,
  overcastWeight,
  SHADOW_HISTORY,
  shadowMarchSteps,
  skyToDirectRatio,
} from './cloudLight';

describe('directional transmittance from optical depth', () => {
  it('is 1 through clear air and falls monotonically with depth', () => {
    expect(directTransmittance(0)).toBe(1);
    expect(directTransmittance(-3)).toBe(1);
    let last = 1;
    for (const tau of [0.5, 1, 2, 5, 10, 20, 40]) {
      const t = directTransmittance(tau);
      expect(t).toBeLessThan(last);
      last = t;
    }
  });

  it('follows δ-Eddington scaling: thin cloud lets most through, cumulus cores and decks almost none', () => {
    expect(DIRECT_EXTINCTION).toBeCloseTo(1 - 0.85 * 0.85, 6);
    expect(directTransmittance(1)).toBeGreaterThan(0.7);
    expect(directTransmittance(5)).toBeGreaterThan(0.2);
    expect(directTransmittance(5)).toBeLessThan(0.3);
    expect(directTransmittance(20)).toBeLessThan(0.005); // a deck or a heap's core
  });

  it('never exceeds the total (direct + diffuse) transmission of a conservative cloud', () => {
    // Two-stream total transmission 1 / (1 + 0.75 (1 − g) τ).
    for (const tau of [0.25, 1, 3, 8, 20]) {
      expect(directTransmittance(tau)).toBeLessThanOrEqual(1 / (1 + 0.75 * 0.15 * tau) + 1e-9);
    }
  });

  it('splits into the beam: beamShare × directTransmittance = e^(−τ)', () => {
    for (const tau of [0, 0.5, 2, 9]) {
      expect(beamShare(tau) * directTransmittance(tau)).toBeCloseTo(Math.exp(-tau), 9);
      expect(beamShare(tau)).toBeLessThanOrEqual(1);
    }
  });
});

describe('overcast flattening weight', () => {
  it('leaves broken cloud alone and flattens closed decks', () => {
    expect(overcastWeight(0.25)).toBe(0); // fair
    expect(overcastWeight(0.5)).toBe(0); // breezy
    expect(overcastWeight(0.6)).toBe(0); // squalls
    expect(overcastWeight(0.95)).toBe(1); // overcast drizzle
    expect(overcastWeight(1)).toBe(1); // gale, storm, hurricanes, fog bank
  });

  it('rises smoothly in between', () => {
    const w = overcastWeight(0.85);
    expect(w).toBeGreaterThan(0.3);
    expect(w).toBeLessThan(0.7);
    expect(overcastWeight(0.9)).toBeGreaterThan(w);
  });
});

describe('cloud dimming of the exposure', () => {
  const noon = { overcast: 0, sinElevation: 1, weight: 1 };

  it('is zero in sunshine, with no light, or with the light down', () => {
    expect(cloudDimmingEv({ ...noon, transmittance: 1 })).toBeCloseTo(0, 9);
    expect(cloudDimmingEv({ ...noon, transmittance: 0, weight: 0 })).toBe(0);
    expect(cloudDimmingEv({ ...noon, transmittance: 0, sinElevation: -0.1 })).toBe(0);
  });

  it('keeps a fraction of the light drop under a heap: dimmer, but not the full drop', () => {
    const ev = cloudDimmingEv({ ...noon, transmittance: 0 });
    const fullDrop = Math.log2((skyToDirectRatio(1) + 1) / skyToDirectRatio(1));
    expect(ev).toBeCloseTo(CLOUD_DIM_KEEP * fullDrop, 9);
    expect(ev).toBeGreaterThan(0.4);
    expect(ev).toBeLessThan(1);
    // Thin cloud dims less than thick.
    expect(cloudDimmingEv({ ...noon, transmittance: 0.6 })).toBeLessThan(ev);
  });

  it('dims a closed overcast like a cloud shadow, whatever the deck lets through', () => {
    const underHeap = cloudDimmingEv({ ...noon, transmittance: 0 });
    expect(cloudDimmingEv({ ...noon, overcast: 1, transmittance: 0.4 })).toBeCloseTo(underHeap, 9);
  });

  it('dims less with a low sun, when the sky already supplies much of the light', () => {
    const high = cloudDimmingEv({ ...noon, transmittance: 0 });
    const low = cloudDimmingEv({ ...noon, transmittance: 0, sinElevation: Math.sin(0.1) });
    expect(low).toBeLessThan(high);
    expect(skyToDirectRatio(Math.sin(0.1))).toBeGreaterThan(skyToDirectRatio(1));
  });

  it('scales with the light source weight through twilight', () => {
    const full = cloudDimmingEv({ ...noon, transmittance: 0 });
    const faint = cloudDimmingEv({ ...noon, transmittance: 0, weight: 0.1 });
    expect(faint).toBeLessThan(full);
    expect(faint).toBeGreaterThan(0);
  });
});

describe('low sun', () => {
  const deg = (d: number): number => Math.sin((d * Math.PI) / 180);

  it('fades the shadow pattern out near the horizon and keeps it once the sun is up', () => {
    expect(lowSunShadowFade(deg(1))).toBe(0);
    expect(lowSunShadowFade(deg(5))).toBeGreaterThan(0);
    expect(lowSunShadowFade(deg(5))).toBeLessThan(1);
    expect(lowSunShadowFade(deg(9))).toBe(1);
    expect(lowSunShadowFade(deg(60))).toBe(1);
  });

  it('marches longer grazing rays with more steps, within a cap', () => {
    expect(shadowMarchSteps(20, 1)).toBe(20);
    expect(shadowMarchSteps(20, deg(30))).toBe(20);
    expect(shadowMarchSteps(20, deg(8))).toBeGreaterThan(20);
    expect(shadowMarchSteps(20, deg(1))).toBe(35);
    expect(shadowMarchSteps(20, 0)).toBe(35);
  });

  it('averages several jittered marches in the history', () => {
    expect(1 / (1 - SHADOW_HISTORY)).toBeGreaterThanOrEqual(4);
    expect(SHADOW_HISTORY).toBeLessThan(1);
  });
});
