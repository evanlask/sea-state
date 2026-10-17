// Cloud types as vertical density profiles, and the mapping from the scene weather (type, coverage,
// base) to the cloud layer the raymarcher draws: shell altitudes, the two profiles the weather map's
// type channel blends between, weather-map generation parameters and the cirrus layer. Pure TS; the
// GPU evaluates the same profile formula (cloudShading.ts). During a weather change the layer
// morphs from one type to the next by interpolating all of these (blendCloudLayers).

import type { CloudType } from '../../sim/weather/presets';

export interface CloudProfile {
  thickness: number; // km, base to top of a mature column
  bottomFade: number; // fraction of the column over which density ramps up from the flat base
  taperStart: number; // fraction where the top starts to round off
  roundness: number; // superellipse exponent of the top: 2 = round dome, 4+ = flat-topped
  density: number; // extinction multiplier (decks and storm cores are optically thicker)
  anvil: number; // 0..1, how far the top spreads out (cumulonimbus incus)
  billow: number; // 0..1, cauliflower flanks: contrast of the shape noise on the column's sides
}

export type ProfileName =
  | 'stratus'
  | 'stratocumulus'
  | 'cumulus'
  | 'congestus'
  | 'cumulonimbus'
  | 'nimbostratus';

// Typical depths [K: WMO International Cloud Atlas]: stratus 0.2–0.8 km, stratocumulus 0.5–1 km,
// fair-weather cumulus (humilis/mediocris) 0.5–1.5 km, towering cumulus 2–5 km, cumulonimbus to
// the tropopause (8–12 km), nimbostratus a 2–4 km deck. The weather map's height channel scales
// each column 0.7–1.3×.
export const CLOUD_PROFILES: Readonly<Record<ProfileName, CloudProfile>> = {
  stratus: {
    thickness: 0.55,
    bottomFade: 0.12,
    taperStart: 0.6,
    roundness: 4,
    density: 0.9,
    anvil: 0,
    billow: 0,
  },
  stratocumulus: {
    thickness: 0.9,
    bottomFade: 0.1,
    taperStart: 0.5,
    roundness: 2.5,
    density: 1,
    anvil: 0,
    billow: 0,
  },
  cumulus: {
    thickness: 0.95,
    bottomFade: 0.06,
    taperStart: 0.5,
    roundness: 2,
    density: 1,
    anvil: 0,
    billow: 0,
  },
  congestus: {
    thickness: 3,
    bottomFade: 0.04,
    taperStart: 0.45,
    roundness: 2,
    density: 1.15,
    anvil: 0,
    billow: 0.5,
  },
  cumulonimbus: {
    thickness: 10,
    bottomFade: 0.02,
    taperStart: 0.5,
    roundness: 2.2,
    density: 1.6,
    anvil: 1,
    billow: 1,
  },
  nimbostratus: {
    thickness: 3.2,
    bottomFade: 0.05,
    taperStart: 0.7,
    roundness: 3,
    density: 1.4,
    anvil: 0,
    billow: 0,
  },
};

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Cumulonimbus tops (cloudShading.ts): a layer whose profiles have an anvil takes its deepest
// profile's thickness as the tropopause. Columns stop just above it (a small overshooting dome)
// and the anvil spreads below it, from ANVIL_BASE over the tallest cores (its sloping underside
// rises toward ANVIL_TOP over shorter columns) to a flat top at the tropopause, carried
// ANVIL_DRIFT km downwind. Fractions of the tropopause height above the base.
export const ANVIL_BASE = 0.72;
export const ANVIL_TOP = 0.9;
export const ANVIL_DRIFT = 3; // km
export const TROPOPAUSE_CAP = 1.08; // columns end here (fraction of the tropopause height)
// Billowing columns (profile billow) push their crowns up or down by up to ±½ this fraction of
// the column where the shape noise bulges or dents: turrets on the dome, not a smooth cap.
export const CROWN_LIFT = 0.2;

// Vertical density envelope of a column, 0..1, at z = (altitude − base) / thickness, for a column
// of the profile's nominal depth at the core of a mature cell. Full from the flat base to
// taperStart, then a superellipse cap (1 − t^p)^(1/p): it meets the top with a horizontal
// tangent, so a cell's silhouette (its width at each height follows the envelope through the
// coverage remap) is a rounded dome, not a point (a plain 1 − t^p reaches zero at a finite slope).
// An anvil adds its flat-topped sheet under the tropopause (here the profile's own top).
export function profileDensity(z: number, p: CloudProfile): number {
  if (z <= 0 || z >= 1) return 0;
  const bottom = smoothstep(0, p.bottomFade, z);
  const t = clamp01((z - p.taperStart) / (1 - p.taperStart));
  const top = Math.max(1 - t ** p.roundness, 0) ** (1 / p.roundness);
  const sheet = smoothstep(ANVIL_BASE, ANVIL_BASE + 0.06, z) * (1 - smoothstep(0.93, 1, z));
  const anvil = smoothstep(0.55, 0.85, p.anvil) * sheet;
  return Math.max(bottom * top, anvil);
}

// Linear blend of two profiles (the weather map's type channel), as the shader does.
export function mixProfiles(a: CloudProfile, b: CloudProfile, t: number): CloudProfile {
  const k = clamp01(t);
  if (k <= 0) return a;
  if (k >= 1) return b;
  const mix = (x: number, y: number): number => x + (y - x) * k;
  return {
    thickness: mix(a.thickness, b.thickness),
    bottomFade: mix(a.bottomFade, b.bottomFade),
    taperStart: mix(a.taperStart, b.taperStart),
    roundness: mix(a.roundness, b.roundness),
    density: mix(a.density, b.density),
    anvil: mix(a.anvil, b.anvil),
    billow: mix(a.billow, b.billow),
  };
}

export interface CloudWeather {
  type: CloudType;
  coverage: number; // 0..1
  base: number; // m above sea level
  precipitation: number; // 0..1
  // Part-way through a weather change: the layer morphs from morphFrom (morph 0) to type (morph 1).
  morphFrom?: CloudType;
  morph?: number;
}

// How the weather-map kernel lays out cloud cells (see WeatherMap.ts).
export interface WeatherMapParams {
  cellsPerTile: number; // Worley cells across the map: sets the spacing of cumulus cells
  // Mid-morph the cell field mixes in a second layout of cellsPerTileTo cells (cell counts must be
  // whole for the map to tile, so the two layouts crossfade rather than interpolate).
  cellsPerTileTo: number;
  cellsMix: number; // 0 = cellsPerTile only, 1 = cellsPerTileTo only
  cellWeight: number; // 0 = pure FBM (sheets), 1 = pure cells (heaps)
  threshold: number; // local value at which cloud starts (higher = sparser)
  softness: number; // width of the coverage edge
  deck: number; // 0..1 coverage floor everywhere (overcast decks)
  typeBias: number; // type channel offset: 0 = profile A, 1 = profile B
  typeSpread: number; // how strongly the strongest cells grow toward profile B
  precipitation: number; // 0..1 rain under heavy cells (or under the whole deck)
}

// Heaps value at a cell centre: the big cell's peak (0.75) plus the small cells' typical share.
export const CELL_PEAK = 0.9;

// The weather map's type channel (WeatherMap.ts runs the same formula) from its two smooth fields
// at a texel, sheets and cluster (0..1): how far toward profile B a mature cell grows there. It is
// the strength a cell centred here would have, not the local value on the cell's own radial
// falloff, so a cell's thickness is nearly constant across it and only its coverage falls off
// toward the edge (which rounds the top through the profile). A type that rose toward each centre
// would stretch every heap into a cone.
export function cellType(
  sheets: number,
  cluster: number,
  m: Pick<WeatherMapParams, 'cellWeight' | 'threshold' | 'typeBias' | 'typeSpread'>,
): number {
  const heaps = CELL_PEAK * (sheets * 0.5 + 0.75);
  const peak = (sheets + (heaps - sheets) * m.cellWeight) * (0.7 + 0.55 * cluster);
  const strength = (peak - m.threshold) / Math.max(1 - m.threshold, 0.05);
  return clamp01(m.typeBias + strength * m.typeSpread + (sheets - 0.5) * 0.3);
}

// Columns stretch up to this multiple of their profile's thickness (the weather map's height
// channel stores the scale over this).
export const MAX_COLUMN_SCALE = 1.3;
// Height of a cell's rim relative to its centre.
export const DOME_RIM = 0.35;

// Quarter-circle arc 0..1 → 0..1 that leaves 1 with a horizontal tangent: (1 − (1 − q)²)^½.
const arc = (q: number): number => Math.sqrt(q * (2 - q));

// How far into a cell's dome a weather-map texel is, 0 (rim, or a saddle between cells) .. 1 (the
// centre of a well-grown cell), from the local map value (how far past the cover threshold) and
// the heaps field (how near a cell centre, its small cells making turrets). WeatherMap.ts runs
// the same formula.
export function cellDome(
  local: number,
  heaps: number,
  m: Pick<WeatherMapParams, 'threshold' | 'softness'>,
): number {
  const grown = clamp01((local - m.threshold + m.softness) / (4 * m.softness));
  const central = clamp01((heaps - 0.4) / 0.5);
  return arc(grown) * arc(central);
}

// The weather map's height channel: the column-height scale, 0..1 of MAX_COLUMN_SCALE, from a
// smooth height noise (0..1) and the cell dome. Within a cell the column rises from DOME_RIM at
// the rim to full height at the centre along circular arcs, so every heap is a dome and merged
// cells a cluster of domes rather than a flat-topped slab; sheets (low cellWeight) stay level.
export function columnScale(heightNoise: number, dome: number, cellWeight: number): number {
  const shape = 1 + (DOME_RIM + (1 - DOME_RIM) * dome - 1) * cellWeight;
  return ((0.7 + 0.6 * clamp01(heightNoise)) * shape) / MAX_COLUMN_SCALE;
}

export interface CloudLayer {
  enabled: boolean; // any volumetric cloud at all
  volumetric: boolean; // the type has a volumetric layer (clear and cirrus skies don't)
  coverage: number; // 0..1 as given
  baseKm: number; // km above sea level
  topKm: number; // km, top of the shell (tallest column)
  profileA: CloudProfile; // type channel 0
  profileB: CloudProfile; // type channel 1
  map: WeatherMapParams;
  cirrus: number; // 0..1 coverage of the 2D cirrus layer at CIRRUS_ALTITUDE
  extinction: number; // 1/km at density 1
}

export const CIRRUS_ALTITUDE = 9; // km
export const MIN_CLOUD_BASE = 0.25; // km: keeps normal cameras below the deck (fog handles the rest)
const CLOUD_EXTINCTION = 45; // 1/km: ~70 m visibility inside a cloud [K: ~30–100 m]

// Default bases when a custom weather gives only a type (m) [K: typical maritime values].
export const DEFAULT_CLOUD_BASE: Readonly<Record<CloudType, number>> = {
  clear: 1000,
  cirrus: 9000,
  cumulus: 900,
  stratocumulus: 700,
  stratus: 350,
  nimbostratus: 500,
  cumulonimbus: 650,
};

// Top of the shell: columns may stretch to MAX_COLUMN_SCALE× their nominal depth (weather map height channel),
// billowing crowns a little higher; a layer with anvils ends at its tropopause cap instead.
export function shellTop(baseKm: number, a: CloudProfile, b: CloudProfile): number {
  const deepest = Math.max(a.thickness, b.thickness);
  const crowns = MAX_COLUMN_SCALE * (1 + 0.5 * CROWN_LIFT * Math.max(a.billow, b.billow));
  const anvil = Math.max(a.anvil, b.anvil);
  return Math.min(baseKm + deepest * (crowns + (TROPOPAUSE_CAP + 0.02 - crowns) * anvil), 14);
}

const layer = (
  w: CloudWeather,
  a: ProfileName | CloudProfile,
  b: ProfileName,
  map: Omit<WeatherMapParams, 'precipitation' | 'cellsPerTileTo' | 'cellsMix'>,
  cirrus: number,
  volumetric = true,
): CloudLayer => {
  const profileA = typeof a === 'string' ? CLOUD_PROFILES[a] : a;
  const profileB = CLOUD_PROFILES[b];
  const baseKm = Math.max(MIN_CLOUD_BASE, w.base / 1000);
  return {
    enabled: w.coverage > 0.01,
    volumetric,
    coverage: clamp01(w.coverage),
    baseKm,
    topKm: shellTop(baseKm, profileA, profileB),
    profileA,
    profileB,
    map: {
      ...map,
      cellsPerTileTo: map.cellsPerTile,
      cellsMix: 0,
      precipitation: clamp01(w.precipitation),
    },
    cirrus: clamp01(cirrus),
    extinction: CLOUD_EXTINCTION,
  };
};

// Scene weather → cloud layer, morphing between two types part-way through a weather change.
export function cloudLayerFor(weather: CloudWeather): CloudLayer {
  const { morphFrom, morph } = weather;
  const to = typeLayer(weather);
  if (morphFrom === undefined || morph === undefined || morphFrom === weather.type) return to;
  return blendCloudLayers(typeLayer({ ...weather, type: morphFrom }), to, morph);
}

// The weather map regenerates (and the clouds' temporal history restarts) only at these steps of a
// morph; the profiles and shell between them follow the morph every frame.
export const MAP_MORPH_STEPS = 10;
export const steppedMorph = (morph: number): number =>
  Math.round(clamp01(morph) * MAP_MORPH_STEPS) / MAP_MORPH_STEPS;

// Layer a part-way (t, 0..1) to layer b: profiles, shell, map parameters and cirrus interpolate and
// the two cell layouts crossfade. A clear or cirrus sky has no volumetric shapes of its own, so it
// borrows the other side's, with no cover (its map threshold and deck), and the clouds grow in or
// melt away in place.
export function blendCloudLayers(a: CloudLayer, b: CloudLayer, t: number): CloudLayer {
  const k = clamp01(t);
  if (k <= 0) return a;
  if (k >= 1) return b;
  const borrow = (none: CloudLayer, shapes: CloudLayer): CloudLayer =>
    none.volumetric || !shapes.volumetric
      ? none
      : {
          ...shapes,
          enabled: none.enabled,
          volumetric: false,
          coverage: none.coverage,
          map: { ...shapes.map, threshold: none.map.threshold, deck: none.map.deck },
          cirrus: none.cirrus,
        };
  const from = borrow(a, b);
  const to = borrow(b, a);
  const mix = (x: number, y: number): number => x + (y - x) * k;
  const profileA = mixProfiles(from.profileA, to.profileA, k);
  const profileB = mixProfiles(from.profileB, to.profileB, k);
  const baseKm = mix(from.baseKm, to.baseKm);
  const m = from.map;
  const n = to.map;
  const cellsDiffer = m.cellsPerTile !== n.cellsPerTile;
  return {
    enabled: from.enabled || to.enabled,
    volumetric: from.volumetric || to.volumetric,
    coverage: mix(from.coverage, to.coverage),
    baseKm,
    topKm: shellTop(baseKm, profileA, profileB),
    profileA,
    profileB,
    map: {
      cellsPerTile: m.cellsPerTile,
      cellsPerTileTo: n.cellsPerTile,
      cellsMix: cellsDiffer ? k : 0,
      cellWeight: mix(m.cellWeight, n.cellWeight),
      threshold: mix(m.threshold, n.threshold),
      softness: mix(m.softness, n.softness),
      deck: mix(m.deck, n.deck),
      typeBias: mix(m.typeBias, n.typeBias),
      typeSpread: mix(m.typeSpread, n.typeSpread),
      precipitation: mix(m.precipitation, n.precipitation),
    },
    cirrus: mix(from.cirrus, to.cirrus),
    extinction: mix(from.extinction, to.extinction),
  };
}

// One cloud type's layer. Coverage drives the map threshold so the sky fraction matches.
function typeLayer(weather: CloudWeather): CloudLayer {
  const c = clamp01(weather.coverage);
  // Cloud cells start where the local map value exceeds this; ~linear in coverage over 0.1..0.9.
  const threshold = 0.82 - 0.62 * c;
  switch (weather.type) {
    case 'clear':
    case 'cirrus': {
      const cirrus = weather.type === 'cirrus' ? Math.max(0.3, c) : 0.05;
      const none = { ...weather, coverage: 0 };
      return layer(
        none,
        'cumulus',
        'cumulus',
        { cellsPerTile: 24, cellWeight: 1, threshold: 1, softness: 0.1, deck: 0, typeBias: 0, typeSpread: 0 },
        cirrus,
        false,
      );
    }
    case 'cumulus':
      // Fair-weather heaps: humilis 0.5–1 km deep in fair weather (the odd mediocris to ~1.5 km);
      // more coverage = deeper convection (breezy: mediocris and some congestus towers).
      return layer(
        weather,
        'cumulus',
        'congestus',
        {
          cellsPerTile: 22,
          cellWeight: 0.75,
          threshold,
          softness: 0.12,
          deck: 0,
          typeBias: -1.05 + 1.2 * c,
          typeSpread: 1.2,
        },
        0.25,
      );
    case 'stratocumulus':
      return layer(
        weather,
        'stratus',
        'stratocumulus',
        {
          cellsPerTile: 40,
          cellWeight: 0.55,
          threshold,
          softness: 0.18,
          deck: smoothstep(0.75, 1, c) * 0.6,
          typeBias: 0.7,
          typeSpread: 0.6,
        },
        0.1,
      );
    case 'stratus':
      return layer(
        weather,
        'stratus',
        'stratocumulus',
        {
          cellsPerTile: 30,
          cellWeight: 0.2,
          threshold,
          softness: 0.25,
          deck: smoothstep(0.7, 1, c) * 0.85,
          typeBias: 0.1,
          typeSpread: 0.5,
        },
        0,
      );
    case 'nimbostratus':
      return layer(
        weather,
        'nimbostratus',
        'congestus',
        {
          cellsPerTile: 16,
          cellWeight: 0.3,
          threshold,
          softness: 0.25,
          deck: smoothstep(0.7, 1, c) * 0.9,
          typeBias: -0.4,
          typeSpread: 0.8,
        },
        0,
      );
    case 'cumulonimbus':
      // Isolated storms in a cumulus field, or (near full coverage) towers embedded in a deck; the
      // field between them thickens into the deck smoothly as the coverage passes ~85%.
      return layer(
        weather,
        mixProfiles(CLOUD_PROFILES.congestus, CLOUD_PROFILES.nimbostratus, smoothstep(0.8, 0.9, c)),
        'cumulonimbus',
        {
          cellsPerTile: 12,
          cellWeight: 0.8,
          threshold,
          softness: 0.22,
          deck: smoothstep(0.8, 1, c) * 0.85,
          typeBias: -1.6 + 0.5 * c,
          typeSpread: 2.6,
        },
        0.1,
      );
  }
}

// Wind aloft from the 10 m wind: roughly 1.5× near cloud base [K: log/Ekman profile], capped so
// hurricane decks don't race across the sky.
export function windAloft(wind: { x: number; z: number }, out = { x: 0, z: 0 }): { x: number; z: number } {
  const speed = Math.hypot(wind.x, wind.z);
  const aloft = Math.min(speed * 1.5, 35);
  const k = speed > 1e-6 ? aloft / speed : 0;
  out.x = wind.x * k;
  out.z = wind.z * k;
  return out;
}

// Share of the clear-sky light that still reaches the air below a cloud cover of this fraction
// (decks shade the haze between the camera and the horizon).
export const airLightFromCover = (coverage: number): number => 1 - 0.85 * clamp01(coverage) ** 1.5;

// Overcast air: the haze and rain murk under a deck.

// The march's ambient term estimates a sample's column optical depth as cover × σ × depth × this.
export const COLUMN_DEPTH_FACTOR = 0.45;
// The diffusion long tail 1 / (1 + DIFFUSION τ) of thick media (≈ 0.75 (1 − g) for g ≈ 0.85).
export const DIFFUSION = 0.11;
// Diffuse reflectance of the sea (Fresnel-averaged sky reflection plus the water body).
export const DECK_SEA_ALBEDO = 0.06;
// Cap of the murk extinction under a deck (1/km): meteorological visibility under a storm is far
// shorter, but the scene keeps the deck readable overhead and leaves near-field fog to its own rain.
export const MURK_MAX = 0.5;

// Optical depth of the deck's column as the march's ambient term sees it at the cloud base (deck
// profile A at its nominal depth): what dims the light diffusing down through it.
export const deckOpticalDepth = (layer: CloudLayer): number =>
  layer.enabled ? layer.coverage * layer.extinction * layer.profileA.thickness * COLUMN_DEPTH_FACTOR : 0;

// How much of the air between the camera and the horizon is lit by a cloud deck rather than by the
// sun and clear sky, 0..1. Under a deck (or in rain or low visibility beneath cloud) the haze is lit
// only by the grey cloud base above and the sea below, so the horizon is grey murk, not a band of
// clear-sky blue. Broken cloud leaves the air in sun and blue sky (fair and breezy horizons stay
// blue): the weight rises over 55–95% cover, and rain or murk under cloud add to it. Fog under a
// clear sky is sunlit (white), so murk counts only in proportion to the cover.
export function overcastAirWeight(coverage: number, precipitation: number, visibility: number): number {
  const c = clamp01(coverage);
  const cover = smoothstep(0.55, 0.95, c);
  const rain = 0.5 * smoothstep(0.2, 1, precipitation);
  const fog = 0.6 * (1 - smoothstep(300, 5000, visibility));
  const murk = c * Math.max(rain, fog);
  return 1 - (1 - cover) * (1 - murk);
}

// Extinction (1/km) of the rain and mist under a deck, from the overcast air weight and the
// meteorological visibility (Koschmieder 3.912 / V), saturating at MURK_MAX. Its optical depth
// grows with the path under the cloud base, so the deck fades smoothly into the murk toward the
// horizon (and the far sea into the same grey) rather than meeting a band of haze. Zero in fair
// weather (no overcast air).
export function murkExtinction(weight: number, visibility: number): number {
  const koschmieder = 3912 / Math.max(visibility, 1);
  return clamp01(weight) * MURK_MAX * (1 - Math.exp(-koschmieder / MURK_MAX));
}

type Rgb3 = readonly [number, number, number];

export interface DeckLight {
  above: Rgb3; // cd/m², hemisphere-mean clear sky above the clouds (the ambient kernel's)
  sunlight: Rgb3; // lux, sun or moon illuminance at the cloud base (through the atmosphere)
  mu: number; // cosine of the light's zenith angle
  depth: number; // deck column optical depth (deckOpticalDepth)
}

const INV_2PI = 1 / (2 * Math.PI);

// Radiance (cd/m²) of the air under a deck: the mean of the cloud base's radiance and the sea's.
// The base is the march's ambient term at z = 0: sky light and sunlight diffused down through the
// column, plus half the light of the sea below, which the base itself lights (albedo
// DECK_SEA_ALBEDO; not the clear sky, whose blue would tint the murk). For a horizontal view any
// phase function weighs the upper and lower hemispheres equally, so haze between a uniform base
// and the sea glows with their mean: grey, about half the base (the CIE overcast sky's horizon is
// a third of its zenith), and dark at night. deckAirLight (cloudShading.ts) is the GPU twin.
export function deckAirRadiance(
  light: DeckLight,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const depth = Math.max(light.depth, 0);
  const diffuse = 1 / (1 + DIFFUSION * depth);
  const direct = Math.exp(-depth / Math.max(light.mu, 0.15));
  const sunDiffuse = Math.max(light.mu, 0) * INV_2PI * Math.max(diffuse - direct, 0);
  const a = DECK_SEA_ALBEDO;
  for (let c = 0; c < 3; c++) {
    const through = light.above[c] * 0.5 * diffuse + light.sunlight[c] * sunDiffuse * (diffuse * 0.5 + 0.5);
    const base = through / (1 - 0.5 * a); // base = through + ½ · a · base
    out[c] = 0.5 * (base + a * base);
  }
  return out;
}
