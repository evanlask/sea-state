// Earth atmosphere parameters for the Hillaire 2020 sky model, plus the photometric constants of the
// sun and moon. Lengths are kilometres and coefficients 1/km, as in the reference implementations
// (Hillaire's MIT UnrealEngineSkyAtmosphere demo and JolifantoBambla/webgpu-sky-atmosphere, MIT).
// Pure TS: shared by the GPU LUTs and the CPU light/exposure code.

export type Rgb = readonly [number, number, number];

export interface AtmosphereParams {
  bottomRadius: number; // km, planet centre to sea level
  topRadius: number; // km, planet centre to the top of the atmosphere
  rayleighScattering: Rgb; // 1/km at sea level
  rayleighScaleHeight: number; // km
  mieScattering: Rgb; // 1/km at sea level
  mieExtinction: Rgb; // 1/km at sea level (scattering + absorption)
  mieScaleHeight: number; // km
  mieG: number; // Henyey-Greenstein asymmetry
  ozoneAbsorption: Rgb; // 1/km at peak density
  ozoneCenter: number; // km, altitude of peak ozone density
  ozoneHalfWidth: number; // km, tent profile half width
  groundAlbedo: Rgb; // ocean planet: much darker than Hillaire's 0.4 land default
}

// Hillaire 2020 / Bruneton Earth values [V: webgpu-sky-atmosphere makeEarthAtmosphere()].
export const EARTH_ATMOSPHERE: AtmosphereParams = {
  bottomRadius: 6360,
  topRadius: 6460,
  rayleighScattering: [0.005802, 0.013558, 0.0331],
  rayleighScaleHeight: 8,
  mieScattering: [0.003996, 0.003996, 0.003996],
  mieExtinction: [0.00444, 0.00444, 0.00444],
  mieScaleHeight: 1.2,
  mieG: 0.8,
  ozoneAbsorption: [0.00065, 0.001881, 0.000085],
  ozoneCenter: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: [0.08, 0.08, 0.08],
};

export interface AtmosphereConditions {
  // Aerosol (Mie) density multiplier: 1 = clear maritime air, 3–5 = hazy, 10 = thick haze.
  hazeDensity: number;
  // 0 = clear, 1 = fully overcast: dims and greys the clear sky and cuts the direct beam.
  overcast: number;
}

export const DEFAULT_CONDITIONS: AtmosphereConditions = { hazeDensity: 1, overcast: 0 };

// Haze scales aerosol scattering and extinction together, keeping the single-scattering albedo.
export function atmosphereWithHaze(base: AtmosphereParams, hazeDensity: number): AtmosphereParams {
  const k = Math.max(0, hazeDensity);
  const scale = (c: Rgb): Rgb => [c[0] * k, c[1] * k, c[2] * k];
  return { ...base, mieScattering: scale(base.mieScattering), mieExtinction: scale(base.mieExtinction) };
}

const DEG = Math.PI / 180;

// Solar illuminance at the top of the atmosphere: 1361 W/m² × ~93 lm/W [K].
export const SUN_ILLUMINANCE_TOA = 128_000; // lux
export const SUN_ANGULAR_RADIUS = 0.2666 * DEG; // rad
export const MOON_ANGULAR_RADIUS = 0.259 * DEG; // rad, mean
// Lunar regolith reflects sunlight slightly reddened [K].
export const MOON_TINT: Rgb = [1.0, 0.94, 0.86];

export const solidAngle = (angularRadius: number): number => 2 * Math.PI * (1 - Math.cos(angularRadius));

// Apparent V magnitude of the moon versus phase angle (Allen; Krisciunas & Schaefer 1991) [K].
function moonMagnitude(phaseAngle: number): number {
  const a = Math.min(Math.abs(phaseAngle), Math.PI) / DEG;
  return -12.73 + 0.026 * a + 4e-9 * a ** 4;
}

// Illuminance (lux) from an object of apparent V magnitude, outside the atmosphere [K].
const magnitudeToIlluminance = (magnitude: number): number => 10 ** ((-14.18 - magnitude) / 2.5);

// Moon illuminance outside the atmosphere for a given phase angle (0 = full, π = new).
export const moonIlluminanceToa = (phaseAngle: number): number =>
  magnitudeToIlluminance(moonMagnitude(phaseAngle));

// Disk-integrated Lommel-Seeliger phase function, normalised to 1 at full moon.
export function lommelSeeligerPhase(phaseAngle: number): number {
  const a = Math.min(Math.max(Math.abs(phaseAngle), 1e-4), Math.PI - 1e-3);
  return Math.max(0, 1 - Math.sin(a / 2) * Math.tan(a / 2) * Math.log(1 / Math.tan(a / 4)));
}

// Fraction of a disk of angular radius r whose centre sits at elevation e that lies above the
// horizon (circular segment area). Used to fade the sun and moon as they set.
export function diskFractionAboveHorizon(elevation: number, radius: number): number {
  const x = Math.max(-1, Math.min(1, elevation / radius));
  return (Math.PI / 2 + Math.asin(x) + x * Math.sqrt(1 - x * x)) / Math.PI;
}
