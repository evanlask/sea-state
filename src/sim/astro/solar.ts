// Solar position, NOAA "General Solar Position Calculations" / solar
// calculator spreadsheet (after Meeus, Astronomical Algorithms). Accurate to
// ~0.01° in position and ~1 minute in rise/set times for |latitude| < 72°.
//
// Inputs and outputs are radians (latitude north positive, longitude east
// positive) and UTC; azimuth is clockwise from north. Equation of time is in
// seconds (NOAA tabulates minutes).

import { normalizeHeading, signedAngle, TWO_PI } from '../core/conventions';
import type { JulianInput } from './time';
import { dateFromJulianDay, julianCentury, julianDayFromMs, SECONDS_PER_DAY, toJulianDay } from './time';

const RAD = Math.PI / 180;

// Apparent altitude of the Sun's upper limb at rise/set: 34′ of refraction
// plus a 16′ semi-diameter, the standard NOAA/USNO convention.
export const SUNRISE_ALTITUDE = -0.833 * RAD;
export const CIVIL_TWILIGHT_ALTITUDE = -6 * RAD;

export interface SolarEphemeris {
  rightAscension: number;
  declination: number;
  equationOfTime: number; // seconds; apparent − mean solar time
  apparentLongitude: number; // ecliptic, of date
  obliquity: number; // corrected obliquity of the ecliptic
  distanceAU: number;
}

export interface SolarPosition extends SolarEphemeris {
  hourAngle: number; // (-π, π], negative before solar noon
  zenith: number; // refracted (apparent)
  elevation: number; // refracted (apparent), what an observer sees
  geometricElevation: number; // without refraction
  azimuth: number; // clockwise from north, [0, 2π)
}

export const createSolarEphemeris = (): SolarEphemeris => ({
  rightAscension: 0,
  declination: 0,
  equationOfTime: 0,
  apparentLongitude: 0,
  obliquity: 0,
  distanceAU: 1,
});

const createSolarPosition = (): SolarPosition => ({
  ...createSolarEphemeris(),
  hourAngle: 0,
  zenith: 0,
  elevation: 0,
  geometricElevation: 0,
  azimuth: 0,
});

// Observer-independent quantities: the NOAA spreadsheet columns G through V.
export function solarEphemeris(jd: number, out: SolarEphemeris = createSolarEphemeris()): SolarEphemeris {
  const t = julianCentury(jd);
  const meanLongitude = (((280.46646 + t * (36000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const m = meanAnomaly * RAD;
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const trueLongitude = meanLongitude + center;
  const trueAnomaly = (meanAnomaly + center) * RAD;
  // Nutation and aberration, abbreviated to the dominant 18.6-year term.
  const omega = (125.04 - 1934.136 * t) * RAD;
  const apparentLongitude = (trueLongitude - 0.00569 - 0.00478 * Math.sin(omega)) * RAD;
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * RAD;

  const sinLambda = Math.sin(apparentLongitude);
  out.rightAscension = normalizeHeading(
    Math.atan2(Math.cos(obliquity) * sinLambda, Math.cos(apparentLongitude)),
  );
  out.declination = Math.asin(Math.sin(obliquity) * sinLambda);

  const l0 = meanLongitude * RAD;
  const y = Math.tan(obliquity / 2) ** 2;
  const e = eccentricity;
  const eqTimeRadians =
    y * Math.sin(2 * l0) -
    2 * e * Math.sin(m) +
    4 * e * y * Math.sin(m) * Math.cos(2 * l0) -
    0.5 * y * y * Math.sin(4 * l0) -
    1.25 * e * e * Math.sin(2 * m);
  // One radian of hour angle is 86400 / 2π seconds.
  out.equationOfTime = (eqTimeRadians / TWO_PI) * SECONDS_PER_DAY;
  out.apparentLongitude = normalizeHeading(apparentLongitude);
  out.obliquity = obliquity;
  out.distanceAU = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(trueAnomaly));
  return out;
}

// NOAA's piecewise refraction fit (Bennett/Saemundsson-style), radians to add
// to the geometric elevation. Assumes 10 °C and 1010 hPa.
export function atmosphericRefraction(geometricElevation: number): number {
  const e = geometricElevation / RAD;
  let arcsec: number;
  if (e > 85) {
    arcsec = 0;
  } else if (e > 5) {
    const tanE = Math.tan(geometricElevation);
    arcsec = 58.1 / tanE - 0.07 / tanE ** 3 + 0.000086 / tanE ** 5;
  } else if (e > -0.575) {
    arcsec = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  } else {
    arcsec = -20.772 / Math.tan(geometricElevation);
  }
  return (arcsec / 3600) * RAD;
}

// Full topocentric position for an observer. Parallax (8.8″) is ignored.
export function solarPosition(
  time: JulianInput,
  latitude: number,
  longitude: number,
  out: SolarPosition = createSolarPosition(),
): SolarPosition {
  const jd = toJulianDay(time);
  solarEphemeris(jd, out);
  // True solar time → hour angle. JD days start at noon, so the fractional day
  // plus a half is the UTC time of day.
  const utcSeconds = ((((jd + 0.5) % 1) + 1) % 1) * SECONDS_PER_DAY;
  const trueSolarSeconds = utcSeconds + out.equationOfTime + (longitude / TWO_PI) * SECONDS_PER_DAY;
  out.hourAngle = signedAngle((trueSolarSeconds / SECONDS_PER_DAY) * TWO_PI - Math.PI);

  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinDec = Math.sin(out.declination);
  const cosDec = Math.cos(out.declination);
  const cosH = Math.cos(out.hourAngle);
  const cosZenith = Math.max(-1, Math.min(1, sinLat * sinDec + cosLat * cosDec * cosH));
  out.geometricElevation = Math.PI / 2 - Math.acos(cosZenith);
  out.elevation = out.geometricElevation + atmosphericRefraction(out.geometricElevation);
  out.zenith = Math.PI / 2 - out.elevation;
  // atan2 form of NOAA's acos azimuth: no branch on the hour-angle sign and no
  // singularity at the zenith.
  const east = -cosDec * Math.sin(out.hourAngle);
  const north = sinDec * cosLat - cosDec * cosH * sinLat;
  out.azimuth = normalizeHeading(Math.atan2(east, north));
  return out;
}

export type PolarCondition = 'polar-day' | 'polar-night' | null;

export interface SunTimes {
  solarNoon: Date;
  sunrise: Date | null; // null during polar day or night
  sunset: Date | null;
  polar: PolarCondition;
}

const scratchEphemeris = createSolarEphemeris();

// Rise, set and apparent noon for a local mean solar date (the date SimClock
// reports), returned in UTC. At longitude 0 this is simply the UTC calendar
// day. `altitude` selects the event: SUNRISE_ALTITUDE (default) or a twilight
// depression such as CIVIL_TWILIGHT_ALTITUDE.
export function sunTimes(
  year: number,
  month: number, // 1–12
  day: number,
  latitude: number,
  longitude: number,
  altitude: number = SUNRISE_ALTITUDE,
): SunTimes {
  // Local mean midnight in UTC: east longitudes reach midnight earlier.
  const dayStartJd = julianDayFromMs(Date.UTC(year, month - 1, day)) - longitude / TWO_PI;
  let noonJd = dayStartJd + 0.5;
  for (let i = 0; i < 2; i++) {
    noonJd = dayStartJd + 0.5 - solarEphemeris(noonJd, scratchEphemeris).equationOfTime / SECONDS_PER_DAY;
  }
  const rise = riseOrSet(dayStartJd, latitude, altitude, -1);
  const set = riseOrSet(dayStartJd, latitude, altitude, 1);
  // The two events can disagree on the day polar day/night begins or ends;
  // report whichever condition holds at either.
  let polar: PolarCondition = null;
  if (typeof rise === 'string') polar = rise;
  else if (typeof set === 'string') polar = set;
  return {
    solarNoon: dateFromJulianDay(noonJd),
    sunrise: typeof rise === 'number' ? dateFromJulianDay(rise) : null,
    sunset: typeof set === 'number' ? dateFromJulianDay(set) : null,
    polar,
  };
}

function riseOrSet(
  dayStartJd: number,
  latitude: number,
  altitude: number,
  sign: -1 | 1,
): number | Exclude<PolarCondition, null> {
  // Start at local noon and walk out by the semi-diurnal arc, re-evaluating
  // the Sun at each estimate (it moves ~0.4° of declination per day).
  let jd = dayStartJd + 0.5;
  for (let i = 0; i < 5; i++) {
    const eph = solarEphemeris(jd, scratchEphemeris);
    const cosH0 =
      (Math.sin(altitude) - Math.sin(latitude) * Math.sin(eph.declination)) /
      (Math.cos(latitude) * Math.cos(eph.declination));
    if (cosH0 > 1) return 'polar-night';
    if (cosH0 < -1) return 'polar-day';
    const h0 = Math.acos(cosH0);
    // Local mean time of the event is 12 h + H/2π days − EoT.
    jd = dayStartJd + 0.5 + (sign * h0) / TWO_PI - eph.equationOfTime / SECONDS_PER_DAY;
  }
  return jd;
}
