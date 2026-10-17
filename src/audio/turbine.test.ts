import { describe, expect, it } from 'vite-plus/test';

import { boatAudioState } from '../app/audioFrame';
import { createBoatDynamics } from '../sim/boats/drivetrains';
import { gasGeneratorSpeed } from '../sim/physics/propulsion/surfaceProp';
import { physicsTuning } from '../sim/physics/tuning';
import { flatWater } from '../sim/physics/water';
import { neutralControls } from '../sim/world/protocol';
import { BOAT_AUDIO } from './boatProfiles';
import { HYDRO_SPRAY, sprayParams, T55_TURBINE, type TurbineInput, turbineParams } from './turbine';

const at = (over: Partial<TurbineInput>): TurbineInput => ({
  n1: 1,
  power: 1,
  turbineRpm: 16_000,
  propRpm: 9500,
  thrust: 15_000,
  propEmersion: 0.5,
  ...over,
});
const IDLE = at({ n1: 0.6, power: 0.04, turbineRpm: 0, propRpm: 0, thrust: 0 });

describe('the hydroplane turbine', () => {
  it('is the hydroplane’s engine, replacing the piston-engine voice', () => {
    expect(BOAT_AUDIO.hydro.engine).toBeNull();
    expect(BOAT_AUDIO.hydro.turbine).toBe(T55_TURBINE);
    expect(BOAT_AUDIO.hydro.spray).toBe(HYDRO_SPRAY);
  });

  it('whines at idle and shrieks spooled up: the compressor tone follows N1', () => {
    const idle = turbineParams(T55_TURBINE, IDLE, undefined);
    const idleFreq = idle.compressorFreq[0];
    const idleGain = idle.compressorGain[0];
    const full = turbineParams(T55_TURBINE, at({}));
    expect(idle.running).toBe(1);
    expect(idleFreq).toBeCloseTo(0.6 * T55_TURBINE.compressor.hz[0]);
    expect(full.compressorFreq[0]).toBeCloseTo(T55_TURBINE.compressor.hz[0]);
    expect(idleGain).toBeGreaterThan(0);
    expect(full.compressorGain[0]).toBeGreaterThan(idleGain);
    expect(full.compressorGain[1]).toBeGreaterThan(0);
    // The exhaust roar grows and brightens with power, the rumble with the propeller.
    expect(full.roarGain).toBeGreaterThan(3 * idle.roarGain);
    expect(full.roarCenter).toBeGreaterThan(idle.roarCenter);
    expect(full.rumbleGain).toBeGreaterThan(idle.rumbleGain);
    expect(full.hissGain).toBeGreaterThan(idle.hissGain);
  });

  it('spools audibly: the whine climbs for seconds after the throttle opens', () => {
    const d = createBoatDynamics('hydro', physicsTuning('hydro', 'arcade'));
    d.placeAtRest(0, 0, 0);
    const c = { ...neutralControls(), throttle: 1 };
    const tel: Record<string, number> = {};
    const pitch: number[] = [];
    const dt = 1 / 120;
    for (let i = 1; i <= 5 / dt; i++) {
      d.step(dt, flatWater, null, i * dt, c);
      if (i % 60 === 0) {
        d.writeTelemetry(tel);
        pitch.push(turbineParams(T55_TURBINE, at({ n1: tel['n1']! })).compressorFreq[0]);
      }
    }
    const [lo, hi] = [0.6 * T55_TURBINE.compressor.hz[0], T55_TURBINE.compressor.hz[0]];
    const share = (f: number): number => (f - lo) / (hi - lo);
    // Half a second in, under half way; still rising after two seconds; there by four.
    expect(share(pitch[0]!)).toBeLessThan(0.5);
    expect(pitch[4]!).toBeGreaterThan(pitch[3]! + 10);
    expect(share(pitch[7]!)).toBeGreaterThan(0.97);
    for (let i = 1; i < pitch.length; i++) expect(pitch[i]!).toBeGreaterThanOrEqual(pitch[i - 1]! - 1e-6);
  });

  it('winds down to silence once the kill switch cuts the fuel', () => {
    // Half way down from idle it still turns, whining lower; stopped, it is silent.
    const winding = turbineParams(T55_TURBINE, at({ n1: gasGeneratorSpeed(0.02, 0.04), power: 0.02 }));
    expect(winding.running).toBeGreaterThan(0.8);
    expect(winding.compressorFreq[0]).toBeCloseTo(0.3 * T55_TURBINE.compressor.hz[0]);
    const stopped = turbineParams(T55_TURBINE, at({ n1: 0, power: 0, turbineRpm: 0, propRpm: 0, thrust: 0 }));
    expect(stopped.running).toBe(0);
    expect(stopped.gain).toBe(0);
  });

  it('screams higher when the propeller leaves the water and the power turbine races', () => {
    const wet = turbineParams(T55_TURBINE, at({ turbineRpm: 16_000, propEmersion: 0.5 }));
    const wetFreq = wet.turbineFreq;
    const wetGain = wet.turbineGain;
    const dry = turbineParams(T55_TURBINE, at({ turbineRpm: 17_300, propEmersion: 1, thrust: 0 }));
    expect(dry.turbineFreq).toBeGreaterThan(wetFreq);
    expect(dry.turbineGain).toBeGreaterThan(wetGain);
    // Out of the water the blades stop slapping.
    expect(dry.bladeGain).toBe(0);
  });

  it('ignores bad telemetry', () => {
    const p = turbineParams(T55_TURBINE, {
      n1: Number.NaN,
      power: Number.POSITIVE_INFINITY,
      turbineRpm: Number.NaN,
      propRpm: -5,
      thrust: Number.NaN,
      propEmersion: Number.NaN,
    });
    for (const [key, value] of Object.entries(p)) {
      for (const v of Array.isArray(value) ? value : [value]) expect(Number.isFinite(v), key).toBe(true);
    }
  });
});

describe('the rooster tail, the wind and the chop', () => {
  const spray = (speed: number, thrust: number, hs = 0, airborne = 0) => ({
    ...sprayParams(HYDRO_SPRAY, { speed, thrust, airborne, hs }),
  });

  it('roars with the propeller’s bite and the speed, and is gone without thrust', () => {
    const fast = spray(80, 15_000);
    expect(spray(80, 0).roosterGain).toBe(0);
    expect(fast.roosterGain).toBeGreaterThan(2 * spray(20, 15_000).roosterGain);
    expect(fast.roosterGain).toBeGreaterThan(spray(80, 2000).roosterGain);
    expect(fast.roosterCenter).toBeGreaterThan(spray(20, 15_000).roosterCenter);
    expect(fast.roosterGain).toBeLessThanOrEqual(HYDRO_SPRAY.rooster.gain);
  });

  it('rushes with the air at speed', () => {
    expect(spray(0, 0).windGain).toBe(0);
    expect(spray(89, 0).windGain).toBeCloseTo(HYDRO_SPRAY.wind.gain);
    expect(spray(44.5, 0).windGain).toBeCloseTo(HYDRO_SPRAY.wind.gain / 4);
  });

  it('slaps the chop at speed, never in a glassy calm or in the air', () => {
    expect(spray(70, 15_000, 0).slapRate).toBe(0);
    expect(spray(70, 15_000, 0.4).slapRate).toBeGreaterThan(2);
    expect(spray(70, 15_000, 0.4, 1).slapRate).toBe(0);
    expect(spray(3, 15_000, 0.4).slapRate).toBe(0);
  });
});

describe('the hydroplane’s audio state', () => {
  it('carries the turbine’s speeds and the propeller’s thrust from the telemetry', () => {
    const s = boatAudioState({
      id: 'h',
      kind: 'hydro',
      position: { x: 0, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      velocity: { x: 0, y: 0, z: -70 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      telemetry: {
        rpm: 8000,
        load: 0.6,
        n1: 0.93,
        gasGenerator: 0.7,
        turbineRpm: 13_500,
        thrust: 12_000,
        propEmersion: 0.45,
        speedThroughWater: 70,
      },
    });
    expect(s.rpm).toBe(8000);
    expect(s.load).toBe(0.6);
    expect(s.turbine).toEqual({
      n1: 0.93,
      power: 0.7,
      turbineRpm: 13_500,
      propRpm: 8000,
      thrust: 12_000,
      propEmersion: 0.45,
    });
  });
});
