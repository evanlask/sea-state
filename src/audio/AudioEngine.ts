// The audio engine: one AudioContext (created and resumed on the first user gesture), category buses
// driven by the audio settings, environment muffling (closed bridge, underwater), a gentle master
// limiter, a listener that follows the camera, and the per-frame/one-shot API the app drives:
//
//   const audio = new AudioEngine({ settings: store.get().audio, samples: bank });
//   store.subscribe((s) => audio.applySettings(s.audio));
//   once the bank has loaded:  audio.refreshRecordings();
//   each frame:   audio.update(dt, { listener, environment, wind, sea, rain, boats, simTime });
//   on events:    audio.handleSimEvents(snapshot.events); lightning.onThunder((e) => audio.thunder(e));
//   on input:     audio.horn(boatId, pressed); audio.winch(boatId);
//
// Graph:  ambience ─┐
//         effects ──┼→ env low-pass ×2 → env gain ─┐
//         engines ──┘                              ├→ master → hide mute → headroom → limiter → out
//         ambience (dry: interior hum, underwater) ┘                  (then a soft clipper for safety)

import { type AudioSettings, defaultSettings } from '../settings/schema';
import { deriveSeed } from '../sim/core/rng';
import { BOAT_KINDS, type SimEvent } from '../sim/world/protocol';
import { Ambience } from './Ambience';
import { BOAT_AUDIO } from './boatProfiles';
import { BoatVoice, type BoatVoiceDeps } from './BoatVoice';
import {
  airAbsorptionCutoff,
  createEnvironmentParams,
  createRainParams,
  createSeaParams,
  createWindParams,
  dbToGain,
  dopplerFactor,
  type EnvironmentParams,
  environmentParams,
  gainToDb,
  type RainParams,
  type SeaParams,
  softClipCurve,
  volumeToGain,
  type WindParams,
} from './curves';
import { filterNode, gainNode, OneShotPlayer, ramp, SoundKit, TAU, TAU_FAST } from './graph';
import { loudestJet } from './jetPlan';
import { JetVoice } from './JetVoice';
import type { SampleBank } from './SampleBank';
import type { ThunderStrike } from './thunderPlan';
import { type ScheduledThunder, ThunderVoices } from './ThunderVoices';
import type { AudioEnvironment, AudioFrame, ListenerPose, Vec3Like } from './types';

export type AudioEngineState = 'locked' | 'running' | 'suspended' | 'closed';

export interface AudioEngineOptions {
  settings?: Readonly<AudioSettings>;
  // Recordings that replace synthesized sounds. One-shots must be loaded before unlock; the ambient
  // beds' loops can arrive later (refreshRecordings).
  samples?: SampleBank;
  panningModel?: PanningModelType; // 'HRTF' (default) or the cheaper 'equalpower'
  seed?: number;
  // Where to listen for the unlocking gesture; null leaves calling unlock() to the app.
  unlockTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
  meter?: boolean; // analysers for level readouts (dev labs)
  createContext?: () => AudioContext;
}

interface AudioLevels {
  peakDb: number; // pre-limiter
  rmsDb: number;
  outPeakDb: number; // post-limiter
  reductionDb: number; // limiter gain reduction
}

export interface AudioDebugInfo {
  state: AudioEngineState;
  sampleRate: number;
  wind: WindParams;
  gustSpeed: number;
  sea: SeaParams;
  rain: RainParams;
  recordedBeds: string[]; // ambient beds playing field recordings
  environment: EnvironmentParams;
  boats: {
    id: string;
    kind: string;
    distance: number;
    doppler: number;
    airCutoff: number;
    f0: number;
    cutoff: number;
    engineGain: number;
    effort: number;
    boost: number;
    rush: number;
    flog: number;
    horn: boolean;
  }[];
  oneShots: { effects: number; ambience: number };
  thunder: ScheduledThunder[];
  jetGain: number; // the distant jet rumble's level (0 when none is overhead)
  levels: AudioLevels | null;
}

export type VolumeBus = 'ambience' | 'effects' | 'engines';

// Per-bus calibration, dB: with every volume at 100 % the three buses play equally loud, about
// −24 LUFS each at master 100 % (BS.1770 integrated loudness in typical scenes, measured offline by
// scripts/audio-levels.ts; re-run it after changing a bus's sound). Untrimmed at 100 %, typical
// scenes measured:
//   ambience  −25.4  wind, sea and rain beds, the mean of Breezy (−30.0) and Gale (−20.7); thunder
//                    (also on this bus) rolls at about −29 at a few km and isn't counted
//   engines   −29.2  the player's engine cruising, from the chase camera (mean of five boats)
//   effects   −31.9  the same runs' hull rush, splashes, slams and horn blasts (mean of six boats)
// Each trim is a whole number of 5 % slider steps (1.5 dB), so the default volumes in
// settings/schema.ts (the mix we like) give back exactly the untrimmed by-ear balance.
export const BUS_TRIM_DB: Readonly<Record<VolumeBus, number>> = {
  ambience: 1.5,
  effects: 7.5,
  engines: 4.5,
};

const BUS_TRIM: Readonly<Record<VolumeBus, number>> = {
  ambience: dbToGain(BUS_TRIM_DB.ambience),
  effects: dbToGain(BUS_TRIM_DB.effects),
  engines: dbToGain(BUS_TRIM_DB.engines),
};

const HEADROOM = 1; // the limiter (and soft clipper after it) catch the rare peaks
const CAMERA_CUT = 50; // m in one frame: a camera cut, not motion (no Doppler spike)
const NO_AIRCRAFT: NonNullable<AudioFrame['aircraft']> = [];

class Graph {
  readonly ctx: AudioContext;
  readonly kit: SoundKit;
  readonly ambienceBus: GainNode;
  readonly ambienceDry: GainNode;
  readonly effectsBus: GainNode;
  readonly enginesBus: GainNode;
  readonly envLowpass: BiquadFilterNode;
  readonly envLowpass2: BiquadFilterNode;
  readonly envGain: GainNode;
  readonly master: GainNode;
  readonly hide: GainNode;
  readonly limiter: DynamicsCompressorNode;
  readonly effects: OneShotPlayer;
  readonly ambienceShots: OneShotPlayer;
  readonly cracks: OneShotPlayer;
  readonly ambience: Ambience;
  readonly thunder: ThunderVoices;
  readonly jet: JetVoice;
  readonly boatDeps: BoatVoiceDeps;
  readonly meters: {
    pre: AnalyserNode;
    post: AnalyserNode;
    data: Float32Array<ArrayBuffer>;
  } | null = null;

  constructor(ctx: AudioContext, options: AudioEngineOptions, seed: number) {
    this.ctx = ctx;
    this.kit = new SoundKit(ctx, seed, options.samples);
    this.kit.prefetchEngineLoops(
      BOAT_KINDS.flatMap((kind) => {
        const engine = BOAT_AUDIO[kind].engine;
        return engine ? [[kind, engine] as const] : [];
      }),
    );
    const panning = options.panningModel ?? 'HRTF';

    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    const headroom = gainNode(ctx, HEADROOM);
    this.hide = gainNode(ctx, 1);
    this.master = gainNode(ctx, 0);
    const clipper = ctx.createWaveShaper();
    clipper.curve = softClipCurve();
    clipper.oversample = '2x';
    this.master
      .connect(this.hide)
      .connect(headroom)
      .connect(this.limiter)
      .connect(clipper)
      .connect(ctx.destination);
    if (options.meter) {
      const pre = ctx.createAnalyser();
      const post = ctx.createAnalyser();
      pre.fftSize = post.fftSize = 2048;
      headroom.connect(pre);
      clipper.connect(post);
      this.meters = { pre, post, data: new Float32Array(2048) };
    }

    this.envGain = gainNode(ctx, 1);
    this.envLowpass = filterNode(ctx, 'lowpass', 18000);
    this.envLowpass2 = filterNode(ctx, 'lowpass', 18000);
    this.envLowpass.connect(this.envLowpass2).connect(this.envGain).connect(this.master);
    this.ambienceBus = gainNode(ctx, 0);
    this.effectsBus = gainNode(ctx, 0);
    this.enginesBus = gainNode(ctx, 0);
    for (const bus of [this.ambienceBus, this.effectsBus, this.enginesBus]) bus.connect(this.envLowpass);
    this.ambienceDry = gainNode(ctx, 0);
    this.ambienceDry.connect(this.master);

    this.effects = new OneShotPlayer(ctx, this.effectsBus, 16, true, panning);
    this.ambienceShots = new OneShotPlayer(ctx, this.ambienceBus, 10, true, panning);
    this.cracks = new OneShotPlayer(ctx, this.ambienceBus, 3, false);
    this.ambience = new Ambience(
      ctx,
      this.kit,
      { exterior: this.ambienceBus, dry: this.ambienceDry },
      this.ambienceShots,
      deriveSeed(seed, 'ambience'),
    );
    this.thunder = new ThunderVoices(
      ctx,
      this.kit,
      this.ambienceBus,
      this.cracks,
      deriveSeed(seed, 'thunder'),
    );
    this.jet = new JetVoice(ctx, this.kit, this.ambienceBus, deriveSeed(seed, 'jet'));
    this.boatDeps = {
      ctx,
      kit: this.kit,
      effects: this.effects,
      engineBus: this.enginesBus,
      effectsBus: this.effectsBus,
      panningModel: panning,
    };
  }

  levels(): AudioLevels | null {
    const m = this.meters;
    if (!m) return null;
    const measure = (node: AnalyserNode): { peak: number; rms: number } => {
      node.getFloatTimeDomainData(m.data);
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < m.data.length; i++) {
        const v = m.data[i] ?? 0;
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
      }
      return { peak, rms: Math.sqrt(sum / m.data.length) };
    };
    const pre = measure(m.pre);
    const post = measure(m.post);
    return {
      peakDb: gainToDb(pre.peak),
      rmsDb: gainToDb(pre.rms),
      outPeakDb: gainToDb(post.peak),
      reductionDb: this.limiter.reduction,
    };
  }
}

export class AudioEngine {
  private readonly options: AudioEngineOptions;
  private readonly seed: number;
  private graph: Graph | null = null;
  private settings: AudioSettings;
  private environment: AudioEnvironment = { enclosed: 0, underwater: 0 };
  private readonly envParams: EnvironmentParams = createEnvironmentParams();
  private readonly boats = new Map<string, BoatVoice>();
  private readonly boatList: BoatVoice[] = [];
  private readonly hornWanted = new Map<string, boolean>();
  private frame = 0;
  private simTime: number | undefined;
  private closed = false;
  private hidden = false;
  private unlocking: Promise<boolean> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly detach: (() => void)[] = [];
  // Last listener pose (copied, so thunder can be placed between frames) and its velocity.
  private readonly listener: ListenerPose = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  };
  private readonly listenerVelocity: Vec3Like = { x: 0, y: 0, z: 0 };
  private hasListener = false;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.seed = options.seed ?? 0x5ea5;
    this.settings = { ...defaultSettings().audio, ...options.settings };
    const target = options.unlockTarget === undefined ? globalThis.window : options.unlockTarget;
    if (target) {
      const onGesture = (): void => {
        void this.unlock();
      };
      const events = ['pointerdown', 'keydown', 'touchend'] as const;
      for (const type of events) target.addEventListener(type, onGesture, { capture: true });
      this.detach.push(() => {
        for (const type of events) target.removeEventListener(type, onGesture, { capture: true });
      });
    }
    if (typeof document !== 'undefined') {
      const onVisibility = (): void => this.onVisibility(document.visibilityState === 'hidden');
      document.addEventListener('visibilitychange', onVisibility);
      this.detach.push(() => document.removeEventListener('visibilitychange', onVisibility));
      this.hidden = document.visibilityState === 'hidden';
    }
  }

  get state(): AudioEngineState {
    if (this.closed) return 'closed';
    const ctx = this.graph?.ctx;
    if (!ctx) return 'locked';
    return ctx.state === 'running' ? 'running' : 'suspended';
  }

  get context(): AudioContext | null {
    return this.graph?.ctx ?? null;
  }

  // Creates the context on first call (must run inside a user gesture) and resumes it.
  unlock(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    let ctx = this.graph?.ctx;
    if (this.unlocking) {
      // An earlier resume() (a gamepad poll, with no activation) may still be pending, and this
      // gesture is the one that can satisfy it: ask again.
      if (ctx && ctx.state !== 'running' && !(this.hidden && this.settings.muteWhenHidden)) {
        void ctx.resume().catch(() => undefined);
      }
      return this.unlocking;
    }
    let resumed: Promise<void>;
    if (!ctx) {
      const created = this.options.createContext?.() ?? new AudioContext({ latencyHint: 'interactive' });
      ctx = created;
      // Resume inside the gesture, before the synchronous (~50 ms) sound-kit build.
      resumed = ctx.resume();
      try {
        this.graph = new Graph(ctx, this.options, this.seed);
      } catch (error) {
        // Don't strand a running context: the next gesture would make another (browsers cap them).
        void resumed
          .catch(() => undefined)
          .then(() => created.close())
          .catch(() => undefined);
        throw error;
      }
      this.applySettings(this.settings);
      // Recordings already in the bank replace their beds' noise from the start.
      this.graph.ambience.setRecorded(true);
      ctx.addEventListener('statechange', () => this.onStateChange());
    } else if (ctx.state === 'running' || (this.hidden && this.settings.muteWhenHidden)) {
      return Promise.resolve(ctx.state === 'running');
    } else {
      resumed = ctx.resume();
    }
    const context = ctx;
    const pending = resumed
      .then(() => context.state === 'running')
      .catch(() => false)
      .finally(() => {
        this.unlocking = null;
      });
    this.unlocking = pending;
    return pending;
  }

  applySettings(settings: Readonly<AudioSettings>): void {
    this.settings = { ...settings };
    const g = this.graph;
    if (!g) return;
    const now = g.ctx.currentTime;
    ramp(g.master.gain, volumeToGain(settings.master), now, TAU_FAST);
    const ambience = BUS_TRIM.ambience * volumeToGain(settings.ambience);
    ramp(g.ambienceBus.gain, ambience, now, TAU_FAST);
    ramp(g.ambienceDry.gain, ambience, now, TAU_FAST);
    ramp(g.effectsBus.gain, BUS_TRIM.effects * volumeToGain(settings.effects), now, TAU_FAST);
    ramp(g.enginesBus.gain, BUS_TRIM.engines * volumeToGain(settings.engines), now, TAU_FAST);
    this.onVisibility(this.hidden);
  }

  // Switches in recordings the sample bank loaded after the audio unlocked.
  refreshRecordings(): void {
    this.graph?.ambience.setRecorded(true);
  }

  // Persistent environment (used when a frame doesn't pass its own).
  setEnvironment(environment: AudioEnvironment): void {
    this.environment = { enclosed: environment.enclosed, underwater: environment.underwater };
  }

  update(dt: number, frame: AudioFrame): void {
    // A NaN step would poison the smoothed state (gusts, Doppler, listener velocity) for good.
    if (!(dt >= 0) || !Number.isFinite(dt)) dt = 0;
    this.simTime = frame.simTime;
    this.copyListener(frame.listener, dt);
    if (frame.environment) this.setEnvironment(frame.environment);
    const g = this.graph;
    if (!g || g.ctx.state !== 'running') {
      this.pollGamepadUnlock();
      return;
    }
    const ctx = g.ctx;
    const now = ctx.currentTime;
    this.frame++;
    this.applyListener(g, now);

    const env = environmentParams(this.environment.enclosed, this.environment.underwater, this.envParams);
    ramp(g.envLowpass.frequency, env.cutoff, now, TAU);
    ramp(g.envLowpass2.frequency, env.cutoff, now, TAU);
    ramp(g.envLowpass.Q, env.q, now, TAU);
    ramp(g.envGain.gain, env.exteriorGain, now, TAU);

    g.ambience.update(dt, frame.wind, frame.sea, frame.rain, env, this.listener);
    g.jet.update(dt, loudestJet(this.listener, frame.aircraft ?? NO_AIRCRAFT, frame.wind.speed));

    const lp = this.listener.position;
    const lv = this.listenerVelocity;
    for (const state of frame.boats) {
      let voice = this.boats.get(state.id);
      if (voice && voice.kind !== state.kind) {
        this.removeBoat(voice);
        voice = undefined;
      }
      if (!voice) {
        voice = new BoatVoice(g.boatDeps, state.id, state.kind, deriveSeed(this.seed, state.id));
        this.boats.set(state.id, voice);
        this.boatList.push(voice);
        if (this.hornWanted.get(state.id)) voice.setHorn(true);
      }
      voice.stamp = this.frame;
      const dx = lp.x - state.position.x;
      const dy = lp.y - state.position.y;
      const dz = lp.z - state.position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const inv = distance > 1e-3 ? 1 / distance : 0;
      const v = state.velocity;
      const listenerAlong = (lv.x * dx + lv.y * dy + lv.z * dz) * inv;
      const sourceAlong = (v.x * dx + v.y * dy + v.z * dz) * inv;
      voice.distance = distance;
      // Smoothed so frame-to-frame velocity noise doesn't warble the pitch.
      const doppler = dopplerFactor(listenerAlong, sourceAlong);
      if (Number.isFinite(doppler)) voice.doppler += (doppler - voice.doppler) * Math.min(1, dt * 8);
      voice.airCutoff = airAbsorptionCutoff(distance);
      voice.update(dt, state, frame.sea.hs, distance > voice.profile.cullDistance);
    }
    for (let i = this.boatList.length - 1; i >= 0; i--) {
      const voice = this.boatList[i];
      if (voice && voice.stamp !== this.frame) this.removeBoat(voice);
    }
  }

  // Forwards the sim's slam events (strength ≈ impact speed, m/s) and collisions (both hulls sound,
  // at the contact point).
  handleSimEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      if (event.type === 'slam') this.slam(event.boatId, event.strength);
      else if (event.type === 'collision') {
        for (const id of [event.boatId, event.otherId]) this.collision(id, event.speed, event);
      }
    }
  }

  collision(boatId: string, speed: number, at: Vec3Like): void {
    if (this.running()) this.boats.get(boatId)?.collision(speed, at.x, at.y, at.z);
  }

  slam(boatId: string, strength: number): void {
    if (this.running()) this.boats.get(boatId)?.slam(strength);
  }

  winch(boatId: string, clicks = 1): void {
    if (this.running()) this.boats.get(boatId)?.winch(clicks);
  }

  horn(boatId: string, on: boolean): void {
    this.hornWanted.set(boatId, on);
    if (this.graph) this.boats.get(boatId)?.setHorn(on);
  }

  // A lightning strike (Lightning's ThunderEvent fits). The rumble arrives distance/343 s after the
  // flash, less any sim time already elapsed since it.
  thunder(strike: ThunderStrike): ScheduledThunder | null {
    const g = this.graph;
    if (!g || !this.running()) return null;
    const elapsed = this.simTime === undefined ? 0 : Math.max(0, this.simTime - strike.time);
    return g.thunder.strike(strike, this.listener, elapsed);
  }

  debug(): AudioDebugInfo {
    const g = this.graph;
    return {
      state: this.state,
      sampleRate: g?.ctx.sampleRate ?? 0,
      wind: g ? { ...g.ambience.wind } : createWindParams(),
      gustSpeed: g?.ambience.gustSpeed ?? 0,
      sea: g ? { ...g.ambience.sea } : createSeaParams(),
      rain: g ? { ...g.ambience.rain } : createRainParams(),
      recordedBeds: g?.ambience.recordedBeds() ?? [],
      environment: { ...this.envParams },
      boats: this.boatList.map((b) => {
        const e = b.engineReadout();
        return {
          id: b.id,
          kind: b.kind,
          distance: b.distance,
          doppler: b.doppler,
          airCutoff: b.airCutoff,
          f0: e.f0,
          cutoff: e.cutoff,
          engineGain: e.gain,
          effort: e.effort,
          boost: e.boost,
          rush: b.rushLevel,
          flog: b.flog.gain,
          horn: b.horning,
        };
      }),
      oneShots: { effects: g?.effects.active() ?? 0, ambience: g?.ambienceShots.active() ?? 0 },
      thunder: g ? [...g.thunder.recent] : [],
      jetGain: g?.jet.level ?? 0,
      levels: g?.levels() ?? null,
    };
  }

  // Silences every boat (a voyage ending or a new one loading, when no frames arrive to say which
  // boats are gone); the beds keep playing until the next update retunes them.
  reset(): void {
    for (let i = this.boatList.length - 1; i >= 0; i--) {
      const voice = this.boatList[i];
      if (voice) this.removeBoat(voice);
    }
    this.hornWanted.clear();
    this.hasListener = false;
    this.listenerVelocity.x = this.listenerVelocity.y = this.listenerVelocity.z = 0;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.hideTimer);
    for (const off of this.detach) off();
    // removeBoat() shrinks the list, so walk it from the end.
    for (let i = this.boatList.length - 1; i >= 0; i--) {
      const voice = this.boatList[i];
      if (voice) this.removeBoat(voice);
    }
    void this.graph?.ctx.close().catch(() => undefined);
    this.graph = null;
  }

  private running(): boolean {
    return this.graph?.ctx.state === 'running';
  }

  private removeBoat(voice: BoatVoice): void {
    voice.dispose();
    this.boats.delete(voice.id);
    const i = this.boatList.indexOf(voice);
    if (i >= 0) this.boatList.splice(i, 1);
  }

  private copyListener(pose: ListenerPose, dt: number): void {
    // Keep the last good pose rather than feed NaN to the panners (AudioParams throw on it).
    const { position: q0, forward: f0, up: u0 } = pose;
    if (!Number.isFinite(q0.x + q0.y + q0.z + f0.x + f0.y + f0.z + u0.x + u0.y + u0.z)) return;
    const p = this.listener.position;
    const v = this.listenerVelocity;
    const q = pose.position;
    if (pose.velocity) {
      v.x = pose.velocity.x;
      v.y = pose.velocity.y;
      v.z = pose.velocity.z;
    } else if (this.hasListener && dt > 0) {
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      const dz = q.z - p.z;
      const cut = dx * dx + dy * dy + dz * dz > CAMERA_CUT * CAMERA_CUT;
      const k = Math.min(1, dt * 10);
      v.x = cut ? 0 : v.x + (dx / dt - v.x) * k;
      v.y = cut ? 0 : v.y + (dy / dt - v.y) * k;
      v.z = cut ? 0 : v.z + (dz / dt - v.z) * k;
    }
    p.x = q.x;
    p.y = q.y;
    p.z = q.z;
    const f = this.listener.forward;
    f.x = pose.forward.x;
    f.y = pose.forward.y;
    f.z = pose.forward.z;
    const u = this.listener.up;
    u.x = pose.up.x;
    u.y = pose.up.y;
    u.z = pose.up.z;
    this.hasListener = true;
  }

  private applyListener(g: Graph, now: number): void {
    const l = g.ctx.listener;
    const { position: p, forward: f, up: u } = this.listener;
    if (l.positionX) {
      // Same smoothing as the boat panners, so sources riding with the camera stay put.
      const tau = 0.02;
      l.positionX.setTargetAtTime(p.x, now, tau);
      l.positionY.setTargetAtTime(p.y, now, tau);
      l.positionZ.setTargetAtTime(p.z, now, tau);
      l.forwardX.setTargetAtTime(f.x, now, tau);
      l.forwardY.setTargetAtTime(f.y, now, tau);
      l.forwardZ.setTargetAtTime(f.z, now, tau);
      l.upX.setTargetAtTime(u.x, now, tau);
      l.upY.setTargetAtTime(u.y, now, tau);
      l.upZ.setTargetAtTime(u.z, now, tau);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  // Gamepad buttons aren't activation events in every browser, but try: Chrome counts them for
  // pages with prior activation, and it costs nothing while locked.
  private pollGamepadUnlock(): void {
    if (this.closed || this.unlocking || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    if (this.hidden && this.settings.muteWhenHidden) return;
    for (const pad of navigator.getGamepads()) {
      if (pad?.buttons[0]?.pressed) {
        void this.unlock();
        return;
      }
    }
  }

  private onVisibility(hidden: boolean): void {
    this.hidden = hidden;
    const g = this.graph;
    if (!g) return;
    const ctx = g.ctx;
    const now = ctx.currentTime;
    clearTimeout(this.hideTimer);
    if (hidden && this.settings.muteWhenHidden) {
      ramp(g.hide.gain, 0, now, 0.03);
      // Suspend once faded, which also stops the audio thread burning CPU in a background tab.
      this.hideTimer = setTimeout(() => {
        if (this.hidden && ctx.state === 'running') void ctx.suspend();
      }, 200);
    } else {
      ramp(g.hide.gain, 1, now, 0.05);
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    }
  }

  private onStateChange(): void {
    // Safari can 'interrupt' a context (calls, other tabs); a later gesture resumes it.
    const g = this.graph;
    if (!g || this.closed) return;
    if (g.ctx.state !== 'running' && !this.hidden) void this.unlock();
  }
}
