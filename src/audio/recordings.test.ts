import { describe, expect, it } from 'vite-plus/test';

import credits from '../../CREDITS.md?raw';
import publicManifest from '../../public/assets-manifest.json';
import { type AssetManifest, assetEntry } from '../app/loading/manifest';
import { type ListedAudio, RECORDED_LOOPS, recordingPlan } from './recordings';

const listing =
  (files: Record<string, ListedAudio>) =>
  (path: string): ListedAudio | null =>
    files[path] ?? null;

describe('recordingPlan', () => {
  it('lists the recordings shipped in the chosen format, with their loop points and trims', () => {
    const plan = recordingPlan(
      listing({
        'audio/loops/sea-wash.webm': { bytes: 80_000, loop: { start: 0.25, end: 20.25 } },
        'audio/loops/sea-wash.m4a': { bytes: 128_000, loop: { start: 0.25, end: 20.25 } },
        'audio/loops/rain-deck.m4a': { bytes: 100_000 },
      }),
      'webm',
      '/sea-state/',
    );
    expect(plan.files).toEqual([{ path: 'audio/loops/sea-wash.webm', bytes: 80_000 }]);
    expect(plan.manifest.baseUrl).toBe('/sea-state/audio/');
    expect(Object.keys(plan.manifest.sounds)).toEqual(['sea-wash']);
    expect(plan.manifest.sounds['sea-wash']).toMatchObject({
      variants: [{ file: 'loops/sea-wash' }],
      loop: true,
      loopStart: 0.25,
      loopEnd: 20.25,
    });
    expect(plan.manifest.sounds['sea-wash']?.gain).toBe(
      RECORDED_LOOPS.find((r) => r.id === 'sea-wash')?.gain,
    );
  });

  it('loops a file whole when it has no valid loop points', () => {
    const plan = recordingPlan(
      listing({ 'audio/loops/rain-deck.m4a': { bytes: 1, loop: { start: 2, end: 1 } } }),
      'm4a',
      '/',
    );
    expect(plan.manifest.sounds['rain-deck']).not.toHaveProperty('loopStart');
    expect(recordingPlan(() => null, 'webm', '/').files).toEqual([]);
  });

  it('ships every recording in both formats with loop points, and credits them', () => {
    const manifest = publicManifest as AssetManifest;
    for (const format of ['webm', 'm4a'] as const) {
      const plan = recordingPlan((path) => assetEntry(manifest, path), format, '/');
      expect(plan.files).toHaveLength(RECORDED_LOOPS.length);
      for (const { id } of RECORDED_LOOPS) {
        const entry = plan.manifest.sounds[id];
        expect(entry?.loopEnd, `${id}.${format}`).toBeGreaterThan(entry?.loopStart ?? Infinity);
      }
      // Small: mono, low bitrate (the whole set well under a megabyte per format).
      expect(plan.files.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThan(1_000_000);
    }
    expect(credits.match(/BigSoundBank #\d{4}/g)).toHaveLength(RECORDED_LOOPS.length);
  });
});
