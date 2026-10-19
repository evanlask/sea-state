// Web Audio plumbing shared by the engine's parts: smoothed parameter ramps, looping sources, the
// procedural sound kit (noise loops and one-shot variants rendered once, with recorded samples
// taking their place where the SampleBank has them, and each engine's firing loop) and a pooled
// one-shot player.

import { deriveSeed, Rng } from '../sim/core/rng';
import type { BoatKind } from '../sim/world/protocol';
import type { EngineProfile } from './boatProfiles';
import {
  noiseLoop,
  renderCrack,
  renderCreak,
  renderCrest,
  renderDrops,
  renderFlogSnap,
  renderLap,
  renderSlam,
  renderSplash,
  renderWinch,
} from './dsp';
import { renderEngineLoop } from './engineLoops';
import type { SampleBank, SoundId } from './SampleBank';
import { VoicePool } from './VoicePool';

// Time constants for setTargetAtTime: ~3τ reaches 95 % of the target.
export const TAU_FAST = 0.03;
export const TAU = 0.1;
export const TAU_SLOW = 0.4;

// `value` within the parameter's own range. A filter's frequency tops out at the context's Nyquist
// frequency, which is only 12 kHz on a 24 kHz device (some Bluetooth headsets): the browser would
// clamp an "open" 18–20 kHz cutoff anyway, warning on every write.
export function inRange(param: AudioParam, value: number): number {
  // Test doubles may leave the range out.
  const { minValue, maxValue } = param as Partial<AudioParam>;
  if (maxValue !== undefined && value > maxValue) return maxValue;
  if (minValue !== undefined && value < minValue) return minValue;
  return value;
}

// Smoothly moves a parameter toward `value`; ignores NaN/∞ so bad input can never poison a param.
export function ramp(param: AudioParam, value: number, now: number, tau = TAU): void {
  if (Number.isFinite(value)) param.setTargetAtTime(inRange(param, value), now, tau);
}

export function gainNode(ctx: BaseAudioContext, gain = 0): GainNode {
  const node = ctx.createGain();
  node.gain.value = gain;
  return node;
}

export function filterNode(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q = 0.707,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = inRange(node.frequency, frequency);
  node.Q.value = q;
  return node;
}

// A looping buffer source started at a random offset, so layers sharing a buffer stay uncorrelated.
// `region` loops part of the buffer (seconds), as padded recorded loops need; `phase` (0..1) picks
// the starting point within the loop instead of a random one.
export function startLoop(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  rng: Rng,
  destination?: AudioNode,
  region?: { start: number; end: number },
  phase?: number,
): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  let start = 0;
  let end = buffer.duration;
  if (region && region.start >= 0 && region.end > region.start && region.end <= buffer.duration) {
    start = region.start;
    end = region.end;
    source.loopStart = start;
    source.loopEnd = end;
  }
  if (destination) source.connect(destination);
  const t = phase ?? rng.next();
  source.start(ctx.currentTime, start + (t - Math.floor(t)) * (end - start));
  return source;
}

export function startOscillator(
  ctx: BaseAudioContext,
  type: OscillatorType | PeriodicWave,
  frequency: number,
  destination?: AudioNode,
): OscillatorNode {
  const osc = ctx.createOscillator();
  if (typeof type === 'string') osc.type = type as OscillatorType;
  else osc.setPeriodicWave(type);
  osc.frequency.value = frequency;
  if (destination) osc.connect(destination);
  osc.start();
  return osc;
}

function toBuffer(
  ctx: BaseAudioContext,
  channels: readonly Float32Array[],
  sampleRate = ctx.sampleRate,
): AudioBuffer {
  const length = channels[0]?.length ?? 1;
  const buffer = ctx.createBuffer(channels.length, length, sampleRate);
  channels.forEach((data, i) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, i));
  return buffer;
}

// ---------------------------------------------------------------------------------------------
// Sound kit

export type OneShotId =
  | 'slam'
  | 'splash'
  | 'creak'
  | 'winch'
  | 'thunder-crack'
  | 'crest'
  | 'lap'
  | 'flog-snap';
export type LoopId = 'wind' | 'sea-lap' | 'sea-wash' | 'sea-roar' | 'rain-deck' | 'rain-water';

// An engine's firing loop (engineLoops.ts) and the rpm it plays at with playbackRate 1.
export interface EngineLoopBuffer {
  buffer: AudioBuffer;
  rootRpm: number;
}

// A recorded ambient loop from the SampleBank.
export interface KitLoop {
  buffer: AudioBuffer;
  gain: number; // trim that matches the synthesized layer's loudness
  region?: { start: number; end: number }; // loop points in a padded file, seconds
}

const ONE_SHOT_RENDERERS: Record<
  OneShotId,
  { variants: number; render: (sr: number, rng: Rng) => Float32Array }
> = {
  slam: { variants: 4, render: renderSlam },
  splash: { variants: 4, render: renderSplash },
  creak: { variants: 5, render: renderCreak },
  winch: { variants: 2, render: (sr, rng) => renderWinch(sr, rng) },
  'thunder-crack': { variants: 3, render: renderCrack },
  crest: { variants: 4, render: renderCrest },
  lap: { variants: 5, render: renderLap },
  'flog-snap': { variants: 4, render: renderFlogSnap },
};

export class SoundKit {
  readonly white: AudioBuffer; // mono
  readonly pinkMono: AudioBuffer;
  readonly pink: AudioBuffer; // stereo, decorrelated channels
  readonly brown: AudioBuffer; // stereo
  readonly drops: {
    deckSparse: AudioBuffer;
    deckDense: AudioBuffer;
    waterSparse: AudioBuffer;
    waterDense: AudioBuffer;
  };
  private readonly oneShots = new Map<OneShotId, { buffers: AudioBuffer[]; gain: number }>();
  private readonly engineLoops = new Map<BoatKind, EngineLoopBuffer>();
  private readonly ctx: BaseAudioContext;
  private readonly seed: number;
  readonly samples: SampleBank | undefined;

  constructor(ctx: BaseAudioContext, seed: number, samples?: SampleBank) {
    this.ctx = ctx;
    this.seed = seed;
    this.samples = samples;
    const sr = ctx.sampleRate;
    const rng = (label: string): Rng => new Rng(deriveSeed(seed, label));
    const noise = (color: 'white' | 'pink' | 'brown', seconds: number, label: string): Float32Array =>
      noiseLoop(color, Math.round(seconds * sr), rng(label));
    this.white = toBuffer(ctx, [noise('white', 3, 'white')]);
    this.pinkMono = toBuffer(ctx, [noise('pink', 5, 'pink-mono')]);
    this.pink = toBuffer(ctx, [noise('pink', 7, 'pink-l'), noise('pink', 7, 'pink-r')]);
    this.brown = toBuffer(ctx, [noise('brown', 7, 'brown-l'), noise('brown', 7, 'brown-r')]);
    const drops = (flavour: 'deck' | 'water', rate: number, label: string): AudioBuffer =>
      toBuffer(ctx, [
        renderDrops(sr, rng(`${label}-l`), 4, rate, flavour),
        renderDrops(sr, rng(`${label}-r`), 4, rate, flavour),
      ]);
    this.drops = {
      deckSparse: drops('deck', 30, 'deck-sparse'),
      deckDense: drops('deck', 150, 'deck-dense'),
      waterSparse: drops('water', 20, 'water-sparse'),
      waterDense: drops('water', 100, 'water-dense'),
    };
    for (const id of Object.keys(ONE_SHOT_RENDERERS) as OneShotId[]) {
      const sample = samples?.get(id);
      if (sample && sample.buffers.length > 0) {
        this.oneShots.set(id, { buffers: sample.buffers, gain: sample.entry.gain ?? 1 });
        continue;
      }
      const spec = ONE_SHOT_RENDERERS[id];
      const r = rng(`one-shot-${id}`);
      const buffers: AudioBuffer[] = [];
      for (let v = 0; v < spec.variants; v++) buffers.push(toBuffer(ctx, [spec.render(sr, r)]));
      this.oneShots.set(id, { buffers, gain: 1 });
    }
  }

  // A random variant of a one-shot and its trim gain.
  oneShot(id: OneShotId, rng: Rng): { buffer: AudioBuffer; gain: number } | null {
    const set = this.oneShots.get(id);
    if (!set || set.buffers.length === 0) return null;
    const buffer = set.buffers[Math.floor(rng.next() * set.buffers.length)] ?? set.buffers[0];
    return buffer ? { buffer, gain: set.gain } : null;
  }

  // An engine's firing loop, rendered the first time a boat of its kind needs it (5–40 ms) unless
  // prefetchEngineLoops got there first.
  engineLoop(kind: BoatKind, profile: EngineProfile): EngineLoopBuffer {
    let loop = this.engineLoops.get(kind);
    if (!loop) {
      const rendered = renderEngineLoop(profile, deriveSeed(this.seed, `engine-${kind}`));
      loop = {
        buffer: toBuffer(this.ctx, rendered.channels, rendered.sampleRate),
        rootRpm: rendered.rootRpm,
      };
      this.engineLoops.set(kind, loop);
    }
    return loop;
  }

  // Renders the engines' loops one at a time in idle moments, so a fleet arriving later doesn't
  // stall a frame rendering them all at once.
  prefetchEngineLoops(engines: readonly (readonly [BoatKind, EngineProfile])[]): void {
    const pending = engines.filter(([kind]) => !this.engineLoops.has(kind));
    const idle: (run: () => void) => void =
      typeof requestIdleCallback === 'function'
        ? (run) => requestIdleCallback(run, { timeout: 3000 })
        : (run) => setTimeout(run, 200);
    const next = (): void => {
      const entry = pending.shift();
      if (!entry) return;
      this.engineLoop(entry[0], entry[1]);
      idle(next);
    };
    idle(next);
  }

  // The recording for an ambient layer, if the bank has one. Read live, so recordings that finish
  // loading after the audio unlock can still be switched in (Ambience.setRecorded).
  recordedLoop(id: LoopId): KitLoop | null {
    const sample = this.samples?.get(id as SoundId);
    const buffer = sample?.buffers[0];
    if (!sample || !buffer) return null;
    const { gain = 1, loopStart, loopEnd } = sample.entry;
    const region =
      loopStart !== undefined && loopEnd !== undefined ? { start: loopStart, end: loopEnd } : undefined;
    return region ? { buffer, gain, region } : { buffer, gain };
  }
}

// ---------------------------------------------------------------------------------------------
// One-shot player

export interface PlayOptions {
  when?: number; // context time; default now
  gain: number;
  rate?: number; // playback rate
  cutoff?: number; // Hz low-pass
  priority?: number; // higher survives voice stealing
  // Spatial players: world position and the inverse-distance reference.
  x?: number;
  y?: number;
  z?: number;
  refDistance?: number;
  pan?: number; // stereo players: -1..1
}

interface OneShotVoice {
  gain: GainNode;
  filter: BiquadFilterNode;
  panner: PannerNode | StereoPannerNode;
  source: AudioBufferSourceNode | null;
}

// A fixed set of reusable voices (gain → low-pass → panner) feeding one bus. Sources are the only
// nodes created per sound, as Web Audio intends; stolen voices fade out over a few ms.
export class OneShotPlayer {
  private readonly pool: VoicePool;
  private readonly voices: OneShotVoice[] = [];
  private readonly ctx: BaseAudioContext;

  constructor(
    ctx: BaseAudioContext,
    destination: AudioNode,
    size: number,
    spatial: boolean,
    panningModel: PanningModelType = 'HRTF',
  ) {
    this.ctx = ctx;
    this.pool = new VoicePool(size);
    for (let i = 0; i < size; i++) {
      const gain = gainNode(ctx, 0);
      const filter = filterNode(ctx, 'lowpass', 20000);
      let panner: PannerNode | StereoPannerNode;
      if (spatial) {
        panner = ctx.createPanner();
        panner.panningModel = panningModel;
        panner.distanceModel = 'inverse';
        panner.rolloffFactor = 1;
        panner.maxDistance = 20000;
      } else {
        panner = ctx.createStereoPanner();
      }
      gain.connect(filter).connect(panner).connect(destination);
      this.voices.push({ gain, filter, panner, source: null });
    }
  }

  get size(): number {
    return this.pool.size;
  }

  active(): number {
    return this.pool.activeCount(this.ctx.currentTime);
  }

  play(buffer: AudioBuffer, options: PlayOptions): boolean {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // Non-finite values would throw in the AudioParams below; a rate of 0 would never end.
    const rate =
      options.rate !== undefined && options.rate > 0 && Number.isFinite(options.rate) ? options.rate : 1;
    const requested = options.when ?? now;
    let when = Number.isFinite(requested) ? Math.max(requested, now) : now;
    const end = when + buffer.duration / rate + 0.05;
    const index = this.pool.acquire(now, end, options.priority ?? 0);
    const voice = this.voices[index];
    if (!voice) return false;
    if (this.pool.lastStolen && voice.source) {
      // Fade the old sound out before the new one starts in the same chain.
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.004);
      voice.source.stop(now + 0.02);
      when = Math.max(when, now + 0.025);
    }
    voice.gain.gain.setValueAtTime(Number.isFinite(options.gain) ? options.gain : 0, when);
    const cutoff = options.cutoff ?? 20000;
    voice.filter.frequency.setValueAtTime(
      inRange(voice.filter.frequency, Number.isFinite(cutoff) ? cutoff : 20000),
      when,
    );
    const panner = voice.panner;
    if (panner instanceof PannerNode) {
      const ref = options.refDistance ?? 5;
      panner.refDistance = Number.isFinite(ref) && ref >= 0 ? ref : 5;
      setPannerPosition(panner, options.x ?? 0, options.y ?? 0, options.z ?? 0);
    } else {
      const pan = options.pan ?? 0;
      panner.pan.setValueAtTime(Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0, when);
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(voice.gain);
    source.onended = () => {
      source.disconnect();
      if (voice.source === source) voice.source = null;
    };
    source.start(when);
    voice.source = source;
    return true;
  }

  stopAll(): void {
    const now = this.ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, 0.01);
      voice.source?.stop(now + 0.05);
    }
  }
}

// PannerNode/AudioListener AudioParams are missing in older Firefox; fall back to the setters.
export function setPannerPosition(panner: PannerNode, x: number, y: number, z: number, tau = 0): void {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return;
  if (panner.positionX) {
    const now = panner.context.currentTime;
    if (tau > 0) {
      panner.positionX.setTargetAtTime(x, now, tau);
      panner.positionY.setTargetAtTime(y, now, tau);
      panner.positionZ.setTargetAtTime(z, now, tau);
    } else {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    }
  } else {
    (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}
