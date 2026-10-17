// Engine synthesis from RPM and load, one voice per boat. The firing note comes from a pre-rendered
// loop of engine cycles (engineLoops.ts: exhaust pulses under load and at closed throttle, plus the
// combustion and valve-train envelopes, in one multichannel buffer) played at playbackRate =
// rpm / root rpm, one source per engine unit. Live nodes add what doesn't scale with rpm:
//   firing note: load cross-fade → low-pass tracking f0 and effort → fixed exhaust resonances
//   combustion/intake noise and valve tick: band-passed noise gated by the loop's envelopes
//   whines (turbo spooling behind the throttle, supercharger, gears), pod-motor and mains hum, and
//   the jet pump's roar and hiss
// Each unit's speed wanders a little (idle hunting, twin engines drifting apart), and the
// crank-driven whines wander with it.

import type { Rng } from '../sim/core/rng';
import type { BoatKind } from '../sim/world/protocol';
import {
  createEngineParams,
  type EngineParams,
  engineParams,
  type EngineProfile,
  lagToward,
} from './boatProfiles';
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

const UNIT_PHASE = 0.37; // units start this far apart in the loop, so their firings never coincide
const WOBBLE_TAU = 0.5; // s, correlation time of the speed wander
const WOBBLE_FLOOR = 0.0015; // no governor holds speed exactly, even at full power
// Band-passed white noise keeps only a few percent of its power; this brings the noise layers'
// profile gains to the same scale as the firing note's.
export const NOISE_TRIM = 10;

interface Whine {
  osc: OscillatorNode;
  gain: GainNode;
  locked: boolean; // driven by the crank (supercharger, gears), so it follows the speed wander
}

export class EngineSynth {
  readonly params: EngineParams = createEngineParams();
  private readonly ctx: BaseAudioContext;
  private readonly profile: EngineProfile;
  private readonly output: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly rng: Rng;
  private readonly rootRpm: number;
  private readonly units: AudioBufferSourceNode[] = [];
  private readonly wobble: number[] = [];
  private readonly spool: number;
  private boost = 0;

  private readonly onGain: GainNode;
  private readonly offGain: GainNode;
  private readonly toneFilter: BiquadFilterNode;
  private readonly toneGain: GainNode;
  private readonly combustionBand: BiquadFilterNode;
  private readonly combustionGain: GainNode;
  private readonly tickGain: GainNode | null = null;
  private readonly whines: Whine[] = [];
  private readonly motor: OscillatorNode | null = null;
  private readonly motorGain: GainNode | null = null;
  private readonly humGain: GainNode | null = null;
  private readonly pumpBand: BiquadFilterNode | null = null;
  private readonly pumpGain: GainNode | null = null;
  private readonly hissGain: GainNode | null = null;
  private readonly burble: GainNode | null = null;
  private readonly burbleDepth: GainNode | null = null;
  private readonly burbleLfo: OscillatorNode | null = null;

  constructor(
    ctx: BaseAudioContext,
    kit: SoundKit,
    kind: BoatKind,
    profile: EngineProfile,
    destination: AudioNode,
    rng: Rng,
  ) {
    this.ctx = ctx;
    this.profile = profile;
    this.rng = rng;
    this.output = gainNode(ctx, 0);
    this.output.connect(destination);
    this.spool = profile.whines.find((w) => w.kind === 'turbo')?.spool ?? 0;

    let out: AudioNode = this.output;
    if (profile.pump) {
      // Jet drive: a burble stage the airborne LFO can chop.
      this.burble = gainNode(ctx, 1);
      this.burble.connect(this.output);
      this.burbleDepth = gainNode(ctx, 0);
      this.burbleLfo = startOscillator(ctx, 'square', 13, this.burbleDepth);
      this.burbleDepth.connect(this.burble.gain);
      this.sources.push(this.burbleLfo);
      out = this.burble;
    }

    // The firing loop: every unit's source into one mix, split into its channels.
    const loop = kit.engineLoop(kind, profile);
    this.rootRpm = loop.rootRpm;
    const channels = loop.buffer.numberOfChannels;
    const mix = gainNode(ctx, 1 / Math.sqrt(profile.units));
    mix.channelInterpretation = 'discrete';
    const split = ctx.createChannelSplitter(channels);
    mix.connect(split);
    const phase = rng.next();
    for (let u = 0; u < profile.units; u++) {
      const source = startLoop(ctx, loop.buffer, rng, mix, undefined, phase + u * UNIT_PHASE);
      source.playbackRate.value = 0;
      this.units.push(source);
      this.sources.push(source);
      this.wobble.push(0);
    }

    // Firing note: working and closed-throttle pulses cross-faded, low-passed, through the exhaust.
    this.onGain = gainNode(ctx, 0);
    this.offGain = gainNode(ctx, 0);
    split.connect(this.onGain, 0);
    split.connect(this.offGain, 1);
    this.toneFilter = filterNode(ctx, 'lowpass', 200, 0.9);
    this.onGain.connect(this.toneFilter);
    this.offGain.connect(this.toneFilter);
    let tone: AudioNode = this.toneFilter;
    for (const f of profile.formants) {
      const peak = filterNode(ctx, 'peaking', f.hz, f.q);
      peak.gain.value = f.db;
      tone = tone.connect(peak);
    }
    this.toneGain = gainNode(ctx, 0);
    tone.connect(this.toneGain).connect(out);

    // Noise layers share one source. Combustion: gain = (1 − depth) + depth · envelope.
    const noise = gainNode(ctx, NOISE_TRIM);
    this.sources.push(startLoop(ctx, kit.white, rng, noise));
    const c = profile.combustion;
    this.combustionBand = filterNode(ctx, 'bandpass', c.center, c.q);
    const gate = gainNode(ctx, 1 - c.depth);
    const depth = gainNode(ctx, c.depth);
    split.connect(depth, 2);
    depth.connect(gate.gain);
    this.combustionGain = gainNode(ctx, 0);
    noise.connect(this.combustionBand).connect(gate).connect(this.combustionGain).connect(out);

    if (profile.tick && channels > 3) {
      const tickGate = gainNode(ctx, 0);
      split.connect(tickGate.gain, 3);
      this.tickGain = gainNode(ctx, 0);
      noise
        .connect(filterNode(ctx, 'bandpass', profile.tick.center, 0.8))
        .connect(tickGate)
        .connect(this.tickGain)
        .connect(out);
    }

    for (const w of profile.whines) {
      const real = new Float32Array(w.partials.length + 1);
      const imag = Float32Array.from([0, ...w.partials]);
      const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
      const gain = gainNode(ctx, 0);
      const osc = startOscillator(ctx, wave, w.hz * 0.25, gain);
      gain.connect(out);
      this.sources.push(osc);
      this.whines.push({ osc, gain, locked: w.kind !== 'turbo' });
    }
    if (profile.motorHum) {
      this.motorGain = gainNode(ctx, 0);
      this.motor = startOscillator(ctx, 'triangle', 100, this.motorGain);
      this.motorGain.connect(out);
      this.sources.push(this.motor);
    }
    if (profile.hum) {
      this.humGain = gainNode(ctx, 0);
      const hum = startOscillator(ctx, 'sawtooth', profile.hum.hz, this.humGain);
      this.humGain.connect(filterNode(ctx, 'lowpass', profile.hum.hz * 5)).connect(out);
      this.sources.push(hum);
    }
    if (profile.pump) {
      this.pumpBand = filterNode(ctx, 'bandpass', profile.pump.center[0], 0.7);
      this.pumpGain = gainNode(ctx, 0);
      noise.connect(this.pumpBand).connect(this.pumpGain).connect(out);
      this.hissGain = gainNode(ctx, 0);
      noise
        .connect(filterNode(ctx, 'highpass', profile.pump.cutoff, 0.6))
        .connect(this.hissGain)
        .connect(out);
    }
  }

  // dt: s since the last update; doppler: pitch factor for this source and the listener; level:
  // extra gain (0 when culled).
  update(dt: number, rpm: number, load: number, airborne: number, doppler: number, level: number): void {
    const now = this.ctx.currentTime;
    const profile = this.profile;
    const p = engineParams(profile, rpm, load, airborne, this.params, this.boost);
    this.boost = lagToward(this.boost, p.boostTarget, dt, this.spool);
    ramp(this.output.gain, p.gain * level, now, TAU);

    // Speed wander: an Ornstein–Uhlenbeck walk per unit, wider at idle where governors hunt.
    const idle = 1 - p.rpmNorm;
    const sigma = profile.wobble * idle * idle + WOBBLE_FLOOR;
    const keep = Math.exp(-Math.max(0, dt) / WOBBLE_TAU);
    const kick = sigma * Math.sqrt(1 - keep * keep);
    const base = p.shaftRpm / this.rootRpm;
    for (let u = 0; u < this.units.length; u++) {
      // Generator sets on one switchboard are locked together; separate engines wander apart.
      const free = u === 0 || profile.detune > 0;
      const w = (this.wobble[u] = free
        ? (this.wobble[u] ?? 0) * keep + kick * this.rng.gaussian()
        : (this.wobble[0] ?? 0));
      const rate = Math.max(0.02, base * (1 + u * profile.detune) * (1 + w));
      const source = this.units[u];
      if (source) ramp(source.playbackRate, rate * doppler, now, TAU_FAST);
    }
    const crank = 1 + (this.wobble[0] ?? 0);

    ramp(this.onGain.gain, p.onLoad, now, TAU);
    ramp(this.offGain.gain, 1 - p.onLoad, now, TAU);
    ramp(this.toneFilter.frequency, p.cutoff * doppler, now, TAU);
    ramp(this.toneGain.gain, p.toneGain, now, TAU);
    ramp(this.combustionBand.frequency, p.combustionCenter, now, TAU);
    ramp(this.combustionGain.gain, p.combustionGain, now, TAU);
    if (this.tickGain) ramp(this.tickGain.gain, p.tickGain, now, TAU);
    this.whines.forEach((w, i) => {
      const f = (p.whineFreq[i] ?? 100) * (w.locked ? crank : 1);
      ramp(w.osc.frequency, f * doppler, now, TAU);
      ramp(w.gain.gain, p.whineGain[i] ?? 0, now, TAU);
    });
    if (this.motor && this.motorGain) {
      ramp(this.motor.frequency, p.motorFreq * doppler, now, TAU);
      ramp(this.motorGain.gain, p.motorGain, now, TAU);
    }
    if (this.humGain) ramp(this.humGain.gain, p.humGain, now, TAU);
    if (this.pumpBand && this.pumpGain && this.hissGain) {
      ramp(this.pumpBand.frequency, p.pumpCenter, now, TAU);
      ramp(this.pumpGain.gain, p.pumpGain, now, TAU);
      ramp(this.hissGain.gain, p.hissGain, now, TAU);
    }
    if (this.burble && this.burbleDepth && this.burbleLfo) {
      // Out of the water the note chops irregularly as the pump sucks air.
      ramp(this.burble.gain, 1 - 0.45 * p.burble, now, TAU_FAST);
      ramp(this.burbleDepth.gain, 0.45 * p.burble, now, TAU_FAST);
      ramp(this.burbleLfo.frequency, this.rng.range(9, 18), now, TAU);
    }
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.02);
    for (const source of this.sources) source.stop(now + 0.1);
    setTimeout(() => this.output.disconnect(), 200);
  }
}
