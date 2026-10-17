// Thunder voices: each strike becomes a rolling rumble (low-passed brown noise under a granular
// envelope, its cutoff sweeping dark) scheduled distance/343 s after the flash, with a sharp crack
// first for close cloud-to-ground strikes. A small pool caps how many rolls overlap.

import { Rng } from '../sim/core/rng';
import { clamp } from './curves';
import { filterNode, gainNode, type OneShotPlayer, type SoundKit } from './graph';
import { planThunder, type ThunderPlan, thunderEnvelope, type ThunderStrike } from './thunderPlan';
import type { ListenerPose } from './types';
import { VoicePool } from './VoicePool';

interface RumbleVoice {
  lowpass: BiquadFilterNode;
  lowpass2: BiquadFilterNode;
  gain: GainNode;
  pan: StereoPannerNode;
  source: AudioBufferSourceNode | null;
}

export interface ScheduledThunder {
  plan: ThunderPlan;
  at: number; // context time the sound arrives
}

export class ThunderVoices {
  readonly recent: ScheduledThunder[] = []; // for the lab readout
  private readonly ctx: BaseAudioContext;
  private readonly kit: SoundKit;
  private readonly cracks: OneShotPlayer;
  private readonly pool: VoicePool;
  private readonly voices: RumbleVoice[] = [];
  private readonly rng: Rng;

  constructor(
    ctx: BaseAudioContext,
    kit: SoundKit,
    destination: AudioNode,
    cracks: OneShotPlayer,
    seed: number,
  ) {
    this.ctx = ctx;
    this.kit = kit;
    this.cracks = cracks;
    this.rng = new Rng(seed);
    this.pool = new VoicePool(4);
    for (let i = 0; i < this.pool.size; i++) {
      const lowpass = filterNode(ctx, 'lowpass', 400, 0.6);
      const lowpass2 = filterNode(ctx, 'lowpass', 400, 0.6);
      const gain = gainNode(ctx, 0);
      const pan = ctx.createStereoPanner();
      lowpass.connect(lowpass2).connect(gain).connect(pan).connect(destination);
      this.voices.push({ lowpass, lowpass2, gain, pan, source: null });
    }
  }

  // `elapsed`: seconds already passed since the flash (sim time now − strike.time), if known.
  strike(strike: ThunderStrike, listener: ListenerPose, elapsed = 0): ScheduledThunder | null {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const p = listener.position;
    const plan = planThunder(strike, p.x, p.y, p.z);
    if (plan.gain < 1e-3 && plan.crackGain < 1e-3) return null;
    // Never schedule in the past; leave a few ms so automation never overlaps.
    const at = now + Math.max(0.03, plan.delay - Math.max(0, elapsed));
    const pan = this.bearingPan(strike, listener);

    if (plan.crackGain > 0) {
      const shot = this.kit.oneShot('thunder-crack', this.rng);
      if (shot) {
        this.cracks.play(shot.buffer, {
          when: at,
          gain: plan.crackGain * shot.gain,
          rate: this.rng.range(0.85, 1.1),
          pan,
          priority: 2,
        });
      }
    }

    const end = at + plan.duration + 0.1;
    const index = this.pool.acquire(now, end, plan.gain);
    const voice = this.voices[index];
    if (voice) {
      const g = voice.gain.gain;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0, now, 0.01);
      voice.source?.stop(now + 0.03);
      const curve = thunderEnvelope(plan, this.rng.int(0, 2 ** 31));
      g.setValueCurveAtTime(curve, Math.max(at, now + 0.06), plan.duration);
      for (const filter of [voice.lowpass, voice.lowpass2]) {
        filter.frequency.cancelScheduledValues(now);
        filter.frequency.setValueAtTime(plan.cutoffStart, at);
        filter.frequency.exponentialRampToValueAtTime(plan.cutoffEnd, at + plan.duration);
      }
      voice.pan.pan.setValueAtTime(pan, at);
      const source = ctx.createBufferSource();
      source.buffer = this.kit.brown;
      source.loop = true;
      // A slightly slowed loop makes the rumble deeper and hides the loop length.
      source.playbackRate.value = this.rng.range(0.6, 0.8);
      source.connect(voice.lowpass);
      source.start(at, this.rng.next() * this.kit.brown.duration);
      source.stop(end);
      source.onended = () => {
        source.disconnect();
        if (voice.source === source) voice.source = null;
      };
      voice.source = source;
    }
    const scheduled = { plan, at };
    this.recent.unshift(scheduled);
    if (this.recent.length > 6) this.recent.length = 6;
    return scheduled;
  }

  pending(): number {
    const now = this.ctx.currentTime;
    return this.recent.filter((t) => t.at > now).length;
  }

  // Stereo position of the strike from the listener's facing; distant thunder is wide and diffuse.
  private bearingPan(strike: ThunderStrike, listener: ListenerPose): number {
    const f = listener.forward;
    const dx = strike.x - listener.position.x;
    const dz = strike.z - listener.position.z;
    const length = Math.hypot(dx, dz) || 1;
    // Right = forward × up for a level camera: (−f.z, 0, f.x).
    const rx = -f.z;
    const rz = f.x;
    const right = (dx * rx + dz * rz) / (length * (Math.hypot(rx, rz) || 1));
    return clamp(right * 0.7, -1, 1);
  }
}
