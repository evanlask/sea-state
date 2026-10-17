// The offline Web Audio emulation behind scripts/audio-levels.ts: levels through the node types
// the measurements rely on.

import { describe, expect, it } from 'vite-plus/test';

import { type OfflineNode, OfflineContext, QUANTUM } from './offlineWebAudio';

// Mean power in dB per channel of each node after a second of settling.
function powers(
  ctx: OfflineContext,
  nodes: Record<string, OfflineNode>,
  quanta = 1500,
): Record<string, number> {
  const sums: Record<string, number> = Object.fromEntries(Object.keys(nodes).map((k) => [k, 0]));
  let n = 0;
  for (let q = 0; q < quanta; q++) {
    ctx.renderQuantum();
    if (q < 400) continue;
    for (const [key, node] of Object.entries(nodes)) {
      const channels = node.output(ctx.renderedQuantum);
      for (const ch of channels) for (const v of ch) sums[key]! += (v * v) / channels.length;
    }
    n += QUANTUM;
  }
  return Object.fromEntries(Object.entries(sums).map(([k, s]) => [k, 10 * Math.log10(s / n)]));
}

describe('offline Web Audio', () => {
  it('renders a sine through gains, biquads and an inverse-distance panner at the spec levels', () => {
    const ctx = new OfflineContext(48_000);
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    osc.start();
    const lowpass = ctx.createBiquadFilter();
    lowpass.frequency.value = 1000;
    lowpass.Q.value = 0.707; // dB for low-pass filters: +0.71 dB at the cutoff
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1000;
    bandpass.Q.value = 4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.5, 0, 0.05);
    const panner = ctx.createPanner();
    panner.refDistance = 5;
    panner.positionZ.value = -10; // straight ahead, twice the reference distance
    for (const node of [lowpass, bandpass, gain, panner]) osc.connect(node).connect(ctx.destination);
    const p = powers(ctx, { osc, lowpass, bandpass, gain, panner });
    expect(p['osc']).toBeCloseTo(-3.01, 1);
    expect(p['lowpass']).toBeCloseTo(-2.3, 1);
    expect(p['bandpass']).toBeCloseTo(-3.01, 1);
    expect(p['gain']).toBeCloseTo(-9.03, 1);
    // −6 dB of distance, and the equal-power split puts half the power in each channel.
    expect(p['panner']).toBeCloseTo(-12.04, 1);
  });

  it('loops a buffer and ends one-shots', () => {
    const ctx = new OfflineContext(48_000);
    const buffer = ctx.createBuffer(1, 480, 48_000);
    buffer.getChannelData(0).fill(0.5);
    const loop = ctx.createBufferSource();
    loop.buffer = buffer;
    loop.loop = true;
    loop.start();
    const shot = ctx.createBufferSource();
    shot.buffer = buffer;
    let ended = false;
    shot.onended = () => {
      ended = true;
    };
    shot.start();
    loop.connect(ctx.destination);
    shot.connect(ctx.destination);
    const p = powers(ctx, { loop, shot }, 500);
    expect(p['loop']).toBeCloseTo(20 * Math.log10(0.5), 3);
    expect(p['shot']).toBe(-Infinity);
    expect(ended).toBe(true);
  });
});
