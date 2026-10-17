// Per-boat audio character: engine profiles (firing order and exhaust pulses, exhaust resonances,
// combustion and valve-train noise, turbo/supercharger/gear whine, a jet pump), horns, and hull data
// for water rush, slams and creaks. Pure data plus the RPM → engine-parameter mapping, so every
// profile is unit-tested. engineLoops.ts renders each engine's firing cycles from the same profile.

import type { BoatKind } from '../sim/world/protocol';
import { clamp01, lerp, smoothstep } from './curves';
import { HYDRO_SPRAY, type SprayProfile, T55_TURBINE, type TurbineProfile } from './turbine';

// A tonal whine: a turbocharger's compressor (pitch follows boost, which lags the throttle), a
// supercharger or a gear mesh (both locked to the crank).
interface WhineSpec {
  kind: 'turbo' | 'supercharger' | 'gear';
  hz: number; // at max rpm (turbo: at full boost)
  gain: number;
  load: number; // 0..1, share of the level that follows engine effort (the rest follows speed)
  spool?: number; // s, turbo lag
  partials: readonly number[]; // relative amplitudes of harmonics 1..n
}

interface Formant {
  hz: number; // fixed: pipe and muffler resonances don't move with rpm
  q: number;
  db: number;
}

export interface EngineProfile {
  label: string;
  stroke: 2 | 4;
  cylinders: number; // fired evenly: every 720°/n (four-stroke) or 360°/n (two-stroke)
  units: number; // engines heard together (twin outboards, generator sets), each its own loop
  detune: number; // speed offset between units (outboards drift apart; grid-locked generators don't)
  idleRpm: number;
  maxRpm: number;
  // Diesel-electric plants run their generators at a constant speed; `rpm` then drives the pod
  // motors only (motorHum) and the generator note follows load alone.
  fixedRpm?: number;
  // The firing loop (engineLoops.ts), in crank degrees so that it scales with rpm as the real
  // thing does.
  pulse: {
    width: number; // crank ° from exhaust-valve opening to the peak of the blowdown flow
    sharpness: number; // rise/decay exponent: high = a sharp crack, low = a soft (turbocharged) puff
    noise: number; // turbulent flow noise riding each pulse, relative to the pulse
  };
  banks?: readonly number[]; // bank of each firing in firing order (cross-plane V8: L R R L R L L R)
  bankGain?: readonly number[]; // relative level of each bank's pulses where the exhausts merge
  bankLag?: readonly number[]; // crank ° each bank's pulses arrive late there (runner lengths)
  spread: number; // fixed cylinder-to-cylinder level spread, fraction
  jitter: { deg: number; level: number }; // cycle-to-cycle timing (crank °) and level spread
  light: { level: number; misfire: number; pop: number }; // closed throttle: level, P(miss), P(pop)
  blades?: { count: number; level: number }; // direct-drive propeller: blade-rate hull pressure pulses
  cycles: number; // engine cycles per loop: how long before the irregularities repeat
  // Live shaping of the firing note:
  brightness: readonly [number, number]; // low-pass cutoff in multiples of f0 at effort 0 and 1
  cutoffRange: readonly [number, number]; // Hz clamp on that cutoff
  formants: readonly Formant[]; // exhaust pipe, muffler and funnel resonances
  // Outboards exhaust through the propeller hub: under way the note goes under water (quieter,
  // muffled) and the cowl's mechanical sounds take over. rpm span of the change, level and cutoff.
  hub?: { rpm: readonly [number, number]; level: number; cutoff: number };
  // Block-radiated combustion noise (diesel clatter) or petrol intake roar: band-passed noise gated
  // per firing. `idle` adds level at light load and low rpm (diesel knock is loudest at idle).
  combustion: { gain: number; center: number; q: number; depth: number; idle: number };
  tick?: { gain: number; center: number }; // valve-train tick of small petrol engines
  whines: readonly WhineSpec[];
  motorHum?: { hzPerRpm: number; gain: number }; // electric pod motors
  hum?: { hz: number; gain: number }; // mains-frequency electrical hum
  // Jet pump: the water roar (a band rising with rpm) and the nozzle's hiss.
  pump?: { gain: number; center: readonly [number, number]; hiss: number; cutoff: number };
  wobble: number; // idle-speed hunting, fraction of rpm
  gain: number;
}

interface HornProfile {
  fundamental: number; // Hz
  partials: readonly number[]; // relative amplitudes of harmonics 1..n
  attack: number; // s
  release: number; // s
  bend: number; // starts this fraction flat and rises to pitch during the attack
  cutoff: number; // Hz, brightness
  voices: number; // detuned copies (multi-trumpet ship horns)
  gain: number;
}

export interface BoatAudioProfile {
  engine: EngineProfile | null; // a piston engine (EngineSynth), or
  turbine?: TurbineProfile; // a gas turbine (TurbineSynth: the hydroplane)
  spray?: SprayProfile; // a rooster tail, wind rush and chop slap at racing speed (the hydroplane)
  horn: HornProfile;
  hullScale: number; // 0 = jet ski .. 1 = big ship: pitch and weight of hull sounds
  topSpeed: number; // m/s, normalizes the water rush
  refDistance: number; // m, Web Audio inverse-distance reference (≈ source size)
  cullDistance: number; // m, beyond this the boat is silent
  creaks: boolean; // wooden/composite creaks in big seas
  rigging: boolean; // standing rigging hum and sail sounds
}

// Container ship: a MAN B&W 6K98-type slow-speed two-stroke (6 × 6 MW at 104 rpm, the KCS design
// point) driving the propeller directly. It fires 10 times a second at full speed and 2–3 at dead
// slow, so it's heard as a throb: each firing a knock through the hull, the five-bladed propeller's
// pressure pulses beating against the six cylinders, the engine-room clatter and the turbochargers'
// whine, all through the funnel and the steelwork.
const CARGO_ENGINE: EngineProfile = {
  label: 'Slow-speed two-stroke diesel',
  stroke: 2,
  cylinders: 6,
  units: 1,
  detune: 0,
  idleRpm: 25,
  maxRpm: 104,
  pulse: { width: 3.5, sharpness: 4, noise: 0.3 },
  spread: 0.06,
  jitter: { deg: 0.8, level: 0.05 },
  light: { level: 0.55, misfire: 0, pop: 0 },
  blades: { count: 5, level: 0.25 },
  cycles: 8,
  brightness: [9, 30],
  cutoffRange: [90, 700],
  formants: [
    { hz: 48, q: 1.1, db: 6 }, // engine-room and hull
    { hz: 190, q: 1.4, db: 4 }, // funnel
  ],
  combustion: { gain: 0.2, center: 260, q: 0.9, depth: 0.85, idle: 0 },
  // Felt more than heard: the turbochargers only just show above the throb.
  whines: [{ kind: 'turbo', hz: 2600, gain: 0.045, load: 0.8, spool: 6, partials: [1, 0.15] }],
  wobble: 0.004,
  gain: 0.75,
};

// Cruise ship: medium-speed generator sets (16 cylinders, 514 rpm for 60 Hz) feeding two Azipods.
// Sets on one switchboard are locked to the grid frequency: a steady hum and turbo whine that thicken
// with load, plus the pods' electric motors.
const CRUISE_ENGINE: EngineProfile = {
  label: 'Diesel-electric generators and pods',
  stroke: 4,
  cylinders: 16,
  units: 2,
  detune: 0,
  idleRpm: 0,
  maxRpm: 145,
  fixedRpm: 514,
  pulse: { width: 10, sharpness: 2.5, noise: 0.2 },
  spread: 0.04,
  jitter: { deg: 0.6, level: 0.04 },
  light: { level: 0.6, misfire: 0, pop: 0 },
  cycles: 24,
  brightness: [2, 5],
  cutoffRange: [100, 600],
  formants: [
    { hz: 70, q: 1.3, db: 7 }, // funnel and engine casing: the deep hum
    { hz: 240, q: 2, db: 3 },
  ],
  combustion: { gain: 0.05, center: 450, q: 0.8, depth: 0.6, idle: 0 },
  whines: [{ kind: 'turbo', hz: 3400, gain: 0.08, load: 0.8, spool: 3, partials: [1, 0.15] }],
  motorHum: { hzPerRpm: 6, gain: 0.08 },
  hum: { hz: 60, gain: 0.09 },
  wobble: 0.0015,
  gain: 0.7, // darker, so a little more level to stay as present
};

// Crab boat: a turbocharged V12 marine diesel (Cat 3512 class), 650 idle to 1800 rpm through a
// reduction gear: a deep rumble from the dry stack, diesel clatter that's loudest at idle, the
// turbo's whistle spooling up behind the throttle and the gearbox's whine.
const CRAB_ENGINE: EngineProfile = {
  label: 'Marine V12 diesel',
  stroke: 4,
  cylinders: 12,
  units: 1,
  detune: 0,
  idleRpm: 650,
  maxRpm: 1800,
  pulse: { width: 12, sharpness: 2.2, noise: 0.35 },
  spread: 0.07,
  jitter: { deg: 1, level: 0.07 },
  light: { level: 0.5, misfire: 0.01, pop: 0 },
  cycles: 64,
  brightness: [2.2, 6.5],
  cutoffRange: [120, 1800],
  formants: [
    { hz: 85, q: 1.5, db: 7 }, // ~5 m dry stack: the deep rumble
    { hz: 320, q: 2.2, db: 4 }, // muffler
  ],
  combustion: { gain: 0.1, center: 1100, q: 1.1, depth: 0.85, idle: 1 },
  whines: [
    { kind: 'turbo', hz: 4600, gain: 0.09, load: 0.85, spool: 1.5, partials: [1, 0.2] },
    { kind: 'gear', hz: 930, gain: 0.03, load: 0.6, partials: [1, 0.4, 0.15] }, // reduction gear
  ],
  wobble: 0.006,
  gain: 0.85, // darker, so a little more level to stay as present
};

// Center console: twin 300 hp four-stroke V8 outboards (cross-plane: each bank fires unevenly, so
// the merged exhaust burbles), 650 idle to 6000 rpm. At idle the exhaust escapes through the idle
// relief ports above the water; under way it leaves through the propeller hub, under water, and the
// cowl's intake roar, valve train and the gearcase's whine take over.
const OUTBOARD_ENGINE: EngineProfile = {
  label: 'Twin V8 four-stroke outboards',
  stroke: 4,
  cylinders: 8,
  units: 2,
  detune: 0.004,
  idleRpm: 650,
  maxRpm: 6000,
  pulse: { width: 10, sharpness: 3, noise: 0.3 },
  banks: [0, 1, 1, 0, 1, 0, 0, 1],
  bankGain: [1, 0.72],
  bankLag: [0, 6],
  spread: 0.08,
  jitter: { deg: 1.4, level: 0.09 },
  light: { level: 0.45, misfire: 0.015, pop: 0.006 },
  cycles: 128,
  brightness: [2.5, 8],
  cutoffRange: [180, 4000],
  formants: [
    { hz: 240, q: 1.6, db: 5 }, // idle relief and midsection
    { hz: 900, q: 2.5, db: 4 }, // cowl
  ],
  hub: { rpm: [1400, 3200], level: 0.7, cutoff: 0.45 },
  combustion: { gain: 0.055, center: 1100, q: 0.7, depth: 0.5, idle: 0.3 },
  tick: { gain: 0.05, center: 5200 },
  whines: [{ kind: 'gear', hz: 1500, gain: 0.095, load: 0.5, partials: [1, 0.45, 0.2] }], // pinion mesh
  wobble: 0.008,
  gain: 0.9,
};

// Jet ski: a supercharged 1.6 l four-stroke triple up to ~8000 rpm. Firing every 240° with sharp,
// uneven pulses makes the triple's rasp; the supercharger whines with boost, and at speed the axial
// pump's water roar and the nozzle's hiss take over.
const PWC_ENGINE: EngineProfile = {
  label: 'Supercharged three-cylinder',
  stroke: 4,
  cylinders: 3,
  units: 1,
  detune: 0,
  idleRpm: 1600,
  maxRpm: 8000,
  pulse: { width: 20, sharpness: 3, noise: 0.45 },
  spread: 0.12,
  jitter: { deg: 1.8, level: 0.12 },
  light: { level: 0.45, misfire: 0.04, pop: 0.008 },
  cycles: 160,
  brightness: [3, 12],
  cutoffRange: [220, 5000],
  formants: [
    { hz: 300, q: 1.8, db: 5 }, // water box
    { hz: 1300, q: 2.5, db: 5 }, // tail pipe: the rasp
  ],
  combustion: { gain: 0.1, center: 1800, q: 0.8, depth: 0.6, idle: 0.2 },
  tick: { gain: 0.13, center: 4200 },
  whines: [{ kind: 'supercharger', hz: 6000, gain: 0.12, load: 0.7, partials: [1, 0.25] }],
  pump: { gain: 0.13, center: [350, 1100], hiss: 0.5, cutoff: 2200 },
  wobble: 0.008,
  gain: 0.5,
};

// COLREG Annex III horn ranges: ≥200 m 70–200 Hz; 75–200 m 130–350 Hz; <75 m 250–700 Hz.
const SHIP_HORN = (fundamental: number, voices: number): HornProfile => ({
  fundamental,
  partials: [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.22, 0.16, 0.12, 0.08],
  attack: 0.25,
  release: 0.5,
  bend: 0.06,
  cutoff: fundamental * 9,
  voices,
  gain: 0.5,
});

export const BOAT_AUDIO: Readonly<Record<BoatKind, BoatAudioProfile>> = {
  cargo: {
    engine: CARGO_ENGINE,
    horn: SHIP_HORN(75, 1),
    hullScale: 1,
    topSpeed: 12.3,
    refDistance: 40,
    cullDistance: 9000,
    creaks: false,
    rigging: false,
  },
  cruise: {
    engine: CRUISE_ENGINE,
    horn: SHIP_HORN(110, 2),
    hullScale: 1,
    topSpeed: 12.3,
    refDistance: 40,
    cullDistance: 9000,
    creaks: false,
    rigging: false,
  },
  crab: {
    engine: CRAB_ENGINE,
    horn: {
      fundamental: 220,
      partials: [1, 0.7, 0.5, 0.35, 0.25, 0.16, 0.1],
      attack: 0.08,
      release: 0.25,
      bend: 0.03,
      cutoff: 2600,
      voices: 1,
      gain: 0.45,
    },
    hullScale: 0.55,
    topSpeed: 6.4,
    refDistance: 12,
    cullDistance: 5000,
    creaks: true,
    rigging: false,
  },
  sail: {
    engine: null,
    horn: {
      fundamental: 420,
      partials: [1, 0.5, 0.35, 0.2, 0.12],
      attack: 0.03,
      release: 0.12,
      bend: 0.02,
      cutoff: 3500,
      voices: 1,
      gain: 0.4,
    },
    hullScale: 0.3,
    topSpeed: 5,
    refDistance: 5,
    cullDistance: 2500,
    creaks: true,
    rigging: true,
  },
  powerboat: {
    engine: OUTBOARD_ENGINE,
    horn: {
      fundamental: 400,
      partials: [1, 0.6, 0.45, 0.3, 0.2, 0.12],
      attack: 0.02,
      release: 0.1,
      bend: 0.01,
      cutoff: 4000,
      voices: 2, // twin-trumpet electric horn
      gain: 0.4,
    },
    hullScale: 0.25,
    topSpeed: 24,
    refDistance: 5,
    cullDistance: 3000,
    creaks: false,
    rigging: false,
  },
  pwc: {
    engine: PWC_ENGINE,
    // A small electronic beep: square-ish, bright, no pitch bend.
    horn: {
      fundamental: 880,
      partials: [1, 0, 0.33, 0, 0.2, 0, 0.14],
      attack: 0.005,
      release: 0.03,
      bend: 0,
      cutoff: 6000,
      voices: 1,
      gain: 0.25,
    },
    hullScale: 0,
    topSpeed: 30,
    refDistance: 3,
    cullDistance: 2500,
    creaks: false,
    rigging: false,
  },
  // A Lycoming T55 turboshaft (turbine.ts) and the roar of its rooster tail; a small electric horn.
  hydro: {
    engine: null,
    turbine: T55_TURBINE,
    spray: HYDRO_SPRAY,
    horn: {
      fundamental: 420,
      partials: [1, 0.6, 0.45, 0.3, 0.2, 0.12],
      attack: 0.02,
      release: 0.1,
      bend: 0.01,
      cutoff: 4000,
      voices: 1,
      gain: 0.4,
    },
    hullScale: 0.2,
    topSpeed: 89,
    refDistance: 8,
    cullDistance: 5000,
    creaks: false,
    rigging: false,
  },
};

// Firing frequency of the prime mover, Hz: a four-stroke fires each cylinder every second
// revolution, a two-stroke every revolution.
export function engineFundamental(profile: EngineProfile, rpm: number): number {
  const shaft = profile.fixedRpm ?? Math.max(0, rpm);
  return (shaft / 60) * profile.cylinders * (profile.stroke === 2 ? 1 : 0.5);
}

// Engine cycle length in crank degrees, and the even firing interval.
export const cycleDegrees = (profile: EngineProfile): number => (profile.stroke === 2 ? 360 : 720);
export const firingInterval = (profile: EngineProfile): number => cycleDegrees(profile) / profile.cylinders;

// Torque as a fraction of rated: how hard the cylinders are working. The sims report load as power
// (torque × speed), so at a given rpm it's load / (rpm / max). On the propeller curve it grows with
// rpm²; a throttle step reads near 1 while the shaft catches up, and closing the throttle at speed
// reads near 0 (overrun).
export function engineEffort(profile: EngineProfile, rpm: number, load: number): number {
  const l = clamp01(Math.abs(Number.isFinite(load) ? load : 0));
  if (profile.fixedRpm !== undefined) return l; // generator sets: the plant's load
  const shaft = Math.max(0, Number.isFinite(rpm) ? rpm : 0) / profile.maxRpm;
  return clamp01(l / Math.max(shaft, 0.25));
}

// Turbo boost the exhaust can sustain, 0..1: half from shaft speed, half from power. The turbo lags
// towards it (lagToward with the whine's spool time).
export function boostTarget(profile: EngineProfile, rpm: number, load: number): number {
  const shaft = profile.fixedRpm !== undefined ? 1 : clamp01(Math.max(0, rpm) / profile.maxRpm);
  return clamp01(0.5 * shaft + 0.5 * Math.sqrt(clamp01(Math.abs(load))));
}

// One-pole lag of `value` towards `target` over dt: exact for any frame time, so it doesn't depend
// on the frame rate. tau ≤ 0 (or a bad value) jumps; a bad target is ignored.
export function lagToward(value: number, target: number, dt: number, tau: number): number {
  if (!Number.isFinite(target)) return value;
  if (tau <= 0 || !Number.isFinite(value)) return target;
  return target + (value - target) * Math.exp(-Math.max(0, dt) / tau);
}

export const MAX_WHINES = 2;

export interface EngineParams {
  running: number; // 0 = stopped .. 1 = running
  shaftRpm: number; // speed the firing loop plays at (the generators' for diesel-electric)
  f0: number; // Hz, firing frequency (before Doppler)
  rpmNorm: number; // 0 at idle .. 1 at max
  effort: number; // torque fraction (engineEffort), less what an airborne pump unloads
  onLoad: number; // cross-fade of the firing loop: 1 = working pulses, 0 = closed-throttle pulses
  toneGain: number; // firing note (exhaust) level
  cutoff: number; // Hz, low-pass on the firing note
  combustionGain: number;
  combustionCenter: number; // Hz
  tickGain: number;
  boost: number; // turbo boost 0..1 the whines used
  boostTarget: number; // boost the exhaust can sustain now, which the turbo spools towards
  whineFreq: number[]; // per profile whine, Hz
  whineGain: number[];
  motorFreq: number;
  motorGain: number;
  humGain: number;
  pumpGain: number;
  pumpCenter: number; // Hz
  hissGain: number;
  burble: number; // 0..1 ventilation burble (airborne jet ski)
  gain: number; // overall
}

export const createEngineParams = (): EngineParams => ({
  running: 0,
  shaftRpm: 0,
  f0: 0,
  rpmNorm: 0,
  effort: 0,
  onLoad: 0,
  toneGain: 0,
  cutoff: 100,
  combustionGain: 0,
  combustionCenter: 1000,
  tickGain: 0,
  boost: 0,
  boostTarget: 0,
  whineFreq: Array.from({ length: MAX_WHINES }, () => 100),
  whineGain: Array.from({ length: MAX_WHINES }, () => 0),
  motorFreq: 100,
  motorGain: 0,
  humGain: 0,
  pumpGain: 0,
  pumpCenter: 500,
  hissGain: 0,
  burble: 0,
  gain: 0,
});

// rpm: shaft rpm (pods for diesel-electric); load 0..1 (power / rated); airborne 0..1. `boost` is
// the lagged turbo boost EngineSynth keeps; omitted, the steady-state boostTarget.
export function engineParams(
  profile: EngineProfile,
  rpm: number,
  load: number,
  airborne: number,
  out: EngineParams = createEngineParams(),
  boost?: number,
): EngineParams {
  const r = Math.max(0, Number.isFinite(rpm) ? rpm : 0);
  const air = clamp01(Number.isFinite(airborne) ? airborne : 0);
  // Out of the water the pump unloads: the engine screams with no load behind it.
  const l = clamp01(Math.abs(Number.isFinite(load) ? load : 0)) * (1 - 0.85 * air);
  const generator = profile.fixedRpm !== undefined;
  const running = generator ? 1 : smoothstep(0.2 * profile.idleRpm, 0.6 * profile.idleRpm, r);
  const span = Math.max(1, profile.maxRpm - profile.idleRpm);
  const rpmNorm = generator ? clamp01(r / profile.maxRpm) : clamp01((r - profile.idleRpm) / span);
  const effort = engineEffort(profile, r, l);
  const bright = Math.max(effort, 0.6 * air);
  const hub = profile.hub ? smoothstep(profile.hub.rpm[0], profile.hub.rpm[1], r) : 0;
  const f0 = engineFundamental(profile, r);
  const [lo, hi] = profile.cutoffRange;
  const cutoff = Math.min(hi, Math.max(lo, f0 * lerp(profile.brightness[0], profile.brightness[1], bright)));
  out.running = running;
  out.shaftRpm = profile.fixedRpm ?? r;
  out.f0 = f0;
  out.rpmNorm = rpmNorm;
  out.effort = effort;
  out.onLoad = smoothstep(0, 0.6, bright);
  out.toneGain = profile.hub ? lerp(1, profile.hub.level, hub) : 1;
  out.cutoff = profile.hub ? cutoff * lerp(1, profile.hub.cutoff, hub) : cutoff;
  const c = profile.combustion;
  out.combustionGain = c.gain * (0.35 + 0.65 * effort + c.idle * (1 - effort) * (1 - rpmNorm) + 0.4 * air);
  out.combustionCenter = c.center * (1 + 0.25 * rpmNorm);
  out.tickGain = profile.tick ? profile.tick.gain * (0.6 + 0.4 * rpmNorm) : 0;
  out.boostTarget = boostTarget(profile, r, l);
  const b = clamp01(boost ?? out.boostTarget);
  out.boost = b;
  const shaft = clamp01(r / profile.maxRpm);
  for (let i = 0; i < MAX_WHINES; i++) {
    const w = profile.whines[i];
    if (!w) {
      out.whineGain[i] = 0;
      continue;
    }
    const work = 1 - w.load + w.load * bright;
    if (w.kind === 'turbo') {
      out.whineFreq[i] = w.hz * (0.25 + 0.75 * b);
      out.whineGain[i] = w.gain * Math.pow(b, 1.5) * work;
    } else {
      out.whineFreq[i] = Math.max(20, w.hz * shaft);
      out.whineGain[i] = w.gain * (w.kind === 'gear' ? Math.pow(rpmNorm, 1.5) : rpmNorm) * work;
    }
  }
  out.motorFreq = profile.motorHum ? Math.max(40, r * profile.motorHum.hzPerRpm) : 100;
  out.motorGain = profile.motorHum ? profile.motorHum.gain * rpmNorm * (0.4 + 0.6 * l) : 0;
  out.humGain = profile.hum ? profile.hum.gain * (0.6 + 0.4 * l) : 0;
  const pump = profile.pump;
  out.pumpCenter = pump ? lerp(pump.center[0], pump.center[1], rpmNorm) : 500;
  out.pumpGain = pump ? pump.gain * Math.pow(rpmNorm, 1.2) * (1 - 0.6 * air) : 0;
  out.hissGain = pump ? pump.gain * pump.hiss * Math.pow(rpmNorm, 1.5) * (1 - 0.6 * air) : 0;
  out.burble = air;
  // Generators get louder with load (more sets online); others mostly with rpm. The working pulses
  // are louder than the closed-throttle ones on top of this (light.level in the loop).
  const level = generator ? 0.55 + 0.45 * l : (0.25 + 0.75 * rpmNorm) * (0.8 + 0.2 * effort);
  out.gain = profile.gain * running * level;
  return out;
}
