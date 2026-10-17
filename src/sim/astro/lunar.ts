// Low-precision Moon position and illumination.
//
// Position: Meeus, Astronomical Algorithms (2nd ed.) ch. 47, the full
// 60 + 60 term tables 47.A/47.B (an abridged ELP-2000/82): ~10″ in longitude,
// ~4″ in latitude. Nutation (≤ 17″) is ignored. Topocentric parallax (up to
// ~1°) is applied to the horizontal coordinates. Table rows cross-checked
// against commenthol/astronomia (MIT) src/moonposition.js.
// Illumination: Meeus ch. 48 using the NOAA Sun from solar.ts.
//
// Angles are radians, distances metres, azimuth clockwise from north.

import { normalizeHeading, signedAngle, TWO_PI } from '../core/conventions';
import { EARTH_RADIUS } from '../core/units';
import { equatorialToHorizontal, localSiderealTime } from './sidereal';
import { atmosphericRefraction, createSolarEphemeris, solarEphemeris } from './solar';
import type { JulianInput } from './time';
import { DELTA_T_SECONDS, degToRadWrapped, julianCentury, SECONDS_PER_DAY, toJulianDay } from './time';

const RAD = Math.PI / 180;
const AU = 149_597_870_700; // m

export interface MoonEcliptic {
  longitude: number; // geocentric ecliptic longitude, mean equinox of date
  latitude: number;
  distance: number; // Earth centre → Moon centre, m
}

export interface MoonPosition extends MoonEcliptic {
  rightAscension: number; // geocentric
  declination: number;
  azimuth: number; // topocentric, clockwise from north
  elevation: number; // topocentric and refracted, what an observer sees
  geometricElevation: number; // topocentric, no refraction
  parallacticAngle: number; // angle of the zenith from celestial north at the Moon, eastward
}

export interface MoonIllumination {
  fraction: number; // illuminated fraction of the disk, 0–1
  phaseAngle: number; // Sun–Moon–Earth angle, 0 at full, π at new
  phase: number; // [0, 1): 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter
  waxing: boolean;
  // Position angle of the bright limb's midpoint, measured from celestial
  // north toward east (Meeus 48.5). Subtract MoonPosition.parallacticAngle to
  // get the angle from the observer's zenith.
  brightLimbAngle: number;
}

// Columns: D, M, M′, F multipliers, Σl (1e-6 °), Σr (1e-3 km). Table 47.A.
// prettier-ignore
const LONGITUDE_DISTANCE: readonly number[] = [
  0, 0, 1, 0, 6288774, -20905355,
  2, 0, -1, 0, 1274027, -3699111,
  2, 0, 0, 0, 658314, -2955968,
  0, 0, 2, 0, 213618, -569925,
  0, 1, 0, 0, -185116, 48888,
  0, 0, 0, 2, -114332, -3149,
  2, 0, -2, 0, 58793, 246158,
  2, -1, -1, 0, 57066, -152138,
  2, 0, 1, 0, 53322, -170733,
  2, -1, 0, 0, 45758, -204586,
  0, 1, -1, 0, -40923, -129620,
  1, 0, 0, 0, -34720, 108743,
  0, 1, 1, 0, -30383, 104755,
  2, 0, 0, -2, 15327, 10321,
  0, 0, 1, 2, -12528, 0,
  0, 0, 1, -2, 10980, 79661,
  4, 0, -1, 0, 10675, -34782,
  0, 0, 3, 0, 10034, -23210,
  4, 0, -2, 0, 8548, -21636,
  2, 1, -1, 0, -7888, 24208,
  2, 1, 0, 0, -6766, 30824,
  1, 0, -1, 0, -5163, -8379,
  1, 1, 0, 0, 4987, -16675,
  2, -1, 1, 0, 4036, -12831,
  2, 0, 2, 0, 3994, -10445,
  4, 0, 0, 0, 3861, -11650,
  2, 0, -3, 0, 3665, 14403,
  0, 1, -2, 0, -2689, -7003,
  2, 0, -1, 2, -2602, 0,
  2, -1, -2, 0, 2390, 10056,
  1, 0, 1, 0, -2348, 6322,
  2, -2, 0, 0, 2236, -9884,
  0, 1, 2, 0, -2120, 5751,
  0, 2, 0, 0, -2069, 0,
  2, -2, -1, 0, 2048, -4950,
  2, 0, 1, -2, -1773, 4130,
  2, 0, 0, 2, -1595, 0,
  4, -1, -1, 0, 1215, -3958,
  0, 0, 2, 2, -1110, 0,
  3, 0, -1, 0, -892, 3258,
  2, 1, 1, 0, -810, 2616,
  4, -1, -2, 0, 759, -1897,
  0, 2, -1, 0, -713, -2117,
  2, 2, -1, 0, -700, 2354,
  2, 1, -2, 0, 691, 0,
  2, -1, 0, -2, 596, 0,
  4, 0, 1, 0, 549, -1423,
  0, 0, 4, 0, 537, -1117,
  4, -1, 0, 0, 520, -1571,
  1, 0, -2, 0, -487, -1739,
  2, 1, 0, -2, -399, 0,
  0, 0, 2, -2, -381, -4421,
  1, 1, 1, 0, 351, 0,
  3, 0, -2, 0, -340, 0,
  4, 0, -3, 0, 330, 0,
  2, -1, 2, 0, 327, 0,
  0, 2, 1, 0, -323, 1165,
  1, 1, -1, 0, 299, 0,
  2, 0, 3, 0, 294, 0,
  2, 0, -1, -2, 0, 8752,
];

// Columns: D, M, M′, F multipliers, Σb (1e-6 °). Table 47.B.
// prettier-ignore
const LATITUDE: readonly number[] = [
  0, 0, 0, 1, 5128122,
  0, 0, 1, 1, 280602,
  0, 0, 1, -1, 277693,
  2, 0, 0, -1, 173237,
  2, 0, -1, 1, 55413,
  2, 0, -1, -1, 46271,
  2, 0, 0, 1, 32573,
  0, 0, 2, 1, 17198,
  2, 0, 1, -1, 9266,
  0, 0, 2, -1, 8822,
  2, -1, 0, -1, 8216,
  2, 0, -2, -1, 4324,
  2, 0, 1, 1, 4200,
  2, 1, 0, -1, -3359,
  2, -1, -1, 1, 2463,
  2, -1, 0, 1, 2211,
  2, -1, -1, -1, 2065,
  0, 1, -1, -1, -1870,
  4, 0, -1, -1, 1828,
  0, 1, 0, 1, -1794,
  0, 0, 0, 3, -1749,
  0, 1, -1, 1, -1565,
  1, 0, 0, 1, -1491,
  0, 1, 1, 1, -1475,
  0, 1, 1, -1, -1410,
  0, 1, 0, -1, -1344,
  1, 0, 0, -1, -1335,
  0, 0, 3, 1, 1107,
  4, 0, 0, -1, 1021,
  4, 0, -1, 1, 833,
  0, 0, 1, -3, 777,
  4, 0, -2, 1, 671,
  2, 0, 0, -3, 607,
  2, 0, 2, -1, 596,
  2, -1, 1, -1, 491,
  2, 0, -2, 1, -451,
  0, 0, 3, -1, 439,
  2, 0, 2, 1, 422,
  2, 0, -3, -1, 421,
  2, 1, -1, 1, -366,
  2, 1, 0, 1, -351,
  4, 0, 0, 1, 331,
  2, -1, 1, 1, 315,
  2, -2, 0, -1, 302,
  0, 0, 1, 3, -283,
  2, 1, 1, -1, -229,
  1, 1, 0, -1, 223,
  1, 1, 0, 1, 223,
  0, 1, -2, -1, -220,
  2, 1, -1, -1, -220,
  1, 0, 1, 1, -185,
  2, -1, -2, -1, 181,
  0, 1, 2, 1, -177,
  4, 0, -2, -1, 176,
  4, -1, -1, -1, 166,
  1, 0, 1, -1, -164,
  4, 0, 1, -1, 132,
  1, 0, -1, -1, -119,
  4, -1, 0, -1, 115,
  2, -2, 0, 1, 107,
];

const createMoonPosition = (): MoonPosition => ({
  longitude: 0,
  latitude: 0,
  distance: 0,
  rightAscension: 0,
  declination: 0,
  azimuth: 0,
  elevation: 0,
  geometricElevation: 0,
  parallacticAngle: 0,
});

// Geocentric ecliptic coordinates (mean equinox of date) for a UT Julian day.
export function moonEcliptic(
  jdUt: number,
  out: MoonEcliptic = { longitude: 0, latitude: 0, distance: 0 },
): MoonEcliptic {
  const t = julianCentury(jdUt + DELTA_T_SECONDS / SECONDS_PER_DAY);
  const t2 = t * t;
  const t3 = t2 * t;
  const t4 = t3 * t;
  const lp = degToRadWrapped(
    218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000,
  );
  const d = degToRadWrapped(297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000);
  const m = degToRadWrapped(357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000);
  const mp = degToRadWrapped(134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000);
  const f = degToRadWrapped(93.272095 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000);
  const a1 = degToRadWrapped(119.75 + 131.849 * t);
  const a2 = degToRadWrapped(53.09 + 479264.29 * t);
  const a3 = degToRadWrapped(313.45 + 481266.484 * t);
  // Terms in M are scaled by the decreasing eccentricity of Earth's orbit.
  const e = 1 - 0.002516 * t - 0.0000074 * t2;
  const eScale = (mMultiple: number): number => (mMultiple === 0 ? 1 : Math.abs(mMultiple) === 1 ? e : e * e);

  let sumL = 0;
  let sumR = 0;
  for (let i = 0; i < LONGITUDE_DISTANCE.length; i += 6) {
    const cm = LONGITUDE_DISTANCE[i + 1];
    const arg =
      LONGITUDE_DISTANCE[i] * d + cm * m + LONGITUDE_DISTANCE[i + 2] * mp + LONGITUDE_DISTANCE[i + 3] * f;
    const scale = eScale(cm);
    sumL += LONGITUDE_DISTANCE[i + 4] * scale * Math.sin(arg);
    sumR += LONGITUDE_DISTANCE[i + 5] * scale * Math.cos(arg);
  }
  let sumB = 0;
  for (let i = 0; i < LATITUDE.length; i += 5) {
    const cm = LATITUDE[i + 1];
    const arg = LATITUDE[i] * d + cm * m + LATITUDE[i + 2] * mp + LATITUDE[i + 3] * f;
    sumB += LATITUDE[i + 4] * eScale(cm) * Math.sin(arg);
  }
  // Venus, Jupiter and Earth-flattening corrections.
  sumL += 3958 * Math.sin(a1) + 1962 * Math.sin(lp - f) + 318 * Math.sin(a2);
  sumB +=
    -2235 * Math.sin(lp) +
    382 * Math.sin(a3) +
    175 * Math.sin(a1 - f) +
    175 * Math.sin(a1 + f) +
    127 * Math.sin(lp - mp) -
    115 * Math.sin(lp + mp);

  out.longitude = normalizeHeading(lp + sumL * 1e-6 * RAD);
  out.latitude = sumB * 1e-6 * RAD;
  out.distance = (385000.56 + sumR / 1000) * 1000;
  return out;
}

// Ecliptic → equatorial for obliquity `epsilon`.
function eclipticToEquatorial(
  longitude: number,
  latitude: number,
  epsilon: number,
  out: { rightAscension: number; declination: number },
): void {
  const sinE = Math.sin(epsilon);
  const cosE = Math.cos(epsilon);
  const sinL = Math.sin(longitude);
  out.rightAscension = normalizeHeading(
    Math.atan2(sinL * cosE - Math.tan(latitude) * sinE, Math.cos(longitude)),
  );
  out.declination = Math.asin(Math.sin(latitude) * cosE + Math.cos(latitude) * sinE * sinL);
}

// Mean obliquity of the ecliptic (Meeus 22.2), radians.
function meanObliquity(jd: number): number {
  const t = julianCentury(jd);
  return (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60) * RAD;
}

const scratchHorizontal = { azimuth: 0, elevation: 0 };
const scratchMoon: MoonEcliptic = { longitude: 0, latitude: 0, distance: 0 };
const scratchMoonEq = { rightAscension: 0, declination: 0 };
const scratchSun = createSolarEphemeris();

// Position for an observer at sea level. Latitude/longitude radians, east positive.
export function moonPosition(
  time: JulianInput,
  latitude: number,
  longitude: number,
  out: MoonPosition = createMoonPosition(),
): MoonPosition {
  const jd = toJulianDay(time);
  moonEcliptic(jd, out);
  eclipticToEquatorial(out.longitude, out.latitude, meanObliquity(jd), out);
  const lst = localSiderealTime(jd, longitude);
  const horizontal = equatorialToHorizontal(
    out.rightAscension,
    out.declination,
    lst,
    latitude,
    scratchHorizontal,
  );
  // Spherical-Earth parallax: the observer sits one Earth radius off the line
  // to the geocentre, which lowers the Moon by up to ~0.95°.
  const geo = horizontal.elevation;
  out.geometricElevation = geo - Math.asin((EARTH_RADIUS / out.distance) * Math.cos(geo));
  out.elevation = out.geometricElevation + atmosphericRefraction(out.geometricElevation);
  out.azimuth = horizontal.azimuth;
  const hourAngle = lst - out.rightAscension;
  out.parallacticAngle = Math.atan2(
    Math.sin(hourAngle),
    Math.tan(latitude) * Math.cos(out.declination) - Math.sin(out.declination) * Math.cos(hourAngle),
  );
  return out;
}

// Geocentric illumination; observer location changes it by < 0.1%.
export function moonIllumination(
  time: JulianInput,
  out: MoonIllumination = { fraction: 0, phaseAngle: 0, phase: 0, waxing: true, brightLimbAngle: 0 },
): MoonIllumination {
  const jd = toJulianDay(time);
  const moon = moonEcliptic(jd, scratchMoon);
  const sun = solarEphemeris(jd, scratchSun);
  eclipticToEquatorial(moon.longitude, moon.latitude, meanObliquity(jd), scratchMoonEq);
  const a = scratchMoonEq.rightAscension;
  const dMoon = scratchMoonEq.declination;
  const a0 = sun.rightAscension;
  const d0 = sun.declination;
  // Geocentric elongation ψ of the Moon from the Sun (Meeus 48.2).
  const cosPsi = Math.sin(d0) * Math.sin(dMoon) + Math.cos(d0) * Math.cos(dMoon) * Math.cos(a0 - a);
  const psi = Math.acos(Math.max(-1, Math.min(1, cosPsi)));
  const sunDistance = sun.distanceAU * AU;
  out.phaseAngle = Math.atan2(sunDistance * Math.sin(psi), moon.distance - sunDistance * cosPsi);
  out.fraction = (1 + Math.cos(out.phaseAngle)) / 2;
  // Phase as the elongation in ecliptic longitude, which runs monotonically
  // through the lunation (the 3D elongation folds back at full moon).
  const elongation = normalizeHeading(moon.longitude - sun.apparentLongitude);
  out.phase = (elongation / TWO_PI) % 1;
  out.waxing = elongation < Math.PI;
  out.brightLimbAngle = normalizeHeading(
    Math.atan2(
      Math.cos(d0) * Math.sin(a0 - a),
      Math.sin(d0) * Math.cos(dMoon) - Math.cos(d0) * Math.sin(dMoon) * Math.cos(a0 - a),
    ),
  );
  return out;
}

// Signed difference between two phases in (-0.5, 0.5], for "how close to full".
export const phaseDifference = (a: number, b: number): number => signedAngle((a - b) * TWO_PI) / TWO_PI;
