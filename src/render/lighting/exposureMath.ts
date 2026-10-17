// Exposure maths shared by the CPU pre-exposure and the GPU auto-exposure kernel: EV100 metering,
// the night-darkening compensation curve, eye adaptation, and a clear-sky illuminance model used
// before (or instead of) GPU metering. Pure TS.
//
// Conventions (Lagarde & de Rousiers 2014, "Moving Frostbite to PBR"):
//   EV100 from scene luminance L (cd/m²):     log2(L · 100 / K), K = 12.5 (reflected-light meter)
//   EV100 from illuminance E (lux):          log2(E · 100 / C), C = 250 (incident-light meter)
//   exposure multiplier (saturation based):  1 / (1.2 · 2^EV100)

const REFLECTED_METER_K = 12.5;
const INCIDENT_METER_C = 250;

export const ev100FromLuminance = (luminance: number): number =>
  Math.log2((Math.max(luminance, 1e-9) * 100) / REFLECTED_METER_K);
export const ev100FromIlluminance = (illuminance: number): number =>
  Math.log2((Math.max(illuminance, 1e-9) * 100) / INCIDENT_METER_C);
export const exposureFromEv100 = (ev100: number): number => 1 / (1.2 * 2 ** ev100);
export const ev100FromExposure = (exposure: number): number =>
  Math.log2(1 / (1.2 * Math.max(exposure, 1e-12)));

export interface ExposureSettings {
  mode: 'auto' | 'manual';
  manualEv100: number;
  minEv100: number; // clamps how far night is brightened
  maxEv100: number;
  compensation: number; // user bias in EV; positive brightens
  speedUp: number; // 1/s, adaptation rate when the scene gets brighter (EV rising)
  speedDown: number; // 1/s, dark adaptation is slower
  nightDarkening: boolean; // apply the sun-elevation compensation curve
}

export const DEFAULT_EXPOSURE_SETTINGS: ExposureSettings = {
  mode: 'auto',
  manualEv100: 14,
  minEv100: -6,
  maxEv100: 16.5,
  compensation: 0,
  speedUp: 2.5,
  speedDown: 0.9,
  nightDarkening: true,
};

const DEG = Math.PI / 180;

// Piecewise-linear interpolation in a sorted [x, y] table, clamped at both ends.
function interpolate(table: readonly (readonly [number, number])[], x: number): number {
  const first = table[0];
  const last = table[table.length - 1];
  if (!first || !last) return 0;
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1];
    const b = table[i];
    if (a && b && x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return last[1];
}

// EV added (darker) versus sun elevation, so dusk and night read as dusk and night rather than
// being metered back up to daylight brightness. Degrees → EV.
const NIGHT_DARKENING: readonly (readonly [number, number])[] = [
  [-18, 2.5],
  [-12, 2.1],
  [-6, 1.2],
  [-2, 0.6],
  [0, 0.35],
  [8, 0],
];

export const nightDarkening = (sunElevation: number): number =>
  interpolate(NIGHT_DARKENING, sunElevation / DEG);

// Highlight protection, as in matrix metering and the eye: the log average alone lets a small
// bright area (flood-lit deck seen from a dark wheelhouse, a lamp-lit cockpit at night) blow out
// and veil the frame with bloom. The meter also takes the plain mean luminance, with each sample
// capped at HIGHLIGHT_SAMPLE_MAX pre-exposed units so the sun disk and glints can't dominate it,
// and keeps that mean within HIGHLIGHT_HEADROOM_EV stops above mid-grey. Ordinary scenes, where
// the mean sits 1–2 stops above the log average, are unchanged.
export const HIGHLIGHT_SAMPLE_MAX = 64; // pre-exposed luminance (~1 is diffuse white)
export const HIGHLIGHT_HEADROOM_EV = 3;

export const highlightProtectedEv100 = (logAverageEv100: number, meanEv100: number): number =>
  Math.max(logAverageEv100, meanEv100 - HIGHLIGHT_HEADROOM_EV);

// Target EV100 for a metered EV100. Clamped first, then darkened, then the user bias.
export function targetEv100(metered: number, sunElevation: number, settings: ExposureSettings): number {
  if (settings.mode === 'manual') return settings.manualEv100;
  const clamped = Math.min(settings.maxEv100, Math.max(settings.minEv100, metered));
  const darken = settings.nightDarkening ? nightDarkening(sunElevation) : 0;
  return clamped + darken - settings.compensation;
}

// Exponential eye adaptation toward a target EV; frame-rate independent.
export function adaptEv100(current: number, target: number, dt: number, settings: ExposureSettings): number {
  const rate = target > current ? settings.speedUp : settings.speedDown;
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dt) * rate));
}

// Clear-sky global horizontal illuminance from the sun and sky (lux, log10) versus sun elevation
// in degrees [K: USNO/Bond & Henderson twilight tables, smoothed].
const SUN_SKY_ILLUMINANCE_LOG10: readonly (readonly [number, number])[] = [
  [-18, -3.2],
  [-12, -2.1],
  [-10, -1.2],
  [-8, -0.35],
  [-6, 0.53],
  [-4, 1.38],
  [-2, 2.15],
  [0, 2.8],
  [5, 3.75],
  [10, 4.15],
  [20, 4.55],
  [30, 4.75],
  [45, 4.92],
  [60, 5.0],
  [90, 5.06],
];

export interface IlluminanceInputs {
  sunElevation: number; // rad
  moonElevation: number; // rad
  moonIlluminance: number; // lux outside the atmosphere for the current phase
  overcast: number; // 0..1
}

// Total horizontal illuminance: sun + sky + moon + starlight/airglow floor. Overcast cuts direct
// and sky light by up to a factor of ten.
export function estimateIlluminance(inputs: IlluminanceInputs): number {
  const sunSky = 10 ** interpolate(SUN_SKY_ILLUMINANCE_LOG10, inputs.sunElevation / DEG);
  const moonUp = Math.max(0, Math.sin(inputs.moonElevation));
  const moon = inputs.moonIlluminance * (moonUp * 0.9 + (moonUp > 0 ? 0.1 : 0));
  const night = 1e-3;
  return (sunSky + moon) * 10 ** -Math.min(1, Math.max(0, inputs.overcast)) + night;
}
