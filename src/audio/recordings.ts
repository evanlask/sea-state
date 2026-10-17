// The recorded ambience the game ships: CC0 field recordings from BigSoundBank, cut into seamless
// loops (source WAVs under assets-src/audio/) and encoded by `npm run assets` into
// public/audio/loops/ (mono Opus ~32 kbps, AAC ~48 kbps). Each replaces the noise of one synthesized bed (Ambience's
// BedLayer); the bed's gain curve, swell LFO and the synthesized one-shots and drops stay. A loop that
// fails to load leaves its bed synthesized.
//
// Trims match each recording's loudness (LUFS, played wide as the engine does) to the noise layer
// it replaces, through that layer's filter at a typical setting, so the curves in curves.ts hold
// for both. The roar's trim allows for the noise kept under it (NOISE_UNDER_RECORDING).

import type { AudioFormat, SampleEntry, SampleManifest, SoundId } from './SampleBank';

export interface RecordedLoop {
  id: SoundId;
  file: string; // under public/audio/, without extension
  gain: number; // linear trim
}

// Cut from BigSoundBank's WAVs (start and length below, 3 s crossfade, 48 kHz mono). "limit x" is
// alimiter=level_in=x:limit=0.5:level=disabled, which only catches the loudest peaks.
export const RECORDED_LOOPS: readonly RecordedLoop[] = [
  // #0266 "Sea: Waves", 20.2 s + 28 s, highpass=f=150, limit 1.5: swirling, slapping water for
  // calm and slight seas.
  { id: 'sea-lap', file: 'loops/sea-lap', gain: 0.6 },
  // #0698 "Sea Waves", 38 s + 20 s, highpass=f=40: its steadiest stretch (±1 dB, no breaker
  // rhythm), the open-sea wash.
  { id: 'sea-wash', file: 'loops/sea-wash', gain: 0.78 },
  // #2570 "Cliff #1", 92 s + 30 s, highpass=f=25 then lowpass=f=800 twice: the gale and storm roar.
  { id: 'sea-roar', file: 'loops/sea-roar', gain: 1.34 },
  // #1292 "Rain on plastic tarpaulin", 32 s + 20 s, highpass=f=100, limit 2: rain on deck.
  { id: 'rain-deck', file: 'loops/rain-deck', gain: 2.63 },
  // #1290 "Rain on puddle", 46 s + 18 s, highpass=f=200, limit 3 (tames the big plinks): rain on
  // the sea. 3 dB under its loudness match: the plinks stood out.
  { id: 'rain-water', file: 'loops/rain-water', gain: 2.3 },
];

// What the asset manifest says about a file (src/app/loading/manifest.ts's AssetEntry fits).
export interface ListedAudio {
  bytes: number;
  loop?: { start: number; end: number };
}

export interface RecordingPlan {
  manifest: SampleManifest;
  files: { path: string; bytes: number }[]; // relative to the site root, in the chosen format
}

// The sample manifest for the recordings the asset manifest lists in `format`; anything missing is
// left out (that bed stays synthesized). `base` is import.meta.env.BASE_URL.
export function recordingPlan(
  lookup: (path: string) => ListedAudio | null,
  format: AudioFormat,
  base: string,
  loops: readonly RecordedLoop[] = RECORDED_LOOPS,
): RecordingPlan {
  const sounds: Partial<Record<SoundId, SampleEntry>> = {};
  const files: RecordingPlan['files'] = [];
  for (const { id, file, gain } of loops) {
    const path = `audio/${file}.${format}`;
    const listed = lookup(path);
    if (!listed) continue;
    const entry: SampleEntry = { variants: [{ file }], gain, loop: true };
    if (listed.loop && listed.loop.end > listed.loop.start) {
      entry.loopStart = listed.loop.start;
      entry.loopEnd = listed.loop.end;
    }
    sounds[id] = entry;
    files.push({ path, bytes: listed.bytes });
  }
  return { manifest: { baseUrl: `${base}audio/`, sounds }, files };
}
