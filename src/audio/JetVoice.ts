// The distant jet rumble: low-passed pink noise with a little low-mid body, swelling and fading
// slowly as the sound path through the turbulent air changes, panned toward where the aircraft was
// when the sound left it (jetPlan.ts). Started only while a jet is audible.

import { Rng } from '../sim/core/rng';
import { filterNode, gainNode, ramp, type SoundKit, startLoop, TAU_SLOW } from './graph';
import type { JetHearing } from './jetPlan';

const SWELL_TAU = 1.5; // s
const STOP_AFTER = 4; // s of silence before the source stops

export class JetVoice {
  private readonly ctx: BaseAudioContext;
  private readonly kit: SoundKit;
  private readonly rng: Rng;
  private readonly input: BiquadFilterNode;
  private readonly lowpass: BiquadFilterNode;
  private readonly lowpass2: BiquadFilterNode;
  private readonly swell: GainNode;
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode;
  private source: AudioBufferSourceNode | null = null;
  private silent = 0;
  private swellTimer = 0;
  level = 0; // last target gain (debug)

  constructor(ctx: BaseAudioContext, kit: SoundKit, destination: AudioNode, seed: number) {
    this.ctx = ctx;
    this.kit = kit;
    this.rng = new Rng(seed);
    this.input = filterNode(ctx, 'highpass', 45, 0.6);
    const body = ctx.createBiquadFilter();
    body.type = 'peaking';
    body.frequency.value = 140;
    body.Q.value = 0.8;
    body.gain.value = 4;
    this.lowpass = filterNode(ctx, 'lowpass', 300, 0.6);
    this.lowpass2 = filterNode(ctx, 'lowpass', 300, 0.6);
    this.swell = gainNode(ctx, 1);
    this.gain = gainNode(ctx, 0);
    this.pan = ctx.createStereoPanner();
    this.input
      .connect(body)
      .connect(this.lowpass)
      .connect(this.lowpass2)
      .connect(this.swell)
      .connect(this.gain)
      .connect(this.pan)
      .connect(destination);
  }

  update(dt: number, jet: JetHearing | null): void {
    const now = this.ctx.currentTime;
    const target = jet?.gain ?? 0;
    this.level = target;
    if (target > 1e-5) {
      this.silent = 0;
      if (!this.source) {
        this.source = startLoop(this.ctx, this.kit.pinkMono, this.rng, this.input);
        this.source.playbackRate.value = 0.7; // deeper, and hides the loop length
      }
    } else if (this.source) {
      this.silent += dt;
      if (this.silent > STOP_AFTER) {
        this.source.stop();
        this.source.disconnect();
        this.source = null;
      }
    }
    ramp(this.gain.gain, target, now, TAU_SLOW * 3);
    if (!jet) return;
    ramp(this.lowpass.frequency, jet.cutoff, now, TAU_SLOW);
    ramp(this.lowpass2.frequency, jet.cutoff, now, TAU_SLOW);
    ramp(this.pan.pan, jet.pan, now, TAU_SLOW);
    // The slow swell of sound through turbulent air: a new level every few seconds.
    this.swellTimer -= dt;
    if (this.swellTimer <= 0) {
      this.swellTimer = this.rng.range(2, 5);
      ramp(this.swell.gain, this.rng.range(0.5, 1.3), now, SWELL_TAU);
    }
  }

  dispose(): void {
    this.source?.stop();
    this.source?.disconnect();
    this.source = null;
    this.pan.disconnect();
  }
}
