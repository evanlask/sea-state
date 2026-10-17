// The volume buses' calibration: equal loudness at 100 %, and default volumes that give back the
// mix we tuned by ear.

import { describe, expect, it } from 'vite-plus/test';

import { defaultSettings } from '../settings/schema';
import { BUS_TRIM_DB, type VolumeBus } from './AudioEngine';
import { gainToDb, volumeToGain } from './curves';

const BUSES: readonly VolumeBus[] = ['ambience', 'effects', 'engines'];

// Typical-scene loudness of each bus at 100 % before the trims, LUFS (scripts/audio-levels.ts).
const UNTRIMMED_LUFS: Record<VolumeBus, number> = { ambience: -25.4, effects: -31.9, engines: -29.2 };

describe('volume bus calibration', () => {
  it('plays every bus equally loud at 100 %, within 1 dB, around −24 LUFS', () => {
    const levels = BUSES.map((bus) => UNTRIMMED_LUFS[bus] + BUS_TRIM_DB[bus]);
    expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(1);
    for (const level of levels) expect(Math.abs(level + 24)).toBeLessThan(1);
  });

  it('defaults undo the trims exactly, so the default mix is the by-ear balance', () => {
    const audio = defaultSettings().audio;
    for (const bus of BUSES) {
      expect(gainToDb(volumeToGain(audio[bus])) + BUS_TRIM_DB[bus]).toBeCloseTo(0, 9);
      // On the menu's 5 % steps, so a player can drag back to it.
      expect(Math.round(audio[bus] * 20) / 20).toBeCloseTo(audio[bus], 12);
    }
    expect(audio.master).toBe(0.8);
  });
});
