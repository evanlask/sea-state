// Loads the recorded sea and rain loops (audio/recordings.ts) into the sample bank: the files the
// asset manifest lists in the browser's format, downloaded through the loading screen when there
// is one (sizes from the manifest) and decoded on an OfflineAudioContext, so this can run before
// the audio unlocks. Anything missing or failing just leaves that bed synthesized.

import { recordingPlan } from '../audio/recordings';
import type { SampleBank } from '../audio/SampleBank';
import type { LoadingManager } from './loading/LoadingManager';
import { assetEntry, assetUrl, loadAssetManifest } from './loading/manifest';

// Recordings are decoded at this rate; the engine's context resamples on playback.
const DECODE_RATE = 48_000;

export async function loadRecordings(
  bank: SampleBank,
  loading: LoadingManager | null,
  base: string = import.meta.env.BASE_URL,
): Promise<number> {
  const format = bank.format;
  if (!format || typeof OfflineAudioContext === 'undefined') return 0;
  const assets = await loadAssetManifest(base);
  const plan = recordingPlan((path) => assetEntry(assets, path), format, base);
  if (plan.files.length === 0) return 0;
  // The bank asks for `${base}audio/<file>.<format>`.
  const fetchFile = async (url: string): Promise<Response> => {
    const path = url.slice(base.length);
    const entry = assetEntry(assets, path);
    const versioned = assetUrl(base, path, entry);
    if (!loading) return fetch(versioned);
    const data = await loading.download(
      {
        id: `audio:${path}`,
        label: 'Downloading sea and rain recordings',
        kind: 'download',
        bytes: entry?.bytes,
        url: versioned,
      },
      { onError: 'throw', retries: 1 },
    );
    return new Response(data);
  };
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: DECODE_RATE });
  const result = await bank.load(plan.manifest, context, undefined, fetchFile);
  if (result.failed.length > 0)
    console.warn('Some sea and rain recordings failed to load; those stay synthesized.', result.failed);
  return result.loaded;
}
