// Seamless ambient loops and the WAV interchange with ffmpeg (pure helpers, unit-tested).
// Lossy codecs add priming and padding at a file's ends, and browsers disagree on trimming them, so
// a loop that wraps at the file boundary can gap or click. The pipeline (audio.ts) instead pads the
// loop with copies of its own tail and head and records the loop points in the asset manifest; the
// player loops between them. The padded signal has the loop's period everywhere, so a decoder that
// shifts it by a few milliseconds still loops seamlessly.

export interface LoopPoints {
  start: number; // seconds
  end: number;
}

// Margin of tail before and head after the loop in a shipped file: far more than any codec delay
// (Opus pre-skip is 6.5 ms, AAC priming ~45 ms).
export const LOOP_MARGIN_SECONDS = 0.25;

// [last `margin` frames][loop][first `margin` frames]. The loop starts at frame `margin`.
export function wrapLoop(loop: Float32Array, margin: number): Float32Array {
  const n = loop.length;
  if (margin < 0 || margin > n) throw new Error('margin must be within the loop length');
  const out = new Float32Array(n + 2 * margin);
  out.set(loop.subarray(n - margin), 0);
  out.set(loop, margin);
  out.set(loop.subarray(0, margin), margin + n);
  return out;
}

export function loopPoints(frames: number, margin: number, sampleRate: number): LoopPoints {
  return { start: margin / sampleRate, end: (margin + frames) / sampleRate };
}

// Loops get one linear gain (a dynamic loudness normalizer would ride the level and break the
// seam): up to the target loudness, but never past the true-peak ceiling.
export function linearGainDb(
  measuredLufs: number,
  measuredTruePeak: number,
  target = -16,
  ceiling = -1.5,
): number {
  if (!Number.isFinite(measuredLufs)) return 0;
  const gain = target - measuredLufs;
  return Number.isFinite(measuredTruePeak) ? Math.min(gain, ceiling - measuredTruePeak) : gain;
}

// The JSON block ffmpeg's loudnorm filter prints (print_format=json) at the end of its log.
export function parseLoudnormMeasurement(log: string): { lufs: number; truePeak: number } | null {
  const start = log.lastIndexOf('{');
  const end = log.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const json = JSON.parse(log.slice(start, end + 1)) as { input_i?: string; input_tp?: string };
    const lufs = Number(json.input_i);
    const truePeak = Number(json.input_tp);
    return Number.isFinite(lufs) && Number.isFinite(truePeak) ? { lufs, truePeak } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// 32-bit float WAV, the interchange format with ffmpeg

export interface PcmAudio {
  sampleRate: number;
  channels: Float32Array[];
}

export function encodeWav({ sampleRate, channels }: PcmAudio): Uint8Array {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 4;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let f = 0; f < frames; f++)
    for (let c = 0; c < count; c++) view.setFloat32(44 + (f * count + c) * 4, channels[c]?.[f] ?? 0, true);
  return out;
}

// Reads 32-bit float WAVs (plain or WAVE_FORMAT_EXTENSIBLE, as ffmpeg writes with pcm_f32le).
export function decodeWav(data: Uint8Array): PcmAudio {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...data.subarray(offset, Math.min(offset + 4, data.length)));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format: { channels: number; sampleRate: number; bits: number; code: number } | null = null;
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = tag(offset);
    let size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      let code = view.getUint16(body, true);
      if (code === 0xfffe && size >= 40) code = view.getUint16(body + 24, true); // sub-format GUID
      format = {
        code,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before its format');
      if (format.code !== 3 || format.bits !== 32) throw new Error('expected 32-bit float WAV');
      // A WAV streamed to a pipe has no sizes; read to the end.
      if (size === 0 || size === 0xffffffff || body + size > data.length) size = data.length - body;
      const frames = Math.floor(size / (4 * format.channels));
      const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++)
        for (let c = 0; c < format.channels; c++)
          channels[c]![f] = view.getFloat32(body + (f * format.channels + c) * 4, true);
      return { sampleRate: format.sampleRate, channels };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}
