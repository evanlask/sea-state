// Optional recorded samples. A manifest maps sound ids to files (without extension); the bank picks
// Opus-in-WebM or AAC (.m4a) by canPlayType, fetches and decodes them, and the engine uses a sample
// in place of synthesis wherever one exists. The game ships recorded sea and rain loops
// (recordings.ts); everything else is synthesized.

// One-shots and ambient loops the engine knows how to swap in (engines are always synthesized).
export type SoundId =
  | 'slam'
  | 'splash'
  | 'creak'
  | 'winch'
  | 'thunder-crack'
  | 'crest'
  | 'lap'
  | 'flog-snap'
  | 'wind'
  | 'sea-lap'
  | 'sea-wash'
  | 'sea-roar'
  | 'rain-deck'
  | 'rain-water';

interface SampleVariant {
  file: string; // path relative to the manifest base, without extension
}

export interface SampleEntry {
  variants: readonly SampleVariant[];
  gain?: number; // linear trim, default 1
  loop?: boolean;
  // Seamless loops padded on both sides (the asset pipeline's loops/): loop between these, seconds.
  loopStart?: number;
  loopEnd?: number;
}

export interface SampleManifest {
  baseUrl: string; // e.g. `${import.meta.env.BASE_URL}audio/`
  sounds: Partial<Record<SoundId, SampleEntry>>;
}

export type AudioFormat = 'webm' | 'm4a';

// Opus first (smaller, gapless); Safari before 17 only decodes AAC.
export function pickAudioFormat(canPlayType: (mime: string) => string): AudioFormat | null {
  if (canPlayType('audio/webm; codecs="opus"') !== '') return 'webm';
  if (canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '') return 'm4a';
  return null;
}

export interface LoadedSample {
  entry: SampleEntry;
  buffers: AudioBuffer[]; // parallel to entry.variants
}

export interface SampleBankOptions {
  fetch?: typeof fetch;
  canPlayType?: (mime: string) => string;
}

export class SampleBank {
  private readonly loaded = new Map<SoundId, LoadedSample>();
  private readonly fetcher: typeof fetch;
  private readonly canPlayType: (mime: string) => string;

  constructor(options: SampleBankOptions = {}) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.canPlayType =
      options.canPlayType ??
      ((mime: string) => (typeof Audio === 'undefined' ? '' : new Audio().canPlayType(mime)));
  }

  get size(): number {
    return this.loaded.size;
  }

  // The format load() fetches, or null when the browser decodes neither.
  get format(): AudioFormat | null {
    return pickAudioFormat(this.canPlayType);
  }

  get(id: SoundId): LoadedSample | undefined {
    return this.loaded.get(id);
  }

  // Decodes every entry of the manifest. Failures are reported and skipped, so a missing file
  // just leaves that sound synthesized. `context` decodes (any BaseAudioContext works); `fetcher`
  // overrides the bank's fetch for this load (e.g. to route downloads through a loading screen).
  async load(
    manifest: SampleManifest,
    context: BaseAudioContext,
    onProgress?: (done: number, total: number) => void,
    fetcher: (url: string) => Promise<Response> = this.fetcher,
  ): Promise<{ loaded: number; failed: string[] }> {
    const format = this.format;
    const failed: string[] = [];
    const entries = Object.entries(manifest.sounds) as [SoundId, SampleEntry][];
    const total = entries.reduce((sum, [, entry]) => sum + entry.variants.length, 0);
    let done = 0;
    if (!format) return { loaded: 0, failed: entries.map(([id]) => id) };
    await Promise.all(
      entries.map(async ([id, entry]) => {
        try {
          const buffers = await Promise.all(
            entry.variants.map(async (variant) => {
              try {
                const response = await fetcher(`${manifest.baseUrl}${variant.file}.${format}`);
                if (!response.ok) throw new Error(`${variant.file}: HTTP ${response.status}`);
                return await context.decodeAudioData(await response.arrayBuffer());
              } finally {
                // Failed files count as done too, so a progress bar still reaches the end.
                onProgress?.(++done, total);
              }
            }),
          );
          this.loaded.set(id, { entry, buffers });
        } catch (error) {
          failed.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    return { loaded: this.loaded.size, failed };
  }

  // Lets tests and tools register already-decoded buffers.
  set(id: SoundId, sample: LoadedSample): void {
    this.loaded.set(id, sample);
  }
}
