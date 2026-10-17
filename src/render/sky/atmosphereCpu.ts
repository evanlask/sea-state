// CPU evaluation of the atmosphere's transmittance, matching the GPU transmittance LUT integrator,
// so the sun and moon DirectionalLight can be coloured without a GPU readback. Pure TS.

import {
  type AtmosphereParams,
  diskFractionAboveHorizon,
  MOON_ANGULAR_RADIUS,
  MOON_TINT,
  moonIlluminanceToa,
  type Rgb,
  SUN_ANGULAR_RADIUS,
  SUN_ILLUMINANCE_TOA,
} from './atmosphereParams';

// Shared with the GPU kernel: samples cluster near the ray origin, where the air is densest.
export const TRANSMITTANCE_SAMPLES = 64;

export type MutableRgb = [number, number, number];

// Extinction coefficients (1/km) at an altitude (km above sea level).
function extinctionAt(params: AtmosphereParams, altitude: number, out: MutableRgb): MutableRgb {
  const h = Math.max(0, altitude);
  const rayleigh = Math.exp(-h / params.rayleighScaleHeight);
  const mie = Math.exp(-h / params.mieScaleHeight);
  const ozone = Math.max(0, 1 - Math.abs(h - params.ozoneCenter) / params.ozoneHalfWidth);
  for (let c = 0; c < 3; c++) {
    out[c] =
      (params.rayleighScattering[c] ?? 0) * rayleigh +
      (params.mieExtinction[c] ?? 0) * mie +
      (params.ozoneAbsorption[c] ?? 0) * ozone;
  }
  return out;
}

const scratch: MutableRgb = [0, 0, 0];

// Transmittance from an altitude (km) to the top of the atmosphere along a direction with the
// given cosine of the zenith angle. Zero when the ray hits the planet.
export function transmittanceToTop(
  params: AtmosphereParams,
  altitude: number,
  cosZenith: number,
  out: MutableRgb = [0, 0, 0],
): MutableRgb {
  const r = params.bottomRadius + Math.max(altitude, 0);
  const mu = Math.max(-1, Math.min(1, cosZenith));
  // Ground hit: below the geometric horizon of this altitude.
  const horizonMu = -Math.sqrt(Math.max(0, 1 - (params.bottomRadius / r) ** 2));
  if (mu < horizonMu) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const b = r * mu;
  const c = r * r - params.topRadius * params.topRadius;
  const tMax = -b + Math.sqrt(Math.max(0, b * b - c));
  const depth: MutableRgb = [0, 0, 0];
  const n = TRANSMITTANCE_SAMPLES;
  const sinZenith = Math.sqrt(Math.max(0, 1 - mu * mu));
  for (let i = 0; i < n; i++) {
    const t0 = (i / n) ** 2 * tMax;
    const t1 = ((i + 1) / n) ** 2 * tMax;
    const t = 0.5 * (t0 + t1);
    const x = t * sinZenith;
    const y = r + t * mu;
    extinctionAt(params, Math.hypot(x, y) - params.bottomRadius, scratch);
    for (let k = 0; k < 3; k++) depth[k] = (depth[k] ?? 0) + scratch[k] * (t1 - t0);
  }
  out[0] = Math.exp(-depth[0]);
  out[1] = Math.exp(-depth[1]);
  out[2] = Math.exp(-depth[2]);
  return out;
}

const luminance = (c: Rgb): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Direct illuminance (lux, linear Rec.709 RGB) from a disk light, attenuated by the atmosphere
// and by the part of the disk below the horizon. `elevation` is radians above the horizon.
function diskIlluminance(
  params: AtmosphereParams,
  elevation: number,
  radius: number,
  toa: number,
  tint: Rgb,
  altitude: number,
  out: MutableRgb,
): MutableRgb {
  const visible = diskFractionAboveHorizon(elevation, radius);
  if (visible <= 0) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  // The visible part of a setting disk sits just above the horizon.
  const effectiveElevation = Math.max(elevation, (elevation + radius) * 0.5, 0);
  transmittanceToTop(params, altitude, Math.sin(effectiveElevation), out);
  const scale = (toa * visible) / Math.max(luminance(tint), 1e-6);
  out[0] *= scale * tint[0];
  out[1] *= scale * tint[1];
  out[2] *= scale * tint[2];
  return out;
}

// Sea-level (or `altitude` km) direct sun illuminance, lux RGB.
export function sunIlluminanceAt(
  params: AtmosphereParams,
  elevation: number,
  altitude = 0.002,
  out: MutableRgb = [0, 0, 0],
): MutableRgb {
  return diskIlluminance(
    params,
    elevation,
    SUN_ANGULAR_RADIUS,
    SUN_ILLUMINANCE_TOA,
    [1, 1, 1],
    altitude,
    out,
  );
}

// Sea-level direct moon illuminance, lux RGB, for a phase angle (0 = full moon).
export function moonIlluminanceAt(
  params: AtmosphereParams,
  elevation: number,
  phaseAngle: number,
  altitude = 0.002,
  out: MutableRgb = [0, 0, 0],
): MutableRgb {
  const toa = moonIlluminanceToa(phaseAngle);
  return diskIlluminance(params, elevation, MOON_ANGULAR_RADIUS, toa, MOON_TINT, altitude, out);
}

export const rgbLuminance = luminance;
