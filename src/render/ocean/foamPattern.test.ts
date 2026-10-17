import { describe, expect, it } from 'vite-plus/test';

import { PHYSICS_SIZES } from '../../sim/ocean/cascades';
import { hash32 } from '../../sim/ocean/hash';
import {
  breakingGroup,
  DENSITY_STD,
  FOAM_DRIFT_ACROSS,
  FOAM_PATCH_ANGLE,
  FOAM_REGION_ANGLE,
  FOAM_DRIFT_ALONG,
  FOAM_MASK_RMS,
  FOAM_PATCH_TILE,
  FOAM_REGION_TILE,
  foamCascadeWeight,
  foamMask,
  hashCell,
  LACE_COARSE_TILE,
  LACE_FINE_ANGLE,
  LACE_FINE_TILE,
  STREAK_CENTRE,
  STREAK_FADE_END,
  STREAK_MEANS,
  STREAK_MIN_WIDTH,
  STREAK_OCTAVES,
  streakLines,
  streakGap,
  streakOctave,
  streakSalt,
} from './foamPattern';

// Deterministic standard normals (Box–Muller over a hash stream).
function normals(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const u1 = (hash32(2 * i + 1) + 0.5) / 4294967296;
    const u2 = (hash32(2 * i + 2) + 0.5) / 4294967296;
    out.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return out;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// Whether two tilings in the same frame line up within a drone view (maxPeriod): some q copies of
// the longer one land within 5% of the shorter tile of a whole number of the shorter ones.
function sharedPeriod(a: number, b: number, maxPeriod = 300): boolean {
  const long = Math.max(a, b);
  const short = Math.min(a, b);
  for (let q = 1; q * long <= maxPeriod; q++) {
    const n = (q * long) / short;
    if (Math.abs(n - Math.round(n)) < 0.05) return true;
  }
  return false;
}

const angleApart = (a: number, b: number): number => {
  const d = Math.abs(a - b) % (Math.PI / 2);
  return Math.min(d, Math.PI / 2 - d);
};

describe('foam pattern scales', () => {
  it('sit in frames rotated apart, so world-fixed tilings never share a lattice', () => {
    // The cascades are axis-aligned; region and patches each turn by their own angle.
    for (const angle of [FOAM_REGION_ANGLE, FOAM_PATCH_ANGLE])
      expect(angleApart(angle, 0)).toBeGreaterThan(0.2);
    expect(angleApart(FOAM_REGION_ANGLE, FOAM_PATCH_ANGLE)).toBeGreaterThan(0.2);
  });

  it('share no period within a drone view where they share a frame', () => {
    // Wind frame: the drift and the coarse lace (stretched along the wind, so across counts); the
    // fine lace is turned off it and 1/φ² of its size.
    expect(sharedPeriod(FOAM_DRIFT_ACROSS, LACE_COARSE_TILE)).toBe(false);
    expect(angleApart(LACE_FINE_ANGLE, 0)).toBeGreaterThan(0.2);
    expect(LACE_COARSE_TILE / LACE_FINE_TILE).toBeCloseTo(((1 + Math.sqrt(5)) / 2) ** 2);
    // The low-frequency fields' tiles are far longer than a cascade-sized repeat would show.
    for (const tile of [FOAM_REGION_TILE, FOAM_PATCH_TILE, FOAM_DRIFT_ALONG])
      for (const patch of PHYSICS_SIZES)
        expect(sharedPeriod(tile, patch), `${tile} m vs ${patch} m`).toBe(false);
  });
});

describe('foam masks and breaking groups', () => {
  const z = normals(50_000);

  it('switch a cascade off in some of the sea and keep its mean near 1', () => {
    const masks = z.map((v) => foamMask(v * DENSITY_STD));
    const off = masks.filter((m) => m === 0).length / masks.length;
    expect(off).toBeGreaterThan(0.1);
    expect(off).toBeLessThan(0.3);
    expect(mean(masks)).toBeGreaterThan(0.85);
    expect(mean(masks)).toBeLessThan(1.05);
    // The strain normalisation is the masks' RMS.
    expect(Math.sqrt(mean(masks.map((m) => m * m)))).toBeCloseTo(FOAM_MASK_RMS, 2);
  });

  it('put short-wave foam on the long waves’ crests, conserving it on average', () => {
    const sigma = 0.1;
    expect(mean(z.map((v) => breakingGroup(v * sigma, sigma)))).toBeCloseTo(1, 2);
    // Compression (D converging) is negative strain: the crest of the longer wave.
    expect(breakingGroup(-sigma, sigma)).toBeGreaterThan(breakingGroup(0, sigma));
    expect(breakingGroup(sigma, sigma)).toBe(0);
  });

  it('count the 20 m cascade at half weight and the long ones fully', () => {
    expect(foamCascadeWeight(20)).toBe(0.5);
    for (const patch of [128, 800, 4096]) expect(foamCascadeWeight(patch)).toBe(1);
  });
});

describe('wind streaks', () => {
  it('hash cells by their two’s-complement bits, as the shader does', () => {
    expect(hashCell(-1, 7)).toBe(hash32(0xffffffff ^ 7));
    expect(hashCell(-1, 7)).not.toBe(hashCell(1, 7));
  });

  it('stay inside their cell however wide the filtering makes them', () => {
    for (const o of STREAK_OCTAVES) {
      const reach = Math.max(o.halfWidth[0] + o.halfWidth[1], STREAK_FADE_END * o.spacing * STREAK_MIN_WIDTH);
      expect(STREAK_CENTRE[0] * o.spacing - reach).toBeGreaterThan(0);
      expect((STREAK_CENTRE[0] + STREAK_CENTRE[1]) * o.spacing + reach).toBeLessThan(o.spacing);
    }
  });

  it('fade to their own mean, so distant water keeps the same brightness', () => {
    STREAK_OCTAVES.forEach((o, octave) => {
      let sum = 0;
      let count = 0;
      // ~800 cells across, each crossed at 37 offsets, along ~10 trails.
      for (let i = 0; i < 30000; i++) {
        const across = ((i + 0.5) * o.spacing) / 37.3;
        for (let j = 0; j < 40; j++) {
          sum += streakLines(j * o.length * 0.173 + i * 3.1, across, 0.01, octave);
          count++;
        }
      }
      expect(Math.abs(sum / count / (STREAK_MEANS[octave] as number) - 1)).toBeLessThan(0.06);
      // Fully faded: exactly the mean, wherever.
      expect(streakOctave(123.4, 56.7, o.spacing, octave)).toBeCloseTo(
        (STREAK_MEANS[octave] as number) * o.weight,
      );
    });
  });

  it('break into fragments every few metres along their length', () => {
    STREAK_OCTAVES.forEach((o, octave) => {
      const h = hashCell(3, streakSalt(octave));
      const steps = 4000;
      const values = Array.from({ length: steps }, (_, i) => streakGap((i * o.gap) / 20, h, o.gap));
      const broken = values.filter((v) => v < 0.05).length / steps;
      expect(broken).toBeGreaterThan(0.15);
      expect(broken).toBeLessThan(0.6);
      // A fragment every few gap periods.
      let runs = 0;
      for (let i = 1; i < steps; i++)
        if ((values[i] as number) > 0.5 !== (values[i - 1] as number) > 0.5) runs++;
      expect(runs / 2).toBeGreaterThan(steps / 20 / 6);
    });
  });

  it('are spaced irregularly, with no period across the wind', () => {
    const o = STREAK_OCTAVES[0] as (typeof STREAK_OCTAVES)[number];
    const step = 0.05;
    const n = 8192;
    const profile = Array.from({ length: n }, (_, i) => streakLines(10, i * step, 0.01, 0));
    // Gaps between line centres vary.
    const centres: number[] = [];
    for (let i = 1; i < n - 1; i++) {
      const v = profile[i] as number;
      if (v > 0.05 && v >= (profile[i - 1] as number) && v > (profile[i + 1] as number))
        centres.push(i * step);
    }
    const gaps = centres.slice(1).map((c, i) => c - (centres[i] as number));
    const gapMean = mean(gaps);
    const gapStd = Math.sqrt(mean(gaps.map((g) => (g - gapMean) ** 2)));
    expect(gapStd / gapMean).toBeGreaterThan(0.25);
    // The autocorrelation has no peak at the cell spacing or its multiples.
    const m = mean(profile);
    const centred = profile.map((v) => v - m);
    const ac = (lag: number): number => {
      let s = 0;
      for (let i = 0; i + lag < n; i++) s += (centred[i] as number) * (centred[i + lag] as number);
      return s / (n - lag);
    };
    const zero = ac(0);
    for (let k = 1; k <= 4; k++) expect(ac(Math.round((k * o.spacing) / step)) / zero).toBeLessThan(0.2);
  });
});
