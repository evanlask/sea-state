// Audio through ffmpeg into Opus in WebM (the main format) and AAC in .m4a (Safari's fallback,
// picked with canPlayType). Apple's AAC encoder (aac_at, macOS builds) is used when ffmpeg has it:
// it holds up better than ffmpeg's own at low bitrates.
//
// - One-shots and beds: leading and trailing silence trimmed, loudness normalized to −16 LUFS.
//   Files under an ambience/ folder (or named *ambience* / *amb_*) are stereo beds; everything else
//   is a mono positional effect.
// - Seamless loops (anything under a loops/ folder): never trimmed, one linear gain toward −16 LUFS
//   (capped by the true peak), padded with their own tail and head, and the loop points go into the
//   asset manifest (see loops.ts). Mono unless also an ambience path: the engine plays a mono loop
//   as two reads half a loop apart, which is as wide as a stereo recording for diffuse sea and rain.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  decodeWav,
  encodeWav,
  linearGainDb,
  LOOP_MARGIN_SECONDS,
  type LoopPoints,
  loopPoints,
  parseLoudnormMeasurement,
  wrapLoop,
} from './loops.ts';

const run = promisify(execFile);

export interface AudioProfile {
  channels: 1 | 2;
  opusKbps: number;
  aacKbps: number;
  loop: boolean;
}

export const EFFECT: AudioProfile = { channels: 1, opusKbps: 40, aacKbps: 64, loop: false };
export const AMBIENCE: AudioProfile = { channels: 2, opusKbps: 64, aacKbps: 96, loop: false };
export const LOOP: AudioProfile = { channels: 1, opusKbps: 32, aacKbps: 48, loop: true };
export const STEREO_LOOP: AudioProfile = { channels: 2, opusKbps: 56, aacKbps: 80, loop: true };

const isAmbience = (path: string): boolean => /(^|\/)ambience\/|ambience|(^|[/_-])amb[_-]/i.test(path);
const isLoop = (path: string): boolean => /(^|\/)loops\//i.test(path);

export function audioProfile(path: string): AudioProfile {
  if (isLoop(path)) return isAmbience(path) ? STEREO_LOOP : LOOP;
  return isAmbience(path) ? AMBIENCE : EFFECT;
}

const TRIM = 'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.02';
// Trailing silence: trim the start of the reversed signal.
const AUDIO_FILTER = `${TRIM},areverse,${TRIM},areverse,loudnorm=I=-16:TP=-1.5:LRA=11`;

export type AacEncoder = 'aac_at' | 'aac';

export function findFfmpeg(): string | null {
  for (const candidate of [
    process.env['FFMPEG'],
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ])
    if (candidate && existsSync(candidate)) return candidate;
  return null;
}

export async function findAacEncoder(ffmpeg: string): Promise<AacEncoder> {
  try {
    const { stdout } = await run(ffmpeg, ['-hide_banner', '-encoders']);
    return /\baac_at\b/.test(stdout) ? 'aac_at' : 'aac';
  } catch {
    return 'aac';
  }
}

export function ffmpegArgs(
  input: string,
  output: string,
  profile: AudioProfile,
  codec: 'opus' | 'aac',
  filter: string = AUDIO_FILTER,
  aacEncoder: AacEncoder = 'aac',
): string[] {
  const encoder =
    codec === 'opus'
      ? ['-c:a', 'libopus', '-b:a', `${profile.opusKbps}k`, '-vbr', 'on', '-ar', '48000']
      : ['-c:a', aacEncoder, '-b:a', `${profile.aacKbps}k`, '-ar', '48000', '-movflags', '+faststart'];
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    input,
    '-vn',
    '-map_metadata',
    '-1',
    '-af',
    filter,
    '-ac',
    String(profile.channels),
    ...encoder,
    output,
  ];
}

// A loop's only processing: one gain, so the level is the same everywhere in the file.
export const loopFilter = (gainDb: number): string => `volume=${gainDb.toFixed(2)}dB`;

export interface EncodedAudio {
  outputs: string[];
  loop?: LoopPoints; // seamless loops: where to loop, in seconds
}

export async function encodeAudio(
  ffmpeg: string,
  input: string,
  outputBase: string,
  path: string,
  aacEncoder: AacEncoder = 'aac',
): Promise<EncodedAudio> {
  const profile = audioProfile(path);
  const outputs = [`${outputBase}.webm`, `${outputBase}.m4a`];
  if (!profile.loop) {
    await run(ffmpeg, ffmpegArgs(input, outputs[0]!, profile, 'opus'));
    await run(ffmpeg, ffmpegArgs(input, outputs[1]!, profile, 'aac', AUDIO_FILTER, aacEncoder));
    return { outputs };
  }
  const work = mkdtempSync(join(tmpdir(), 'sea-state-loop-'));
  try {
    // Decoded at the source rate (resampling the bare loop would smear its seam) and mixed to the
    // profile's channels, then padded with its own tail and head; the encoders resample that.
    const decoded = join(work, 'decoded.wav');
    const channels = String(profile.channels);
    const quiet = ['-hide_banner', '-loglevel', 'error', '-y'];
    await run(ffmpeg, [...quiet, '-i', input, '-vn', '-ac', channels, '-c:a', 'pcm_f32le', decoded]);
    const pcm = decodeWav(readFileSync(decoded));
    const frames = pcm.channels[0]?.length ?? 0;
    const margin = Math.min(Math.round(LOOP_MARGIN_SECONDS * pcm.sampleRate), frames);
    const wrapped = join(work, 'wrapped.wav');
    writeFileSync(
      wrapped,
      encodeWav({ sampleRate: pcm.sampleRate, channels: pcm.channels.map((c) => wrapLoop(c, margin)) }),
    );
    // loudnorm only measures here; it prints the result on stderr.
    const measure = 'loudnorm=I=-16:TP=-1.5:print_format=json';
    const { stderr } = await run(ffmpeg, [
      '-hide_banner',
      '-nostats',
      '-i',
      decoded,
      '-af',
      measure,
      '-f',
      'null',
      '-',
    ]);
    const measured = parseLoudnormMeasurement(stderr);
    const filter = loopFilter(measured ? linearGainDb(measured.lufs, measured.truePeak) : 0);
    await run(ffmpeg, ffmpegArgs(wrapped, outputs[0]!, profile, 'opus', filter));
    await run(ffmpeg, ffmpegArgs(wrapped, outputs[1]!, profile, 'aac', filter, aacEncoder));
    return { outputs, loop: loopPoints(frames, margin, pcm.sampleRate) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
