import { describe, expect, it } from 'vite-plus/test';

import {
  breakingFraction,
  cascadeFootprintWeight,
  diskSlopeVariance,
  FOAM_OFF_THRESHOLD,
  type FoamLayer,
  foamForWind,
  fresnelExact,
  fresnelSchlick,
  jacobianStd,
  leanVariance,
  lightAlpha,
  mipLevelCount,
  normalQuantile,
  roughnessFromSlopeVariance,
  snellWindowHalfAngle,
  spectrumStatistics,
  SUN_ANGULAR_RADIUS,
  WATER_F0,
  renderedWhitecapCoverage,
  WATER_IOR,
  WHITECAP_MAX,
  whitecapCoverage,
} from './oceanOptics';

describe('Fresnel', () => {
  it('reflects ~2% at normal incidence and everything at grazing', () => {
    expect(WATER_F0).toBeCloseTo(0.0204, 3);
    expect(fresnelExact(1)).toBeCloseTo(WATER_F0, 4);
    expect(fresnelExact(0)).toBeCloseTo(1, 6);
  });

  it('Schlick is close to exact, but off by up to ~6% at grazing (why the shader uses exact)', () => {
    let worst = 0;
    for (let c = 0.05; c <= 1; c += 0.05)
      worst = Math.max(worst, Math.abs(fresnelSchlick(c) - fresnelExact(c)));
    expect(worst).toBeLessThan(0.07);
    expect(worst).toBeGreaterThan(0.01);
  });

  it('totally reflects inside water beyond the critical angle (Snell window ≈ 48.6°)', () => {
    const critical = snellWindowHalfAngle();
    expect((critical * 180) / Math.PI).toBeCloseTo(48.6, 1);
    expect(fresnelExact(Math.cos(critical + 0.01), WATER_IOR, 1)).toBe(1);
    expect(fresnelExact(Math.cos(critical - 0.2), WATER_IOR, 1)).toBeLessThan(0.2);
  });
});

describe('roughness from slope variance', () => {
  it('adds variances: base floor, waves, then the light disk', () => {
    expect(roughnessFromSlopeVariance(0, 0.0001)).toBeCloseTo(0.01, 6);
    expect(roughnessFromSlopeVariance(0.03, 0.0001)).toBeCloseTo(Math.sqrt(0.0301), 6);
    expect(roughnessFromSlopeVariance(5)).toBe(1);
    expect(diskSlopeVariance(SUN_ANGULAR_RADIUS)).toBeCloseTo(SUN_ANGULAR_RADIUS ** 2 / 8, 12);
    expect(lightAlpha(0, SUN_ANGULAR_RADIUS)).toBeCloseTo(SUN_ANGULAR_RADIUS / Math.sqrt(8), 9);
    expect(lightAlpha(0.1, SUN_ANGULAR_RADIUS)).toBeGreaterThan(0.1);
  });

  it('LEAN variance is E[s²] − E[s]² per axis, never negative', () => {
    expect(leanVariance(0.1, -0.2, 0.02, 0.05)).toBeCloseTo(0.01 + 0.01, 9);
    expect(leanVariance(0.3, 0, 0.05, 0)).toBe(0);
  });

  it('fades a cascade out as the pixel footprint approaches its patch size', () => {
    expect(cascadeFootprintWeight(0.01, 20)).toBe(1);
    expect(cascadeFootprintWeight(20, 20)).toBe(0);
    const mid = cascadeFootprintWeight(5, 20);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe('mip chains', () => {
  it('counts levels down to 1×1', () => {
    expect(mipLevelCount(128)).toBe(8);
    expect(mipLevelCount(256)).toBe(9);
    expect(mipLevelCount(512)).toBe(10);
    expect(mipLevelCount(1)).toBe(1);
  });
});

describe('spectrum statistics', () => {
  it('recovers the variance and slope of a single mode (Parseval, unnormalised FFT)', () => {
    const n = 8;
    const length = 16;
    const h0 = new Float32Array(n * n * 4);
    // Mode m = (2, 0): h0(k) = conj(h0(−k)) = 0.5 gives h = cos(kx − ωt), variance 1/2; stored on
    // both ±k texels as the CPU generator does.
    const set = (x: number, y: number, re: number): void => {
      h0[(y * n + x) * 4] = re;
    };
    set(2, 0, 0.5);
    set(n - 2, 0, 0.5);
    const stats = spectrumStatistics(h0, n, length);
    const k = (2 * 2 * Math.PI) / length;
    expect(stats.heightVariance).toBeCloseTo(0.5, 6);
    expect(stats.slopeVarianceX).toBeCloseTo(0.5 * k * k, 5);
    expect(stats.slopeVarianceZ).toBe(0);
    expect(jacobianStd(0.8, stats.slopeVarianceX)).toBeCloseTo(0.8 * Math.sqrt(0.5) * k, 5);
  });
});

describe('wind → foam', () => {
  it('normal quantile matches tabulated values', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 2);
    expect(normalQuantile(0.1587)).toBeCloseTo(1, 2);
    expect(normalQuantile(0.0228)).toBeCloseTo(2, 2);
  });

  it('whitecap coverage follows Monahan (~1% at 10 m/s, ~10% at 20 m/s)', () => {
    expect(whitecapCoverage(10)).toBeGreaterThan(0.008);
    expect(whitecapCoverage(10)).toBeLessThan(0.012);
    expect(whitecapCoverage(20)).toBeGreaterThan(0.09);
    expect(whitecapCoverage(60)).toBe(1);
  });

  it('renders Monahan coverage, easing to a ceiling in hurricanes', () => {
    for (const u of [4, 8, 12, 16, 20]) {
      expect(renderedWhitecapCoverage(u)).toBeLessThanOrEqual(whitecapCoverage(u));
      expect(renderedWhitecapCoverage(u)).toBeGreaterThan(0.8 * whitecapCoverage(u));
    }
    expect(renderedWhitecapCoverage(33)).toBeGreaterThan(0.3);
    expect(renderedWhitecapCoverage(50)).toBeGreaterThan(renderedWhitecapCoverage(33));
    expect(renderedWhitecapCoverage(70)).toBeGreaterThan(renderedWhitecapCoverage(50));
    expect(renderedWhitecapCoverage(70)).toBeLessThan(WHITECAP_MAX);
  });

  // The physics cascades as a near gale has them: (patch, Jacobian deviation).
  const layers: FoamLayer[] = [
    { patch: 4096, std: 0.036 },
    { patch: 800, std: 0.06 },
    { patch: 128, std: 0.065 },
    { patch: 20, std: 0.068 },
    { patch: 3.2, std: 0.2 },
  ];

  it('breaks more of the sea as the wind rises, with streaks only from Beaufort 7', () => {
    const calm = foamForWind(2, layers);
    const breezy = foamForWind(8, layers);
    const gale = foamForWind(20, layers);
    expect(calm.crestThreshold).toBeLessThan(breezy.crestThreshold);
    expect(breezy.crestThreshold).toBeLessThan(gale.crestThreshold);
    expect(gale.crestThreshold).toBeLessThan(1);
    for (let i = 1; i < 4; i++) {
      expect(calm.thresholds[i]).toBeLessThan(breezy.thresholds[i] as number);
      expect(breezy.thresholds[i]).toBeLessThan(gale.thresholds[i] as number);
    }
    expect(breezy.streaks).toBe(0);
    expect(foamForWind(13.9, layers).streaks).toBeGreaterThan(0.02);
    expect(gale.streaks).toBeGreaterThan(0.5);
    expect(gale.decayRate).toBeLessThan(breezy.decayRate);
    // Spume streaks the whole sea only past a gale, fully in a hurricane.
    expect(gale.spume).toBeLessThan(0.05);
    expect(foamForWind(27, layers).spume).toBeGreaterThan(0.2);
    expect(foamForWind(45, layers).spume).toBe(1);
  });

  it('breaks the wind sea’s cascades, never the swell’s or the visual ones', () => {
    const foam = foamForWind(15, layers);
    expect(foam.thresholds[0]).toBe(FOAM_OFF_THRESHOLD);
    expect(foam.thresholds[4]).toBe(FOAM_OFF_THRESHOLD);
    expect(foam.gains[4]).toBe(0);
    // Each breaking cascade's (Gaussian) Jacobian falls below its threshold on its share of the sea,
    // which adds up to the breaking fraction for the wind's coverage.
    const tail = (z: number): number => {
      let sum = 0;
      for (let x = z; x < z + 12; x += 1e-3) sum += Math.exp(-0.5 * (x + 5e-4) ** 2) * 1e-3;
      return sum / Math.sqrt(2 * Math.PI);
    };
    let share = 0;
    for (let i = 1; i < 4; i++) {
      const std = (layers[i] as FoamLayer).std;
      share += tail((1 - (foam.thresholds[i] as number)) / std);
      expect(foam.gains[i]).toBeCloseTo(1 / (0.15 * std), 6);
    }
    expect(share).toBeCloseTo(breakingFraction(renderedWhitecapCoverage(15)), 3);
    // Most of it on the 800 m and 128 m cascades: the 20 m one only adds specks.
    const z = (i: number): number => (1 - (foam.thresholds[i] as number)) / (layers[i] as FoamLayer).std;
    expect(tail(z(3))).toBeLessThan(0.25 * share);
  });
});
