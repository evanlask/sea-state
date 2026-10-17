import { describe, expect, it } from 'vite-plus/test';

import {
  airAbsorptionCutoff,
  bowSplashRate,
  crestRate,
  creakRate,
  dopplerFactor,
  environmentParams,
  flogParams,
  gainToVolume,
  poissonChance,
  rainParams,
  seaBedWeights,
  seaParams,
  slamParams,
  softClipCurve,
  volumeToGain,
  waterRushCenter,
  waterRushGain,
  windLoudness,
  windParams,
} from './curves';

const range = (from: number, to: number, steps: number): number[] =>
  Array.from({ length: steps + 1 }, (_, i) => from + ((to - from) * i) / steps);

const nonDecreasing = (values: number[]): boolean =>
  values.every((v, i) => i === 0 || v >= (values[i - 1] ?? -Infinity) - 1e-12);

describe('volumeToGain', () => {
  it('maps 0 to silence and 1 to unity', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBeCloseTo(1, 12);
  });

  it('is monotonic and perceptual (half the slider is far below half the gain)', () => {
    expect(nonDecreasing(range(0, 1, 100).map(volumeToGain))).toBe(true);
    expect(volumeToGain(0.5)).toBeCloseTo(10 ** (-15 / 20), 6); // −15 dB
    expect(volumeToGain(0.8)).toBeCloseTo(10 ** (-6 / 20), 6);
  });

  it('clamps and rejects garbage', () => {
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(2)).toBeCloseTo(1);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });

  it('inverts with gainToVolume, taper included', () => {
    for (const v of [0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.95, 1]) {
      expect(gainToVolume(volumeToGain(v))).toBeCloseTo(v, 9);
    }
    expect(gainToVolume(0)).toBe(0);
    expect(gainToVolume(Number.NaN)).toBe(0);
    expect(gainToVolume(2)).toBe(1);
  });
});

describe('wind mapping', () => {
  it('is near silent in a calm and roars in a hurricane', () => {
    expect(windLoudness(0)).toBe(0);
    expect(windLoudness(2)).toBeLessThan(0.02);
    expect(windLoudness(33)).toBeGreaterThan(0.6);
    expect(windLoudness(70)).toBeGreaterThan(0.95);
    expect(windLoudness(70)).toBeLessThanOrEqual(1);
  });

  it('raises loudness, cutoff, howl pitch and Q monotonically with speed', () => {
    const params = range(0, 70, 140).map((s) => ({ ...windParams(s) }));
    const keys = [
      'loudness',
      'rushGain',
      'rushCutoff',
      'howlFreq',
      'howlQ',
      'howlGain',
      'whistleGain',
    ] as const;
    for (const key of keys) expect(nonDecreasing(params.map((p) => p[key])), key).toBe(true);
    expect(windParams(3).howlGain).toBeLessThan(0.005); // no howl in light air
    expect(windParams(50).whistleGain).toBeGreaterThan(0);
  });

  it('keeps every layer gain bounded', () => {
    const p = windParams(1000);
    expect(p.rushGain).toBeLessThanOrEqual(0.55);
    expect(p.howlGain).toBeLessThan(0.7);
    expect(p.whistleGain).toBeLessThanOrEqual(0.12);
  });
});

describe('sea mapping', () => {
  it('cross-fades lap → wash → roar with weights that sum to 1', () => {
    for (const hs of range(0, 20, 80)) {
      const w = seaBedWeights(hs);
      expect(w.lap + w.wash + w.roar).toBeCloseTo(1, 9);
      for (const v of [w.lap, w.wash, w.roar]) expect(v).toBeGreaterThanOrEqual(0);
    }
    const dominant = (hs: number): string => {
      const w = seaBedWeights(hs);
      return w.lap >= w.wash && w.lap >= w.roar ? 'lap' : w.wash >= w.roar ? 'wash' : 'roar';
    };
    expect(dominant(0.2)).toBe('lap');
    expect(dominant(2.5)).toBe('wash');
    expect(dominant(12)).toBe('roar');
  });

  it('grows the bed energy monotonically with Hs (equal-power mix)', () => {
    const energy = range(0, 20, 100).map((hs) => {
      const p = seaParams(hs, 10, undefined);
      return p.lapGain ** 2 + p.washGain ** 2 + p.roarGain ** 2;
    });
    expect(nonDecreasing(energy)).toBe(true);
  });

  it('uses Tp for the swell modulation, defaulting to Pierson-Moskowitz', () => {
    expect(seaParams(2, 10, 10).swellRate).toBeCloseTo(0.1);
    expect(seaParams(4, 10, undefined).swellRate).toBeCloseTo(1 / 10); // 5·√4
  });

  it('breaks crests only with whitecap wind, more in bigger seas', () => {
    expect(crestRate(2, 0.2)).toBe(0);
    expect(crestRate(10, 1)).toBeGreaterThan(0);
    expect(crestRate(25, 9)).toBeGreaterThan(crestRate(10, 1));
    expect(nonDecreasing(range(0, 70, 70).map((w) => crestRate(w, 5)))).toBe(true);
  });
});

describe('rain mapping', () => {
  it('splits deck and water flavours and silences at zero intensity', () => {
    const none = rainParams(0, 0.5);
    expect(none.deckHiss + none.waterHiss + none.deckDrops + none.waterDrops).toBe(0);
    const deck = rainParams(0.7, 1);
    expect(deck.waterHiss).toBe(0);
    expect(deck.deckHiss).toBeGreaterThan(0);
    const water = rainParams(0.7, 0);
    expect(water.deckDrops).toBe(0);
    expect(water.waterHiss).toBeGreaterThan(0);
  });

  it('gets louder with intensity', () => {
    expect(nonDecreasing(range(0, 1, 50).map((i) => rainParams(i, 0.3).deckHiss))).toBe(true);
    expect(nonDecreasing(range(0, 1, 50).map((i) => rainParams(i, 0.3).denseMix))).toBe(true);
  });
});

describe('environment', () => {
  it('is transparent in the open', () => {
    const p = environmentParams(0, 0);
    expect(p.cutoff).toBeGreaterThan(15000);
    expect(p.exteriorGain).toBe(1);
    expect(p.interiorHum).toBe(0);
  });

  it('muffles a closed bridge and muffles underwater even more', () => {
    const bridge = { ...environmentParams(1, 0) };
    const under = { ...environmentParams(0, 1) };
    expect(bridge.cutoff).toBeLessThan(1500);
    expect(bridge.exteriorGain).toBeLessThan(0.6);
    expect(bridge.interiorHum).toBeGreaterThan(0);
    expect(under.cutoff).toBeLessThan(bridge.cutoff);
    expect(under.underwaterBed).toBeGreaterThan(0);
    expect(nonDecreasing(range(0, 1, 20).map((e) => -environmentParams(e, 0).cutoff))).toBe(true);
  });
});

describe('distance and motion', () => {
  it('dulls far sources with air absorption', () => {
    expect(airAbsorptionCutoff(1)).toBe(20000);
    expect(airAbsorptionCutoff(1000)).toBeCloseTo(1936, -1);
    expect(nonDecreasing(range(1, 20000, 100).map((d) => -airAbsorptionCutoff(d)))).toBe(true);
  });

  it('raises pitch for approaching sources and lowers it for receding ones', () => {
    expect(dopplerFactor(0, 0)).toBe(1);
    expect(dopplerFactor(0, 20)).toBeCloseTo(343 / 323, 6); // source closing at 20 m/s
    expect(dopplerFactor(0, -20)).toBeCloseTo(343 / 363, 6);
    expect(dopplerFactor(-20, 0)).toBeCloseTo(363 / 343, 6); // listener closing
    expect(dopplerFactor(0, 1e6)).toBeLessThanOrEqual(2);
  });

  it('maps slam strength to a bounded gain, lower and darker for big hulls', () => {
    const out = { gain: 0, rate: 1, cutoff: 0 };
    expect(slamParams(0.1, 0, out).gain).toBe(0);
    const gains = range(0.5, 30, 50).map((s) => slamParams(s, 0.5, out).gain);
    expect(nonDecreasing(gains)).toBe(true);
    expect(Math.max(...gains)).toBeLessThanOrEqual(1);
    const small = { ...slamParams(5, 0, out) };
    const ship = { ...slamParams(5, 1, out) };
    expect(ship.rate).toBeLessThan(small.rate);
    expect(ship.cutoff).toBeLessThan(small.cutoff);
  });

  it('scales hull rush, splashes and creaks sensibly', () => {
    expect(waterRushGain(0)).toBe(0);
    expect(nonDecreasing(range(0, 1, 20).map(waterRushGain))).toBe(true);
    expect(waterRushCenter(1, 1)).toBeLessThan(waterRushCenter(1, 0));
    expect(bowSplashRate(0, 3)).toBe(0);
    expect(bowSplashRate(0.8, 3)).toBeGreaterThan(bowSplashRate(0.8, 0.2));
    expect(creakRate(0.3, 0.5)).toBe(0); // no creaks in flat water
    expect(creakRate(0.3, 5)).toBeGreaterThan(creakRate(0.05, 5));
  });

  it('flogs harder with luffing and wind', () => {
    const out = { gain: 0, rate: 0, center: 0, snapRate: 0 };
    expect(flogParams(0, 15, out).gain).toBe(0);
    const light = flogParams(1, 4, out).gain;
    const fresh = { ...flogParams(1, 15, out) };
    expect(fresh.gain).toBeGreaterThan(light);
    expect(fresh.rate).toBeGreaterThanOrEqual(4);
    expect(fresh.rate).toBeLessThanOrEqual(8);
    expect(fresh.snapRate).toBeGreaterThan(0);
  });

  it('turns rates into per-frame chances', () => {
    expect(poissonChance(0, 1)).toBe(0);
    expect(poissonChance(1, 1)).toBeCloseTo(1 - Math.exp(-1));
    expect(poissonChance(100, 1)).toBeLessThanOrEqual(1);
  });
});

describe('softClipCurve', () => {
  it('is linear below the knee, monotonic, odd and below full scale', () => {
    const curve = Array.from(softClipCurve(1001));
    expect(curve[500]).toBeCloseTo(0, 9);
    expect(curve[750]).toBeCloseTo(0.5, 9); // x = 0.5
    expect(nonDecreasing(curve)).toBe(true);
    expect(curve[1000]).toBeLessThan(0.98);
    expect(curve[0]).toBeCloseTo(-(curve[1000] ?? 0), 9);
  });
});
