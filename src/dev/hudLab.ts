// HUD lab (dev only, /dev/hud-lab.html): the HUD over a moving horizon, fed with animated
// mock data for every boat type and a set of scenarios (sailing points, heavy weather,
// collision course, lights off). URL params make any state reproducible for screenshots,
// e.g. ?boat=sail&scenario=beam-reach&night=1&t=12&ui=0.

import '../styles/base.css';
import { TELEGRAPH_NOTCHES } from '../input/axes';
import { lightFittings } from '../render/boats/lights/groups';
import type { HudMode, LengthUnit, SpeedUnit, WindUnit } from '../settings/schema';
import { DEG, normalizeHeading, signedAngle } from '../sim/core/conventions';
import { knotsToMs, msToKnots } from '../sim/core/units';
import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';
import { evaluateAlerts } from '../ui/hud/alerts';
import { beaufortFromMs, douglasFromHs } from '../ui/hud/format';
import { hintRowsFor } from '../ui/hud/hints';
import { DEFAULT_HUD_SETTINGS, Hud } from '../ui/hud/Hud';
import type {
  ConditionsState,
  FleetEntry,
  HudModel,
  LightSignal,
  Propulsion,
  SailingState,
  StabilityInfo,
  TrimState,
} from '../ui/hud/model';
import { dangerZoneFromGz } from '../ui/hud/motion';
import { idealSheetAngles, isGybeZone, pointOfSail } from '../ui/hud/sailing';

type Scenario =
  | 'cruise'
  | 'heavy'
  | 'collision'
  | 'lights-off'
  | 'drifting'
  | 'close-hauled'
  | 'beam-reach'
  | 'broad-reach'
  | 'run'
  | 'in-irons'
  | 'gybe-danger'
  | 'overpowered';

const POWERED_SCENARIOS: readonly Scenario[] = ['cruise', 'heavy', 'collision', 'lights-off', 'drifting'];
const SAIL_SCENARIOS: readonly Scenario[] = [
  'close-hauled',
  'beam-reach',
  'broad-reach',
  'run',
  'in-irons',
  'gybe-danger',
  'overpowered',
  'heavy',
  'collision',
];

interface BoatSpec {
  name: string;
  speedKn: number;
  rollAmp: number; // deg in fair weather
  rollPeriod: number; // s
  pitchAmp: number;
  stability: StabilityInfo;
}

// GZ curve shaped like the YD-41 data for the sailboat.
const SAIL_GZ = [0, 0.4, 0.72, 0.95, 1.1, 1.12, 1.05, 0.92, 0.75, 0.55, 0.35, 0.16, -0.02, -0.2].map(
  (gz, i) => ({
    heel: i * 10 * DEG,
    gz,
  }),
);

const BOATS: Record<BoatKind, BoatSpec> = {
  cargo: {
    name: 'Northern Meridian',
    speedKn: 22,
    rollAmp: 2,
    rollPeriod: 22,
    pitchAmp: 0.6,
    stability: { dangerHeel: 35 * DEG, avs: 65 * DEG },
  },
  cruise: {
    name: 'Solstice Dawn',
    speedKn: 20,
    rollAmp: 1.5,
    rollPeriod: 18,
    pitchAmp: 0.5,
    stability: { dangerHeel: 30 * DEG, avs: 60 * DEG },
  },
  crab: {
    name: 'Aleutian Pride',
    speedKn: 10.5,
    rollAmp: 6,
    rollPeriod: 8,
    pitchAmp: 3,
    stability: { dangerHeel: 28 * DEG, avs: 58 * DEG },
  },
  sail: {
    name: 'Wind Dancer',
    speedKn: 7,
    rollAmp: 3,
    rollPeriod: 5,
    pitchAmp: 2.5,
    stability: dangerZoneFromGz(SAIL_GZ, 100 * DEG),
  },
  powerboat: {
    name: 'Reel Deal',
    speedKn: 38,
    rollAmp: 4,
    rollPeriod: 3.5,
    pitchAmp: 4,
    stability: { dangerHeel: 40 * DEG, avs: 75 * DEG },
  },
  pwc: {
    name: 'Spray',
    speedKn: 45,
    rollAmp: 6,
    rollPeriod: 2.5,
    pitchAmp: 5,
    stability: { dangerHeel: 35 * DEG, avs: 70 * DEG },
  },
  hydro: {
    name: 'Sea Fury',
    speedKn: 140,
    rollAmp: 1,
    rollPeriod: 1,
    pitchAmp: 1.5,
    stability: { dangerHeel: 60 * DEG, avs: 88 * DEG },
  },
};

interface LabState {
  boat: BoatKind;
  scenario: Scenario;
  night: boolean;
  autoTrim: boolean;
  fleet: boolean;
  frozen: number | null;
}

const params = new URLSearchParams(location.search);
const pick = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const value = params.get(name) as T | null;
  return value && allowed.includes(value) ? value : fallback;
};
const flag = (name: string, fallback: boolean): boolean => {
  const v = params.get(name);
  return v === null ? fallback : v === '1' || v === 'true';
};

const initialBoat = pick<BoatKind>('boat', BOAT_KINDS, 'cargo');
const state: LabState = {
  boat: initialBoat,
  scenario: pick<Scenario>(
    'scenario',
    initialBoat === 'sail' ? SAIL_SCENARIOS : POWERED_SCENARIOS,
    initialBoat === 'sail' ? 'beam-reach' : 'cruise',
  ),
  night: flag('night', false),
  autoTrim: flag('auto', false),
  fleet: flag('fleet', true),
  frozen: params.has('t') ? Number(params.get('t')) : null,
};

const app = document.getElementById('app') ?? document.body;
const hud = new Hud(app, {
  mode: pick<HudMode>('mode', ['full', 'minimal', 'off'], 'full'),
  scale: Number(params.get('scale') ?? DEFAULT_HUD_SETTINGS.scale) || 1,
  nightDimming: flag('dim', true) ? 'auto' : 'off',
  redNightTint: flag('red', false),
  controlHints: flag('hints', true),
  radar: flag('radar', true),
  units: {
    speed: pick<SpeedUnit>('speed', ['kn', 'mph', 'kmh'], 'kn'),
    length: pick<LengthUnit>('length', ['m', 'ft'], 'm'),
    wind: pick<WindUnit>('wind', ['kn', 'ms', 'beaufort'], 'kn'),
  },
});

// ---------------------------------------------------------------------------
// Mock model

const heavy = (): boolean => state.scenario === 'heavy' || state.scenario === 'overpowered';

// C&C 115 polar at 10 kn TWS (ORC), interpolated by TWA; scaled gently with wind speed.
const POLAR: readonly [number, number][] = [
  [0, 0],
  [30, 2.5],
  [40, 5.6],
  [52, 7.29],
  [90, 7.77],
  [120, 7.74],
  [150, 6.73],
  [180, 5.9],
];

function polarKn(twaDeg: number, twsKn: number): number {
  const a = Math.abs(twaDeg);
  let speed = 0;
  for (let i = 1; i < POLAR.length; i++) {
    const [a0, s0] = POLAR[i - 1];
    const [a1, s1] = POLAR[i];
    if (a <= a1) {
      speed = s0 + ((s1 - s0) * (a - a0)) / (a1 - a0);
      break;
    }
  }
  return speed * Math.min(1.25, Math.pow(twsKn / 10, 0.45));
}

const SAIL_TWA: Partial<Record<Scenario, number>> = {
  'close-hauled': 44,
  'beam-reach': 90,
  'broad-reach': 135,
  run: 168,
  'in-irons': 8,
  'gybe-danger': 176,
  overpowered: 50,
  heavy: 70,
  collision: 95,
};

// Sheet error per scenario (degrees past the ideal angle; + eased too far, − over-trimmed).
const SAIL_ERRORS: Partial<Record<Scenario, [number, number]>> = {
  'close-hauled': [9, 1],
  'beam-reach': [0, -10],
  'broad-reach': [-12, 7],
  run: [1, 0],
  'in-irons': [12, 14],
  'gybe-danger': [0, 0],
  overpowered: [0, 0],
};

function trimFrom(error: number): TrimState {
  return error > 4.5 ? 'luffing' : error < -4.5 ? 'stalled' : 'optimal';
}

function flowFor(state: TrimState, wind: 'windward' | 'leeward' | 'leech'): number {
  if (state === 'optimal') return 0.95;
  if (state === 'luffing') return wind === 'windward' ? 0.1 : wind === 'leech' ? 0.55 : 0.85;
  return wind === 'leeward' ? -0.6 : wind === 'leech' ? -0.4 : 0.9;
}

function sailing(t: number, twsMs: number): SailingState {
  const s = state.scenario;
  const twaDeg = (SAIL_TWA[s] ?? 90) + Math.sin(t * 0.35) * 3;
  const twa = twaDeg * DEG;
  const twsKn = msToKnots(twsMs);
  const inIrons = s === 'in-irons';
  const targetKn = polarKn(twaDeg, twsKn);
  const speedKn = inIrons ? 0.6 + Math.sin(t * 0.5) * 0.3 : targetKn * (s === 'close-hauled' ? 0.86 : 0.97);
  const v = knotsToMs(speedKn);
  // Apparent wind in the boat frame (x starboard, y ahead).
  const ax = twsMs * Math.sin(twa);
  const ay = twsMs * Math.cos(twa) + v;
  const awa = Math.atan2(ax, ay);
  const aws = Math.hypot(ax, ay);
  const ideal = idealSheetAngles(awa);
  const [mainErr, jibErr] = state.autoTrim ? [0, 0] : (SAIL_ERRORS[s] ?? [0, 0]);
  const side = Math.sign(ideal.boom) || 1;
  const wobble = Math.sin(t * 0.8) * 1.2;
  const boom =
    s === 'gybe-danger'
      ? side * (80 + Math.sin(t * 1.3) * 6) * DEG
      : ideal.boom + side * (mainErr + wobble) * DEG;
  const jib = ideal.jib + side * jibErr * DEG;
  const mainTrim = trimFrom(mainErr);
  const jibTrim = trimFrom(jibErr);
  const heelDeg =
    s === 'overpowered'
      ? 31 + Math.sin(t * 0.6) * 4
      : s === 'heavy'
        ? 24
        : inIrons
          ? 1
          : 12 * Math.max(0.2, Math.cos(twa * 0.8));
  const heel = -Math.sign(twa) * heelDeg * DEG; // heels to leeward
  return {
    tws: twsMs,
    twa,
    aws,
    awa,
    pointOfSail: pointOfSail(twa),
    boomAngle: boom,
    jibAngle: jib,
    idealBoomAngle: ideal.boom,
    idealJibAngle: ideal.jib,
    mainTrim,
    jibTrim,
    telltales: {
      jibWindward: flowFor(jibTrim, 'windward'),
      jibLeeward: flowFor(jibTrim, 'leeward'),
      mainLeech: flowFor(mainTrim, 'leech'),
    },
    reef: s === 'heavy' ? 2 : s === 'overpowered' ? 0 : 0,
    jibFurl: s === 'heavy' ? 0.4 : 0,
    autoTrim: state.autoTrim,
    heel,
    vmg: v * Math.cos(twa),
    targetSpeed: knotsToMs(targetKn),
    targetPct: targetKn > 0.1 ? speedKn / targetKn : 0,
    bestUpwindTwa: 43 * DEG,
    bestDownwindTwa: 148 * DEG,
    gybeDanger: s === 'gybe-danger' || (s === 'run' && isGybeZone(twa, 10 * DEG)),
    inIrons,
  };
}

function propulsion(kind: BoatKind, t: number, speedFrac: number): Propulsion | null {
  const steer = Math.sin(t * 0.25) * 0.5 + (state.scenario === 'heavy' ? Math.sin(t * 1.1) * 0.45 : 0);
  const drifting = state.scenario === 'drifting';
  switch (kind) {
    case 'cargo':
    case 'crab': {
      const notch = drifting ? 4 : state.scenario === 'heavy' ? 7 : 8;
      const value = TELEGRAPH_NOTCHES[notch].value;
      const maxRpm = kind === 'cargo' ? 104 : 380;
      const response = value * (0.92 + Math.sin(t * 0.4) * 0.04);
      const order = Math.round(steer * 35) * DEG;
      return {
        type: 'ship',
        telegraph: { notch, lever: value, response },
        shaftRpm:
          response * maxRpm * (state.scenario === 'heavy' ? 1 + Math.max(0, Math.sin(t * 0.9)) * 0.12 : 1),
        maxRpm,
        engineLoad: Math.abs(response) * (0.85 + Math.sin(t * 0.7) * 0.08),
        rudderOrder: order,
        rudderAngle: order * (0.75 + Math.sin(t * 0.6) * 0.15),
        rudderMax: 35 * DEG,
        bowThruster: drifting ? Math.sin(t * 0.3) * 0.7 : 0,
        thrusterAvailable: speedFrac < 0.25,
      };
    }
    case 'cruise': {
      const notch = drifting ? 4 : 7;
      const value = TELEGRAPH_NOTCHES[notch].value;
      const angle = steer * 30 * DEG;
      return {
        type: 'pods',
        telegraph: { notch, lever: value, response: value * 0.95 },
        pods: [
          { angle, thrust: value * 0.95 },
          { angle: angle * 0.96, thrust: value * 0.93 },
        ],
        powerLoad: Math.abs(value) * 0.9,
        bowThruster: drifting ? -0.55 : 0,
        thrusterAvailable: speedFrac < 0.25,
      };
    }
    case 'powerboat': {
      const throttle = drifting ? 0 : state.scenario === 'heavy' ? 0.55 + Math.sin(t * 0.8) * 0.2 : 0.82;
      const rpm = 650 + throttle * 5200 + Math.sin(t * 3) * 60;
      return {
        type: 'outboards',
        engines: [
          { throttle, rpm, maxRpm: 6000, trim: 0.38 },
          { throttle, rpm: rpm - 40, maxRpm: 6000, trim: 0.38 },
        ],
        steering: steer * 30 * DEG,
        steeringMax: 30 * DEG,
      };
    }
    case 'pwc': {
      const braking = state.scenario === 'drifting';
      const throttle = braking ? 0.15 : 0.7 + Math.sin(t * 0.9) * 0.25;
      return {
        type: 'jet',
        throttle,
        rpm: 1500 + throttle * 6300,
        maxRpm: 8000,
        nozzle: steer * 22 * DEG,
        nozzleMax: 22 * DEG,
        bucket: braking ? (Math.sin(t) > 0 ? 'brake' : 'reverse') : 'ahead',
      };
    }
    case 'hydro': {
      // The lever opening and closing every few seconds, N1 spooling after it.
      const lever = drifting ? 0 : 0.6 + 0.4 * Math.sign(Math.sin(t * 0.8));
      const n1Order = 0.6 + 0.4 * Math.sqrt(lever);
      const n1 = 0.6 + 0.4 * Math.sqrt(drifting ? 0 : 0.6 + 0.35 * Math.sin(t * 0.8 - 0.9));
      return {
        type: 'turbine',
        powerLever: lever,
        n1,
        n1Order,
        power: Math.max(0, ((n1 - 0.6) / 0.4) ** 2),
        propRpm: 2000 + 7000 * ((n1 - 0.6) / 0.4),
        maxRpm: 9500,
        wingAngle: -3 * DEG,
        wingTrim: 7 / 12,
        rudder: steer * 17 * DEG,
        rudderMax: 17 * DEG,
        turnG: Math.abs(steer) * 1.5,
        killed: false,
      };
    }
    case 'sail':
      return null;
  }
}

function conditions(t: number, heading: number, sail: SailingState | null): ConditionsState {
  const storm = heavy();
  const windKn = storm ? (state.scenario === 'overpowered' ? 24 : 42) : state.boat === 'sail' ? 12 : 16;
  // The sailboat's true wind is the conditions' wind, so the two panels agree.
  const windSpeed = sail ? sail.tws : knotsToMs(windKn + Math.sin(t * 0.7) * (storm ? 4 : 1.5));
  const hs = storm ? (state.scenario === 'overpowered' ? 2.2 : 7.4) : 1.1;
  const night = state.night;
  return {
    windFrom: sail ? normalizeHeading(heading + sail.twa) : normalizeHeading(heading + 115 * DEG),
    windSpeed,
    windGust: windSpeed * (storm ? 1.35 : 1.18),
    beaufort: beaufortFromMs(windSpeed),
    beaufortName: '',
    hs,
    tp: storm ? 11.5 : 6.2,
    waveFrom: normalizeHeading(heading + 120 * DEG),
    douglas: douglasFromHs(hs),
    douglasName: '',
    swell: {
      height: storm ? 3.2 : 0.8,
      period: storm ? 14 : 11,
      from: normalizeHeading(heading + 150 * DEG),
    },
    weather: storm
      ? { summary: 'Heavy rain and thunder', icon: 'thunderstorm' }
      : { summary: night ? 'Clear night' : 'Fair, scattered cloud', icon: night ? 'clear' : 'partly-cloudy' },
    visibility: storm ? 1200 : 18_000,
    lightningDistance: storm ? 3800 + Math.sin(t * 0.1) * 600 : null,
    localTime: night ? 23 * 60 + 12 : 14 * 60 + 32,
    sunrise: 6 * 60 + 41,
    sunset: 19 * 60 + 58,
    polar: null,
    moon: night ? { phase: 0.38, fraction: 0.86 } : null,
    isNight: night,
  };
}

interface Track {
  id: string;
  name: string;
  kind: BoatKind;
  x: number; // m east at t = 0, relative to the own boat's start
  y: number;
  course: number;
  speed: number;
}

function fleetTracks(ownHeading: number, ownSpeed: number): Track[] {
  const kinds: BoatKind[] = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc'];
  const names: Record<BoatKind, string> = {
    cargo: BOATS.cargo.name,
    cruise: BOATS.cruise.name,
    crab: BOATS.crab.name,
    sail: BOATS.sail.name,
    powerboat: BOATS.powerboat.name,
    pwc: BOATS.pwc.name,
    hydro: BOATS.hydro.name,
  };
  const others = kinds.filter((k) => k !== state.boat).slice(0, 4);
  const layout = [
    { brg: 35, rng: 2600, course: 200, kn: 14 },
    { brg: -70, rng: 1500, course: 20, kn: 9 },
    { brg: 160, rng: 3800, course: 60, kn: 18 },
    { brg: -140, rng: 900, course: 300, kn: 5 },
  ];
  const tracks = others.map((kind, i) => {
    const l = layout[i];
    const brg = ownHeading + l.brg * DEG;
    return {
      id: kind,
      name: names[kind],
      kind,
      x: Math.sin(brg) * l.rng,
      y: Math.cos(brg) * l.rng,
      course: normalizeHeading(ownHeading + l.course * DEG),
      speed: knotsToMs(l.kn),
    };
  });
  if (state.scenario === 'collision' && tracks[0]) {
    // Crossing from starboard to meet within 60 m of our track at T seconds.
    const T = 75;
    const meetX = Math.sin(ownHeading) * ownSpeed * T;
    const meetY = Math.cos(ownHeading) * ownSpeed * T;
    const course = normalizeHeading(ownHeading - 95 * DEG);
    const speed = Math.max(ownSpeed, knotsToMs(10));
    tracks[0] = {
      ...tracks[0],
      x: meetX - Math.sin(course) * speed * T + 40,
      y: meetY - Math.cos(course) * speed * T,
      course,
      speed,
    };
  }
  return tracks;
}

let lastAlertIds = new Set<string>();

function buildModel(t: number): HudModel {
  const kind = state.boat;
  const spec = BOATS[kind];
  const storm = heavy();
  const sea = storm ? (kind === 'cargo' || kind === 'cruise' ? 6 : 3.2) : 1;
  // A collision course needs a steady own course, or the CPA wanders off.
  const weave = state.scenario === 'collision' ? 0 : 1;
  const heading = normalizeHeading((62 + weave * (Math.sin(t * 0.05) * 14 + Math.sin(t * 0.21) * 2)) * DEG);
  const rateOfTurn = weave * (0.05 * 14 * Math.cos(t * 0.05) + 0.21 * 2 * Math.cos(t * 0.21)) * DEG;
  const twsMs = knotsToMs(storm ? (state.scenario === 'overpowered' ? 24 : 30) : 12);
  const sail = kind === 'sail' ? sailing(t, twsMs) : null;
  const drifting = state.scenario === 'drifting';
  const speedKn = sail
    ? msToKnots(sail.targetSpeed * sail.targetPct)
    : drifting
      ? 0.4
      : spec.speedKn * (storm ? 0.7 : 1);
  const speed = knotsToMs(speedKn);
  const phase = (2 * Math.PI * t) / spec.rollPeriod;
  const rollDeg = spec.rollAmp * sea * (Math.sin(phase) + 0.25 * Math.sin(phase * 2.3 + 1));
  const roll = (sail ? sail.heel / DEG + rollDeg * 0.5 : rollDeg) * DEG;
  const pitch = spec.pitchAmp * Math.min(sea, 2.5) * Math.sin(phase * 1.4 + 0.6) * DEG;
  const planing = (kind === 'powerboat' || kind === 'pwc') && speedKn > 18;
  const airborne = kind === 'pwc' && storm && Math.sin(t * 0.9) > 0.85;
  const verticalG =
    1 + (storm ? 0.55 : 0.08) * Math.sin(phase * 1.7) * (kind === 'cargo' || kind === 'cruise' ? 0.25 : 1);
  const slams = storm ? Math.floor(t / 7) : 0;
  const cond = conditions(t, heading, sail);
  const cog = normalizeHeading(
    heading + (sail ? 4 : storm ? 6 : 2) * DEG * -Math.sign(signedAngle(cond.windFrom - heading)),
  );

  const tracks = state.fleet ? fleetTracks(weave ? 62 * DEG : cog, speed) : [];
  const loop = t % 120;
  const ownX = Math.sin(cog) * speed * loop;
  const ownY = Math.cos(cog) * speed * loop;
  const fleet: FleetEntry[] = tracks.length
    ? [
        { id: 'own', name: spec.name, kind, bearing: 0, range: 0, speed, heading: cog, active: true },
        ...tracks.map((tr) => {
          const x = tr.x + Math.sin(tr.course) * tr.speed * loop - ownX;
          const y = tr.y + Math.cos(tr.course) * tr.speed * loop - ownY;
          return {
            id: tr.id,
            name: tr.name,
            kind: tr.kind,
            bearing: normalizeHeading(Math.atan2(x, y)),
            range: Math.hypot(x, y),
            speed: tr.speed,
            heading: tr.course,
            active: false,
          };
        }),
      ]
    : [];

  const prop = propulsion(kind, t, speedKn / spec.speedKn);
  const night = state.night;
  const signals: LightSignal[] = [];
  if (kind === 'crab' && state.scenario !== 'lights-off') signals.push('fishing');
  if (drifting && (kind === 'cargo' || kind === 'cruise')) signals.push('nuc');
  const lights = {
    nav: night && state.scenario !== 'lights-off' && kind !== 'pwc',
    deck: night && (kind === 'crab' || kind === 'cruise'),
    cabin: night && kind !== 'pwc',
    extra: night && kind === 'crab',
    signals,
    fitted: lightFittings(kind),
  };

  const rudder = prop?.type === 'ship' ? { angle: prop.rudderAngle, max: prop.rudderMax } : null;
  const alerts = evaluateAlerts(
    {
      kind,
      speed,
      heading,
      cog,
      roll,
      stability: spec.stability,
      waveFrom: cond.waveFrom,
      hs: cond.hs,
      tp: cond.tp,
      breakingHit: storm && Math.sin(phase * 0.7) > 0.9,
      deckWater: storm && kind === 'crab' ? 0.2 + Math.max(0, Math.sin(t * 0.4)) * 0.3 : 0,
      airborne,
      inIrons: sail?.inIrons ?? false,
      accidentalGybe: state.scenario === 'gybe-danger' && t % 14 < 3,
      rudder,
      isNight: night,
      navLights: lights.nav,
      fleet,
      units: hud.getSettings().units,
    },
    lastAlertIds,
  );
  lastAlertIds = new Set(alerts.map((a) => a.id));

  return {
    boat: { kind, name: spec.name, stability: spec.stability },
    motion: { speed, heading, cog, rateOfTurn, roll, pitch, verticalG, slams, onPlane: planing, airborne },
    propulsion: prop,
    sailing: sail,
    conditions: cond,
    lights,
    alerts,
    fleet,
    camera: kind === 'sail' ? 'Cockpit' : kind === 'cargo' || kind === 'cruise' ? 'Bridge' : 'Helm',
    controls: { hints: hintRowsFor(kind) },
  };
}

// ---------------------------------------------------------------------------
// Lab controls

function controls(): void {
  if (params.get('ui') === '0') return;
  const ui = document.createElement('div');
  ui.id = 'lab-ui';
  const option = (value: string, label = value): string => `<option value="${value}">${label}</option>`;
  ui.innerHTML = `
    <button type="button" class="lab-toggle">HUD lab</button>
    <label>Boat <select data-k="boat">${BOAT_KINDS.map((k) => option(k)).join('')}</select></label>
    <label>Scenario <select data-k="scenario"></select></label>
    <label>Night <input type="checkbox" data-k="night"></label>
    <label>Red tint <input type="checkbox" data-k="red"></label>
    <label>Auto dim <input type="checkbox" data-k="dim"></label>
    <label>Auto trim <input type="checkbox" data-k="auto"></label>
    <label>Fleet <input type="checkbox" data-k="fleet"></label>
    <label>Radar <input type="checkbox" data-k="radar"></label>
    <label>Hints <input type="checkbox" data-k="hints"></label>
    <h2>Display</h2>
    <label>Mode (H) <select data-k="mode">${option('full')}${option('minimal')}${option('off')}</select></label>
    <label>Scale <input type="range" min="0.6" max="1.6" step="0.05" data-k="scale"></label>
    <label>Speed <select data-k="speed">${option('kn')}${option('mph')}${option('kmh', 'km/h')}</select></label>
    <label>Length <select data-k="length">${option('m')}${option('ft')}</select></label>
    <label>Wind <select data-k="wind">${option('kn')}${option('ms', 'm/s')}${option('beaufort')}</select></label>`;
  document.body.append(ui);
  const field = <T extends HTMLElement>(k: string): T => ui.querySelector(`[data-k="${k}"]`) as T;
  const scenario = field<HTMLSelectElement>('scenario');
  const fillScenarios = (): void => {
    const list = state.boat === 'sail' ? SAIL_SCENARIOS : POWERED_SCENARIOS;
    scenario.innerHTML = list.map((s) => option(s)).join('');
    if (!list.includes(state.scenario)) state.scenario = list[0];
    scenario.value = state.scenario;
  };
  const sync = (): void => {
    const s = hud.getSettings();
    field<HTMLSelectElement>('boat').value = state.boat;
    fillScenarios();
    field<HTMLInputElement>('night').checked = state.night;
    field<HTMLInputElement>('red').checked = s.redNightTint;
    field<HTMLInputElement>('dim').checked = s.nightDimming === 'auto';
    field<HTMLInputElement>('auto').checked = state.autoTrim;
    field<HTMLInputElement>('fleet').checked = state.fleet;
    field<HTMLInputElement>('radar').checked = s.radar;
    field<HTMLInputElement>('hints').checked = s.controlHints;
    field<HTMLSelectElement>('mode').value = s.mode;
    field<HTMLInputElement>('scale').value = String(s.scale);
    field<HTMLSelectElement>('speed').value = s.units.speed;
    field<HTMLSelectElement>('length').value = s.units.length;
    field<HTMLSelectElement>('wind').value = s.units.wind;
  };
  ui.addEventListener('change', (event) => {
    const el = event.target as HTMLInputElement | HTMLSelectElement;
    const k = el.dataset.k;
    const checked = el instanceof HTMLInputElement && el.checked;
    const units = hud.getSettings().units;
    switch (k) {
      case 'boat':
        state.boat = el.value as BoatKind;
        fillScenarios();
        break;
      case 'scenario':
        state.scenario = el.value as Scenario;
        break;
      case 'night':
        state.night = checked;
        break;
      case 'red':
        hud.setSettings({ redNightTint: checked });
        break;
      case 'dim':
        hud.setSettings({ nightDimming: checked ? 'auto' : 'off' });
        break;
      case 'auto':
        state.autoTrim = checked;
        break;
      case 'fleet':
        state.fleet = checked;
        break;
      case 'radar':
        hud.setSettings({ radar: checked });
        break;
      case 'hints':
        hud.setSettings({ controlHints: checked });
        break;
      case 'mode':
        hud.setMode(el.value as HudMode);
        break;
      case 'speed':
        hud.setSettings({ units: { ...units, speed: el.value as SpeedUnit } });
        break;
      case 'length':
        hud.setSettings({ units: { ...units, length: el.value as LengthUnit } });
        break;
      case 'wind':
        hud.setSettings({ units: { ...units, wind: el.value as WindUnit } });
        break;
    }
    updateBackground();
  });
  ui.addEventListener('input', (event) => {
    const el = event.target as HTMLInputElement;
    if (el.dataset.k === 'scale') hud.setSettings({ scale: Number(el.value) });
  });
  ui.querySelector('.lab-toggle')?.addEventListener('click', () => ui.classList.toggle('is-collapsed'));
  window.addEventListener('keydown', (event) => {
    if (event.code === 'KeyH') {
      hud.cycleMode();
      sync();
    }
  });
  sync();
}

// ---------------------------------------------------------------------------
// Loop

const horizon = document.getElementById('lab-horizon');

function updateBackground(): void {
  document.body.classList.toggle('lab-night', state.night);
  document.body.classList.toggle('lab-storm', heavy());
}

let last = performance.now();
let elapsed = 0;

function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  elapsed += dt;
  const t = state.frozen ?? elapsed;
  const model = buildModel(t);
  hud.update(model, dt);
  if (horizon) {
    const { roll, pitch } = model.motion;
    horizon.style.transform = `translateY(${((pitch / DEG) * 0.9).toFixed(2)}vh) rotate(${(-roll / DEG).toFixed(2)}deg)`;
  }
  requestAnimationFrame(tick);
}

updateBackground();
controls();
requestAnimationFrame(tick);
