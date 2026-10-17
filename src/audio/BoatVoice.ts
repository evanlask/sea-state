// Everything one boat sounds like, placed in 3D: engine (EngineSynth), water rush along the hull,
// bow splashes, slams and creaks (pooled one-shots), the sailboat's flogging sails and rigging moan,
// winches, and a press-and-hold horn. Two PannerNodes per boat (engine bus and effects bus) each
// follow an air-absorption low-pass so distant boats sound dull.

import { Rng } from '../sim/core/rng';
import type { BoatKind } from '../sim/world/protocol';
import { BOAT_AUDIO, type BoatAudioProfile } from './boatProfiles';
import {
  aeolianFrequency,
  bowSplashRate,
  type CollisionParams,
  collisionParams,
  creakRate,
  type FlogParams,
  flogParams,
  poissonChance,
  riggingGain,
  type SlamParams,
  slamParams,
  waterRushCenter,
  waterRushGain,
  waterRushLevel,
} from './curves';
import { harmonicTables } from './dsp';
import { EngineSynth } from './EngineSynth';
import {
  filterNode,
  gainNode,
  type OneShotPlayer,
  ramp,
  setPannerPosition,
  type SoundKit,
  startLoop,
  startOscillator,
  TAU,
  TAU_SLOW,
} from './graph';
import { createSprayParams, type SprayParams, sprayParams } from './turbine';
import { TurbineSynth } from './TurbineSynth';
import type { BoatAudioState } from './types';

export interface BoatVoiceDeps {
  ctx: BaseAudioContext;
  kit: SoundKit;
  effects: OneShotPlayer; // spatial pool on the effects bus
  engineBus: AudioNode;
  effectsBus: AudioNode;
  panningModel: PanningModelType;
}

// Standing-rigging wire diameters (m): shrouds, forestay, backstay.
const RIG_WIRES = [0.006, 0.009, 0.012] as const;

function makePanner(ctx: BaseAudioContext, model: PanningModelType, refDistance: number): PannerNode {
  const panner = ctx.createPanner();
  panner.panningModel = model;
  panner.distanceModel = 'inverse';
  panner.refDistance = refDistance;
  panner.rolloffFactor = 1;
  panner.maxDistance = 20000;
  return panner;
}

export class BoatVoice {
  readonly id: string;
  readonly kind: BoatKind;
  readonly profile: BoatAudioProfile;
  readonly engine: EngineSynth | null;
  readonly turbine: TurbineSynth | null;
  readonly spray: SprayParams = createSprayParams();
  stamp = 0; // last frame this boat was seen
  // Readouts for the lab.
  distance = 0;
  doppler = 1;
  airCutoff = 20000;
  rushLevel = 0;
  readonly flog: FlogParams = { gain: 0, rate: 5, center: 400, snapRate: 0 };

  private readonly deps: BoatVoiceDeps;
  private readonly rng: Rng;
  private readonly enginePanner: PannerNode;
  private readonly fxPanner: PannerNode;
  private readonly engineAir: BiquadFilterNode;
  private readonly fxAir: BiquadFilterNode;
  private readonly fxLevel: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly rushBand: BiquadFilterNode;
  private readonly rushGain: GainNode;
  private readonly sail: {
    band: BiquadFilterNode;
    gain: GainNode;
    lfoA: OscillatorNode;
    lfoB: OscillatorNode;
    rigging: BiquadFilterNode[];
    riggingGain: GainNode;
  } | null = null;
  // A racing hydroplane's water and air (profile.spray): the rooster tail's roar and hiss, the
  // hollow wind rush in two resonant bands.
  private readonly sprayNodes: {
    roosterBand: BiquadFilterNode;
    roosterGain: GainNode;
    hissGain: GainNode;
    windBands: BiquadFilterNode[];
    windGain: GainNode;
  } | null = null;
  private readonly hornGain: GainNode;
  private readonly hornFilter: BiquadFilterNode;
  private hornWave: PeriodicWave | null = null;
  private hornOscs: OscillatorNode[] = [];
  private hornOn = false;
  private readonly slamScratch: SlamParams = { gain: 0, rate: 1, cutoff: 1000 };
  private readonly hitScratch: CollisionParams = { gain: 0, rate: 1, cutoff: 1000, groan: 0 };
  private x = 0;
  private y = 0;
  private z = 0;

  constructor(deps: BoatVoiceDeps, id: string, kind: BoatKind, seed: number) {
    const ctx = deps.ctx;
    this.deps = deps;
    this.id = id;
    this.kind = kind;
    this.profile = BOAT_AUDIO[kind];
    this.rng = new Rng(seed);
    const p = this.profile;

    this.enginePanner = makePanner(ctx, deps.panningModel, p.refDistance);
    this.engineAir = filterNode(ctx, 'lowpass', 20000, 0.5);
    this.engineAir.connect(this.enginePanner).connect(deps.engineBus);
    this.engine = p.engine ? new EngineSynth(ctx, deps.kit, kind, p.engine, this.engineAir, this.rng) : null;
    this.turbine = p.turbine ? new TurbineSynth(ctx, deps.kit, p.turbine, this.engineAir, this.rng) : null;

    this.fxPanner = makePanner(ctx, deps.panningModel, p.refDistance);
    this.fxAir = filterNode(ctx, 'lowpass', 20000, 0.5);
    this.fxLevel = gainNode(ctx, 1);
    this.fxLevel.connect(this.fxAir).connect(this.fxPanner).connect(deps.effectsBus);

    // Water rushing along the hull, and the source for the sail layers.
    const pink = startLoop(ctx, deps.kit.pinkMono, this.rng);
    this.sources.push(pink);
    this.rushBand = filterNode(ctx, 'bandpass', 400, 0.8);
    this.rushGain = gainNode(ctx, 0);
    pink.connect(this.rushBand).connect(this.rushGain).connect(this.fxLevel);

    if (p.rigging) {
      // Flogging cloth: band-passed noise chopped by two detuned LFOs (an irregular 4–8 Hz flap).
      const band = filterNode(ctx, 'bandpass', 400, 1.1);
      const chop = gainNode(ctx, 0.4);
      const gain = gainNode(ctx, 0);
      pink.connect(band).connect(chop).connect(gain).connect(this.fxLevel);
      const depth = gainNode(ctx, 0.3);
      depth.connect(chop.gain);
      const lfoA = startOscillator(ctx, 'sawtooth', 5.3, depth);
      const lfoB = startOscillator(ctx, 'sine', 7.1, depth);
      this.sources.push(lfoA, lfoB);
      const riggingOut = gainNode(ctx, 0);
      const rigging = RIG_WIRES.map((_, i) => {
        const f = filterNode(ctx, 'bandpass', 300, 28);
        const trim = gainNode(ctx, 1.6 - 0.35 * i);
        pink.connect(f).connect(trim).connect(riggingOut);
        return f;
      });
      riggingOut.connect(this.fxLevel);
      this.sail = { band, gain, lfoA, lfoB, rigging, riggingGain: riggingOut };
    }

    if (p.spray) {
      // Its own pink loop, so the tail's roar and the hull's rush don't move together.
      const noise = startLoop(ctx, deps.kit.pinkMono, this.rng);
      this.sources.push(noise);
      const roosterBand = filterNode(ctx, 'bandpass', p.spray.rooster.center[0], 0.5);
      const roosterGain = gainNode(ctx, 0);
      noise.connect(roosterBand).connect(roosterGain).connect(this.fxLevel);
      const hissGain = gainNode(ctx, 0);
      noise
        .connect(filterNode(ctx, 'highpass', p.spray.rooster.hissCutoff, 0.6))
        .connect(hissGain)
        .connect(this.fxLevel);
      const windGain = gainNode(ctx, 0);
      const windBands = p.spray.wind.centers.map((hz) => {
        const band = filterNode(ctx, 'bandpass', hz, p.spray!.wind.q);
        noise.connect(band).connect(windGain);
        return band;
      });
      windGain.connect(this.fxLevel);
      this.sprayNodes = { roosterBand, roosterGain, hissGain, windBands, windGain };
    }

    this.hornGain = gainNode(ctx, 0);
    this.hornFilter = filterNode(ctx, 'lowpass', p.horn.cutoff, 0.8);
    // Horns bypass fxLevel: they're meant to carry beyond the boat's culling range.
    this.hornGain.connect(this.hornFilter).connect(this.fxAir);
  }

  update(dt: number, state: BoatAudioState, hs: number, culled: boolean): void {
    const now = this.deps.ctx.currentTime;
    const p = this.profile;
    this.x = state.position.x;
    this.y = state.position.y;
    this.z = state.position.z;
    setPannerPosition(this.enginePanner, this.x, this.y, this.z, 0.02);
    setPannerPosition(this.fxPanner, this.x, this.y, this.z, 0.02);
    ramp(this.engineAir.frequency, this.airCutoff, now, TAU);
    ramp(this.fxAir.frequency, this.airCutoff, now, TAU);
    const level = culled ? 0 : 1;
    this.engine?.update(dt, state.rpm, state.load, state.airborne ?? 0, this.doppler, level);
    if (this.turbine && state.turbine) this.turbine.update(dt, state.turbine, this.doppler, level);
    ramp(this.fxLevel.gain, level, now, TAU);
    if (culled) return;
    if (this.sprayNodes && p.spray) this.updateSpray(dt, state, hs, p.spray);

    const airborne = state.airborne ?? 0;
    const rush = waterRushLevel(state.speedThroughWater, p.topSpeed) * (1 - airborne);
    this.rushLevel = rush;
    ramp(this.rushGain.gain, waterRushGain(rush), now, TAU);
    ramp(this.rushBand.frequency, waterRushCenter(rush, p.hullScale), now, TAU);

    if (this.sail) {
      const aw = state.apparentWind ?? 0;
      const f = flogParams(state.luffing ?? 0, aw, this.flog);
      ramp(this.sail.gain.gain, f.gain, now, TAU);
      ramp(this.sail.band.frequency, f.center, now, TAU_SLOW);
      // Wander the two flap rates so the pattern never repeats.
      ramp(this.sail.lfoA.frequency, f.rate * this.rng.range(0.85, 1.15), now, TAU_SLOW);
      ramp(this.sail.lfoB.frequency, f.rate * this.rng.range(1.2, 1.5), now, TAU_SLOW);
      ramp(this.sail.riggingGain.gain, riggingGain(aw), now, TAU_SLOW);
      this.sail.rigging.forEach((filter, i) => {
        ramp(filter.frequency, Math.max(60, aeolianFrequency(aw, RIG_WIRES[i] ?? 0.01)), now, TAU_SLOW);
      });
      if (this.rng.next() < poissonChance(f.snapRate, dt)) {
        this.oneShot('flog-snap', 0.5 * (state.luffing ?? 0), this.rng.range(0.85, 1.2), 1, 3);
      }
    }

    if (this.rng.next() < poissonChance(bowSplashRate(rush, hs), dt)) {
      const gain = (0.25 + 0.5 * rush) * this.rng.range(0.5, 1);
      this.oneShot('splash', gain, this.rng.range(0.8, 1.2) * (1.1 - 0.5 * p.hullScale), 0, p.refDistance);
    }
    if (p.creaks && this.rng.next() < poissonChance(creakRate(state.motion ?? 0, hs), dt)) {
      const rate = this.rng.range(0.75, 1.25) * (this.kind === 'crab' ? 0.7 : 1);
      this.oneShot('creak', this.rng.range(0.2, 0.45), rate, -1, 3);
    }
  }

  private updateSpray(
    dt: number,
    state: BoatAudioState,
    hs: number,
    profile: NonNullable<BoatAudioProfile['spray']>,
  ): void {
    const nodes = this.sprayNodes;
    if (!nodes) return;
    const now = this.deps.ctx.currentTime;
    const d = this.doppler;
    const s = sprayParams(
      profile,
      {
        speed: state.speedThroughWater,
        thrust: state.turbine?.thrust ?? 0,
        airborne: state.airborne ?? 0,
        hs,
      },
      this.spray,
    );
    // The tail is ragged: its level wanders frame to frame as sheets of water come and go.
    const ragged = this.rng.range(0.8, 1.15);
    ramp(nodes.roosterGain.gain, s.roosterGain * ragged, now, TAU);
    ramp(nodes.roosterBand.frequency, s.roosterCenter * d, now, TAU);
    ramp(nodes.hissGain.gain, s.roosterHiss * ragged, now, TAU);
    ramp(nodes.windGain.gain, s.windGain, now, TAU_SLOW);
    nodes.windBands.forEach((band, i) => ramp(band.frequency, (s.windCenters[i] ?? 400) * d, now, TAU));
    if (this.rng.next() < poissonChance(s.slapRate, dt)) {
      this.oneShot('slam', s.slapGain * this.rng.range(0.6, 1), this.rng.range(1.1, 1.5), 0, 4);
    }
  }

  // Impact speed of a slam, m/s.
  slam(strength: number): void {
    const s = slamParams(strength, this.profile.hullScale, this.slamScratch);
    if (s.gain <= 0) return;
    const shot = this.deps.kit.oneShot('slam', this.rng);
    if (!shot) return;
    this.deps.effects.play(shot.buffer, {
      gain: s.gain * shot.gain,
      rate: s.rate * this.rng.range(0.92, 1.08),
      cutoff: s.cutoff,
      x: this.x,
      y: this.y,
      z: this.z,
      refDistance: this.profile.refDistance,
      priority: 1 + s.gain,
    });
    if (s.gain > 0.3) this.oneShot('splash', 0.6 * s.gain, s.rate * 1.1, 1, this.profile.refDistance);
  }

  // Struck another boat at (x, y, z) with this closing speed, m/s.
  collision(speed: number, x: number, y: number, z: number): void {
    const c = collisionParams(speed, this.profile.hullScale, this.hitScratch);
    if (c.gain <= 0) return;
    const shot = this.deps.kit.oneShot('slam', this.rng);
    if (shot) {
      this.deps.effects.play(shot.buffer, {
        gain: c.gain * shot.gain,
        rate: c.rate * this.rng.range(0.94, 1.06),
        cutoff: c.cutoff,
        x,
        y,
        z,
        refDistance: this.profile.refDistance,
        priority: 2 + c.gain,
      });
    }
    this.oneShot('creak', c.groan, c.rate * 0.8, 2, this.profile.refDistance, 0.05);
    this.oneShot('splash', 0.5 * c.gain, c.rate * 1.2, 1, this.profile.refDistance);
  }

  winch(clicks = 1): void {
    for (let i = 0; i < Math.max(1, Math.min(clicks, 4)); i++) {
      this.oneShot('winch', 0.5, this.rng.range(0.9, 1.1), 1, 2, i * 0.5);
    }
  }

  setHorn(on: boolean): void {
    if (on === this.hornOn) return;
    this.hornOn = on;
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const h = this.profile.horn;
    const g = this.hornGain.gain;
    g.cancelScheduledValues(now);
    if (on) {
      this.stopHornOscillators(now + 0.01);
      this.hornWave ??= (() => {
        const t = harmonicTables(h.partials, Math.round(h.fundamental));
        return ctx.createPeriodicWave(t.real, t.imag);
      })();
      const voiceGain = 1 / Math.sqrt(h.voices);
      for (let v = 0; v < h.voices; v++) {
        // Multi-trumpet horns are tuned slightly apart: a rich, beating chord.
        const pitch = h.fundamental * (1 + v * 0.012);
        const trim = gainNode(ctx, voiceGain);
        const osc = startOscillator(ctx, this.hornWave, pitch * (1 - h.bend), trim);
        osc.frequency.setTargetAtTime(pitch, now, Math.max(h.attack / 2, 0.005));
        trim.connect(this.hornGain);
        osc.onended = () => trim.disconnect();
        this.hornOscs.push(osc);
      }
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(h.gain, now, Math.max(h.attack / 3, 0.002));
    } else {
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(0, now, Math.max(h.release / 3, 0.005));
      // Pitch sags a little as the air pressure drops.
      for (const osc of this.hornOscs) {
        osc.frequency.setTargetAtTime(osc.frequency.value * (1 - h.bend * 0.5), now, h.release);
      }
      this.stopHornOscillators(now + h.release * 2.5 + 0.05);
    }
  }

  get horning(): boolean {
    return this.hornOn;
  }

  // The engine's readouts for the debug info and the lab, whichever kind of engine it is: a
  // turbine reports its compressor tone as f0, its roar's centre as the cutoff, N1 as the boost.
  engineReadout(): { f0: number; cutoff: number; gain: number; effort: number; boost: number } {
    if (this.engine) {
      const e = this.engine.params;
      return { f0: e.f0, cutoff: e.cutoff, gain: e.gain, effort: e.effort, boost: e.boost };
    }
    if (this.turbine) {
      const t = this.turbine.params;
      return {
        f0: t.compressorFreq[0],
        cutoff: t.roarCenter,
        gain: t.gain,
        effort: t.roarGain,
        boost: t.spool,
      };
    }
    return { f0: 0, cutoff: 0, gain: 0, effort: 0, boost: 0 };
  }

  dispose(): void {
    const now = this.deps.ctx.currentTime;
    this.engine?.dispose();
    this.turbine?.dispose();
    this.hornGain.gain.cancelScheduledValues(now);
    this.hornGain.gain.setTargetAtTime(0, now, 0.01);
    this.stopHornOscillators(now + 0.05);
    this.fxLevel.gain.cancelScheduledValues(now);
    this.fxLevel.gain.setTargetAtTime(0, now, 0.02);
    for (const source of this.sources) source.stop(now + 0.1);
    setTimeout(() => {
      this.fxPanner.disconnect();
      this.enginePanner.disconnect();
    }, 250);
  }

  private stopHornOscillators(when: number): void {
    for (const osc of this.hornOscs) osc.stop(when);
    this.hornOscs = [];
  }

  private oneShot(
    id: 'splash' | 'creak' | 'winch' | 'flog-snap' | 'slam',
    gain: number,
    rate: number,
    priority: number,
    refDistance: number,
    delay = 0,
  ): void {
    const shot = this.deps.kit.oneShot(id, this.rng);
    if (!shot) return;
    this.deps.effects.play(shot.buffer, {
      when: this.deps.ctx.currentTime + delay,
      gain: gain * shot.gain,
      rate,
      cutoff: this.airCutoff,
      x: this.x,
      y: this.y,
      z: this.z,
      refDistance,
      priority,
    });
  }
}
