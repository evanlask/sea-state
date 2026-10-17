// The audio engine's lifecycle and robustness against bad input, on the offline Web Audio
// emulation: unlock/resume handling, a failed graph build, NaN steps and poses, resetting voices
// and the one-shot player's parameter guards.

import { describe, expect, it } from 'vite-plus/test';

import { AudioEngine } from '../../src/audio/AudioEngine';
import { OneShotPlayer } from '../../src/audio/graph';
import type { AudioFrame, BoatAudioState } from '../../src/audio/types';
import { installGlobals, OfflineContext } from './offlineWebAudio';

const SETTINGS = { master: 1, ambience: 1, effects: 1, engines: 1, muteWhenHidden: false };

function engine(ctx: OfflineContext): AudioEngine {
  installGlobals();
  return new AudioEngine({
    settings: SETTINGS,
    panningModel: 'equalpower',
    unlockTarget: null,
    createContext: () => ctx as never,
  });
}

const boat = (id = 'b'): BoatAudioState => ({
  id,
  kind: 'powerboat',
  position: { x: 20, y: 0.5, z: 0 },
  velocity: { x: 0, y: 0, z: -8 },
  rpm: 3000,
  load: 0.5,
  speedThroughWater: 8,
});

const frame = (boats: BoatAudioState[] = [boat()]): AudioFrame => ({
  listener: { position: { x: 0, y: 2, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
  wind: { speed: 12, gustFactor: 1.5 },
  sea: { hs: 1.5 },
  boats,
});

describe('AudioEngine robustness', () => {
  it('survives a NaN step: gusts and Doppler stay finite afterwards', async () => {
    const audio = engine(new OfflineContext(48_000));
    await audio.unlock();
    audio.update(1 / 60, frame());
    audio.update(Number.NaN, frame());
    audio.update(1 / 60, frame());
    audio.update(1 / 60, frame());
    const info = audio.debug();
    expect(Number.isFinite(info.gustSpeed)).toBe(true);
    expect(info.gustSpeed).toBeGreaterThan(0);
    expect(Number.isFinite(info.boats[0]?.doppler)).toBe(true);
    audio.dispose();
  });

  it('keeps the last good listener pose when the camera goes non-finite', async () => {
    const audio = engine(new OfflineContext(48_000));
    await audio.unlock();
    audio.update(1 / 60, frame());
    const bad = frame();
    bad.listener.position.x = Number.NaN;
    audio.update(1 / 60, bad);
    audio.update(1 / 60, frame());
    const info = audio.debug();
    expect(Number.isFinite(info.boats[0]?.distance)).toBe(true);
    expect(Number.isFinite(info.boats[0]?.doppler)).toBe(true);
    audio.dispose();
  });

  it('reset() silences every boat and the next frame brings them back', async () => {
    const audio = engine(new OfflineContext(48_000));
    await audio.unlock();
    audio.update(1 / 60, frame([boat('a'), boat('b')]));
    expect(audio.debug().boats).toHaveLength(2);
    audio.reset();
    expect(audio.debug().boats).toHaveLength(0);
    audio.update(1 / 60, frame([boat('a')]));
    expect(audio.debug().boats.map((b) => b.id)).toEqual(['a']);
    audio.dispose();
  });
});

describe('AudioEngine.unlock', () => {
  it('asks the context to resume again on a later gesture while an earlier resume is pending', async () => {
    const ctx = new OfflineContext(48_000);
    let calls = 0;
    ctx.resume = (): Promise<void> => {
      calls++;
      // Blocked while there is no activation: the unlock's own resume and applySettings' retry.
      if (calls <= 2) return new Promise<void>(() => undefined);
      ctx.state = 'running';
      return Promise.resolve();
    };
    const audio = engine(ctx);
    const first = audio.unlock();
    expect(audio.state).toBe('suspended');
    const second = audio.unlock();
    expect(second).toBe(first);
    expect(calls).toBe(3);
    expect(audio.state).toBe('running');
    audio.dispose();
  });

  it('closes the context it made if building the graph throws, and can unlock again later', async () => {
    const broken = new OfflineContext(48_000);
    broken.createDynamicsCompressor = (): never => {
      throw new Error('no compressor');
    };
    let closed = false;
    broken.close = (): Promise<void> => {
      closed = true;
      return Promise.resolve();
    };
    const good = new OfflineContext(48_000);
    const contexts = [broken, good];
    installGlobals();
    const audio = new AudioEngine({
      settings: SETTINGS,
      panningModel: 'equalpower',
      unlockTarget: null,
      createContext: () => contexts.shift() as never,
    });
    expect(() => audio.unlock()).toThrow('no compressor');
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(true);
    expect(audio.state).toBe('locked');
    await expect(audio.unlock()).resolves.toBe(true);
    audio.dispose();
  });
});

describe('OneShotPlayer parameter guards', () => {
  it('plays at rate 1, unfiltered and centred when given non-finite values', () => {
    installGlobals();
    const ctx = new OfflineContext(48_000);
    const player = new OneShotPlayer(ctx as never, ctx.destination as never, 2, false);
    const buffer = ctx.createBuffer(1, 4800, 48_000);
    expect(
      player.play(buffer as never, {
        gain: 1,
        rate: Number.NaN,
        cutoff: Number.NaN,
        pan: Number.NaN,
        when: Number.NaN,
      }),
    ).toBe(true);
    expect(player.play(buffer as never, { gain: 1, rate: 0 })).toBe(true);
    const rates = [...ctx.sources].map(
      (s) => (s as unknown as { playbackRate: { value: number } }).playbackRate.value,
    );
    expect(rates).toEqual([1, 1]);
  });
});
