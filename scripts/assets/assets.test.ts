import { describe, expect, it } from 'vite-plus/test';

import { audioProfile, AMBIENCE, EFFECT, ffmpegArgs, LOOP, loopFilter, STEREO_LOOP } from './audio.ts';
import { formatBytes, formatSaving, formatSizeReport } from './format.ts';
import {
  decodeWav,
  encodeWav,
  linearGainDb,
  loopPoints,
  parseLoudnormMeasurement,
  wrapLoop,
} from './loops.ts';
import { buildManifest, kindForPath, serializeManifest, sha256 } from './manifest.ts';
import { cappedSize, packChannels, planTextureJobs, textureRole } from './texturePacking.ts';
import { textureCodec } from './textures.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('kindForPath', () => {
  it('classifies the managed directories', () => {
    expect(kindForPath('models/sail/model.glb')).toBe('model');
    expect(kindForPath('models/sail/model.lod1.glb')).toBe('model');
    expect(kindForPath('models/sail/align.json')).toBe('align');
    expect(kindForPath('models/sail/credits.json')).toBe('credits');
    expect(kindForPath('models/characters/rider/model.glb')).toBe('model');
    expect(kindForPath('textures/teak_albedo.ktx2')).toBe('texture');
    expect(kindForPath('ui/logo.webp')).toBe('image');
    expect(kindForPath('audio/horn.webm')).toBe('audio');
    expect(kindForPath('data/stars.bin.gz')).toBe('data');
  });

  it('leaves out licence text and unmanaged files', () => {
    expect(kindForPath('data/stars.LICENSE.txt')).toBeNull();
    expect(kindForPath('favicon.svg')).toBeNull();
    expect(kindForPath('models/sail/.DS_Store')).toBeNull();
  });
});

describe('buildManifest', () => {
  const files = [
    { path: 'models/sail/model.glb', data: bytes('glb') },
    { path: 'data/stars.bin.gz', data: bytes('stars!') },
    { path: 'data/stars.LICENSE.txt', data: bytes('licence') },
  ];

  it('records size, hash and kind, sorted by path', () => {
    const manifest = buildManifest(files, null, new Map([['models/sail/model.glb', 1000]]));
    expect(Object.keys(manifest.assets)).toEqual(['data/stars.bin.gz', 'models/sail/model.glb']);
    expect(manifest.assets['data/stars.bin.gz']).toEqual({
      bytes: 6,
      sha256: sha256(bytes('stars!')),
      kind: 'data',
    });
    expect(manifest.assets['models/sail/model.glb']?.sourceBytes).toBe(1000);
    expect(sha256(bytes('glb'))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries a source size over only while the content is unchanged', () => {
    const first = buildManifest(files, null, new Map([['models/sail/model.glb', 1000]]));
    expect(buildManifest(files, first).assets['models/sail/model.glb']?.sourceBytes).toBe(1000);
    const changed = [{ path: 'models/sail/model.glb', data: bytes('new glb') }];
    expect(buildManifest(changed, first).assets['models/sail/model.glb']?.sourceBytes).toBeUndefined();
  });

  it('records audio loop points, carried over while the content is unchanged', () => {
    const path = 'audio/loops/sea.webm';
    const audio = [{ path, data: bytes('opus') }];
    const first = buildManifest(audio, null, new Map(), new Map([[path, { start: 0.25, end: 20.25 }]]));
    expect(first.assets[path]?.loop).toEqual({ start: 0.25, end: 20.25 });
    expect(buildManifest(audio, first).assets[path]?.loop).toEqual({ start: 0.25, end: 20.25 });
    const changed = [{ path, data: bytes('new opus') }];
    expect(buildManifest(changed, first).assets[path]?.loop).toBeUndefined();
    expect(buildManifest(files, null).assets['data/stars.bin.gz']).not.toHaveProperty('loop');
  });

  it('serializes stably with a trailing newline', () => {
    const text = serializeManifest(buildManifest(files, null));
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(buildManifest(files, null));
  });
});

describe('size report', () => {
  it('formats bytes and changes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(90_323)).toBe('90.3 KB');
    expect(formatBytes(18_400_000)).toBe('18.40 MB');
    expect(formatSaving(1000, 375)).toBe('−62.5%');
    expect(formatSaving(100, 150)).toBe('+50.0%');
    expect(formatSaving(undefined, 10)).toBe('');
  });

  it('tabulates before/after with totals over files that have a source', () => {
    const report = formatSizeReport({
      version: 1,
      assets: {
        'data/stars.bin.gz': { bytes: 90_000, sha256: 'a', kind: 'data' },
        'models/sail/model.glb': { bytes: 250_000, sha256: 'b', kind: 'model', sourceBytes: 1_000_000 },
      },
    });
    const lines = report.split('\n');
    expect(lines[0]).toMatch(/^Asset\s+Kind\s+Before\s+After\s+Change$/);
    expect(lines.find((l) => l.startsWith('data/'))).toMatch(/—\s+90\.0 KB$/);
    expect(lines.find((l) => l.startsWith('models/'))).toMatch(/1\.00 MB\s+250\.0 KB\s+−75\.0%$/);
    expect(lines.at(-1)).toMatch(/^Total \(2 files\)\s+1\.00 MB\s+340\.0 KB\s+−75\.0%$/);
  });
});

describe('codec choices', () => {
  it('uses UASTC for data maps and ETC1S for colour', () => {
    expect(textureCodec('teak_normal.png')).toBe('uastc');
    expect(textureCodec('rust-ORM.png')).toBe('uastc');
    expect(textureCodec('surface.png')).toBe('uastc');
    expect(textureCodec('paint_roughness.jpg')).toBe('uastc');
    expect(textureCodec('teak_albedo.png')).toBe('etc1s');
    expect(textureCodec('normandy_flag.png')).toBe('etc1s');
  });

  it('picks the ambience or effect audio profile', () => {
    expect(audioProfile('audio/ambience/wind.wav')).toBe(AMBIENCE);
    expect(audioProfile('audio/amb_harbour.wav')).toBe(AMBIENCE);
    expect(audioProfile('audio/horn.wav')).toBe(EFFECT);
    const args = ffmpegArgs('in.wav', 'out.webm', EFFECT, 'opus');
    expect(args).toContain('libopus');
    expect(args.join(' ')).toContain('loudnorm=I=-16');
    expect(args.slice(-1)).toEqual(['out.webm']);
  });

  it('treats loops/ as small seamless loops, mono unless ambience', () => {
    expect(audioProfile('audio/loops/sea-wash.wav')).toBe(LOOP);
    expect(audioProfile('audio/ambience/loops/harbour.wav')).toBe(STEREO_LOOP);
    expect(LOOP).toMatchObject({ channels: 1, loop: true });
    expect(LOOP.opusKbps).toBeLessThanOrEqual(32);
    expect(AMBIENCE.loop).toBe(false);
  });

  it('encodes loops with one linear gain and no trimming', () => {
    const args = ffmpegArgs('in.wav', 'out.m4a', LOOP, 'aac', loopFilter(-3.456), 'aac_at').join(' ');
    expect(args).toContain('-af volume=-3.46dB -ac 1');
    expect(args).toContain('-c:a aac_at -b:a 48k');
    expect(args).not.toMatch(/silenceremove|loudnorm/);
  });
});

describe('seamless loops', () => {
  // Deterministic noise in [-1, 1).
  const noise = (n: number, seed = 1): Float32Array => {
    const out = new Float32Array(n);
    let s = seed;
    for (let i = 0; i < n; i++) {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      out[i] = s / 1_073_741_824 - 1;
    }
    return out;
  };

  it('pads a loop with its own tail and head, periodic throughout', () => {
    const loop = noise(500);
    const wrapped = wrapLoop(loop, 100);
    expect(wrapped).toHaveLength(700);
    for (let i = 0; i + 500 < wrapped.length; i++) expect(wrapped[i + 500]).toBe(wrapped[i]);
    expect(wrapped.subarray(100, 600)).toEqual(loop);
    expect(loopPoints(500, 100, 50)).toEqual({ start: 2, end: 12 });
  });

  it('picks a linear gain toward the target, capped by the true peak', () => {
    expect(linearGainDb(-20, -10)).toBe(4);
    expect(linearGainDb(-30, -3)).toBe(1.5);
    expect(linearGainDb(-12, -1)).toBe(-4);
    expect(linearGainDb(-Infinity, -3)).toBe(0);
  });

  it("parses loudnorm's measurement", () => {
    const log = '[Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-25.02",\n\t"input_tp" : "-3.36"\n}\n';
    expect(parseLoudnormMeasurement(log)).toEqual({ lufs: -25.02, truePeak: -3.36 });
    expect(parseLoudnormMeasurement('no json here')).toBeNull();
    expect(parseLoudnormMeasurement('{ "input_i": "-inf", "input_tp": "-inf" }')).toBeNull();
  });

  it('round-trips 32-bit float WAVs', () => {
    const pcm = { sampleRate: 48_000, channels: [Float32Array.of(0, 0.5, -1), Float32Array.of(1, -0.25, 0)] };
    expect(decodeWav(encodeWav(pcm))).toEqual(pcm);
  });

  it('reads WAVE_FORMAT_EXTENSIBLE and streamed (unsized) WAVs', () => {
    const plain = encodeWav({ sampleRate: 44_100, channels: [Float32Array.of(0.25, -0.5)] });
    // The same file with a 40-byte extensible fmt chunk (float sub-format) and no data size.
    const ext = new Uint8Array(plain.length + 24);
    const view = new DataView(ext.buffer);
    ext.set(plain.subarray(0, 36));
    view.setUint32(16, 40, true);
    view.setUint16(20, 0xfffe, true);
    view.setUint16(36, 22, true); // cbSize
    view.setUint16(44, 3, true); // sub-format GUID starts with the format code
    ext.set(plain.subarray(36), 60);
    view.setUint32(64, 0xffffffff, true);
    expect(decodeWav(ext)).toEqual({ sampleRate: 44_100, channels: [Float32Array.of(0.25, -0.5)] });
    expect(() => decodeWav(bytes('RIFF....WAVEjunk'))).toThrow();
  });
});

describe('texture sets', () => {
  it('reads map roles from file names, with or without a set prefix', () => {
    expect(textureRole('normal.jpg')).toEqual({ stem: '', role: 'normal' });
    expect(textureRole('teak_Roughness.png')).toEqual({ stem: 'teak_', role: 'roughness' });
    expect(textureRole('hull-ao.png')).toEqual({ stem: 'hull-', role: 'ao' });
    expect(textureRole('metalness.jpg').role).toBe('metalness');
    expect(textureRole('albedo.png').role).toBe('color');
    expect(textureRole('normandy_flag.png').role).toBeNull();
  });

  const none = (): object => ({});

  it('packs a normal map with its data maps into surface.ktx2 and keeps colour separate', () => {
    const jobs = planTextureJobs(
      [
        'textures/steel/color.jpg',
        'textures/steel/normal.jpg',
        'textures/steel/roughness.jpg',
        'textures/steel/ao.jpg',
      ],
      none,
    );
    expect(jobs.map((j) => j.output)).toEqual(['textures/steel/color.ktx2', 'textures/steel/surface.ktx2']);
    const packed = jobs[1]!;
    expect(packed.kind).toBe('pack');
    if (packed.kind !== 'pack') return;
    expect(packed.layout).toBe('surface');
    expect(packed.sources).toEqual({
      normal: 'textures/steel/normal.jpg',
      roughness: 'textures/steel/roughness.jpg',
      ao: 'textures/steel/ao.jpg',
    });
  });

  it('packs data maps without a normal map into a glTF ORM, per prefix', () => {
    const jobs = planTextureJobs(
      ['textures/a_roughness.png', 'textures/a_metal.png', 'textures/b_normal.png'],
      none,
    );
    expect(jobs.map((j) => [j.output, j.kind])).toEqual([
      ['textures/a_orm.ktx2', 'pack'],
      ['textures/b_normal.ktx2', 'single'],
    ]);
  });

  it('applies per-set size caps and skips', () => {
    const jobs = planTextureJobs(
      ['textures/rubber/color.jpg', 'textures/rubber/normal.jpg', 'textures/rubber/roughness.jpg'],
      (dir) => (dir === 'textures/rubber' ? { maxSize: 512, skip: ['color'], rdo: null } : {}),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ output: 'textures/rubber/surface.ktx2', maxSize: 512, rdo: null });
  });

  it('knows the ambientCG detail sets', () => {
    const jobs = planTextureJobs([
      'textures/painted-metal/color.jpg',
      'textures/painted-metal/normal.jpg',
      'textures/painted-metal/roughness.jpg',
      'textures/painted-metal/metalness.jpg',
    ]);
    expect(jobs.map((j) => j.output)).toEqual(['textures/painted-metal/surface.ktx2']);
    expect(jobs[0]!.maxSize).toBe(1024);
  });

  it('interleaves channels in the surface and ORM layouts', () => {
    const grey = (...values: number[]) => ({ data: new Uint8Array(values), channels: 1 });
    const normal = { data: new Uint8Array([10, 20, 255, 30, 40, 250]), channels: 3 };
    const surface = packChannels('surface', 2, { normal, roughness: grey(100, 110), ao: grey(200, 210) });
    expect([...surface]).toEqual([10, 20, 100, 200, 30, 40, 110, 210]);
    // No AO: metalness goes to alpha; no roughness: rough (255).
    expect([...packChannels('surface', 1, { normal, metalness: grey(7) })]).toEqual([10, 20, 255, 7]);
    expect([...packChannels('surface', 1, { normal })]).toEqual([10, 20, 255, 255]);
    expect([...packChannels('orm', 1, { roughness: grey(90) })]).toEqual([255, 90, 0, 255]);
    expect([...packChannels('orm', 1, { ao: grey(1), roughness: grey(2), metalness: grey(3) })]).toEqual([
      1, 2, 3, 255,
    ]);
  });

  it('caps the longer side and keeps the aspect', () => {
    expect(cappedSize(1024, 512, 512)).toEqual({ width: 512, height: 256 });
    expect(cappedSize(256, 256, 1024)).toEqual({ width: 256, height: 256 });
  });
});
