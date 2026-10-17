// COLREGs navigation-light maths (Rules 20–30 and Annex I), pure TS: light kinds and their
// horizontal sectors in the body frame (bow −Z, up +Y, starboard +X), the cut-off ramps at the sector
// edges, the vertical spread, colours, required ranges per vessel length and the luminous intensity
// that gives them, and which lights a vessel shows for its state. The renderer mirrors the sector
// and vertical maths in TSL (lightNodes.ts); this file is the tested reference.

import type { BoatKind } from '../../../sim/world/protocol';

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
export const NAUTICAL_MILE = 1852; // m

// ---------------------------------------------------------------------------------------------
// Kinds, sectors and cut-offs

// Sector shapes (Rule 21). Tricolour and combination lanterns are several of these in one housing.
export type LightKind = 'masthead' | 'starboard' | 'port' | 'stern' | 'allRound';
export type LightColour = 'white' | 'red' | 'green' | 'yellow';

// One edge of a sector. Angles in radians, measured from the prescribed sector limit.
export interface SectorEdge {
  insideFade: number; // within the sector: full intensity until this far from the edge…
  edgeValue: number; // …then a linear fade to this fraction at the limit (Annex I 9(a)(ii): ≥ 50 %)
  outsideCutoff: number; // beyond the limit: linear fade to zero at this angle ("practical cut-off")
}

// Relative bearings, radians clockwise from the bow (+ to starboard). The sector runs clockwise
// from `from` to `to`; `from === to` (or a 2π width) means all-round.
export interface LightSector {
  from: number;
  to: number;
  fromEdge: SectorEdge;
  toEdge: SectorEdge;
}

// Annex I 9(a)(i): sidelights reach practical cut-off 1–3° outside the sector in the forward
// direction, keeping full intensity right up to the bow.
export const SIDELIGHT_FORWARD_EDGE: SectorEdge = { insideFade: 0, edgeValue: 1, outsideCutoff: 2 * DEG };
// Annex I 9(a)(ii): masthead and stern lights, and sidelights 22.5° abaft the beam, may drop to 50 %
// over the last 5° inside the sector and reach cut-off at not more than 5° outside it.
export const OTHER_EDGE: SectorEdge = { insideFade: 5 * DEG, edgeValue: 0.5, outsideCutoff: 4 * DEG };

const ABEAM_AFT = 112.5 * DEG; // 22.5° abaft the beam

export const SECTORS: Readonly<Record<LightKind, LightSector>> = {
  masthead: { from: -ABEAM_AFT, to: ABEAM_AFT, fromEdge: OTHER_EDGE, toEdge: OTHER_EDGE }, // 225°
  starboard: { from: 0, to: ABEAM_AFT, fromEdge: SIDELIGHT_FORWARD_EDGE, toEdge: OTHER_EDGE }, // 112.5°
  port: { from: -ABEAM_AFT, to: 0, fromEdge: OTHER_EDGE, toEdge: SIDELIGHT_FORWARD_EDGE }, // 112.5°
  stern: { from: ABEAM_AFT, to: TWO_PI - ABEAM_AFT, fromEdge: OTHER_EDGE, toEdge: OTHER_EDGE }, // 135°
  allRound: { from: 0, to: TWO_PI, fromEdge: OTHER_EDGE, toEdge: OTHER_EDGE }, // 360°
};

const wrapPositive = (angle: number): number => {
  const a = angle % TWO_PI;
  return a < 0 ? a + TWO_PI : a;
};
const wrapSigned = (angle: number): number => {
  const a = wrapPositive(angle);
  return a > Math.PI ? a - TWO_PI : a;
};

export const sectorWidth = (sector: LightSector): number => {
  const width = wrapPositive(sector.to - sector.from);
  return width === 0 ? TWO_PI : width;
};

// Centre bearing and half width: the form the GPU uses.
export function sectorCentre(sector: LightSector): { centre: number; halfWidth: number } {
  const width = sectorWidth(sector);
  return { centre: wrapSigned(sector.from + width / 2), halfWidth: width / 2 };
}

// Intensity fraction at `outside` radians beyond an edge (negative = inside the sector).
export function edgeRamp(edge: SectorEdge, outside: number): number {
  if (outside <= 0) {
    if (edge.insideFade <= 0) return edge.edgeValue;
    const t = Math.min(1, -outside / edge.insideFade);
    return edge.edgeValue + (1 - edge.edgeValue) * t;
  }
  if (outside >= edge.outsideCutoff) return 0;
  return edge.edgeValue * (1 - outside / edge.outsideCutoff);
}

// Horizontal intensity fraction toward a relative bearing (radians clockwise from the bow).
export function horizontalVisibility(sector: LightSector, bearing: number): number {
  const { centre, halfWidth } = sectorCentre(sector);
  if (halfWidth >= Math.PI) return 1;
  const delta = wrapSigned(bearing - centre);
  const edge = delta < 0 ? sector.fromEdge : sector.toEdge;
  return edgeRamp(edge, Math.abs(delta) - halfWidth);
}

// Annex I 10: full intensity 5° above and below the horizontal, ≥ 60 % to 7.5°; sailing vessels'
// lights keep ≥ 50 % to 25°. Beyond that real lanterns still leak light, so the curve settles on a
// floor rather than zero (a chase camera above a small boat still sees its lights).
export const VERTICAL_FLAT = 5 * DEG;
export const VERTICAL_WIDTH = 2.8 * DEG;
export const VERTICAL_FLOOR = 0.3;
export const VERTICAL_FLOOR_SAIL = 0.5;

export function verticalVisibility(elevation: number, floor = VERTICAL_FLOOR): number {
  const x = Math.max(0, Math.abs(elevation) - VERTICAL_FLAT) / VERTICAL_WIDTH;
  return floor + (1 - floor) * Math.exp(-x * x);
}

export interface DirectionLike {
  x: number;
  y: number;
  z: number;
}

// Relative bearing (clockwise from the bow) and elevation of a body-frame direction.
export const bearingOf = (d: DirectionLike): number => Math.atan2(d.x, -d.z);
const elevationOf = (d: DirectionLike): number => Math.atan2(d.y, Math.hypot(d.x, d.z) || Number.MIN_VALUE);

// Fraction of the light's intensity seen along a body-frame direction from the light to the viewer.
export function visibility(
  kind: LightKind | LightSector,
  towardViewer: DirectionLike,
  verticalFloor = VERTICAL_FLOOR,
): number {
  const sector = typeof kind === 'string' ? SECTORS[kind] : kind;
  return (
    horizontalVisibility(sector, bearingOf(towardViewer)) *
    verticalVisibility(elevationOf(towardViewer), verticalFloor)
  );
}

// ---------------------------------------------------------------------------------------------
// Range and intensity

// Annex I 8: I = 3.43·10⁶ · T · D² · K^−D with T = 2·10⁻⁷ lux (threshold) and K = 0.8 (atmospheric
// transmissivity, ~13 nm meteorological visibility); D in nautical miles, I in candela.
const THRESHOLD_LUX = 2e-7;
const TRANSMISSIVITY = 0.8;

export const luminousIntensity = (rangeNm: number): number =>
  3.43e6 * THRESHOLD_LUX * rangeNm * rangeNm * TRANSMISSIVITY ** -rangeNm;

// Inverse of luminousIntensity (bisection; monotonic for D > 0).
export function visibleRangeNm(intensity: number): number {
  let lo = 0;
  let hi = 30;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (luminousIntensity(mid) < intensity) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export type VesselClass = 'large' | 'medium' | 'small'; // ≥ 50 m, 12–50 m, < 12 m

export const vesselClass = (length: number): VesselClass =>
  length >= 50 ? 'large' : length >= 12 ? 'medium' : 'small';

// Rule 22 minimum visible ranges, nautical miles.
export function requiredRangeNm(kind: LightKind, length: number): number {
  const sides = kind === 'port' || kind === 'starboard';
  if (length >= 50) return kind === 'masthead' ? 6 : 3;
  if (length >= 12) {
    if (kind === 'masthead') return length >= 20 ? 5 : 3;
    return 2;
  }
  return sides ? 1 : 2;
}

export const requiredIntensity = (kind: LightKind, length: number): number =>
  luminousIntensity(requiredRangeNm(kind, length));

// Rule 20: lights from sunset to sunrise and in restricted visibility (sunset ≈ −0.83° with refraction).
export const SUNSET_ELEVATION = -0.833 * DEG;
const RESTRICTED_VISIBILITY = 2 * NAUTICAL_MILE; // m, a common working threshold

export const lightsRequired = (sunElevation: number, visibilityM = Number.POSITIVE_INFINITY): boolean =>
  sunElevation < SUNSET_ELEVATION || visibilityM < RESTRICTED_VISIBILITY;

// ---------------------------------------------------------------------------------------------
// Colours (Annex I 7). Chromaticities are CIE 1931 xy, chosen inside (white, green) or on the sRGB
// gamut edge nearest to (red, yellow) the COLREG regions, which lie partly outside sRGB.

export const COLREG_CHROMATICITY: Readonly<Record<LightColour, readonly [number, number]>> = {
  white: [0.38, 0.377], // ~4000 K LED
  red: [0.64, 0.33], // sRGB red primary; COLREG red (x ≥ 0.66) is outside sRGB
  green: [0.28, 0.5], // blue-green, as COLREG requires
  yellow: [0.6, 0.36],
};

export type Rgb = readonly [number, number, number];

const luminanceOf = (rgb: Rgb): number => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];

// Linear sRGB with unit luminance for a chromaticity, so colour × candela keeps photometric units.
export function chromaticityToLinear(x: number, y: number): Rgb {
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = Math.max(0, 3.2404542 * X - 1.5371385 - 0.4985314 * Z);
  const g = Math.max(0, -0.969266 * X + 1.8760108 + 0.041556 * Z);
  const b = Math.max(0, 0.0556434 * X - 0.2040259 + 1.0572252 * Z);
  const l = luminanceOf([r, g, b]);
  return [r / l, g / l, b / l];
}

export function linearToChromaticity(rgb: Rgb): [number, number] {
  const [r, g, b] = rgb;
  const X = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const sum = X + Y + Z;
  return [X / sum, Y / sum];
}

const srgbChannel = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

// 0xRRGGBB sRGB → linear sRGB with unit luminance (for work lights and accents).
export function srgbHexToLinear(hex: number): Rgb {
  const rgb: Rgb = [
    srgbChannel(((hex >> 16) & 255) / 255),
    srgbChannel(((hex >> 8) & 255) / 255),
    srgbChannel((hex & 255) / 255),
  ];
  const l = luminanceOf(rgb) || 1;
  return [rgb[0] / l, rgb[1] / l, rgb[2] / l];
}

export const LIGHT_COLOURS: Readonly<Record<LightColour, Rgb>> = {
  white: chromaticityToLinear(...COLREG_CHROMATICITY.white),
  red: chromaticityToLinear(...COLREG_CHROMATICITY.red),
  green: chromaticityToLinear(...COLREG_CHROMATICITY.green),
  yellow: chromaticityToLinear(...COLREG_CHROMATICITY.yellow),
};

// ---------------------------------------------------------------------------------------------
// Which lights a vessel shows

// Mount roles. A lantern may serve several (the console boat's stern-pole white is also its anchor
// light). Signals share three positions on a mast: red-white-red for RAM, red-red (upper and lower)
// for NUC, red over white for fishing.
const NAV_ROLES = [
  'masthead',
  'mastheadAft',
  'port',
  'starboard',
  'stern',
  'allRoundWhite',
  'anchorForward',
  'anchorAft',
  'signalRedUpper',
  'signalWhite',
  'signalRedLower',
  'tricolourPort',
  'tricolourStarboard',
  'tricolourStern',
] as const;
export type NavRole = (typeof NAV_ROLES)[number];

export interface NavSignals {
  fishing: boolean; // Rule 26(c): fishing other than trawling (pots): all-round red over white
  nuc: boolean; // Rule 27(a): not under command, two all-round red
  anchor: boolean; // Rule 30: at anchor
  ram: boolean; // Rule 27(b): restricted in ability to manoeuvre, red-white-red
  tricolour: boolean; // Rule 25(b): sailing vessel < 20 m, combined lantern at the masthead
}
export type SignalKey = keyof NavSignals;

export const NO_SIGNALS: Readonly<NavSignals> = {
  fishing: false,
  nuc: false,
  anchor: false,
  ram: false,
  tricolour: false,
};

export interface NavState {
  on: boolean; // master switch
  makingWay: boolean; // moving through the water (NUC, RAM and fishing add sidelights only then)
  signals: Partial<NavSignals>;
}

type VesselType = 'power' | 'sail' | 'pwc';

export interface VesselLightProfile {
  length: number; // m, LOA
  type: VesselType;
  signals: readonly SignalKey[]; // signals the boat can show (the HUD greys the rest out)
}

export const VESSEL_LIGHTS: Readonly<Record<BoatKind, VesselLightProfile>> = {
  cargo: { length: 243.5, type: 'power', signals: ['nuc', 'ram', 'anchor'] },
  cruise: { length: 317.2, type: 'power', signals: ['nuc', 'ram', 'anchor'] },
  crab: { length: 38.1, type: 'power', signals: ['fishing', 'nuc', 'anchor'] },
  sail: { length: 11.5, type: 'sail', signals: ['anchor', 'tricolour'] },
  powerboat: { length: 10.1, type: 'power', signals: ['anchor'] },
  // A PWC needs no lights (most places ban them at night); the "nav" switch is an accessory white.
  pwc: { length: 3.3, type: 'pwc', signals: [] },
  // A race boat carries none; this one shows a small power-driven vessel's sidelights and all-round white.
  hydro: { length: 9.4, type: 'power', signals: ['anchor'] },
};

function sidesAndStern(profile: VesselLightProfile, tricolour: boolean): NavRole[] {
  if (profile.type === 'pwc') return ['allRoundWhite'];
  if (profile.type === 'sail' && tricolour && profile.length < 20) {
    return ['tricolourPort', 'tricolourStarboard', 'tricolourStern'];
  }
  // Rule 23(d)(i): a power-driven vessel < 12 m may show an all-round white in place of the
  // masthead light and sternlight.
  if (profile.type === 'power' && profile.length < 12) return ['port', 'starboard', 'allRoundWhite'];
  return ['port', 'starboard', 'stern'];
}

function underwayRoles(profile: VesselLightProfile, tricolour: boolean): NavRole[] {
  const sides = sidesAndStern(profile, tricolour);
  if (profile.type !== 'power' || profile.length < 12) return sides;
  // Rule 23(a): masthead light; a second, higher one aft on vessels ≥ 50 m.
  return profile.length >= 50 ? ['masthead', 'mastheadAft', ...sides] : ['masthead', ...sides];
}

function anchorRoles(profile: VesselLightProfile): NavRole[] {
  return profile.length >= 50 ? ['anchorForward', 'anchorAft'] : ['anchorForward'];
}

// Lights shown for a state, in priority order (most important first). Signals the boat doesn't
// support are ignored.
export function navRoles(profileOrKind: VesselLightProfile | BoatKind, state: NavState): NavRole[] {
  const profile = typeof profileOrKind === 'string' ? VESSEL_LIGHTS[profileOrKind] : profileOrKind;
  if (!state.on) return [];
  const has = (key: SignalKey): boolean => profile.signals.includes(key) && state.signals[key] === true;
  const anchored = has('anchor');
  const tricolour = has('tricolour');
  const making = state.makingWay && !anchored;
  const sides = sidesAndStern(profile, tricolour).filter((r) => r !== 'allRoundWhite');

  // An anchored vessel is not "not under command", so anchor overrides NUC.
  if (has('nuc') && !anchored) return ['signalRedUpper', 'signalRedLower', ...(making ? sides : [])];
  if (has('ram')) {
    const extra = anchored ? anchorRoles(profile) : making ? underwayRoles(profile, tricolour) : [];
    return ['signalRedUpper', 'signalWhite', 'signalRedLower', ...extra];
  }
  // Fishing lights apply at anchor too (Rule 26 replaces Rule 30 while fishing).
  if (has('fishing')) return ['signalRedUpper', 'signalWhite', ...(making ? sides : [])];
  if (anchored) return profile.type === 'pwc' ? ['allRoundWhite'] : anchorRoles(profile);
  return underwayRoles(profile, tricolour);
}

// Role → lantern kind and colour (a mount may override both).
export const ROLE_LIGHT: Readonly<Record<NavRole, { kind: LightKind; colour: LightColour }>> = {
  masthead: { kind: 'masthead', colour: 'white' },
  mastheadAft: { kind: 'masthead', colour: 'white' },
  port: { kind: 'port', colour: 'red' },
  starboard: { kind: 'starboard', colour: 'green' },
  stern: { kind: 'stern', colour: 'white' },
  allRoundWhite: { kind: 'allRound', colour: 'white' },
  anchorForward: { kind: 'allRound', colour: 'white' },
  anchorAft: { kind: 'allRound', colour: 'white' },
  signalRedUpper: { kind: 'allRound', colour: 'red' },
  signalWhite: { kind: 'allRound', colour: 'white' },
  signalRedLower: { kind: 'allRound', colour: 'red' },
  tricolourPort: { kind: 'port', colour: 'red' },
  tricolourStarboard: { kind: 'starboard', colour: 'green' },
  tricolourStern: { kind: 'stern', colour: 'white' },
};
