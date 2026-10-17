// Aircraft contrails: the rare jet crossing the sky at cruise altitude, its condensation trail and
// the schedule that decides when one appears. Pure TS (ContrailSystem draws it, the audio engine
// hears it); world metres and seconds, +Y up, north −Z, east +X, headings clockwise from north.
//
// A jet flies a straight track at constant speed and the trail it leaves drifts with the wind at
// that height, also constant, so the whole trail stays a straight segment: the point emitted `a`
// seconds ago is at   aircraft(now) − (V − W)·a   (V the jet's velocity, W the wind). The shader
// projects each sky pixel onto that line to find the age it sees, and age sets the width and the
// opacity. The trail forms only where the air is cold and moist enough, which here is a stretch
// of the track [formOn, formOff], so trails can start and end in mid-sky as real ones do.

import { deriveSeed, Rng } from '../../sim/core/rng';
import type { CloudType } from '../../sim/weather/presets';

export const MEAN_INTERVAL = 300; // s between jets in clear or fair weather, on average
// Drawn at once: a lingering trail or two while the next jet comes over. Each event lasts 13–30
// minutes (the crossing, then the trail fading), so a jet arriving while all are taken is skipped:
// in fair weather a new one comes over every 9 minutes or so.
export const MAX_CONTRAILS = 3;
export const TRAIL_GAP = 0.35; // s: the trail condenses ~90 m behind the engines
const ONSET = 2; // s for the young trail to reach full density
const VORTEX_SPREAD = 25; // m the wake vortices spread the young trail within its first minute
const VORTEX_TIME = 20; // s
const REFERENCE_WIDTH = 20; // m at which the optical depth is tau0
const EXIT = 100_000; // m along the track: by then the aircraft is a speck low in the haze

export interface ContrailWeather {
  clouds: { type: CloudType; coverage: number };
  precipitation: number; // 0..1
  visibility: number; // m
}

// How the trail ages: short-lived (dry air: gone within a minute or two) to persistent (ice-
// supersaturated air: spreading into a band of cirrus over many minutes).
export interface TrailPersistence {
  width0: number; // m, full width at half maximum just behind the aircraft
  spread: number; // m/s, steady widening after the vortex phase
  tau0: number; // optical depth across the trail at REFERENCE_WIDTH
  life: number; // s, e-folding time of the trail's ice
  maxAge: number; // s, gone (smoothly) by this age
}

export interface ContrailEvent {
  id: number;
  t0: number; // s, time the aircraft was at along = start
  closest: { x: number; z: number }; // m, the track's point of closest approach to the spawn point
  heading: number; // rad
  speed: number; // m/s
  altitude: number; // m above sea level
  start: number; // m along the track at t0 (negative: before the closest approach)
  formOn: number; // m along the track where the trail starts forming
  formOff: number; // m along the track where it stops
  wind: { x: number; z: number }; // m/s toward, at the jet's altitude
  persistence: TrailPersistence;
  strobe: { period: number; double: boolean; phase: number }; // white anti-collision strobes
  beaconPhase: number; // s, the red beacon's offset
  glintSeed: number;
}

export interface Vec2 {
  x: number;
  z: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// --- Spawn rules ---------------------------------------------------------------------------------

// Share of the clear-sky rate a cloud cover leaves: you notice jets on clear and fair days; a
// broken shower sky hides most of them; a closed deck, rain or fog hides them all.
function cloudVisibilityFactor(type: CloudType, coverage: number): number {
  const c = clamp(coverage, 0, 1);
  switch (type) {
    case 'clear':
    case 'cirrus':
      return 1;
    case 'cumulus':
      return 1 - 0.7 * smoothstep(0.3, 0.9, c);
    case 'stratocumulus':
      return 0.5 * (1 - smoothstep(0.5, 0.85, c));
    case 'cumulonimbus':
      return 0.35 * (1 - smoothstep(0.7, 0.95, c));
    case 'stratus':
    case 'nimbostratus':
      return 0.3 * (1 - smoothstep(0.4, 0.8, c));
  }
}

// Jets per second for the weather (a Poisson rate).
export function contrailRate(weather: ContrailWeather): number {
  const clouds = cloudVisibilityFactor(weather.clouds.type, weather.clouds.coverage);
  const rain = 1 - smoothstep(0.55, 0.8, weather.precipitation);
  const fog = smoothstep(1500, 6000, weather.visibility);
  return (clouds * rain * fog) / MEAN_INTERVAL;
}

// --- Track and trail -----------------------------------------------------------------------------

export const headingVector = (heading: number): Vec2 => ({ x: Math.sin(heading), z: -Math.cos(heading) });

// The wind at the jet's altitude (m/s toward): stronger than at the surface and veered a little,
// never calm (the upper westerlies blow on the calmest sea day).
export function windAloftForJet(surface: Vec2, rng: Rng): Vec2 {
  const s0 = Math.hypot(surface.x, surface.z);
  const heading = s0 > 0.3 ? Math.atan2(surface.x, -surface.z) : rng.range(0, 2 * Math.PI);
  const veer = rng.range(0.1, 0.45);
  const speed = clamp(8 + 1.8 * s0 + rng.range(-4, 6), 5, 45);
  const d = headingVector(heading + veer);
  return { x: d.x * speed, z: d.z * speed };
}

export function persistenceFor(persistent: number, rng: Rng): TrailPersistence {
  const long = persistent >= 0.5;
  const life = long ? rng.range(150, 360) : rng.range(25, 70);
  return {
    width0: rng.range(3, 6),
    spread: long ? rng.range(0.8, 2) : rng.range(0.25, 0.6),
    tau0: long ? rng.range(0.75, 1) : rng.range(0.5, 0.7),
    life,
    maxAge: life * 3,
  };
}

export interface PlanOptions {
  time: number; // s, now
  around: Vec2; // m, where the track passes near (the camera)
  surfaceWind: Vec2; // m/s toward
  cirrus?: boolean; // moist upper air: persistent trails more likely
  forced?: boolean; // debug: already in flight close by, with a trail behind it
}

// A random jet crossing: straight track at 9.5–11.5 km and 230–260 m/s, passing within ~45 km.
export function planContrail(rng: Rng, id: number, options: PlanOptions): ContrailEvent {
  const heading = rng.range(0, 2 * Math.PI);
  const side = rng.next() < 0.5 ? -1 : 1;
  const offset = options.forced ? rng.range(2000, 9000) : 45_000 * rng.next() ** 1.3;
  const n = headingVector(heading + Math.PI / 2);
  const speed = rng.range(230, 260);
  const altitude = rng.range(9500, 11_500);
  const start = -rng.range(80_000, 120_000);
  let formOn = Math.max(start, -lerp(15_000, 100_000, rng.next()));
  const formOff = lerp(15_000, 100_000, rng.next());
  let t0 = options.time;
  if (options.forced) {
    // Already 25 km out on its way over, the trail behind it formed long ago.
    formOn = start;
    t0 = options.time - (-25_000 - start) / speed;
  }
  const persistent = options.cirrus ? Math.max(rng.next(), rng.next()) : rng.next();
  return {
    id,
    t0,
    closest: { x: options.around.x + n.x * offset * side, z: options.around.z + n.z * offset * side },
    heading,
    speed,
    altitude,
    start,
    formOn,
    formOff,
    wind: windAloftForJet(options.surfaceWind, rng),
    persistence: persistenceFor(persistent, rng),
    strobe: { period: rng.range(1, 1.5), double: rng.next() < 0.5, phase: rng.range(0, 2) },
    beaconPhase: rng.range(0, 1),
    glintSeed: rng.range(0, 1000),
  };
}

// Metres along the track at time t.
export const alongTrack = (e: ContrailEvent, t: number): number => e.start + e.speed * (t - e.t0);

export function aircraftPosition(
  e: ContrailEvent,
  t: number,
  out = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } {
  const s = alongTrack(e, t);
  const u = headingVector(e.heading);
  out.x = e.closest.x + u.x * s;
  out.y = e.altitude;
  out.z = e.closest.z + u.z * s;
  return out;
}

export function aircraftVelocity(e: ContrailEvent): { x: number; y: number; z: number } {
  const u = headingVector(e.heading);
  return { x: u.x * e.speed, y: 0, z: u.z * e.speed };
}

// V − W: the trail point of age a sits at aircraft(now) − this × a.
export function trailRecession(e: ContrailEvent): Vec2 {
  const u = headingVector(e.heading);
  return { x: u.x * e.speed - e.wind.x, z: u.z * e.speed - e.wind.z };
}

// Where the air that left the engines `age` seconds ago is now (xz, m).
export function trailPoint(e: ContrailEvent, t: number, age: number): Vec2 {
  const p = aircraftPosition(e, t);
  const r = trailRecession(e);
  return { x: p.x - r.x * age, z: p.z - r.z * age };
}

// Ages present in the trail at time t: [min, max] (s); empty when max ≤ min.
export function trailAgeRange(e: ContrailEvent, t: number): { min: number; max: number } {
  const s = alongTrack(e, t);
  const min = Math.max(TRAIL_GAP, (s - e.formOff) / e.speed);
  const max = Math.min(t - e.t0, (s - e.formOn) / e.speed, e.persistence.maxAge);
  return { min, max };
}

// The aircraft has flown out of sight and its newest trail has faded.
export function contrailFinished(e: ContrailEvent, t: number): boolean {
  const s = alongTrack(e, t);
  return s > EXIT && (s - e.formOff) / e.speed > e.persistence.maxAge;
}

// Full width at half maximum (m) of the trail at an age: the vortex phase, then steady spreading.
export function trailWidth(p: TrailPersistence, age: number): number {
  const a = Math.max(0, age);
  return p.width0 + VORTEX_SPREAD * (1 - Math.exp(-a / VORTEX_TIME)) + p.spread * a;
}

// Peak optical depth across the trail at an age: condenses over the first seconds, thins as it
// spreads (partly made up by ice growing in moist air) and fades with the ice's life.
function trailOpticalDepth(p: TrailPersistence, age: number): number {
  if (age <= TRAIL_GAP || age >= p.maxAge) return 0;
  const onset = smoothstep(TRAIL_GAP, TRAIL_GAP + ONSET, age);
  const dilution = Math.min(1.4, (REFERENCE_WIDTH / trailWidth(p, age)) ** 0.35);
  const fade = Math.exp(-age / p.life) * (1 - smoothstep(0.6 * p.maxAge, p.maxAge, age));
  return p.tau0 * onset * dilution * fade;
}

// Opacity of the trail's core at an age (resolved, not pixel-filtered).
export const trailOpacity = (p: TrailPersistence, age: number): number =>
  1 - Math.exp(-trailOpticalDepth(p, age));

// Shader constants mirrored from the functions above (ContrailSystem).
export const TRAIL_SHAPE = {
  gap: TRAIL_GAP,
  onset: ONSET,
  vortexSpread: VORTEX_SPREAD,
  vortexTime: VORTEX_TIME,
  referenceWidth: REFERENCE_WIDTH,
} as const;

// --- Lights ---------------------------------------------------------------------------------------

const pulse = (t: number, period: number, phase: number, length: number): number => {
  const x = (((t + phase) % period) + period) % period;
  return x < length ? 1 : 0;
};

// Luminous intensities (cd) of the aircraft's lights at time t: steady red (port) and green
// (starboard) wingtip lights, the white strobes (single or double flash) and the red beacon.
export function aircraftLights(
  e: ContrailEvent,
  t: number,
): { red: number; green: number; strobe: number; beacon: number } {
  const s = e.strobe;
  const strobe = Math.max(
    pulse(t, s.period, s.phase, 0.06),
    s.double ? pulse(t, s.period, s.phase - 0.16, 0.06) : 0,
  );
  return { red: 40, green: 40, strobe: 400 * strobe, beacon: 150 * pulse(t, 1, e.beaconPhase, 0.1) };
}

// Sun glint off the fuselage, 0..1: mostly faint, now and then flashing as the angle sweeps by.
export function aircraftGlint(e: ContrailEvent, t: number): number {
  const a = Math.sin(t * 0.37 + e.glintSeed) * 0.6 + Math.sin(t * 0.91 + e.glintSeed * 1.7) * 0.4;
  return 0.15 + 0.85 * Math.max(0, a) ** 8;
}

// --- Schedule -------------------------------------------------------------------------------------

export interface ScheduleFrame {
  time: number; // s
  around: Vec2; // m, the camera
  weather: ContrailWeather;
  surfaceWind: Vec2; // m/s toward
}

// Rare random jets, deterministic per seed for a given run of frames: a Poisson process whose rate
// follows the weather (the hazard integrates the rate; a jet spawns when it passes an exponential
// draw), at most MAX_CONTRAILS at once.
export class ContrailSchedule {
  readonly events: ContrailEvent[] = [];
  private rng: Rng;
  private hazard = 0;
  private threshold: number;
  private lastTime = Number.NaN;
  private nextId = 1;

  constructor(seed: number) {
    this.rng = new Rng(deriveSeed(seed, 'contrails'));
    this.threshold = this.draw();
  }

  update(frame: ScheduleFrame): void {
    const dt = Number.isFinite(this.lastTime) ? clamp(frame.time - this.lastTime, 0, 1) : 0;
    this.lastTime = frame.time;
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e && contrailFinished(e, frame.time)) this.events.splice(i, 1);
    }
    this.hazard += contrailRate(frame.weather) * dt;
    if (this.hazard < this.threshold) return;
    this.hazard = 0;
    this.threshold = this.draw();
    if (this.events.length >= MAX_CONTRAILS) return;
    this.spawn(frame, false);
  }

  // Debug: a jet passing nearly overhead right now (replaces the oldest if all slots are taken).
  force(frame: ScheduleFrame): ContrailEvent {
    if (this.events.length >= MAX_CONTRAILS) this.events.shift();
    return this.spawn(frame, true);
  }

  private spawn(frame: ScheduleFrame, forced: boolean): ContrailEvent {
    const event = planContrail(this.rng, this.nextId++, {
      time: frame.time,
      around: frame.around,
      surfaceWind: frame.surfaceWind,
      cirrus: frame.weather.clouds.type === 'cirrus',
      forced,
    });
    this.events.push(event);
    return event;
  }

  private draw(): number {
    return -Math.log(1 - this.rng.next() * 0.999999);
  }
}
