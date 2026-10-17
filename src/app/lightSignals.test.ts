import { describe, expect, it } from 'vite-plus/test';

import { autoSignals, nextSignalOverride, signalsWithOverride } from './lightSignals';

describe('autoSignals', () => {
  it('shows NUC on a ship drifting without propulsion', () => {
    expect(autoSignals({ kind: 'cargo', speed: 0.1, telemetry: { load: 0 }, deckLights: false })).toEqual([
      'nuc',
    ]);
    expect(autoSignals({ kind: 'cargo', speed: 0.1, telemetry: { load: 0.4 }, deckLights: false })).toEqual(
      [],
    );
    expect(autoSignals({ kind: 'cruise', speed: 6, telemetry: { load: 0 }, deckLights: false })).toEqual([]);
  });

  it('shows fishing on a crabber working under deck lights', () => {
    expect(autoSignals({ kind: 'crab', speed: 1, telemetry: {}, deckLights: true })).toEqual(['fishing']);
    expect(autoSignals({ kind: 'crab', speed: 5, telemetry: {}, deckLights: true })).toEqual([]);
    expect(autoSignals({ kind: 'crab', speed: 1, telemetry: {}, deckLights: false })).toEqual([]);
  });

  it('shows nothing once capsized', () => {
    expect(autoSignals({ kind: 'cargo', speed: 0, telemetry: { capsized: 1 }, deckLights: false })).toEqual(
      [],
    );
  });
});

describe('manual signal override', () => {
  it('cycles auto → anchor → RAM → auto', () => {
    expect(nextSignalOverride(null)).toBe('anchor');
    expect(nextSignalOverride('anchor')).toBe('ram');
    expect(nextSignalOverride('ram')).toBeNull();
  });

  it('replaces the automatic signals while set, except when capsized', () => {
    const drifting = { kind: 'cargo', speed: 0, telemetry: { load: 0 }, deckLights: false };
    expect(signalsWithOverride(drifting, null)).toEqual(['nuc']);
    expect(signalsWithOverride(drifting, 'anchor')).toEqual(['anchor']);
    expect(signalsWithOverride({ ...drifting, telemetry: { capsized: 1 } }, 'ram')).toEqual([]);
  });
});
