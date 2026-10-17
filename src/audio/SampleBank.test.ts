import { describe, expect, it } from 'vite-plus/test';

import { pickAudioFormat, SampleBank, type SampleManifest } from './SampleBank';

describe('pickAudioFormat', () => {
  it('prefers Opus in WebM, falls back to AAC, else nothing', () => {
    expect(pickAudioFormat(() => 'probably')).toBe('webm');
    expect(pickAudioFormat((mime) => (mime.startsWith('audio/mp4') ? 'maybe' : ''))).toBe('m4a');
    expect(pickAudioFormat(() => '')).toBeNull();
  });
});

describe('SampleBank', () => {
  const manifest: SampleManifest = {
    baseUrl: '/audio/',
    sounds: {
      slam: { variants: [{ file: 'slam-1' }, { file: 'slam-2' }] },
      wind: { variants: [{ file: 'wind-1' }], loop: true },
    },
  };
  const fakeContext = {
    decodeAudioData: async (data: ArrayBuffer) => ({ duration: data.byteLength }) as unknown as AudioBuffer,
  } as unknown as BaseAudioContext;

  it('fetches the chosen format, decodes and reports progress', async () => {
    const urls: string[] = [];
    const bank = new SampleBank({
      canPlayType: (mime) => (mime.includes('mp4') ? 'maybe' : ''),
      fetch: async (input) => {
        urls.push(input as string);
        return new Response(new ArrayBuffer(4));
      },
    });
    const progress: number[] = [];
    const result = await bank.load(manifest, fakeContext, (done) => progress.push(done));
    expect(result).toEqual({ loaded: 2, failed: [] });
    expect(urls.sort()).toEqual(['/audio/slam-1.m4a', '/audio/slam-2.m4a', '/audio/wind-1.m4a']);
    expect(progress).toEqual([1, 2, 3]);
    expect(bank.get('slam')?.buffers).toHaveLength(2);
  });

  it('skips sounds whose files fail, leaving them synthesized', async () => {
    const bank = new SampleBank({
      canPlayType: () => 'probably',
      fetch: async (input) =>
        (input as string).includes('slam')
          ? new Response(null, { status: 404 })
          : new Response(new ArrayBuffer(2)),
    });
    const result = await bank.load(manifest, fakeContext);
    expect(result.loaded).toBe(1);
    expect(result.failed[0]).toMatch(/^slam: /);
    expect(bank.get('slam')).toBeUndefined();
    expect(bank.get('wind')).toBeDefined();
  });

  it('reports its format and can fetch through another loader for one load', async () => {
    const bank = new SampleBank({
      canPlayType: () => 'probably',
      fetch: () => Promise.reject(new Error('the default fetch should not be used')),
    });
    expect(bank.format).toBe('webm');
    expect(new SampleBank({ canPlayType: () => '' }).format).toBeNull();
    const urls: string[] = [];
    const result = await bank.load(manifest, fakeContext, undefined, async (url) => {
      urls.push(url);
      return new Response(new ArrayBuffer(1));
    });
    expect(result).toEqual({ loaded: 2, failed: [] });
    expect(urls).toContain('/audio/slam-1.webm');
  });

  it('counts failed files as done so a progress bar reaches the end', async () => {
    const bank = new SampleBank({
      canPlayType: () => 'probably',
      fetch: async (input) =>
        (input as string).includes('slam-1')
          ? new Response(null, { status: 404 })
          : new Response(new ArrayBuffer(2)),
    });
    const progress: [number, number][] = [];
    const result = await bank.load(manifest, fakeContext, (done, total) => progress.push([done, total]));
    expect(result.failed).toHaveLength(1);
    expect(progress.at(-1)).toEqual([3, 3]);
    expect(progress).toHaveLength(3);
  });
});
