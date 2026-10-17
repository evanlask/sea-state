// Physical constants and unit conversions. Everything inside the simulation is SI.

export const GRAVITY = 9.80665; // m/s²
export const RHO_SEAWATER = 1025; // kg/m³
export const RHO_AIR = 1.225; // kg/m³ at 15 °C, sea level
export const NU_SEAWATER = 1.19e-6; // m²/s kinematic viscosity at 15 °C
export const EARTH_RADIUS = 6_371_000; // m, mean

export const KNOT = 1852 / 3600; // m/s
export const MPH = 0.44704; // m/s
const KMH = 1 / 3.6; // m/s
const FOOT = 0.3048; // m
export const NAUTICAL_MILE = 1852; // m

export const knotsToMs = (knots: number): number => knots * KNOT;
export const msToKnots = (ms: number): number => ms / KNOT;
const msToMph = (ms: number): number => ms / MPH;
const msToKmh = (ms: number): number => ms / KMH;
const metersToFeet = (meters: number): number => meters / FOOT;

export type SpeedUnit = 'kn' | 'mph' | 'kmh';
export type LengthUnit = 'm' | 'ft';

export function convertSpeed(ms: number, unit: SpeedUnit): number {
  switch (unit) {
    case 'kn':
      return msToKnots(ms);
    case 'mph':
      return msToMph(ms);
    case 'kmh':
      return msToKmh(ms);
  }
}

export function convertLength(meters: number, unit: LengthUnit): number {
  return unit === 'm' ? meters : metersToFeet(meters);
}
