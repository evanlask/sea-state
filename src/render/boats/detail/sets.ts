// The ambientCG CC0 texture sets used as close-up surface detail on the procedural boats, and what
// the game knows about each one. Pure data. `npm run assets` builds them from
// assets-src/textures/<set>/ into public/textures/<set>/ (see scripts/assets/texturePacking.ts):
//   surface.ktx2  R, G normal X, Y (OpenGL, +Y up) · B roughness · A AO, or metalness without AO
//   color.ktx2    sRGB colour, only for sets whose colour the shaders read
// Means below were measured on the 1K sources and let the shaders add a map's *variation* on top of
// the procedural values instead of replacing them.

export const DETAIL_SETS = [
  'painted-metal',
  'painted-metal-worn',
  'rusty-steel',
  'deck-planks',
  'diamond-plate',
  'sailcloth',
  'rope',
  'rubber',
  'gelcoat',
] as const;

export type DetailSetId = (typeof DETAIL_SETS)[number];
export type DetailMapKind = 'surface' | 'color';

export interface DetailSetInfo {
  asset: string; // ambientCG asset ID, for the credits
  description: string;
  maps: readonly DetailMapKind[]; // files the pipeline ships for this set
  alpha: 'ao' | 'metal' | 'none'; // what surface.a holds
  aspect: number; // texture width / height
  roughness: number; // mean of surface.b
  alphaMean: number; // mean of surface.a
  luminance: number; // mean linear luminance of color.ktx2 (0 without one)
  // As a worn layer: which channel marks the damage (painted-metal-worn: rough rust patches;
  // rusty-steel: where the metal mask says it isn't bare steel).
  wear: 'roughness' | 'unmetal';
  // Pattern repeats across one tile (planks: seams at v = k / 12), 0 for irregular patterns.
  repeats: number;
}

export const DETAIL_SET_INFO: Readonly<Record<DetailSetId, DetailSetInfo>> = {
  'painted-metal': {
    asset: 'PaintedMetal004',
    description: 'scratched paint',
    maps: ['surface'],
    alpha: 'metal',
    aspect: 1,
    roughness: 0.154,
    alphaMean: 0.093,
    luminance: 0,
    wear: 'roughness',
    repeats: 0,
  },
  'painted-metal-worn': {
    asset: 'PaintedMetal006',
    description: 'chipped paint over rust',
    maps: ['surface'],
    alpha: 'ao',
    aspect: 1,
    roughness: 0.45,
    alphaMean: 0.799,
    luminance: 0,
    wear: 'roughness',
    repeats: 0,
  },
  'rusty-steel': {
    asset: 'Metal022',
    description: 'rusty steel',
    maps: ['surface', 'color'],
    alpha: 'metal',
    aspect: 1,
    roughness: 0.693,
    alphaMean: 0.505,
    luminance: 0.112,
    wear: 'unmetal',
    repeats: 0,
  },
  'deck-planks': {
    asset: 'Planks023A',
    description: 'weathered deck planks',
    maps: ['surface', 'color'],
    alpha: 'ao',
    aspect: 1,
    roughness: 0.849,
    alphaMean: 0.92,
    luminance: 0.082,
    wear: 'roughness',
    repeats: 12,
  },
  'diamond-plate': {
    asset: 'DiamondPlate008A',
    description: 'diamond plate',
    maps: ['surface'],
    alpha: 'ao',
    aspect: 1,
    roughness: 0.289,
    alphaMean: 0.77,
    luminance: 0,
    wear: 'roughness',
    repeats: 10,
  },
  sailcloth: {
    asset: 'Fabric061',
    description: 'woven sailcloth',
    maps: ['surface'],
    alpha: 'ao',
    aspect: 1,
    roughness: 0.839,
    alphaMean: 0.789,
    luminance: 0,
    wear: 'roughness',
    repeats: 64,
  },
  rope: {
    asset: 'Rope001',
    description: 'laid rope',
    maps: ['surface', 'color'],
    alpha: 'none',
    aspect: 2,
    roughness: 0.65,
    alphaMean: 1,
    luminance: 0.157,
    wear: 'roughness',
    repeats: 8,
  },
  rubber: {
    asset: 'Rubber004',
    description: 'rubber',
    maps: ['surface'],
    alpha: 'none',
    aspect: 1,
    roughness: 0.591,
    alphaMean: 1,
    luminance: 0,
    wear: 'roughness',
    repeats: 0,
  },
  gelcoat: {
    asset: 'Plastic013A',
    description: 'gelcoat / white plastic',
    maps: ['surface'],
    alpha: 'none',
    aspect: 1,
    roughness: 0.401,
    alphaMean: 1,
    luminance: 0,
    wear: 'roughness',
    repeats: 0,
  },
};

export const detailMapPath = (set: DetailSetId, map: DetailMapKind): string => `textures/${set}/${map}.ktx2`;
