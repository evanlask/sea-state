// Builds the HUD's view model each frame from the snapshot, the scenario's weather and sea, and the
// clock. Keeps the little state the derived readouts need (rate of turn, vertical g, slams, alert holds).

import { nearestNotch } from '../input/axes';
import { lightFittings } from '../render/boats/lights/groups';
import type { SimClock } from '../sim/astro/clock';
import { moonIllumination } from '../sim/astro/lunar';
import { type PolarCondition, solarPosition, sunTimes } from '../sim/astro/solar';
import { stabilityCurve } from '../sim/boats/calibration/index';
import { attitudeFromQuat } from '../sim/core/attitude';
import { DEG, signedAngle, vectorToHeading } from '../sim/core/conventions';
import { GRAVITY } from '../sim/core/units';
import { SAIL_KEYS } from '../sim/sail/telemetry';
import { getWeatherPreset } from '../sim/weather/presets';
import { beaufortFromWind, douglasFromHs } from '../sim/weather/tables';
import { BOAT_KINDS, type BoatKind, type BoatSnapshot, type SpectrumMessage } from '../sim/world/protocol';
import { evaluateAlerts, sortAlerts } from '../ui/hud/alerts';
import type { HudUnits } from '../ui/hud/format';
import { hintRowsFor } from '../ui/hud/hints';
import type {
  ConditionsState,
  FleetEntry,
  HudAlert,
  HudModel,
  JetBucket,
  LightsState,
  Propulsion,
  SailingState,
  StabilityInfo,
  TelegraphReadout,
  TrimState,
  WeatherIcon,
} from '../ui/hud/model';
import { dangerZoneFromGz } from '../ui/hud/motion';
import { pointOfSail } from '../ui/hud/sailing';
import { BOAT_CARDS, fleetNames } from '../ui/menu/boats';
import { type ScenarioChoices, seaStateFor, windFor } from './scenarioConfig';

// Each hull's GZ curve, AVS and downflooding angle from the calibration.
const STABILITY: Record<BoatKind, StabilityInfo> = Object.fromEntries(
  BOAT_KINDS.map((kind) => {
    const s = stabilityCurve(kind);
    return [kind, dangerZoneFromGz(s.curve, s.downflooding)];
  }),
) as Record<BoatKind, StabilityInfo>;

// The attitude gauge's danger zone for this boat as loaded: the sim reports the AVS of its loading
// condition (telemetry 'avs'); a heavier deck load pulls the danger heel in with it.
export function loadedStability(base: StabilityInfo, avs: number | undefined): StabilityInfo {
  if (avs === undefined || !(avs > 0) || Math.abs(avs - base.avs) < 0.01) return base;
  return { avs, dangerHeel: Math.min(avs, (base.dangerHeel * avs) / base.avs) };
}

const PLANING_SPEED: Partial<Record<BoatKind, number>> = { powerboat: 8, pwc: 6, hydro: 15 }; // m/s

// How long a momentary event keeps its alert up, s.
const GYBE_HOLD_S = 4;
const BREAKING_HOLD_S = 5;
const AIRBORNE_HOLD_S = 3;
const FLOODING_HOLD_S = 8;
// A breaking crest's impact (telemetry 'breaking', N) that counts as a hit, per newton of weight.
const BREAKING_HIT = 0.05;

const tel = (t: Record<string, number>, key: string, fallback = 0): number => t[key] ?? fallback;

function telegraphReadout(t: Record<string, number>): TelegraphReadout {
  const lever = tel(t, 'telegraphOrder');
  return { notch: nearestNotch(lever), lever, response: tel(t, 'telegraphResponse') };
}

const JET_BUCKETS: readonly JetBucket[] = ['ahead', 'neutral', 'brake', 'reverse'];

export function propulsionFromTelemetry(kind: BoatKind, t: Record<string, number>): Propulsion | null {
  switch (kind) {
    case 'cargo':
    case 'crab':
      return {
        type: 'ship',
        telegraph: telegraphReadout(t),
        shaftRpm: tel(t, 'rpm'),
        maxRpm: tel(t, 'maxRpm', 100),
        engineLoad: tel(t, 'load'),
        rudderOrder: tel(t, 'rudderOrder'),
        rudderAngle: tel(t, 'rudderAngle'),
        rudderMax: tel(t, 'rudderMax', 35 * DEG),
        bowThruster: tel(t, 'thruster'),
        thrusterAvailable: tel(t, 'thrusterAvailable') > 0.5,
      };
    case 'cruise':
      return {
        type: 'pods',
        telegraph: telegraphReadout(t),
        pods: [
          { angle: tel(t, 'pod0Angle'), thrust: tel(t, 'pod0Thrust') },
          { angle: tel(t, 'pod1Angle'), thrust: tel(t, 'pod1Thrust') },
        ],
        powerLoad: tel(t, 'load'),
        bowThruster: tel(t, 'thruster'),
        thrusterAvailable: tel(t, 'thrusterAvailable') > 0.5,
      };
    case 'powerboat':
      return {
        type: 'outboards',
        engines: [0, 1].map((i) => ({
          throttle: tel(t, `eng${i}Throttle`),
          rpm: tel(t, `eng${i}Rpm`),
          maxRpm: tel(t, 'maxRpm', 6000),
          trim: tel(t, `eng${i}Trim`),
        })),
        steering: tel(t, 'steering'),
        steeringMax: tel(t, 'steeringMax', 30 * DEG),
      };
    case 'pwc':
      return {
        type: 'jet',
        throttle: tel(t, 'throttle'),
        rpm: tel(t, 'rpm'),
        maxRpm: tel(t, 'maxRpm', 8000),
        nozzle: tel(t, 'nozzle'),
        nozzleMax: tel(t, 'nozzleMax', 20 * DEG),
        bucket: JET_BUCKETS[Math.round(tel(t, 'bucket', 1))] ?? 'neutral',
      };
    case 'hydro':
      return {
        type: 'turbine',
        powerLever: tel(t, 'throttle'),
        n1: tel(t, 'n1'),
        n1Order: tel(t, 'n1Order'),
        power: tel(t, 'load'),
        propRpm: tel(t, 'rpm'),
        maxRpm: tel(t, 'maxRpm', 9500),
        wingAngle: tel(t, 'wingAngle'),
        wingTrim: tel(t, 'wingTrim'),
        rudder: tel(t, 'rudderAngle'),
        rudderMax: tel(t, 'rudderMax', 17 * DEG),
        turnG: Math.abs(tel(t, 'speedThroughWater') * tel(t, 'yawRate')) / GRAVITY,
        killed: tel(t, 'killSwitch') > 0.5,
      };
    case 'sail':
      return null;
  }
}

export interface HudInputs {
  boats: readonly BoatSnapshot[];
  playerId: string;
  dt: number;
  choices: ScenarioChoices;
  spectrum: SpectrumMessage | null;
  clock: SimClock;
  latitudeDeg: number;
  longitudeDeg: number;
  camera: string;
  lights: LightsState;
  alerts: readonly HudAlert[];
  units?: HudUnits; // hud.units; defaults to knots and metres
}

function weatherSummary(choices: ScenarioChoices): {
  summary: string;
  icon: WeatherIcon;
  visibility: number;
} {
  const preset = getWeatherPreset(choices.weather);
  const custom = choices.weather === 'custom' ? choices.customWeather : undefined;
  const rain = custom ? custom.rain : preset.precipitation;
  const cover = custom ? custom.cloudCover : preset.clouds.coverage;
  const type = custom ? custom.cloudType : preset.clouds.type;
  const visibility = custom ? custom.visibilityKm * 1000 : preset.visibility;
  const lightning = custom ? custom.lightning > 0 : preset.lightningPerMinute > 0;
  const wind = windFor(choices).speed;
  let icon: WeatherIcon = cover < 0.3 ? 'clear' : cover < 0.7 ? 'partly-cloudy' : 'cloudy';
  if (visibility < 1000 && rain < 0.3) icon = 'fog';
  if (rain > 0) icon = rain < 0.3 ? 'drizzle' : rain < 0.7 ? 'rain' : 'heavy-rain';
  if (type === 'cumulonimbus' && rain > 0.3) icon = lightning ? 'thunderstorm' : 'squall';
  if (wind >= 32.7) icon = 'hurricane';
  const summary = custom ? 'Custom conditions' : preset.description.split(/[.:—]/)[0]?.trim() || preset.name;
  return { summary, icon, visibility };
}

const minutesOfDayUtc = (date: Date | null, longitudeDeg: number): number | null => {
  if (!date) return null;
  // Local mean solar time: UTC shifted by longitude (no time zones at sea).
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  return (((minutes + longitudeDeg * 4) % 1440) + 1440) % 1440;
};

export class HudModelBuilder {
  private previousHeading: number | null = null;
  private previousVy: number | null = null;
  private verticalG = 1;
  private rateOfTurn = 0;
  private slams = 0;
  private lightning: { distance: number; at: number } | null = null;
  private sunTimesKey = '';
  private shownAlerts: ReadonlySet<string> = new Set();
  private gybeHold = 0; // s
  private lastGybes = 0;
  private breakingHold = 0; // s
  private airborneHold = 0; // s
  private floodingHold = 0; // s
  private lastFlooding = 0;
  private sunrise: number | null = null;
  private sunset: number | null = null;
  private polar: PolarCondition = null;
  private choiceConditions: {
    choices: ScenarioChoices;
    wind: ReturnType<typeof windFor>;
    beaufort: ReturnType<typeof beaufortFromWind>;
    sea: ReturnType<typeof seaStateFor>;
    weather: ReturnType<typeof weatherSummary>;
  } | null = null;

  addSlam(): void {
    this.slams++;
  }

  // A lightning strike this far from the observer, m. Shown as "Thunderstorm 4 km" for a minute.
  addThunder(distance: number): void {
    this.lightning = { distance, at: performance.now() };
  }

  build(inputs: HudInputs): HudModel | null {
    const player = inputs.boats.find((boat) => boat.id === inputs.playerId);
    if (!player) return null;
    const attitude = attitudeFromQuat(player.orientation);
    const vx = player.velocity.x;
    const vz = player.velocity.z;
    const speed = Math.hypot(vx, vz);
    const dt = Math.max(1e-3, inputs.dt);

    // Smoothed derivatives so the gauges don't twitch with frame timing.
    if (this.previousHeading !== null) {
      const instant = signedAngle(attitude.heading - this.previousHeading) / dt;
      this.rateOfTurn += (instant - this.rateOfTurn) * Math.min(1, dt * 3);
    }
    this.previousHeading = attitude.heading;
    if (this.previousVy !== null) {
      const g = 1 + (player.velocity.y - this.previousVy) / dt / GRAVITY;
      this.verticalG += (g - this.verticalG) * Math.min(1, dt * 8);
    }
    this.previousVy = player.velocity.y;

    const kind = player.kind;
    const planing = PLANING_SPEED[kind];
    const model: HudModel = {
      boat: {
        kind,
        name: BOAT_CARDS[kind].name,
        stability: loadedStability(STABILITY[kind], player.telemetry['avs']),
      },
      motion: {
        speed,
        heading: attitude.heading,
        cog: speed > 0.2 ? vectorToHeading(vx, vz) : attitude.heading,
        rateOfTurn: this.rateOfTurn,
        roll: attitude.roll,
        pitch: attitude.pitch,
        verticalG: this.verticalG,
        slams: this.slams,
        onPlane:
          'onPlane' in player.telemetry
            ? (player.telemetry['onPlane'] ?? 0) > 0.5
            : planing !== undefined && speed > planing,
        airborne: (player.telemetry['airborne'] ?? 0) > 0.5,
      },
      propulsion: propulsionFromTelemetry(kind, player.telemetry),
      sailing: kind === 'sail' ? sailingFromTelemetry(player.telemetry) : null,
      conditions: this.conditions(inputs),
      lights: { ...inputs.lights, fitted: lightFittings(kind) },
      alerts: inputs.alerts,
      fleet: this.fleet(inputs, player),
      camera: inputs.camera,
      controls: { hints: hintRowsFor(kind) },
    };
    model.alerts = sortAlerts([...inputs.alerts, ...this.alerts(model, player.telemetry, dt, inputs.units)]);
    return model;
  }

  // Skipper alerts with hysteresis (alerts already showing hold until clearly over). Momentary
  // events (a gybe, a breaking crest, a jump, water coming in) hold a few seconds so they can be read.
  private alerts(
    model: HudModel,
    t: Record<string, number>,
    dt: number,
    units: HudUnits | undefined,
  ): HudAlert[] {
    const extra: HudAlert[] = [];
    if ((t['capsized'] ?? 0) > 0.5) {
      extra.push({
        id: 'capsized',
        severity: 'danger',
        text: 'Capsized',
        detail: 'Press Backspace to recover',
      });
    } else if (model.propulsion?.type === 'turbine' && model.propulsion.killed) {
      // Upright again after a capsize, but the kill switch has cut the turbine.
      extra.push({
        id: 'kill-switch',
        severity: 'warning',
        text: 'Turbine shut down by the kill switch',
        detail: 'Press Backspace to recover and relight it',
      });
    }
    const kind = model.boat.kind;
    const gybes = kind === 'sail' ? (t[SAIL_KEYS.gybes] ?? 0) : 0;
    this.gybeHold = gybes > this.lastGybes ? GYBE_HOLD_S : Math.max(0, this.gybeHold - dt);
    this.lastGybes = gybes;
    // A breaking crest hitting with a twentieth of the boat's weight or more is one that can roll it.
    const breaking = t['breaking'] ?? 0;
    const weight = (t['mass'] ?? 0) * GRAVITY;
    this.breakingHold =
      weight > 0 && breaking > BREAKING_HIT * weight ? BREAKING_HOLD_S : Math.max(0, this.breakingHold - dt);
    this.airborneHold = model.motion.airborne ? AIRBORNE_HOLD_S : Math.max(0, this.airborneHold - dt);
    const flooding = t['flooding'] ?? 0;
    const rising = flooding > this.lastFlooding + 1e-5 || (t['downflooding'] ?? 0) > 0.5;
    this.floodingHold = rising ? FLOODING_HOLD_S : Math.max(0, this.floodingHold - dt);
    this.lastFlooding = flooding;
    const propulsion = model.propulsion;
    const rudder =
      propulsion?.type === 'ship'
        ? { angle: propulsion.rudderAngle, max: propulsion.rudderMax }
        : propulsion?.type === 'outboards'
          ? { angle: propulsion.steering, max: propulsion.steeringMax }
          : propulsion?.type === 'jet'
            ? { angle: propulsion.nozzle, max: propulsion.nozzleMax }
            : propulsion?.type === 'turbine'
              ? { angle: propulsion.rudder, max: propulsion.rudderMax }
              : kind === 'sail'
                ? { angle: t['rudderAngle'] ?? 0, max: t['rudderMax'] ?? 0 }
                : null;
    const conditions = model.conditions;
    const alerts = evaluateAlerts(
      {
        kind,
        speed: model.motion.speed,
        heading: model.motion.heading,
        cog: model.motion.cog,
        roll: model.motion.roll,
        pitch: model.motion.pitch,
        stability: model.boat.stability,
        waveFrom: conditions.waveFrom,
        hs: conditions.hs,
        tp: conditions.tp,
        breakingHit: this.breakingHold > 0,
        deckWater: t['deckWater'] ?? 0,
        flooding,
        floodingRising: this.floodingHold > 0,
        airborne: this.airborneHold > 0,
        inIrons: model.sailing?.inIrons ?? false,
        accidentalGybe: this.gybeHold > 0,
        rudder,
        isNight: conditions.isNight,
        navLights: model.lights.nav,
        fleet: model.fleet,
        units,
      },
      this.shownAlerts,
    );
    this.shownAlerts = new Set([...extra, ...alerts].map((alert) => alert.id));
    return [...extra, ...alerts];
  }

  private conditions(inputs: HudInputs): ConditionsState {
    // The parts that only follow the choices (replaced, never edited, on a change) once per choice.
    let fixed = this.choiceConditions;
    if (fixed?.choices !== inputs.choices) {
      const wind = windFor(inputs.choices);
      fixed = {
        choices: inputs.choices,
        wind,
        beaufort: beaufortFromWind(wind.speed),
        sea: seaStateFor(inputs.choices),
        weather: weatherSummary(inputs.choices),
      };
      this.choiceConditions = fixed;
    }
    const { wind, beaufort, sea, weather } = fixed;
    const hs = inputs.spectrum?.significantHeight ?? 0;
    const douglas = douglasFromHs(hs);
    const clock = inputs.clock;
    const lat = inputs.latitudeDeg * DEG;
    const lon = inputs.longitudeDeg * DEG;
    const key = clock.dateString;
    if (key !== this.sunTimesKey) {
      const { year, month, day } = clock.date;
      const times = sunTimes(year, month, day, lat, lon);
      this.sunrise = minutesOfDayUtc(times.sunrise, inputs.longitudeDeg);
      this.sunset = minutesOfDayUtc(times.sunset, inputs.longitudeDeg);
      this.polar = times.polar;
      this.sunTimesKey = key;
    }
    const sun = solarPosition(clock.julianDay, lat, lon);
    const isNight = sun.elevation < -6 * DEG;
    const moon = moonIllumination(clock.julianDay);
    return {
      windFrom: wind.from,
      windSpeed: wind.speed,
      windGust: wind.speed * wind.gustFactor,
      beaufort: beaufort.force,
      beaufortName: beaufort.name,
      hs,
      tp: inputs.spectrum?.peakPeriod ?? 0,
      // A manual sea can run at an angle to the wind.
      waveFrom: wind.from + (sea.mode === 'manual' ? (sea.directionOffset ?? 0) : 0),
      douglas: douglas.code,
      douglasName: douglas.name,
      swell: sea.swell ? { height: sea.swell.height, period: sea.swell.period, from: sea.swell.from } : null,
      weather: { summary: weather.summary, icon: weather.icon },
      visibility: weather.visibility,
      lightningDistance:
        this.lightning && performance.now() - this.lightning.at < 60_000 ? this.lightning.distance : null,
      localTime: clock.localSolarHours * 60,
      sunrise: this.sunrise,
      sunset: this.sunset,
      polar: this.polar,
      moon: isNight ? { phase: moon.phase, fraction: moon.fraction } : null,
      isNight,
    };
  }

  private fleet(inputs: HudInputs, player: BoatSnapshot): FleetEntry[] {
    const names = fleetNames(inputs.boats);
    return inputs.boats.map((boat, i) => {
      const dx = boat.position.x - player.position.x;
      const dz = boat.position.z - player.position.z;
      const attitude = attitudeFromQuat(boat.orientation);
      return {
        id: boat.id,
        name: names[i] ?? BOAT_CARDS[boat.kind].name,
        kind: boat.kind,
        bearing: vectorToHeading(dx, dz),
        range: Math.hypot(dx, dz),
        speed: Math.hypot(boat.velocity.x, boat.velocity.z),
        heading: attitude.heading,
        active: boat.id === inputs.playerId,
      };
    });
  }
}

// The sail module's readouts (sim/sail/telemetry.ts) → the HUD's sailing layout.
const trimState = (value: number): TrimState =>
  value < -0.5 ? 'luffing' : value > 0.5 ? 'stalled' : 'optimal';

function sailingFromTelemetry(t: Record<string, number>): SailingState {
  const v = (key: string): number => t[key] ?? 0;
  const twa = v(SAIL_KEYS.twa);
  return {
    tws: v(SAIL_KEYS.tws),
    twa,
    aws: v(SAIL_KEYS.aws),
    awa: v(SAIL_KEYS.awa),
    pointOfSail: pointOfSail(twa),
    boomAngle: v(SAIL_KEYS.boomAngle),
    jibAngle: v(SAIL_KEYS.jibAngle),
    idealBoomAngle: v(SAIL_KEYS.idealBoomAngle),
    idealJibAngle: v(SAIL_KEYS.idealJibAngle),
    mainTrim: trimState(v(SAIL_KEYS.mainTrim)),
    jibTrim: trimState(v(SAIL_KEYS.jibTrim)),
    telltales: {
      jibWindward: v(SAIL_KEYS.telltaleJibWindward),
      jibLeeward: v(SAIL_KEYS.telltaleJibLeeward),
      mainLeech: v(SAIL_KEYS.telltaleMainLeech),
    },
    reef: v(SAIL_KEYS.reef),
    jibFurl: v(SAIL_KEYS.jibFurl),
    autoTrim: v(SAIL_KEYS.autoTrim) > 0.5,
    heel: v(SAIL_KEYS.heel),
    vmg: v(SAIL_KEYS.vmg),
    targetSpeed: v(SAIL_KEYS.targetSpeed),
    targetPct: v(SAIL_KEYS.targetPct),
    bestUpwindTwa: v(SAIL_KEYS.bestUpwindTwa),
    bestDownwindTwa: v(SAIL_KEYS.bestDownwindTwa),
    gybeDanger: v(SAIL_KEYS.gybeDanger) > 0.5,
    inIrons: v(SAIL_KEYS.inIrons) > 0.5,
  };
}
