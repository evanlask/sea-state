import { describe, expect, it } from 'vite-plus/test';

import { decompressGzip, fetchWithProgress, HttpError, type FetchProgress } from './fetch';

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function chunkedResponse(sizes: number[], headers: Record<string, string> = {}): Response {
  let value = 0;
  const chunks = sizes.map((size) => Uint8Array.from({ length: size }, () => value++ % 256));
  return new Response(streamOf(chunks), { headers });
}

describe('fetchWithProgress', () => {
  it('streams bytes and reports progress against the expected size', async () => {
    const reports: FetchProgress[] = [];
    const buffer = await fetchWithProgress('/a.bin', {
      expectedBytes: 300,
      onProgress: (progress) => reports.push(progress),
      fetch: () => Promise.resolve(chunkedResponse([100, 100, 100])),
    });
    expect(buffer.byteLength).toBe(300);
    expect(new Uint8Array(buffer)[150]).toBe(150);
    expect(reports.map((r) => r.loaded)).toEqual([0, 100, 200, 300]);
    expect(reports.every((r) => r.total === 300)).toBe(true);
  });

  it('falls back to Content-Length when no size was expected', async () => {
    const reports: FetchProgress[] = [];
    await fetchWithProgress('/b.bin', {
      onProgress: (progress) => reports.push(progress),
      fetch: () => Promise.resolve(chunkedResponse([10, 10], { 'content-length': '20' })),
    });
    expect(reports.at(-1)).toEqual({ loaded: 20, total: 20 });
  });

  it('retries after a failure with backoff', async () => {
    let calls = 0;
    const buffer = await fetchWithProgress('/c.bin', {
      backoffMs: 1,
      fetch: () => {
        calls++;
        if (calls === 1) return Promise.reject(new TypeError('network down'));
        if (calls === 2) return Promise.resolve(new Response('busy', { status: 503 }));
        return Promise.resolve(chunkedResponse([5]));
      },
    });
    expect(calls).toBe(3);
    expect(buffer.byteLength).toBe(5);
  });

  it('gives up after the retry budget and does not retry a 404', async () => {
    let calls = 0;
    const failing = (): Promise<Response> => {
      calls++;
      return Promise.reject(new TypeError('offline'));
    };
    await expect(fetchWithProgress('/d', { backoffMs: 1, retries: 1, fetch: failing })).rejects.toThrow(
      'offline',
    );
    expect(calls).toBe(2);

    calls = 0;
    const missing = (): Promise<Response> => {
      calls++;
      return Promise.resolve(new Response('', { status: 404, statusText: 'Not Found' }));
    };
    await expect(fetchWithProgress('/e', { backoffMs: 1, fetch: missing })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = fetchWithProgress('/f', {
      signal: controller.signal,
      fetch: (_url, init) =>
        init?.signal?.aborted
          ? Promise.reject(new DOMException('aborted', 'AbortError'))
          : Promise.resolve(chunkedResponse([1])),
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('decompressGzip', () => {
  it('round-trips through CompressionStream', async () => {
    const text = 'Sirius Canopus Arcturus Vega '.repeat(200);
    const original = new TextEncoder().encode(text);
    const compressed = await new Response(
      new Blob([original]).stream().pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer();
    expect(compressed.byteLength).toBeLessThan(original.byteLength);
    const restored = await decompressGzip(compressed);
    expect(new TextDecoder().decode(restored)).toBe(text);
  });
});
