// The hydroplane's gas turbine (turbine.ts has the sounds and their curves), one voice per boat:
//
//   compressor whine: two periodic tones on N1, a shadow tone a few cents off the first (the beat
//                     that makes a turbine shimmer), gently amplitude-wobbled
//   power turbine:    a periodic tone on the free turbine's rpm
//   exhaust roar:     band-passed white noise, its centre rising with spool; hiss: high-passed noise
//   rumble:           low-passed pink noise; blade buzz: a sawtooth at blade rate through a band-pass
//
// Tones and filter centres take the Doppler factor, so a boat passing at 90 m/s drops a fourth.

import type { Rng } from '../sim/core/rng';
import { NOISE_TRIM } from './EngineSynth';
import {
  filterNode,
  gainNode,
  ramp,
  type SoundKit,
  startLoop,
  startOscillator,
  TAU,
  TAU_FAST,
} from './graph';
import {
  createTurbineParams,
  type TurbineInput,
  type TurbineParams,
  turbineParams,
  type TurbineProfile,
} from './turbine';

const WOBBLE_HZ = 5.7; // the whine's slow amplitude wobble
const WOBBLE_DEPTH = 0.12;

const periodicWave = (ctx: BaseAudioContext, partials: readonly number[]): PeriodicWave =>
  ctx.createPeriodicWave(new Float32Array(partials.length + 1), Float32Array.from([0, ...partials]), {
    disableNormalization: true,
  });

export class TurbineSynth {
  readonly params: TurbineParams = createTurbineParams();
  private readonly ctx: BaseAudioContext;
  private readonly profile: TurbineProfile;
  private readonly output: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly compressor: OscillatorNode[] = [];
  private readonly compressorGain: GainNode[] = [];
  private readonly shadow: OscillatorNode;
  private readonly turbine: OscillatorNode;
  private readonly turbineGain: GainNode;
  private readonly roarBand: BiquadFilterNode;
  private readonly roarGain: GainNode;
  private readonly hissGain: GainNode;
  private readonly rumbleGain: GainNode;
  private readonly blade: OscillatorNode;
  private readonly bladeBand: BiquadFilterNode;
  private readonly bladeGain: GainNode;

  constructor(
    ctx: BaseAudioContext,
    kit: SoundKit,
    profile: TurbineProfile,
    destination: AudioNode,
    rng: Rng,
  ) {
    this.ctx = ctx;
    this.profile = profile;
    this.output = gainNode(ctx, 0);
    this.output.connect(destination);

    // Compressor whine, through a wobbling gain.
    const whine = gainNode(ctx, 1 - WOBBLE_DEPTH);
    whine.connect(this.output);
    const wobble = gainNode(ctx, WOBBLE_DEPTH);
    wobble.connect(whine.gain);
    this.sources.push(startOscillator(ctx, 'sine', WOBBLE_HZ * rng.range(0.9, 1.1), wobble));
    const wave = periodicWave(ctx, profile.compressor.partials);
    for (let i = 0; i < 2; i++) {
      const gain = gainNode(ctx, 0);
      gain.connect(whine);
      const osc = startOscillator(ctx, wave, profile.compressor.hz[i] ?? 1000, gain);
      this.compressor.push(osc);
      this.compressorGain.push(gain);
      this.sources.push(osc);
    }
    // The shadow of the first stage's tone, sharing its gain.
    const first = this.compressorGain[0] as GainNode;
    const shadowTrim = gainNode(ctx, 0.5);
    shadowTrim.connect(first);
    this.shadow = startOscillator(ctx, 'sine', profile.compressor.hz[0], shadowTrim);
    this.sources.push(this.shadow);

    this.turbineGain = gainNode(ctx, 0);
    this.turbine = startOscillator(
      ctx,
      periodicWave(ctx, profile.powerTurbine.partials),
      profile.powerTurbine.hzAtRated,
      this.turbineGain,
    );
    this.turbineGain.connect(this.output);
    this.sources.push(this.turbine);

    // Noise layers.
    const white = gainNode(ctx, NOISE_TRIM);
    this.sources.push(startLoop(ctx, kit.white, rng, white));
    this.roarBand = filterNode(ctx, 'bandpass', profile.roar.center[0], profile.roar.q);
    this.roarGain = gainNode(ctx, 0);
    white.connect(this.roarBand).connect(this.roarGain).connect(this.output);
    this.hissGain = gainNode(ctx, 0);
    white
      .connect(filterNode(ctx, 'highpass', profile.hiss.cutoff, 0.6))
      .connect(this.hissGain)
      .connect(this.output);
    const pink = startLoop(ctx, kit.pinkMono, rng);
    this.sources.push(pink);
    this.rumbleGain = gainNode(ctx, 0);
    pink
      .connect(filterNode(ctx, 'lowpass', profile.rumble.cutoff, 0.8))
      .connect(this.rumbleGain)
      .connect(this.output);

    this.bladeGain = gainNode(ctx, 0);
    this.bladeBand = filterNode(ctx, 'bandpass', 800, profile.blades.q);
    this.blade = startOscillator(ctx, 'sawtooth', 100, this.bladeBand);
    this.bladeBand.connect(this.bladeGain).connect(this.output);
    this.sources.push(this.blade);
  }

  // dt: s since the last update (unused: the spool lag is the sim's); doppler: pitch factor for this
  // source and the listener; level: extra gain (0 when culled).
  update(_dt: number, input: TurbineInput, doppler: number, level: number): void {
    const now = this.ctx.currentTime;
    const p = turbineParams(this.profile, input, this.params);
    ramp(this.output.gain, p.gain * level, now, TAU);
    for (let i = 0; i < 2; i++) {
      const osc = this.compressor[i];
      const gain = this.compressorGain[i];
      if (osc) ramp(osc.frequency, p.compressorFreq[i]! * doppler, now, TAU_FAST);
      if (gain) ramp(gain.gain, p.compressorGain[i]!, now, TAU);
    }
    ramp(
      this.shadow.frequency,
      p.compressorFreq[0] * (1 + this.profile.compressor.beat) * doppler,
      now,
      TAU_FAST,
    );
    ramp(this.turbine.frequency, p.turbineFreq * doppler, now, TAU_FAST);
    ramp(this.turbineGain.gain, p.turbineGain, now, TAU);
    ramp(this.roarBand.frequency, p.roarCenter * doppler, now, TAU);
    ramp(this.roarGain.gain, p.roarGain, now, TAU);
    ramp(this.hissGain.gain, p.hissGain, now, TAU);
    ramp(this.rumbleGain.gain, p.rumbleGain, now, TAU);
    ramp(this.blade.frequency, p.bladeFreq * doppler, now, TAU_FAST);
    ramp(this.bladeBand.frequency, Math.min(8000, 2.5 * p.bladeFreq * doppler), now, TAU);
    ramp(this.bladeGain.gain, p.bladeGain, now, TAU);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.02);
    for (const source of this.sources) source.stop(now + 0.1);
    setTimeout(() => this.output.disconnect(), 200);
  }
}
