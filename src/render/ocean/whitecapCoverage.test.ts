import { describe, expect, it } from 'vite-plus/test';

import { hash32 } from '../../sim/ocean/hash';
import { WEATHER_PRESETS } from '../../sim/weather/presets';
import {
  FOAM_THICK_LACE,
  foamBrightness,
  foamShown,
  LACE_COARSE_TILE,
  LACE_FINE_ANGLE,
  LACE_FINE_TILE,
  WAKE_FOAM_EDGES,
  wakeFoamAmount,
} from './foamPattern';
import { smoothstep, whitecapCoverage } from './oceanOptics';
import { foamDetailTexture, presetCoverage } from './whitecapEstimate';

const preset = (id: string): (typeof WEATHER_PRESETS)[number] => {
  const p = WEATHER_PRESETS.find((q) => q.id === id);
  if (!p) throw new Error(`no preset ${id}`);
  return p;
};

// Mean white the bubble pattern shows for a foam amount at a footprint, over the sea (buildFoam).
function meanWhite(amount: number, footprint: number, brightness = true, samples = 6000): number {
  const detail = foamDetailTexture();
  const c = Math.cos(LACE_FINE_ANGLE);
  const s = Math.sin(LACE_FINE_ANGLE);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const u = (hash32(2 * i + 1) / 4294967296) * 100;
    const v = (hash32(2 * i + 2) / 4294967296) * 100;
    const coarse = detail.sample(
      u / LACE_COARSE_TILE,
      v / LACE_COARSE_TILE,
      (footprint / LACE_COARSE_TILE) * 512,
      [0, 0, 0],
    );
    const fine = detail.sample(
      (u * c - v * s) / LACE_FINE_TILE + 0.37,
      (u * s + v * c) / LACE_FINE_TILE + 0.37,
      (footprint / LACE_FINE_TILE) * 512,
      [0, 0, 0],
    );
    const lace = (coarse[0] as number) * 0.55 + (fine[0] as number) * 0.45;
    const density = coarse[1] as number;
    const thick = smoothstep(0.55, 1, amount);
    const pattern =
      lace * (density * 0.6 + 0.55) + (density * 0.3 + 0.75 - lace * (density * 0.6 + 0.55)) * thick;
    sum +=
      foamShown(amount, pattern, footprint) *
      (brightness ? foamBrightness(amount, footprint) : 1) *
      (1 - thick * FOAM_THICK_LACE * (1 - lace));
  }
  return sum / samples;
}

describe('foam on the bubble pattern', () => {
  it('shows nothing without foam, and about as much white as there is foam', () => {
    expect(meanWhite(0, 0.02)).toBeLessThan(1e-4);
    expect(meanWhite(0, 3)).toBeLessThan(1e-4);
    for (const amount of [0.1, 0.3, 0.5]) {
      expect(meanWhite(amount, 0.02)).toBeGreaterThan(0.6 * amount);
      expect(meanWhite(amount, 0.02)).toBeLessThan(1.1 * amount);
    }
  });

  it('shows as much of the pattern whatever the footprint, so distant whitecaps neither vanish nor grey out', () => {
    for (const amount of [0.05, 0.2, 0.5, 0.8]) {
      const near = meanWhite(amount, 0.01, false);
      for (const footprint of [0.1, 0.3, 1, 3]) {
        const far = meanWhite(amount, footprint, false);
        expect(far / near).toBeGreaterThan(0.7);
        expect(far / near).toBeLessThan(1.45);
      }
    }
  });

  it('is linear enough in the amount that mip-averaged foam keeps its mean', () => {
    // Half the footprint at 0.4, half bare, against the average amount 0.2 (both far away).
    const split = 0.5 * meanWhite(0.4, 3);
    expect(meanWhite(0.2, 3) / split).toBeGreaterThan(0.7);
    expect(meanWhite(0.2, 3) / split).toBeLessThan(1.3);
  });

  it('shows boat wake foam at its amount, hiding only traces', () => {
    expect(wakeFoamAmount(WAKE_FOAM_EDGES[0])).toBe(0);
    expect(wakeFoamAmount(0.01)).toBe(0);
    expect(wakeFoamAmount(0.2)).toBe(0.2);
    expect(wakeFoamAmount(1)).toBe(1);
  });
});

// The whole whitecap pipeline replayed offline (whitecapEstimate.ts): the rendered sea's mean
// whiteness per preset against the observed coverage, Monahan & O'Muircheartaigh (1980).
describe('whitecap coverage per preset', () => {
  const footprints = [0.02, 2]; // m: right by the camera, and a few hundred metres off at chase height
  const run = (id: string): { wind: number; near: number; far: number } => {
    const p = preset(id);
    const result = presetCoverage(p, { footprints, dt: 1 / 15, times: [10, 13], samples: 12_000 });
    return {
      wind: p.windSpeed,
      near: result.coverage[0]?.coverage ?? 0,
      far: result.coverage[1]?.coverage ?? 0,
    };
  };

  // Beaufort 3 to 10: within a factor of 1.5 of Monahan (2.5 at Force 3, where 0.05% of the sea is a
  // few breaking texels per patch at any moment), close up and far off.
  const bands: [string, number][] = [
    ['fair', 2.5],
    ['breezy', 1.5],
    ['near-gale', 1.5],
    ['gale', 1.5],
    ['storm', 1.5],
  ];
  const results = new Map<string, { wind: number; near: number; far: number }>();

  for (const [id, factor] of bands) {
    it(`${id}: tracks the observed coverage`, () => {
      const r = run(id);
      results.set(id, r);
      const reference = whitecapCoverage(r.wind);
      for (const coverage of [r.near, r.far]) {
        expect(coverage).toBeGreaterThan(reference / factor);
        expect(coverage).toBeLessThan(reference * factor);
      }
    }, 60_000);
  }

  it('hurricane-1: very white, but not a sheet', () => {
    const r = run('hurricane-1');
    for (const coverage of [r.near, r.far]) {
      expect(coverage).toBeGreaterThan(0.3);
      expect(coverage).toBeLessThan(0.55);
    }
  }, 60_000);

  it('rises with the wind', () => {
    const order = bands.map(([id]) => results.get(id)?.near ?? Number.NaN);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1] as number);
  });
});
