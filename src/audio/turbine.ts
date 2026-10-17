// The Unlimited hydroplane's sound: a Lycoming T55 turboshaft and the water it throws.
// Pure data and parameter mapping, so every curve is unit-tested; TurbineSynth (engine bus) and
// BoatVoice's spray layers (effects bus) copy these numbers into the graph.
//
// Engine, from the telemetry of propulsion/surfaceProp.ts:
//   compressor whine  two tones of the gas generator's compressor stages, pitched by N1 (the gas
//                     generator's speed, ~60 % at idle): the throttle sets the gas power, which spools
//                     over seconds, so the whine climbs well behind the lever, and winds down for
//                     seconds after a kill switch
//   power turbine     the free turbine's scream, pitched by its rpm (geared to the propeller): it
//                     rises with the boat's speed, and races when the propeller leaves the water
//   exhaust roar      broadband noise from the stack, growing and brightening with gas power
//   hiss              the jet's high hiss, with power
//   rumble            the gearbox and the propeller shaft, low-passed noise with the propeller's rpm
//   blade buzz        the surface-piercing propeller's blades slapping into the water, at blade rate
// Water and air (BoatVoice):
//   rooster tail      the roar of the wall of water the propeller throws up: bite (thrust) × speed
//   wind rush         two resonant noise bands, the hollow rush of 200 mph air past the canopy
//   chop slap         the sponsons' pads slapping crests, a slam one-shot per hit, more often with
//                     sea and speed

import { clamp01, lerp, smoothstep } from './curves';

export interface TurbineProfile {
  label: string;
  idleN1: number; // gas-generator speed at idle, share of rated
  compressor: {
    hz: readonly [number, number]; // the two stages' tones at 100 % N1
    gain: number;
    partials: readonly number[]; // relative amplitudes of harmonics 1..n
    beat: number; // detune of a shadow tone that beats against the first (rotating-stall shimmer)
  };
  powerTurbine: { hzAtRated: number; ratedRpm: number; gain: number; partials: readonly number[] }; // ratedRpm: its own
  roar: { gain: number; center: readonly [number, number]; q: number };
  hiss: { gain: number; cutoff: number };
  rumble: { gain: number; cutoff: number };
  blades: { count: number; gain: number; q: number; maxRpm: number; thrustRef: number }; // N for full bite
  gain: number;
}

export interface SprayProfile {
  thrustRef: number; // N of propeller thrust for full bite (the rooster tail's, boatSpray.ts)
  topSpeed: number; // m/s
  rooster: { gain: number; center: readonly [number, number]; hiss: number; hissCutoff: number };
  wind: { gain: number; centers: readonly [number, number]; q: number };
  slap: { rate: number; gain: number }; // pad slaps per second at full speed in a 0.5 m chop
}

// [E] Lycoming T55 turboshaft: N1 about 18,700 rpm at 100 % (312 Hz); the whine is the compressor's
// blade-passing tones, the scream the power turbine's (about 16,000 rpm at the rated propeller speed,
// 9,500 rpm). Tuned by ear for the high, rising shriek of the class, not counted blade by blade.
export const T55_TURBINE: TurbineProfile = {
  label: 'Lycoming T55 turboshaft',
  idleN1: 0.6,
  compressor: { hz: [4100, 6240], gain: 0.092, partials: [1, 0.3, 0.12], beat: 0.0015 },
  powerTurbine: { hzAtRated: 2130, ratedRpm: 16_000, gain: 0.054, partials: [1, 0.5, 0.25, 0.12] },
  roar: { gain: 0.063, center: [420, 1500], q: 0.55 },
  hiss: { gain: 0.012, cutoff: 3600 },
  rumble: { gain: 0.78, cutoff: 150 },
  blades: { count: 3, gain: 0.18, q: 2.2, maxRpm: 10_000, thrustRef: 7500 },
  // At 160 mph from the chase camera about as loud as the other boats cruising (scripts/audio-levels.ts:
  // −23 LUFS on the engines bus at 100 %, against −24 for the center console and the jet ski).
  gain: 0.67,
};

export const HYDRO_SPRAY: SprayProfile = {
  thrustRef: 0.25 * 3062 * 9.81, // a quarter of its weight
  topSpeed: 89,
  rooster: { gain: 0.42, center: [380, 1100], hiss: 0.35, hissCutoff: 2600 },
  wind: { gain: 0.28, centers: [260, 820], q: 2.5 },
  slap: { rate: 5, gain: 0.45 },
};

export interface TurbineInput {
  n1: number; // gas-generator speed, share of rated
  power: number; // gas-generator power 0..1 (telemetry gasGenerator)
  turbineRpm: number; // power turbine
  propRpm: number;
  thrust: number; // N
  propEmersion: number; // 0 deep .. 1 out of the water
}

export interface TurbineParams {
  running: number; // 0 stopped .. 1 lit
  spool: number; // 0 at idle .. 1 at 100 % N1
  compressorFreq: [number, number]; // Hz before Doppler
  compressorGain: [number, number];
  turbineFreq: number;
  turbineGain: number;
  roarCenter: number;
  roarGain: number;
  hissGain: number;
  rumbleGain: number;
  bladeFreq: number; // blade-passing rate, Hz
  bladeGain: number;
  gain: number; // overall
}

export const createTurbineParams = (): TurbineParams => ({
  running: 0,
  spool: 0,
  compressorFreq: [1000, 1500],
  compressorGain: [0, 0],
  turbineFreq: 100,
  turbineGain: 0,
  roarCenter: 500,
  roarGain: 0,
  hissGain: 0,
  rumbleGain: 0,
  bladeFreq: 20,
  bladeGain: 0,
  gain: 0,
});

const finite = (v: number): number => (Number.isFinite(v) ? v : 0);

export function turbineParams(
  p: TurbineProfile,
  input: TurbineInput,
  out: TurbineParams = createTurbineParams(),
): TurbineParams {
  const n1 = Math.max(0, finite(input.n1));
  const power = clamp01(finite(input.power));
  const nt = Math.max(0, finite(input.turbineRpm)) / p.powerTurbine.ratedRpm;
  const prop = Math.max(0, finite(input.propRpm));
  const emersion = clamp01(finite(input.propEmersion));
  // Lit from a third of idle speed (winding down after the kill switch it fades out).
  const running = smoothstep(0.1, 0.35, n1);
  const spool = clamp01((n1 - p.idleN1) / (1 - p.idleN1));
  out.running = running;
  out.spool = spool;
  const c = p.compressor;
  out.compressorFreq[0] = Math.max(40, c.hz[0] * n1);
  out.compressorFreq[1] = Math.max(40, c.hz[1] * n1);
  // A turbine whines loudest spooled up, but it's there at idle too; the second stage comes in
  // with speed.
  out.compressorGain[0] = c.gain * (0.45 + 0.55 * spool);
  out.compressorGain[1] = c.gain * 0.6 * spool * spool;
  const pt = p.powerTurbine;
  out.turbineFreq = Math.max(40, pt.hzAtRated * Math.min(nt, 1.2));
  // The scream grows with the power turbine's speed, the more so unloaded (the propeller out).
  out.turbineGain = pt.gain * Math.pow(Math.min(nt, 1.2), 1.4) * (1 + 0.6 * emersion);
  const r = p.roar;
  out.roarCenter = lerp(r.center[0], r.center[1], spool);
  out.roarGain = r.gain * (0.12 + 0.88 * Math.pow(power, 0.7)) * running;
  out.hissGain = p.hiss.gain * Math.pow(power, 1.2) * running;
  const propNorm = clamp01(prop / p.blades.maxRpm);
  out.rumbleGain = p.rumble.gain * (0.15 + 0.85 * propNorm) * (0.4 + 0.6 * power);
  out.bladeFreq = Math.max(10, (prop / 60) * p.blades.count);
  // A half-immersed propeller slaps hardest; deep or out of the water it doesn't.
  const bite = Math.sqrt(clamp01(Math.max(0, finite(input.thrust)) / p.blades.thrustRef));
  out.bladeGain = p.blades.gain * bite * (1 - Math.abs(2 * emersion - 1) * 0.7) * propNorm;
  out.gain = p.gain * running;
  return out;
}

export interface SprayInput {
  speed: number; // m/s through the water
  thrust: number; // N
  airborne: number; // 0..1
  hs: number; // m
}

export interface SprayParams {
  roosterGain: number;
  roosterCenter: number; // Hz before Doppler
  roosterHiss: number;
  windGain: number;
  windCenters: [number, number];
  slapRate: number; // per second
  slapGain: number;
}

export const createSprayParams = (): SprayParams => ({
  roosterGain: 0,
  roosterCenter: 500,
  roosterHiss: 0,
  windGain: 0,
  windCenters: [200, 600],
  slapRate: 0,
  slapGain: 0,
});

export function sprayParams(
  p: SprayProfile,
  input: SprayInput,
  out: SprayParams = createSprayParams(),
): SprayParams {
  const s = clamp01(Math.max(0, finite(input.speed)) / p.topSpeed);
  const bite = Math.sqrt(clamp01(Math.max(0, finite(input.thrust)) / p.thrustRef));
  const air = clamp01(finite(input.airborne));
  // The rooster tail: as loud as it is tall (roosterShape: bite × speed^1.5), with a floor for the
  // propeller's churn at low speed.
  const tail = bite * (0.12 + 0.88 * Math.pow(s, 1.3));
  const r = p.rooster;
  out.roosterGain = r.gain * tail;
  out.roosterCenter = lerp(r.center[0], r.center[1], s);
  out.roosterHiss = r.gain * r.hiss * tail * s;
  const w = p.wind;
  out.windGain = w.gain * s * s;
  out.windCenters[0] = w.centers[0] * (0.7 + 0.6 * s);
  out.windCenters[1] = w.centers[1] * (0.7 + 0.6 * s);
  // Pads slapping crests: with the chop and the speed, not in a glassy calm or in the air.
  const chop = Math.min(Math.max(0, finite(input.hs)) / 0.5, 2);
  out.slapRate = p.slap.rate * chop * smoothstep(0.1, 0.6, s) * (1 - air);
  out.slapGain = p.slap.gain * (0.5 + 0.5 * s) * Math.min(1, 0.5 + chop / 2);
  return out;
}
