// The hydroplane's voice (src/audio/TurbineSynth.ts and BoatVoice's spray layers) rendered offline:
// a fleet hydroplane passing 12 m from the listener at 200 mph, engine and rooster tail audible and
// finite, well clear of full scale, and its pitch dropping by about a fourth as it goes by.

import { describe, expect, it } from 'vite-plus/test';

import { AudioEngine } from '../../src/audio/AudioEngine';
import type { AudioFrame, BoatAudioState } from '../../src/audio/types';
import { installGlobals, type OfflineNode, OfflineContext } from './offlineWebAudio';

describe('hydroplane voice', () => {
  it('passes at 200 mph: loud, finite, below full scale, and its Doppler drops a fourth', async () => {
    installGlobals();
    const ctx = new OfflineContext(48_000);
    const audio = new AudioEngine({
      settings: { master: 1, ambience: 1, effects: 1, engines: 1, muteWhenHidden: false },
      panningModel: 'equalpower',
      unlockTarget: null,
      createContext: () => ctx as never,
    });
    await audio.unlock();
    const graph = (audio as unknown as { graph: Record<string, OfflineNode> }).graph;
    const speed = 89;
    const boat: BoatAudioState = {
      id: 'h',
      kind: 'hydro',
      position: { x: 0, y: 0.5, z: 0 },
      velocity: { x: 0, y: 0, z: -speed },
      rpm: 9500,
      load: 1,
      speedThroughWater: speed,
      airborne: 0,
      turbine: { n1: 1, power: 1, turbineRpm: 16_000, propRpm: 9500, thrust: 15_000, propEmersion: 0.5 },
    };
    const frame: AudioFrame = {
      listener: { position: { x: 12, y: 2, z: 0 }, forward: { x: -1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } },
      wind: { speed: 0 },
      sea: { hs: 0.2 },
      boats: [boat],
    };
    const fps = 60;
    const seconds = 4; // passes at 2 s
    let peak = 0;
    const energy = { engines: 0, effects: 0 };
    let approaching = 0;
    let receding = 0;
    let written = 0;
    for (let f = 0; f < seconds * fps; f++) {
      const t = f / fps;
      boat.position.z = speed * (2 - t);
      audio.update(1 / fps, frame);
      const until = Math.round(((f + 1) / fps) * 48_000);
      while (written < until) {
        const out = ctx.renderQuantum();
        const q = ctx.renderedQuantum;
        for (const ch of out) for (const v of ch) peak = Math.max(peak, Math.abs(v));
        for (const bus of ['engines', 'effects'] as const) {
          for (const ch of graph[`${bus}Bus`]!.output(q)) for (const v of ch) energy[bus] += v * v;
        }
        written += 128;
      }
      const d = audio.debug().boats[0]?.doppler ?? 1;
      if (t > 1 && t < 1.6) approaching = Math.max(approaching, d);
      if (t > 2.6 && t < 3.2) receding = Math.max(receding, 1 / d);
    }
    expect(Number.isFinite(peak)).toBe(true);
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(0.7);
    expect(energy.engines).toBeGreaterThan(0);
    expect(energy.effects).toBeGreaterThan(0);
    // c / (c − v) approaching, c / (c + v) receding: 1.35 and 0.79 for 89 m/s nearly head-on.
    expect(approaching).toBeGreaterThan(1.25);
    expect(receding).toBeGreaterThan(1.2);
    const info = audio.debug().boats[0]!;
    expect(info.f0).toBeGreaterThan(3000); // the compressor whine, spooled up
    expect(info.boost).toBeCloseTo(1);
    audio.dispose();
  });
});
