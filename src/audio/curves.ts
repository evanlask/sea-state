// Pure parameter-mapping curves for the audio engine: physical inputs (wind speed, significant wave
// height, rain rate, boat speed, environment) to gains and filter settings. No Web Audio here, so every
// curve is unit-tested; the graph code only copies these numbers into AudioParams.

export const SPEED_OF_SOUND = 343; // m/s in air at 20 °C

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x: number): number => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// Interpolates frequencies on a log scale, which is how pitch and filter sweeps are heard.
const logLerp = (a: number, b: number, t: number): number => a * Math.pow(b / a, t);

// Probability that a Poisson process with `rate` events/s fires at least once in `dt` seconds.
export const poissonChance = (rate: number, dt: number): number =>
  rate <= 0 || dt <= 0 ? 0 : 1 - Math.exp(-rate * dt);

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (gain: number): number => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

// ---------------------------------------------------------------------------------------------
// Volume sliders

const VOLUME_RANGE_DB = 30;
const VOLUME_TAPER = 0.1;

// Slider 0..1 to linear gain. A 30 dB exponential curve sounds even across the slider (a linear
// slider does nothing for its top half), with a linear taper below 10% so 0 is true silence.
export function volumeToGain(volume: number): number {
  const v = clamp01(Number.isFinite(volume) ? volume : 0);
  if (v === 0) return 0;
  return dbToGain(-VOLUME_RANGE_DB * (1 - v)) * Math.min(1, v / VOLUME_TAPER);
}

// The slider position that gives `gain` (inverse of volumeToGain; gains above unity give 1).
export function gainToVolume(gain: number): number {
  if (!(gain > 0)) return 0;
  const v = 1 + gainToDb(gain) / VOLUME_RANGE_DB;
  if (v >= 1) return 1;
  if (v >= VOLUME_TAPER) return v;
  // In the taper: bisect (volumeToGain is increasing).
  let lo = 0;
  let hi = VOLUME_TAPER;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (volumeToGain(mid) < gain) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------------------------
// Wind

export interface WindParams {
  loudness: number; // 0..1 overall wind level
  rushGain: number; // broadband rush
  rushCutoff: number; // Hz, low-pass on the rush
  howlGain: number; // resonant band-pass "howl"
  howlFreq: number; // Hz
  howlQ: number;
  whistleGain: number; // high shriek in storm-force wind
  whistleFreq: number; // Hz
}

export const createWindParams = (): WindParams => ({
  loudness: 0,
  rushGain: 0,
  rushCutoff: 250,
  howlGain: 0,
  howlFreq: 200,
  howlQ: 3,
  whistleGain: 0,
  whistleFreq: 2000,
});

// Calm is near silent (2 m/s ≈ −38 dB), a gale about −6 dB, a hurricane saturates at full level.
export function windLoudness(speed: number): number {
  const s = Math.max(0, speed);
  return 1 - Math.exp(-Math.pow(s / 30, 1.6));
}

// `speed` is the instantaneous wind (mean plus gust) at the listener, m/s.
export function windParams(speed: number, out: WindParams = createWindParams()): WindParams {
  const s = Math.max(0, speed);
  const loud = windLoudness(s);
  out.loudness = loud;
  out.rushGain = 0.55 * loud;
  out.rushCutoff = logLerp(250, 7000, Math.pow(loud, 0.8));
  // Edge tones rise with flow speed; Q sharpens as the flow gets more organised around fittings.
  out.howlFreq = 180 + 22 * s;
  out.howlQ = Math.min(3 + 0.3 * s, 22);
  // Narrow bands carry little power, so compensate with Q to keep the howl audible.
  out.howlGain = 0.22 * loud * smoothstep(6, 25, s) * Math.sqrt(out.howlQ / 3);
  out.whistleFreq = 1900 + 40 * s;
  out.whistleGain = 0.12 * loud * smoothstep(25, 55, s);
  return out;
}

// Vortex-shedding (Aeolian) tone of a wire or stay: f = St·U/d with Strouhal ≈ 0.2.
export const aeolianFrequency = (speed: number, diameter: number): number =>
  (0.2 * Math.max(0, speed)) / Math.max(diameter, 1e-4);

// Sailboat rigging moan: grows from a fresh breeze and dominates in a gale of apparent wind.
export const riggingGain = (apparentWind: number): number => 0.2 * smoothstep(8, 28, apparentWind);

// ---------------------------------------------------------------------------------------------
// Sea

export interface SeaParams {
  loudness: number; // overall bed level; its square is the bed's total energy
  lapGain: number; // calm: lapping and close splashes
  washGain: number; // moderate: open-sea wash
  roarGain: number; // storm: deep roar
  swellRate: number; // Hz, the wash's slow swell modulation (1 / Tp)
  washCenter: number; // Hz
  roarCutoff: number; // Hz
  lapRate: number; // lap one-shots per second
  crestRate: number; // breaking-crest bursts per second
  crestGain: number;
}

export const createSeaParams = (): SeaParams => ({
  loudness: 0,
  lapGain: 0,
  washGain: 0,
  roarGain: 0,
  swellRate: 0.1,
  washCenter: 700,
  roarCutoff: 200,
  lapRate: 0,
  crestRate: 0,
  crestGain: 0,
});

// Mix weights for the three beds; they sum to 1 and never overlap lap with roar.
export interface SeaBedWeights {
  lap: number;
  wash: number;
  roar: number;
}

export function seaBedWeights(hs: number, out: SeaBedWeights = { lap: 0, wash: 0, roar: 0 }): SeaBedWeights {
  out.lap = 1 - smoothstep(0.4, 2, hs);
  out.roar = smoothstep(3, 9, hs);
  out.wash = Math.max(0, 1 - out.lap - out.roar);
  return out;
}

const scratchWeights: SeaBedWeights = { lap: 0, wash: 0, roar: 0 };

const seaLoudness = (hs: number): number => 0.12 + 0.88 * (1 - Math.exp(-Math.max(0, hs) / 4));

// Peak period when the caller has none: Pierson-Moskowitz gives Tp ≈ 5·√Hs.
const defaultPeakPeriod = (hs: number): number => clamp(5 * Math.sqrt(Math.max(hs, 0)), 2, 16);

// Whitecaps begin around Beaufort 3 (~4 m/s); their rate grows with wind and sea height.
export function crestRate(windSpeed: number, hs: number): number {
  return 0.6 * smoothstep(4, 12, windSpeed) * (0.3 + Math.min(Math.max(hs, 0), 12) / 4);
}

export function seaParams(
  hs: number,
  windSpeed: number,
  peakPeriod: number | undefined,
  out: SeaParams = createSeaParams(),
): SeaParams {
  const h = Math.max(0, hs);
  const w = seaBedWeights(h, scratchWeights);
  const loud = seaLoudness(h);
  out.loudness = loud;
  // Equal-power cross-fade: the total energy follows loudness² whatever the mix.
  out.lapGain = 0.5 * loud * Math.sqrt(w.lap);
  out.washGain = 0.5 * loud * Math.sqrt(w.wash);
  out.roarGain = 0.5 * loud * Math.sqrt(w.roar);
  out.swellRate = 1 / (peakPeriod && peakPeriod > 0 ? peakPeriod : defaultPeakPeriod(h));
  out.washCenter = lerp(800, 450, smoothstep(0.5, 8, h));
  out.roarCutoff = lerp(160, 420, smoothstep(3, 16, h));
  out.lapRate = w.lap * (1.2 + 3 * smoothstep(0.03, 0.6, h));
  out.crestRate = crestRate(windSpeed, h);
  out.crestGain = 0.25 + 0.55 * smoothstep(1, 12, h);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Rain

export interface RainParams {
  deckHiss: number;
  waterHiss: number;
  deckDrops: number; // droplet clicks on hard surfaces
  waterDrops: number; // droplet "plinks" on water
  denseMix: number; // 0 = sparse drop loop, 1 = dense
}

export const createRainParams = (): RainParams => ({
  deckHiss: 0,
  waterHiss: 0,
  deckDrops: 0,
  waterDrops: 0,
  denseMix: 0,
});

// intensity 0..1 (drizzle to torrential); deck 0..1 is how much hard surface is around the listener.
export function rainParams(
  intensity: number,
  deck: number,
  out: RainParams = createRainParams(),
): RainParams {
  const i = clamp01(intensity);
  const d = clamp01(deck);
  const hiss = 0.3 * Math.pow(i, 0.8);
  // Individual drops are what you hear in light rain; heavy rain fuses into hiss.
  const drops = 0.22 * Math.sqrt(i) * (1 - 0.4 * smoothstep(0.5, 1, i));
  out.deckHiss = hiss * d;
  out.waterHiss = hiss * (1 - d);
  out.deckDrops = drops * d;
  out.waterDrops = drops * (1 - d) * 0.7;
  out.denseMix = smoothstep(0.25, 0.8, i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Environment muffling

export interface EnvironmentParams {
  cutoff: number; // Hz, low-pass on every exterior sound
  q: number;
  exteriorGain: number;
  interiorHum: number; // closed-bridge machinery hum
  underwaterBed: number; // low rumble heard under the surface
}

export const createEnvironmentParams = (): EnvironmentParams => ({
  cutoff: 18000,
  q: 0.707,
  exteriorGain: 1,
  interiorHum: 0,
  underwaterBed: 0,
});

const OPEN_CUTOFF = 18000;
const ENCLOSED_CUTOFF = 900; // through bridge windows and steel
const UNDERWATER_CUTOFF = 300;

export function environmentParams(
  enclosed: number,
  underwater: number,
  out: EnvironmentParams = createEnvironmentParams(),
): EnvironmentParams {
  const e = clamp01(enclosed);
  const u = clamp01(underwater);
  const ln = Math.log(OPEN_CUTOFF) + e * Math.log(ENCLOSED_CUTOFF / OPEN_CUTOFF);
  out.cutoff = Math.max(200, Math.exp(ln + u * Math.log(UNDERWATER_CUTOFF / OPEN_CUTOFF)));
  out.q = 0.707 + 0.5 * u; // a slight resonance makes the underwater muffle "boomy"
  out.exteriorGain = (1 - 0.55 * e) * (1 - 0.4 * u);
  out.interiorHum = 0.07 * e * (1 - u);
  out.underwaterBed = 0.28 * u;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Distance and motion

// Frequency where atmospheric absorption reaches ~6 dB over `distance` (α ≈ 1.6e-9·f² dB/m at
// 20 °C, 50 % RH), used as a per-source low-pass so far boats sound dull.
export function airAbsorptionCutoff(distance: number): number {
  const d = Math.max(distance, 1);
  return clamp(61237 / Math.sqrt(d), 300, 20000);
}

// Doppler factor for a source and listener: (c − v_l·n) / (c − v_s·n), with n the unit vector from
// source to listener and v_l·n, v_s·n the velocity components along it (m/s). Clamped to stay sane
// near the speed of sound or with bad input.
export function dopplerFactor(listenerAlong: number, sourceAlong: number): number {
  const c = SPEED_OF_SOUND;
  const vl = clamp(listenerAlong, -0.5 * c, 0.5 * c);
  const vs = clamp(sourceAlong, -0.5 * c, 0.5 * c);
  return clamp((c - vl) / (c - vs), 0.5, 2);
}

// ---------------------------------------------------------------------------------------------
// Hull and sail

export interface SlamParams {
  gain: number;
  rate: number; // playback rate: big hulls and weak slams sound lower
  cutoff: number; // Hz
}

// strength ≈ impact speed, m/s. hullScale 0 (jet ski) .. 1 (ship).
export function slamParams(strength: number, hullScale: number, out: SlamParams): SlamParams {
  const s = Math.max(0, strength);
  const k = clamp01(hullScale);
  out.gain = Math.min(1, Math.pow(s / 8, 1.2)) * (s < 0.3 ? 0 : 1);
  out.rate = lerp(1.25, 0.55, k) * (0.85 + 0.15 * Math.min(1, s / 6));
  out.cutoff = lerp(1200, 5000, clamp01(s / 10)) * lerp(1, 0.5, k);
  return out;
}

// Hull-on-hull impact (closing speed, m/s): a slam sample pitched down and louder per m/s than a
// slam (boats are hard), plus a structural groan that grows with the impact.
export interface CollisionParams extends SlamParams {
  groan: number; // 0..1 creak layer gain
}

export function collisionParams(speed: number, hullScale: number, out: CollisionParams): CollisionParams {
  const s = Math.max(0, speed);
  const k = clamp01(hullScale);
  out.gain = s < 0.3 ? 0 : Math.min(1, 0.15 + s / 4);
  out.rate = lerp(1.0, 0.45, k) * (0.8 + 0.1 * Math.min(1, s / 4));
  out.cutoff = lerp(900, 3500, clamp01(s / 6)) * lerp(1, 0.6, k);
  out.groan = s < 0.3 ? 0 : Math.min(1, 0.2 + s / 5);
  return out;
}

// Normalized speed through water: 0 at rest, 1 at the hull's top speed.
export const waterRushLevel = (speed: number, topSpeed: number): number =>
  clamp01(Math.abs(speed) / Math.max(topSpeed, 0.1));

export const waterRushGain = (level: number): number => 0.45 * Math.pow(clamp01(level), 1.3);

// Band centre of the hull rush; large hulls sound lower.
export const waterRushCenter = (level: number, hullScale: number): number =>
  lerp(280, 1900, clamp01(level)) * lerp(1, 0.45, clamp01(hullScale));

// Bow-splash bursts per second, from speed and sea height.
export const bowSplashRate = (level: number, hs: number): number =>
  level < 0.05 ? 0 : 3 * level * smoothstep(0.1, 2.5, hs + 0.3 * level);

// Creaks per second from angular motion (rad/s) in a seaway.
export const creakRate = (motion: number, hs: number): number =>
  1.6 * smoothstep(0.03, 0.35, Math.abs(motion)) * smoothstep(1, 4, hs);

export interface FlogParams {
  gain: number;
  rate: number; // Hz, base flapping rate (the modulator adds irregularity)
  center: number; // Hz, band centre of the cloth noise
  snapRate: number; // sharp cracks per second at heavy flogging
}

export function flogParams(luffing: number, apparentWind: number, out: FlogParams): FlogParams {
  const l = clamp01(luffing);
  const aw = Math.max(0, apparentWind);
  out.gain = 0.4 * Math.pow(l, 1.3) * smoothstep(1, 12, aw);
  out.rate = 4 + 4 * clamp01(aw / 20);
  out.center = 220 + 30 * Math.min(aw, 30);
  out.snapRate = l > 0.4 ? 2.5 * smoothstep(0.4, 1, l) * smoothstep(6, 18, aw) : 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Output safety

// Transfer curve for a WaveShaper after the limiter: exactly linear up to `knee`, then a tanh
// shoulder that never reaches full scale, so a transient the limiter's attack lets through
// saturates softly instead of clipping hard.
export function softClipCurve(samples = 2048, knee = 0.75, ceiling = 0.98): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(samples);
  const room = ceiling - knee;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}
