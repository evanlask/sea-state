// HudModel: the plain, already-computed data the app hands the HUD every frame. The HUD
// never reaches into the simulation; everything it shows comes through here. SI units and
// the conventions in sim/core/conventions.ts throughout: angles in radians, headings
// clockwise from north, relative angles positive to starboard, "%" values as fractions.

import type { BoatKind } from '../../sim/world/protocol';

export type HudSeverity = 'info' | 'warning' | 'danger';

export interface HudAlert {
  id: string; // stable per condition, so the HUD can tell a new alert from a held one
  severity: HudSeverity;
  text: string; // the headline: what's wrong, in plain words (about 40 characters at most)
  detail?: string; // what to do about it, or where; a smaller second line
}

// From the boat's GZ curve (see dangerZoneFromGz): the attitude gauge turns red from
// dangerHeel and deep red past the angle of vanishing stability.
export interface StabilityInfo {
  dangerHeel: number; // rad, where the righting-arm margin gets low (or downflooding)
  avs: number; // rad, angle of vanishing stability
}

interface BoatInfo {
  kind: BoatKind;
  name: string;
  stability: StabilityInfo;
}

interface MotionState {
  speed: number; // m/s over ground
  heading: number; // rad
  cog: number; // rad, course over ground
  rateOfTurn: number; // rad/s, + turning to starboard
  roll: number; // rad, + starboard down
  pitch: number; // rad, + bow up
  verticalG: number; // vertical specific force in g; 1 when riding steadily
  slams: number; // slam count this session; the ride meter flashes when it rises
  onPlane: boolean;
  airborne: boolean;
}

// Engine order telegraph plus the engine's actual response (ships, crab boat, cruise ship).
export interface TelegraphReadout {
  notch: number; // index into TELEGRAPH_NOTCHES (input/axes.ts)
  lever: number; // -1..1 lever position, differs from the notch while a trigger sweeps it
  response: number; // -1..1 engine output actually delivered; astern negative
}

export interface ShipPropulsion {
  type: 'ship';
  telegraph: TelegraphReadout;
  shaftRpm: number; // signed, astern negative
  maxRpm: number;
  engineLoad: number; // 0..1 of MCR
  rudderOrder: number; // rad, + starboard
  rudderAngle: number; // rad, actual
  rudderMax: number; // rad, usually 35°
  bowThruster: number; // -1 port .. 1 starboard
  thrusterAvailable: boolean; // bow thrusters lose effect above ~5 kn
}

export interface PodReadout {
  angle: number; // rad, 0 = thrusting astern (driving ahead); + steers to starboard like a rudder
  thrust: number; // -1..1
}

export interface PodPropulsion {
  type: 'pods';
  telegraph: TelegraphReadout;
  pods: readonly PodReadout[]; // port first
  powerLoad: number; // 0..1 of plant power
  bowThruster: number;
  thrusterAvailable: boolean;
}

interface OutboardReadout {
  throttle: number; // -1..1, reverse negative
  rpm: number;
  maxRpm: number;
  trim: number; // 0 (down) .. 1 (fully up)
}

export interface OutboardPropulsion {
  type: 'outboards';
  engines: readonly OutboardReadout[]; // port first
  steering: number; // rad, + starboard
  steeringMax: number;
}

export type JetBucket = 'ahead' | 'neutral' | 'brake' | 'reverse';

export interface JetPropulsion {
  type: 'jet';
  throttle: number; // 0..1
  rpm: number;
  maxRpm: number;
  nozzle: number; // rad, + starboard
  nozzleMax: number;
  bucket: JetBucket;
}

// The hydroplane: a gas turbine through a surface-piercing propeller, the wing, the rudder.
export interface TurbinePropulsion {
  type: 'turbine';
  powerLever: number; // 0..1, the throttle
  n1: number; // gas-generator speed, share of rated (~0.6 at idle)
  n1Order: number; // the N1 the lever is asking for: the needle lags it while the turbine spools
  power: number; // 0..1 of rated shaft power
  propRpm: number;
  maxRpm: number;
  wingAngle: number; // rad, + leading edge up (less down-force)
  wingTrim: number; // 0 least down-force .. 1 most (bow up)
  rudder: number; // rad, + starboard
  rudderMax: number;
  turnG: number; // sideways acceleration in the turn, g
  killed: boolean; // the kill switch has cut the fuel (after a capsize)
}

export type Propulsion =
  | ShipPropulsion
  | PodPropulsion
  | OutboardPropulsion
  | JetPropulsion
  | TurbinePropulsion;

export type TrimState = 'luffing' | 'optimal' | 'stalled';

export type PointOfSail = 'in-irons' | 'close-hauled' | 'close-reach' | 'beam-reach' | 'broad-reach' | 'run';

// Streamer flow: 1 streams cleanly, 0 lifts and flutters, -1 is stalled (curls forward).
interface Telltales {
  jibWindward: number;
  jibLeeward: number;
  mainLeech: number;
}

export interface SailingState {
  tws: number; // m/s
  twa: number; // rad relative to the bow, (-π, π], + wind from starboard
  aws: number;
  awa: number;
  pointOfSail: PointOfSail;
  boomAngle: number; // rad from the centreline, + boom to starboard
  jibAngle: number; // rad, clew angle from the centreline at the tack, + to starboard
  idealBoomAngle: number; // signed like boomAngle (see idealSheetAngles)
  idealJibAngle: number;
  mainTrim: TrimState;
  jibTrim: TrimState;
  telltales: Telltales;
  reef: number; // 0..3
  jibFurl: number; // 0 fully set .. 1 rolled away
  autoTrim: boolean;
  heel: number; // rad, + starboard down
  vmg: number; // m/s toward (+) or away from the wind
  targetSpeed: number; // m/s from the polar at this TWS/TWA
  targetPct: number; // boat speed / targetSpeed
  bestUpwindTwa: number; // rad, unsigned
  bestDownwindTwa: number;
  gybeDanger: boolean;
  inIrons: boolean;
}

export type WeatherIcon =
  | 'clear'
  | 'partly-cloudy'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'heavy-rain'
  | 'squall'
  | 'thunderstorm'
  | 'snow'
  | 'hurricane';

interface SwellState {
  height: number; // m
  period: number; // s
  from: number; // rad
}

export interface ConditionsState {
  windFrom: number; // rad, true, meteorological
  windSpeed: number; // m/s at 10 m
  windGust: number; // m/s
  beaufort: number;
  beaufortName: string; // passthrough from the weather system; '' falls back to the HUD's table
  hs: number; // significant wave height, m
  tp: number; // peak period, s
  waveFrom: number; // rad
  douglas: number;
  douglasName: string;
  swell: SwellState | null;
  weather: { summary: string; icon: WeatherIcon };
  visibility: number; // m
  lightningDistance: number | null; // m to the nearest recent strike
  localTime: number; // minutes after local midnight
  sunrise: number | null; // minutes; null in polar day or night
  sunset: number | null;
  polar: 'polar-day' | 'polar-night' | null; // midnight sun / polar night: no sunrise or sunset
  moon: { phase: number; fraction: number } | null; // phase 0 new .. 0.5 full .. 1
  isNight: boolean;
}

export type LightSignal = 'fishing' | 'nuc' | 'anchor' | 'ram';

export interface LightsState {
  nav: boolean;
  deck: boolean; // deck and work lights
  cabin: boolean; // cabin and accommodation
  extra: boolean; // searchlights, underwater lights, headlight (what the boat has)
  signals: readonly LightSignal[];
  // What the boat is fitted with (switches it lacks are hidden; omitted: all shown). extra is the
  // HUD's name for the boat's extras ('Search', 'Underwater'…), null when it has none.
  fitted?: { deck: boolean; cabin: boolean; extra: string | null };
}

export interface FleetEntry {
  id: string;
  name: string;
  kind: BoatKind;
  bearing: number; // rad true, from the active boat
  range: number; // m
  speed: number; // m/s
  heading: number; // rad (course, for the radar and CPA)
  active: boolean; // the boat the player is helming
}

export interface HintRow {
  label: string;
  keyboard: string;
  gamepad: string;
}

export type InputDeviceKind = 'keyboard' | 'gamepad';

// Shown while the helm boat is capsized or sunk: how the voyage went and how to recover.
export interface CapsizeCardModel {
  title: string;
  rows: { label: string; value: string }[];
  hint: string;
}

export interface HudModel {
  boat: BoatInfo;
  motion: MotionState;
  propulsion: Propulsion | null; // null for the sailboat
  sailing: SailingState | null; // non-null selects the sailing layout
  conditions: ConditionsState;
  lights: LightsState;
  alerts: readonly HudAlert[];
  fleet: readonly FleetEntry[]; // includes the active boat (range 0)
  camera: string; // e.g. 'Helm', 'Chase', 'Orbit'
  controls: { device: InputDeviceKind; hints: readonly HintRow[] };
  capsize?: CapsizeCardModel | null;
}
