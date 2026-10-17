import { describe, expect, it } from 'vite-plus/test';

import { loadSurvivalBests, recordSurvival, SurvivalRun } from './survival';

const memory = (): { getItem(k: string): string | null; setItem(k: string, v: string): void } => {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};

describe('SurvivalRun', () => {
  it('accumulates time, worst roll and green-water episodes until a capsize', () => {
    const run = new SurvivalRun('crab', 'hurricane-1');
    run.sample({ dt: 10, roll: 0.3, deckWater: 0.2, capsized: false });
    run.sample({ dt: 10, roll: -0.6, deckWater: 0.3, capsized: false }); // same episode
    run.sample({ dt: 10, roll: 0.1, deckWater: 0, capsized: false });
    run.sample({ dt: 10, roll: 0.2, deckWater: 0.4, capsized: false }); // new episode
    run.addSlam();
    expect(run.sample({ dt: 5, roll: 2.5, deckWater: 0.5, capsized: true })).toBe(true);
    expect(run.sample({ dt: 100, roll: 0, deckWater: 0, capsized: false })).toBe(false);
    const result = run.result(new Date('2026-10-12T00:00:00Z'));
    expect(result.survivedS).toBe(45);
    expect(result.maxRollDeg).toBe(143);
    expect(result.greenWater).toBe(2);
    expect(result.slams).toBe(1);
  });
});

describe('survival bests', () => {
  it('keeps the longest run per boat and storm', () => {
    const storage = memory();
    const base = { boat: 'pwc' as const, weather: 'gale' as const, maxRollDeg: 0, slams: 0, greenWater: 0 };
    expect(recordSurvival(storage, { ...base, survivedS: 60, date: 'a' }).isBest).toBe(true);
    expect(recordSurvival(storage, { ...base, survivedS: 30, date: 'b' }).isBest).toBe(false);
    expect(recordSurvival(storage, { ...base, survivedS: 90, date: 'c' }).isBest).toBe(true);
    expect(loadSurvivalBests(storage)).toHaveLength(1);
    expect(loadSurvivalBests(storage)[0]?.survivedS).toBe(90);
  });

  it('drops malformed or stale entries instead of handing them to the menu', () => {
    const storage = memory();
    const good = {
      boat: 'pwc',
      weather: 'gale',
      survivedS: 60,
      maxRollDeg: 10,
      slams: 1,
      greenWater: 0,
      date: 'a',
    };
    storage.setItem(
      'sea-state:survival-bests',
      JSON.stringify([
        null,
        7,
        { ...good, weather: 'retired-storm' },
        { ...good, boat: 'raft' },
        { ...good, survivedS: '9' },
        good,
      ]),
    );
    expect(loadSurvivalBests(storage)).toEqual([good]);
  });

  it('still reports a best when storage refuses the write', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const result = {
      boat: 'pwc' as const,
      weather: 'gale' as const,
      survivedS: 5,
      maxRollDeg: 0,
      slams: 0,
      greenWater: 0,
      date: 'a',
    };
    expect(recordSurvival(storage, result).isBest).toBe(true);
  });

  it('survives corrupt storage', () => {
    const storage = memory();
    storage.setItem('sea-state:survival-bests', '{oops');
    expect(loadSurvivalBests(storage)).toEqual([]);
  });
});
