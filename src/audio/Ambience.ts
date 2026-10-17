// Ambience: wind (rush, howl, storm whistle, gusts), the sea bed (calm lapping → open wash → storm
// roar, plus breaking-crest and lap one-shots around the listener), rain (deck vs water flavours)
// and the dry interior/underwater beds. Every parameter comes from curves.ts and is ramped with
// setTargetAtTime; nothing is created per frame except one-shot sources. The sea and rain beds can
// play field recordings in place of their noise (setRecorded); the one-shots, drops, howl and
// whistle stay synthesized and layer on top.

import { Rng } from '../sim/core/rng';
import {
  clamp,
  createRainParams,
  createSeaParams,
  createWindParams,
  type EnvironmentParams,
  poissonChance,
  type RainParams,
  rainParams,
  type SeaParams,
  seaParams,
  type WindParams,
  windParams,
} from './curves';
import {
  filterNode,
  gainNode,
  type KitLoop,
  type OneShotPlayer,
  ramp,
  type SoundKit,
  startLoop,
  startOscillator,
  TAU,
  TAU_SLOW,
  type LoopId,
} from './graph';
import type { ListenerPose, RainAudio, SeaAudio, WindAudio } from './types';

export interface AmbienceOutputs {
  exterior: GainNode; // muffled by the environment filter (ambience volume)
  dry: GainNode; // heard directly: interior hum, underwater bed (ambience volume)
}

// Seconds for the cross-fade between a bed's noise and its recording.
const SWAP_TAU = 0.25;

// A bed layer: a noise loop through its shaping filter, and, while recordings are on and the bank
// has one, a field recording in its place. Both feed `gain`, which update() drives from the curves,
// so the recording follows sea state and rain like the noise did. The filter only shapes the noise.
export class BedLayer {
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  private readonly ctx: BaseAudioContext;
  private readonly rng: Rng;
  private readonly synthGain: GainNode;
  private readonly under: number;
  // The playing recording: its sources and its own fader (which carries the trim).
  private recording: { loop: KitLoop; sources: AudioBufferSourceNode[]; fade: GainNode } | null = null;

  // `under`: how much of the noise stays under a recording (adds weight a recording lacks).
  constructor(
    ctx: BaseAudioContext,
    synth: AudioBuffer,
    rng: Rng,
    type: BiquadFilterType,
    frequency: number,
    q: number,
    output: AudioNode,
    under = 0,
  ) {
    this.ctx = ctx;
    this.rng = rng;
    this.under = under;
    this.filter = filterNode(ctx, type, frequency, q);
    this.gain = gainNode(ctx, 0);
    this.synthGain = gainNode(ctx, 1);
    startLoop(ctx, synth, rng, this.filter);
    this.filter.connect(this.synthGain).connect(this.gain);
    this.gain.connect(output);
  }

  get recorded(): boolean {
    return this.recording !== null;
  }

  // Cross-fades to the recording (null: back to the noise). Calling again with the same loop is free.
  setRecording(loop: KitLoop | null): void {
    const now = this.ctx.currentTime;
    const old = this.recording;
    if (loop?.buffer === old?.loop.buffer) return;
    if (old) {
      ramp(old.fade.gain, 0, now, SWAP_TAU);
      for (const source of old.sources) source.stop(now + 8 * SWAP_TAU);
    }
    this.recording = loop ? this.startRecording(loop, now) : null;
    ramp(this.synthGain.gain, loop ? this.under : 1, now, SWAP_TAU);
  }

  // A mono recording plays as two reads half a loop apart, one per side: as wide as a stereo
  // recording for diffuse sea and rain, at half the download.
  private startRecording(loop: KitLoop, now: number): NonNullable<BedLayer['recording']> {
    const ctx = this.ctx;
    const fade = gainNode(ctx, 0);
    fade.connect(this.gain);
    ramp(fade.gain, loop.gain, now, SWAP_TAU);
    let sources: AudioBufferSourceNode[];
    if (loop.buffer.numberOfChannels === 1) {
      const merger = ctx.createChannelMerger(2);
      merger.connect(fade);
      const phase = this.rng.next();
      sources = [phase, phase + 0.5].map((p, side) => {
        const source = startLoop(ctx, loop.buffer, this.rng, undefined, loop.region, p);
        source.connect(merger, 0, side);
        return source;
      });
    } else {
      sources = [startLoop(ctx, loop.buffer, this.rng, fade, loop.region)];
    }
    const last = sources[sources.length - 1];
    if (last) last.onended = () => fade.disconnect();
    return { loop, sources, fade };
  }
}

// How much of a bed's noise stays under its recording (recordings.ts sets the trims with this in).
// The storm recording has little below 100 Hz, so the brown-noise rumble keeps the weight.
const NOISE_UNDER_RECORDING: Partial<Record<LoopId, number>> = { 'sea-roar': 0.6 };

export class Ambience {
  readonly wind: WindParams = createWindParams();
  readonly sea: SeaParams = createSeaParams();
  readonly rain: RainParams = createRainParams();
  gustSpeed = 0; // the wind speed actually heard this frame, m/s

  private readonly ctx: BaseAudioContext;
  private readonly kit: SoundKit;
  private readonly oneShots: OneShotPlayer;
  private readonly rng: Rng;

  private readonly rush: BedLayer;
  private readonly rushHighpass: BiquadFilterNode;
  private readonly howl: BiquadFilterNode;
  private readonly howl2: BiquadFilterNode;
  private readonly howlGain: GainNode;
  private readonly howlPan: StereoPannerNode;
  private readonly howlWobble: OscillatorNode;
  private readonly howlWobbleDepth: GainNode;
  private readonly whistle: BiquadFilterNode;
  private readonly whistleGain: GainNode;

  private readonly lapBed: BedLayer;
  private readonly wash: BedLayer;
  private readonly washSwell: GainNode;
  private readonly swellLfo: OscillatorNode;
  private readonly roar: BedLayer;
  private readonly roarSwell: GainNode;
  private readonly roarLfo: OscillatorNode;

  private readonly deckHiss: BedLayer;
  private readonly waterHiss: BedLayer;
  private readonly beds: ReadonlyMap<LoopId, BedLayer>;
  private readonly drops: GainNode[];

  private readonly humGain: GainNode;
  private readonly underwaterGain: GainNode;

  // Gust state: a smoothed random walk in [-0.35, 1] scaled by (gustFactor − 1).
  private gust = 0;
  private gustTarget = 0;
  private gustTimer = 0;

  constructor(
    ctx: BaseAudioContext,
    kit: SoundKit,
    out: AmbienceOutputs,
    oneShots: OneShotPlayer,
    seed: number,
  ) {
    this.ctx = ctx;
    this.kit = kit;
    this.oneShots = oneShots;
    const rng = (this.rng = new Rng(seed));
    const ext = out.exterior;

    // Wind. The rush and howls share one stereo pink loop (different bands, so no comb effects).
    const bed = (
      id: LoopId,
      synth: AudioBuffer,
      type: BiquadFilterType,
      frequency: number,
      q: number,
      output: AudioNode,
    ): BedLayer => new BedLayer(ctx, synth, rng, type, frequency, q, output, NOISE_UNDER_RECORDING[id]);
    this.rushHighpass = filterNode(ctx, 'highpass', 50);
    this.rush = bed('wind', kit.pink, 'lowpass', 400, 0.5, this.rushHighpass);
    this.rushHighpass.connect(ext);
    const howlSource = startLoop(ctx, kit.pink, rng);
    this.howl = filterNode(ctx, 'bandpass', 300, 4);
    this.howl2 = filterNode(ctx, 'bandpass', 440, 5);
    this.howlGain = gainNode(ctx, 0);
    this.howlPan = ctx.createStereoPanner();
    const howl2Trim = gainNode(ctx, 0.5);
    howlSource.connect(this.howl).connect(this.howlGain);
    howlSource.connect(this.howl2).connect(howl2Trim).connect(this.howlGain);
    this.howlGain.connect(this.howlPan).connect(ext);
    // A slow pitch wobble on the howl, like flow eddying around fittings.
    this.howlWobbleDepth = gainNode(ctx, 0);
    this.howlWobble = startOscillator(ctx, 'sine', 0.37, this.howlWobbleDepth);
    this.howlWobbleDepth.connect(this.howl.frequency);
    this.howlWobbleDepth.connect(this.howl2.frequency);
    this.whistle = filterNode(ctx, 'bandpass', 2000, 12);
    this.whistleGain = gainNode(ctx, 0);
    startLoop(ctx, kit.white, rng, this.whistle);
    this.whistle.connect(this.whistleGain).connect(this.howlPan);

    // Sea bed.
    this.lapBed = bed('sea-lap', kit.pink, 'bandpass', 520, 0.9, ext);
    this.washSwell = gainNode(ctx, 0.7);
    this.wash = bed('sea-wash', kit.pink, 'bandpass', 700, 0.6, this.washSwell);
    this.washSwell.connect(ext);
    const swellDepth = gainNode(ctx, 0.3);
    this.swellLfo = startOscillator(ctx, 'sine', 0.12, swellDepth);
    swellDepth.connect(this.washSwell.gain);
    this.roarSwell = gainNode(ctx, 0.8);
    this.roar = bed('sea-roar', kit.brown, 'lowpass', 250, 0.7, this.roarSwell);
    this.roarSwell.connect(ext);
    const roarDepth = gainNode(ctx, 0.2);
    this.roarLfo = startOscillator(ctx, 'sine', 0.07, roarDepth);
    roarDepth.connect(this.roarSwell.gain);

    // Rain: a hiss per flavour plus sparse and dense drop loops per flavour.
    this.deckHiss = bed('rain-deck', kit.white, 'bandpass', 3800, 0.5, ext);
    this.waterHiss = bed('rain-water', kit.pink, 'highpass', 1400, 0.6, ext);
    this.beds = new Map([
      ['wind', this.rush],
      ['sea-lap', this.lapBed],
      ['sea-wash', this.wash],
      ['sea-roar', this.roar],
      ['rain-deck', this.deckHiss],
      ['rain-water', this.waterHiss],
    ]);
    const d = kit.drops;
    this.drops = [d.deckSparse, d.deckDense, d.waterSparse, d.waterDense].map((buffer) => {
      const gain = gainNode(ctx, 0);
      startLoop(ctx, buffer, rng, gain);
      gain.connect(ext);
      return gain;
    });

    // Dry beds: machinery hum inside a closed bridge, and the low rumble under water.
    this.humGain = gainNode(ctx, 0);
    const humLowpass = filterNode(ctx, 'lowpass', 140, 0.9);
    startLoop(ctx, kit.brown, rng, humLowpass);
    const mains = gainNode(ctx, 0.08);
    startOscillator(ctx, 'sawtooth', 60, mains);
    mains.connect(filterNode(ctx, 'lowpass', 260)).connect(this.humGain);
    humLowpass.connect(this.humGain).connect(out.dry);
    this.underwaterGain = gainNode(ctx, 0);
    const underLowpass = filterNode(ctx, 'lowpass', 220, 1.2);
    startLoop(ctx, kit.brown, rng, underLowpass);
    underLowpass.connect(this.underwaterGain).connect(out.dry);
  }

  // Recordings on: each bed with a recording in the bank cross-fades to it (call again after the
  // bank loads more). Off: every bed back to its noise.
  setRecorded(enabled: boolean): void {
    for (const [id, layer] of this.beds) layer.setRecording(enabled ? this.kit.recordedLoop(id) : null);
  }

  // Which beds are playing recordings, for debug readouts.
  recordedBeds(): LoopId[] {
    return [...this.beds].filter(([, layer]) => layer.recorded).map(([id]) => id);
  }

  update(
    dt: number,
    wind: WindAudio,
    sea: SeaAudio,
    rain: RainAudio | undefined,
    env: EnvironmentParams,
    listener: ListenerPose,
  ): void {
    const now = this.ctx.currentTime;
    this.updateWind(dt, now, wind, listener);
    this.updateSea(dt, now, sea, listener, env);
    rainParams(rain?.intensity ?? 0, rain?.deck ?? 0, this.rain);
    const r = this.rain;
    ramp(this.deckHiss.gain.gain, r.deckHiss, now, TAU_SLOW);
    ramp(this.waterHiss.gain.gain, r.waterHiss, now, TAU_SLOW);
    const [deckSparse, deckDense, waterSparse, waterDense] = this.drops;
    if (deckSparse && deckDense && waterSparse && waterDense) {
      ramp(deckSparse.gain, r.deckDrops * (1 - r.denseMix), now, TAU_SLOW);
      ramp(deckDense.gain, r.deckDrops * r.denseMix, now, TAU_SLOW);
      ramp(waterSparse.gain, r.waterDrops * (1 - r.denseMix), now, TAU_SLOW);
      ramp(waterDense.gain, r.waterDrops * r.denseMix, now, TAU_SLOW);
    }
    ramp(this.humGain.gain, env.interiorHum, now, TAU_SLOW);
    ramp(this.underwaterGain.gain, env.underwaterBed, now, TAU);
  }

  private updateWind(dt: number, now: number, wind: WindAudio, listener: ListenerPose): void {
    const mean = Math.max(0, wind.speed);
    const gustiness = Math.max(0, (wind.gustFactor ?? 1) - 1);
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      // Gusts arrive every few seconds; lulls are shallower than peaks.
      this.gustTarget = this.rng.range(-0.35, 1) * this.rng.next();
      this.gustTimer = this.rng.range(1.5, 6);
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt / 1.2);
    const speed = mean * (1 + gustiness * this.gust);
    this.gustSpeed = speed;
    const w = windParams(speed, this.wind);
    ramp(this.rush.gain.gain, w.rushGain, now, TAU_SLOW);
    ramp(this.rush.filter.frequency, w.rushCutoff, now, TAU_SLOW);
    ramp(this.howl.frequency, w.howlFreq, now, TAU_SLOW);
    ramp(this.howl.Q, w.howlQ, now, TAU_SLOW);
    ramp(this.howl2.frequency, w.howlFreq * 1.47, now, TAU_SLOW);
    ramp(this.howl2.Q, w.howlQ * 1.2, now, TAU_SLOW);
    ramp(this.howlGain.gain, w.howlGain, now, TAU_SLOW);
    ramp(this.howlWobbleDepth.gain, w.howlFreq * 0.05, now, TAU_SLOW);
    ramp(this.howlWobble.frequency, 0.2 + 0.03 * speed, now, TAU_SLOW);
    ramp(this.whistle.frequency, w.whistleFreq, now, TAU_SLOW);
    ramp(this.whistleGain.gain, w.whistleGain, now, TAU_SLOW);
    // Pan the howl toward windward: the wind's "from" bearing relative to where the listener faces.
    if (wind.from !== undefined) {
      const f = listener.forward;
      const facing = Math.atan2(f.x, -f.z);
      ramp(this.howlPan.pan, clamp(Math.sin(wind.from - facing) * 0.6, -1, 1), now, TAU_SLOW);
    }
  }

  private updateSea(
    dt: number,
    now: number,
    sea: SeaAudio,
    listener: ListenerPose,
    env: EnvironmentParams,
  ): void {
    const s = seaParams(sea.hs, this.gustSpeed, sea.tp, this.sea);
    ramp(this.lapBed.gain.gain, s.lapGain * 0.6, now, TAU_SLOW);
    ramp(this.wash.gain.gain, s.washGain, now, TAU_SLOW);
    ramp(this.roar.gain.gain, s.roarGain, now, TAU_SLOW);
    ramp(this.wash.filter.frequency, s.washCenter, now, TAU_SLOW);
    ramp(this.roar.filter.frequency, s.roarCutoff, now, TAU_SLOW);
    ramp(this.swellLfo.frequency, s.swellRate, now, TAU_SLOW);
    ramp(this.roarLfo.frequency, s.swellRate * 0.6, now, TAU_SLOW);
    // Under water nobody hears crests break overhead; the one-shots would just leak through.
    const dry = env.underwaterBed > 0.2 ? 0 : 1;
    const p = listener.position;
    if (dry && this.rng.next() < poissonChance(s.crestRate, dt)) {
      const shot = this.kit.oneShot('crest', this.rng);
      if (shot) {
        const angle = this.rng.next() * Math.PI * 2;
        const distance = this.rng.range(20, 60 + 15 * sea.hs);
        this.oneShots.play(shot.buffer, {
          gain: s.crestGain * shot.gain * this.rng.range(0.6, 1),
          rate: this.rng.range(0.8, 1.15) * (sea.hs > 6 ? 0.85 : 1),
          x: p.x + Math.cos(angle) * distance,
          y: 0,
          z: p.z + Math.sin(angle) * distance,
          refDistance: 25,
          priority: 0,
        });
      }
    }
    if (dry && this.rng.next() < poissonChance(s.lapRate, dt)) {
      const shot = this.kit.oneShot('lap', this.rng);
      if (shot) {
        const angle = this.rng.next() * Math.PI * 2;
        const distance = this.rng.range(1.5, 6);
        this.oneShots.play(shot.buffer, {
          gain: 0.35 * shot.gain * this.rng.range(0.4, 1),
          rate: this.rng.range(0.85, 1.2),
          x: p.x + Math.cos(angle) * distance,
          y: Math.min(p.y, 0.5),
          z: p.z + Math.sin(angle) * distance,
          refDistance: 2,
          priority: -1,
        });
      }
    }
  }
}
