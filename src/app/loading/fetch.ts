// Streaming fetch with byte-level progress and retries, plus gzip decoding, for the
// loading pipeline. Sizes come from the asset manifest when known, else Content-Length.

export interface FetchProgress {
  loaded: number;
  // Null when neither the caller nor the server gave a size.
  total: number | null;
}

export interface FetchWithProgressOptions {
  expectedBytes?: number;
  onProgress?: (progress: FetchProgress) => void;
  signal?: AbortSignal;
  retries?: number;
  // First retry waits this long, doubling each time.
  backoffMs?: number;
  init?: RequestInit;
  // Injectable for tests; defaults to the global fetch.
  fetch?: typeof fetch;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(url: string, status: number, statusText: string) {
    super(`GET ${url} failed: ${status} ${statusText}`.trim());
    this.name = 'HttpError';
    this.status = status;
  }
}

// Client errors other than timeouts and rate limits won't fix themselves on retry.
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500 || error.status === 408 || error.status === 429;
  return !(error instanceof DOMException && error.name === 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOnce(url: string, options: FetchWithProgressOptions): Promise<ArrayBuffer> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const response = await fetchImpl(url, { ...options.init, signal: options.signal });
  if (!response.ok) throw new HttpError(url, response.status, response.statusText);

  // Content-Length is the compressed size under Content-Encoding, so the manifest size wins.
  const header = Number(response.headers.get('content-length'));
  const total = options.expectedBytes ?? (Number.isFinite(header) && header > 0 ? header : null);
  const report = (loaded: number): void =>
    options.onProgress?.({ loaded, total: total === null ? null : Math.max(total, loaded) });
  report(0);

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    report(buffer.byteLength);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      report(loaded);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export async function fetchWithProgress(
  url: string,
  options: FetchWithProgressOptions = {},
): Promise<ArrayBuffer> {
  const retries = options.retries ?? 2;
  const backoff = options.backoffMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, options);
    } catch (error) {
      if (options.signal?.aborted || attempt >= retries || !isRetryable(error)) throw error;
      await sleep(backoff * 2 ** attempt, options.signal);
    }
  }
}

export async function decompressGzip(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
