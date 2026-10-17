import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../sim/core/rng';
import { BedLayer } from './Ambience';
import type { KitLoop } from './graph';

// Just enough of Web Audio for a bed layer's wiring.
class FakeParam {
  value: number;
  target: number | undefined;
  constructor(value = 0) {
    this.value = value;
  }
  setTargetAtTime(value: number): this {
    this.target = value;
    return this;
  }
}

class FakeNode {
  connections: unknown[][] = [];
  connect(destination: unknown, ...indices: number[]): unknown {
    this.connections.push([destination, ...indices]);
    return destination;
  }
  disconnect(): void {
    this.connections = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  offset: number | undefined;
  stoppedAt: number | undefined;
  onended: (() => void) | null = null;
  start(_when: number, offset: number): void {
    this.offset = offset;
  }
  stop(when: number): void {
    this.stoppedAt = when;
  }
}

class FakeContext {
  currentTime = 0;
  sources: FakeSource[] = [];
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createChannelMerger(): FakeNode {
    return new FakeNode();
  }
}

const buffer = (duration: number, channels: number): AudioBuffer =>
  ({ duration, numberOfChannels: channels }) as unknown as AudioBuffer;

function setup(under = 0) {
  const ctx = new FakeContext();
  const layer = new BedLayer(
    ctx as unknown as BaseAudioContext,
    buffer(7, 2),
    new Rng(1),
    'bandpass',
    700,
    0.6,
    new FakeGain() as unknown as AudioNode,
    under,
  );
  // The private faders, to check where the cross-fades are heading.
  const mix = layer as unknown as { synthGain: FakeGain; recording: { fade: FakeGain } | null };
  return { ctx, layer, mix };
}

describe('BedLayer', () => {
  it('starts on its noise', () => {
    const { ctx, layer } = setup();
    expect(ctx.sources).toHaveLength(1);
    expect(layer.recorded).toBe(false);
    expect(layer.filter.type).toBe('bandpass');
  });

  it('cross-fades to a mono recording played wide, inside its loop points', () => {
    const { ctx, layer, mix } = setup(0.6);
    const loop: KitLoop = { buffer: buffer(20.5, 1), gain: 1.3, region: { start: 0.25, end: 20.25 } };
    layer.setRecording(loop);
    const [left, right] = ctx.sources.slice(1);
    expect(ctx.sources).toHaveLength(3);
    for (const source of [left!, right!]) {
      expect(source).toMatchObject({ loop: true, loopStart: 0.25, loopEnd: 20.25 });
      expect(source.offset).toBeGreaterThanOrEqual(0.25);
      expect(source.offset).toBeLessThan(20.25);
    }
    // Half a loop apart, one per side of a stereo merge.
    expect((((right!.offset! - left!.offset!) % 20) + 20) % 20).toBeCloseTo(10, 6);
    expect(left!.connections[0]?.slice(1)).toEqual([0, 0]);
    expect(right!.connections[0]?.slice(1)).toEqual([0, 1]);
    expect(mix.synthGain.gain.target).toBe(0.6);
    expect(mix.recording?.fade.gain).toMatchObject({ value: 0, target: 1.3 });
    expect(layer.recorded).toBe(true);

    layer.setRecording(loop);
    expect(ctx.sources).toHaveLength(3); // same recording: nothing restarts
  });

  it('fades a replaced recording out while the new one fades in', () => {
    const { ctx, layer, mix } = setup();
    layer.setRecording({ buffer: buffer(10, 2), gain: 0.8 });
    const first = mix.recording!.fade;
    layer.setRecording({ buffer: buffer(12, 2), gain: 0.5 });
    expect(ctx.sources[1]!.stoppedAt).toBeGreaterThan(0);
    expect(first.gain.target).toBe(0);
    expect(mix.recording?.fade.gain.target).toBe(0.5);
  });

  it('plays a stereo recording as one source and fades back to the noise', () => {
    const { ctx, layer, mix } = setup();
    layer.setRecording({ buffer: buffer(10, 2), gain: 0.8 });
    expect(ctx.sources).toHaveLength(2);
    const fade = mix.recording!.fade;
    layer.setRecording(null);
    expect(ctx.sources[1]!.stoppedAt).toBeGreaterThan(0);
    expect(fade.gain.target).toBe(0);
    expect(mix.synthGain.gain.target).toBe(1);
    expect(layer.recorded).toBe(false);
  });
});
