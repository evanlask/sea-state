// Foam pattern maths (pure, Node-testable), mirrored by the TSL in OceanMaterial (buildSurface's
// per-cascade foam, buildFoam): the scales the foam detail texture is sampled at, what hides the
// cascades' tiling, and the procedural wind streaks.
//
// Nothing in the foam may repeat visibly from a drone a few hundred metres up:
//  - Texture scales are irrational multiples of each other and of the cascade patches, and the
//    low-frequency fields are rotated off the cascade grid (or follow the wind), so no two periods
//    line up.
//  - Each cascade's foam tiles at its patch. Masks from those fields, and the next longer cascade's
//    compression (short waves break on the crests of long ones, whose waves don't share the
//    period), make its copies differ; the 20 m cascade, whose period is also a divisor of the
//    800 m one's, counts at half weight.
//  - Streaks are procedural threads (no tiling texture): per across-wind cell a random offset,
//    centimetre-scale width and brightness, broken along the wind into trails of random length and
//    every few metres into fragments, in octaves at non-commensurate spacings and slightly
//    different angles, bent by the low-frequency fields and frayed by the bubble texture. They show
//    where foam is being drawn out downwind of breaking crests (and, towards a hurricane, in
//    wind-aligned bands everywhere), and fade to their mean before they get thinner than a pixel.

import { hash32 } from '../../sim/ocean/hash';

const GOLDEN = (1 + Math.sqrt(5)) / 2;

const normalPdf = (z: number): number => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// Low-frequency foam fields, from the detail texture's density channel (value noise, features a
// quarter of a tile down to a nineteenth; mean 0.5, standard deviation ≈ 0.15), centred:
//  region   world-fixed, rotated off the cascade grid: where seas break more (wave groups, gusts),
//           and which copies of the 800 m cascade's breakers show
export const FOAM_REGION_TILE = 904; // m
export const FOAM_REGION_ANGLE = 0.37; // rad
//  patches  the same for the 128 m cascade's copies
export const FOAM_PATCH_TILE = 188; // m
export const FOAM_PATCH_ANGLE = -0.83; // rad
//  drift    wind-aligned, long downwind: bends the streaks, warps the bubble cells, and picks the
//           20 m cascade's copies
export const FOAM_DRIFT_ALONG = 401; // m
export const FOAM_DRIFT_ACROSS = 67; // m
// Crest threshold shift per unit of region deviation, as a share of the distance to J = 1: more
// crests break in some regions than others.
export const FOAM_REGION_THRESHOLD = 0.8;
// Thick foam keeps some of its bubble structure: 1 − this × (1 − lace) at full thickness.
export const FOAM_THICK_LACE = 0.3;
// Bubble cells (lace): a coarse tile and a finer one at 1/φ² of it, rotated, so their sum never
// repeats; both stretched along the wind in streaky seas.
export const LACE_COARSE_TILE = 8.5; // m
export const LACE_FINE_TILE = LACE_COARSE_TILE / (GOLDEN * GOLDEN); // ≈ 3.25 m
export const LACE_FINE_ANGLE = 1.1; // rad
// How much of the bubble pattern a foam amount shows. The thin-foam pattern (lace × density) is
// roughly normal with this mean and deviation close up, so a threshold at its (1 − amount) quantile
// (a logistic approximation of the normal one) shows `amount` of it: thin foam keeps only the
// brightest bubble walls, thick foam closes up, and the mean whiteness is linear in the amount.
// Farther out the texture's mips average the pattern away (its deviation falls as this fit of the
// footprint), and the threshold's softness grows to make up the difference, so a pixel covering
// many bubbles still shows `amount` of white: whitecaps neither vanish nor turn to uniform grey
// with distance, and since the mean is linear, mip-filtered foam keeps its mean too.
export const FOAM_PATTERN_MEAN = 0.495;
export const FOAM_PATTERN_STD = 0.176;
export const FOAM_PATTERN_FOOTPRINT = 0.15; // m
export const FOAM_PATTERN_FALLOFF = 0.75;
export const FOAM_EDGE_SOFTNESS = 0.03; // logistic scale of the bubble walls close up
// Normal quantile ≈ logistic quantile × this (a logistic of scale σ/1.7 matches a normal of σ).
export const FOAM_LOGISTIC_SCALE = 1 / 1.7;

const foamPatternStd = (footprint: number): number =>
  FOAM_PATTERN_STD * (1 + Math.max(0, footprint) / FOAM_PATTERN_FOOTPRINT) ** -FOAM_PATTERN_FALLOFF;

export function foamShown(amount: number, pattern: number, footprint: number): number {
  const a = Math.min(0.999, Math.max(1e-5, amount));
  const centre = FOAM_PATTERN_MEAN - FOAM_PATTERN_STD * FOAM_LOGISTIC_SCALE * Math.log(a / (1 - a));
  const std = foamPatternStd(footprint);
  const softness = Math.max(
    Math.sqrt(Math.max(FOAM_PATTERN_STD * FOAM_PATTERN_STD - std * std, 0)) * FOAM_LOGISTIC_SCALE,
    FOAM_EDGE_SOFTNESS,
  );
  return 1 / (1 + Math.exp((centre - pattern) / softness));
}

// How far the bubble pattern has been averaged away at this footprint, 0 (sharp) to 1 (flat).
const foamPatternFade = (footprint: number): number => 1 - foamPatternStd(footprint) / FOAM_PATTERN_STD;

// Foam brightness: thin foam is greyer than thick. Once a pixel covers many patches their amounts
// are averaged (thinned) while the white they show is mostly thick foam's, so it tends to the
// brightness of typical whitecap foam instead.
export const FOAM_FAR_BRIGHTNESS = 0.85;
export const foamBrightness = (amount: number, footprint: number): number =>
  0.6 + 0.4 * amount + (FOAM_FAR_BRIGHTNESS - 0.6 - 0.4 * amount) * foamPatternFade(footprint);

// Boat wake foam (trails, breaking wake crests, hull contact) counts toward the foam amount at its
// value once past a trace: its sources are physically scaled (wakeFoam.ts), so a yacht's faint
// strip shows as scattered bubbles; only the last traces of decayed trails and the filtering
// halos around the stamps stay hidden.
export const WAKE_FOAM_EDGES = [0.02, 0.12] as const;
export const wakeFoamAmount = (wake: number): number =>
  wake * smoothstep(WAKE_FOAM_EDGES[0], WAKE_FOAM_EDGES[1], wake);

// Warp amplitudes, m per unit of density deviation.
export const LACE_WARP = 7;
export const STREAK_WARP = 10;

// Every cascade's foam tiles at its patch length. Two factors make the copies differ:
//  - a mask from a low-frequency field (1 + 6·deviation, clamped: off in about a fifth of the sea),
//    longest cascade first: none, region, patches (+ a little drift), drift + patches;
export const FOAM_MASK_GAIN = 6;
export const FOAM_MASK_MAX = 1.6;
export const foamMask = (deviation: number): number =>
  Math.min(FOAM_MASK_MAX, Math.max(0, 1 + FOAM_MASK_GAIN * deviation));
// The masks also scale the cascades' strain (which crests whiten), at this depth and divided by
// their RMS, so the strain variance, and with it the calibrated whitecap coverage, holds. Full
// depth would leave whole patches of a hurricane without a whitecap.
export const FOAM_STRAIN_MASK = 0.5;
export const DENSITY_STD = 0.15; // of the detail texture's density channel
export const MASK_PATCH_DRIFT = 0.6;
export const MASK_SHORT_DRIFT = 0.8;
export const MASK_SHORT_PATCHES = 0.6;
function foamMaskRms(std = DENSITY_STD): number {
  let sum = 0;
  const dz = 0.001;
  for (let z = -8; z < 8; z += dz) sum += foamMask(z * std) ** 2 * normalPdf(z) * dz;
  return Math.sqrt(sum);
}
//  - breaking groups: short waves break on the crests of longer ones, so each cascade's foam is
//    scaled by the next longer foam cascade's compression z = (∂Dx/∂x + ∂Dz/∂z) / σ (negative on
//    its crests): max(0.5 − z, 0), capped, over its mean for Gaussian z (so coverage holds).
export const GROUP_OFFSET = 0.5;
export const GROUP_MAX = 1.5;

// E[min(max(GROUP_OFFSET − z, 0), GROUP_MAX)] for standard normal z, numerically.
function groupMean(): number {
  let sum = 0;
  const dz = 0.001;
  for (let z = -8; z < 8; z += dz)
    sum += Math.min(Math.max(GROUP_OFFSET - z, 0), GROUP_MAX) * normalPdf(z) * dz;
  return sum;
}

export const GROUP_SCALE = 1 / groupMean();
export const FOAM_MASK_RMS = foamMaskRms();

export function breakingGroup(longerStrain: number, longerJacobianStd: number): number {
  const z = longerStrain / Math.max(longerJacobianStd, 1e-3);
  return Math.min(Math.max(GROUP_OFFSET - z, 0), GROUP_MAX) * GROUP_SCALE;
}

// The 20 m physics patch holds 0.6–4 m waves: steep enough to dominate the Jacobian, but they
// only break as specks on the longer waves. At full weight their 20 m period would show in the foam
// (800 m = 40 × 20 m, so it would also reinforce the 800 m cascade's), so cascades shorter than this
// count at half weight in the whitecap strain and the accumulated foam (the coverage calibration
// keeps them at full weight); the accumulated foam is scaled up by this to make up its share.
const FOAM_FULL_PATCH = 60; // m
const FOAM_SHORT_WEIGHT = 0.5;
export const FOAM_ACCUMULATED_GAIN = 1.25;
export const foamCascadeWeight = (patch: number): number => (patch < FOAM_FULL_PATCH ? FOAM_SHORT_WEIGHT : 1);

export interface StreakOctave {
  spacing: number; // m between neighbouring streak cells, across the wind
  halfWidth: readonly [number, number]; // m, min and range
  length: number; // m, mean trail period along the wind
  gap: number; // m, period of the breaks along a thread
  angle: number; // rad off the wind direction
  weight: number; // brightness
}

// Fine threads, not ropes: sub-metre wide (centimetres for the finest), broken every few metres,
// trails of tens of metres. Spacings step by ≈ 2.5 (never a ratio of small integers); angles fan
// out a few degrees.
export const STREAK_OCTAVES: readonly StreakOctave[] = [
  { spacing: 1.3, halfWidth: [0.03, 0.06], length: 23, gap: 1.3, angle: 0, weight: 1 },
  { spacing: 3.1, halfWidth: [0.04, 0.09], length: 47, gap: 2.3, angle: -0.05, weight: 0.8 },
  { spacing: 7.9, halfWidth: [0.06, 0.12], length: 89, gap: 3.9, angle: 0.08, weight: 0.6 },
];

// Per cell: centre in [0.3, 0.7] of the cell, half-width, brightness, trail length factor (min,
// range). Per trail: kept with this probability; it rises over the first [0.1, 0.3] of its length
// and fades out from [0.4, 0.8] of it to its end. Along it, value noise (a knot per gap period)
// through these edges breaks it into fragments.
export const STREAK_CENTRE = [0.3, 0.4] as const;
export const STREAK_BRIGHTNESS = [0.25, 0.45] as const;
export const STREAK_GAP_EDGES = [0.35, 0.75] as const;
export const streakGapSalt = 0x6a9;
export const STREAK_LENGTH = [0.55, 0.9] as const;
export const STREAK_PRESENCE = 0.8;
export const STREAK_RISE = [0.1, 0.2] as const;
export const STREAK_FALL = [0.4, 0.4] as const;
// Footprints (in spacings) where an octave starts and finishes fading to its mean: before its
// lines get narrower than a pixel could hold apart (no moiré).
export const STREAK_FADE_START = 0.08;
export const STREAK_FADE_END = 0.25;
// Line half-width never below this many pixel footprints (filtered, brightness-conserving).
export const STREAK_MIN_WIDTH = 1;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

// Streak presence: foam drawn out downwind, from the accumulated foam on the downwind (lee) faces of
// the crests, or (as old foam and spume fill the sea towards a hurricane) in wind-aligned bands
// where drift + region · this is high. Threads are frayed by the bubble texture.
export const STREAK_TRAIL = [0.06, 0.5] as const; // accumulated foam where trails start / are full
// Lee faces: slope along the wind (of the foam-making cascades) where trails are faint / full.
export const STREAK_LEE = [0.03, -0.1] as const;
export const STREAK_WINDWARD = 0.3; // trail presence left on windward faces
export const STREAK_FRAY = [0.1, 0.7] as const; // of lace · 0.7 + bubbles · 0.5
export const STREAK_BAND = [-0.08, 0.1] as const;
export const STREAK_BAND_REGION = 0.6;
export const STREAK_BASE = 1; // band presence at full spume (× spume², so mostly hurricanes)
export const STREAK_GAIN = 2.4;
// Threads brighten towards a hurricane (× 1 + this × spume): spume fills the air and the sea.
export const STREAK_SPUME_GAIN = 1.5;
// Region warp of the streaks, m per unit deviation: long, gentle meanders shared by all of them.
export const STREAK_REGION_WARP = 15;

// Byte k (0–3) of a hash as a value in [0, 1].
const hashByte = (h: number, k: number): number => ((h >>> (8 * k)) & 255) / 255;

// Hash of a signed integer cell (its two's-complement bits, as WGSL's u32(i32) gives).
export const hashCell = (cell: number, salt: number): number => hash32((cell | 0) ^ salt);

export const streakSalt = (octave: number): number => hash32(0x5eed + octave);

// Fragments along a thread: value noise between per-knot hashes (h is the thread's cell hash),
// through STREAK_GAP_EDGES.
export function streakGap(along: number, h: number, gap: number): number {
  const s = along / gap + hashByte(h, 3) * 13.7;
  const knot = Math.floor(s);
  const f = s - knot;
  const w = f * f * (3 - 2 * f);
  const a = hashByte(hash32(h ^ hash32((knot | 0) ^ streakGapSalt)), 0);
  const b = hashByte(hash32(h ^ hash32(((knot + 1) | 0) ^ streakGapSalt)), 0);
  return smoothstep(STREAK_GAP_EDGES[0], STREAK_GAP_EDGES[1], a + (b - a) * w);
}

// Brightness along a trail at g ∈ [0, 1): rising over [0, rise], fading out over [fall, 1].
const streakTaper = (g: number, rise: number, fall: number): number =>
  smoothstep(0, rise, g) * (1 - smoothstep(fall, 1, g));

// One streak octave at wind-frame coordinates (along: downwind m; across: m, already warped) for a
// pixel of this footprint (m), before the distance fade.
export function streakLines(along: number, across: number, footprint: number, octave: number): number {
  const o = STREAK_OCTAVES[octave] as StreakOctave;
  const c = across / o.spacing;
  const cell = Math.floor(c);
  const f = c - cell;
  const h = hashCell(cell, streakSalt(octave));
  const centre = STREAK_CENTRE[0] + STREAK_CENTRE[1] * hashByte(h, 0);
  const halfWidth = o.halfWidth[0] + o.halfWidth[1] * hashByte(h, 1);
  const brightness = STREAK_BRIGHTNESS[0] + STREAK_BRIGHTNESS[1] * hashByte(h, 2);
  const length = o.length * (STREAK_LENGTH[0] + STREAK_LENGTH[1] * hashByte(h, 3));
  const q = along / length + hashByte(h, 2) * 7.3;
  const trail = Math.floor(q);
  const g = q - trail;
  const t = hash32(h ^ hash32(trail | 0));
  const present = hashByte(t, 0) < STREAK_PRESENCE ? 1 : 0;
  const rise = STREAK_RISE[0] + STREAK_RISE[1] * hashByte(t, 1);
  const fall = STREAK_FALL[0] + STREAK_FALL[1] * hashByte(t, 2);
  const taper = streakTaper(g, rise, fall);
  const d = Math.abs(f - centre) * o.spacing;
  const w = Math.max(halfWidth, footprint * STREAK_MIN_WIDTH);
  const x = Math.min(1, (d / w) ** 2);
  const profile = (1 - x) ** 2 * (halfWidth / w);
  return profile * brightness * taper * present * streakGap(along, h, o.gap);
}

// Mean of streakLines over the plane: what an octave fades to once its lines are sub-pixel. The
// profile integrates to 16/15 of the half-width whatever the filtering; the rest are independent
// means, the taper's over its uniform rise and fall and the gaps' over their knots, numerically.
function streakMean(octave: number): number {
  const o = STREAK_OCTAVES[octave] as StreakOctave;
  const steps = 32;
  let taper = 0;
  for (let i = 0; i < steps; i++) {
    const rise = STREAK_RISE[0] + STREAK_RISE[1] * ((i + 0.5) / steps);
    for (let j = 0; j < steps; j++) {
      const fall = STREAK_FALL[0] + STREAK_FALL[1] * ((j + 0.5) / steps);
      for (let k = 0; k < steps * 4; k++) taper += streakTaper((k + 0.5) / (steps * 4), rise, fall);
    }
  }
  taper /= steps * steps * steps * 4;
  let gaps = 0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const a = (i + 0.5) / steps;
      const b = (j + 0.5) / steps;
      for (let k = 0; k < steps; k++) {
        const f = (k + 0.5) / steps;
        gaps += smoothstep(STREAK_GAP_EDGES[0], STREAK_GAP_EDGES[1], a + (b - a) * f * f * (3 - 2 * f));
      }
    }
  }
  gaps /= steps * steps * steps;
  const halfWidth = o.halfWidth[0] + o.halfWidth[1] / 2;
  const brightness = STREAK_BRIGHTNESS[0] + STREAK_BRIGHTNESS[1] / 2;
  return ((16 / 15) * halfWidth * brightness * STREAK_PRESENCE * taper * gaps) / o.spacing;
}

export const STREAK_MEANS: readonly number[] = STREAK_OCTAVES.map((_, i) => streakMean(i));

// The octave as drawn: lines up close, fading to their mean as the footprint grows.
export function streakOctave(along: number, across: number, footprint: number, octave: number): number {
  const o = STREAK_OCTAVES[octave] as StreakOctave;
  const fade = smoothstep(STREAK_FADE_START * o.spacing, STREAK_FADE_END * o.spacing, footprint);
  const lines = fade < 1 ? streakLines(along, across, footprint, octave) : 0;
  return (lines + ((STREAK_MEANS[octave] as number) - lines) * fade) * o.weight;
}
