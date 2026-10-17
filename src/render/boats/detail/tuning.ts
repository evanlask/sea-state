// Surface-detail tuning: which ambientCG set each boat part gets, how big a tile is in metres and
// how strongly each map acts.
//
// A recipe has a base layer and, on the working boats, an optional worn layer that only shows
// inside the procedural weathering (rust patches and streaks), so chipped paint appears where the
// procedural model already puts rust and the liveries stay intact elsewhere.
//
// Strengths are 0..1 unless noted; 0 turns that effect off. Detail fades out between 40% and 100%
// of `fade` metres from the camera (back to the procedural look) so distant hulls don't shimmer or
// show the tiling.

import type { BoatKind } from '../../../sim/world/protocol';
import { DETAIL_SET_INFO, type DetailSetId } from './sets';

export interface DetailLayer {
  set: DetailSetId;
  tile: number; // metres per texture repeat (texture height for non-square sets)
  fade: number; // camera distance (m) where the detail is gone
  normal: number; // normal-map strength, 1 = as authored
  roughness?: number; // share of the map's roughness variation added to the procedural roughness
  color?: number; // colour-map luminance modulating the base colour (sets with a colour map)
  albedo?: number; // mix toward the colour map's own colour (rusty steel showing through)
  ao?: number; // AO channel (sets whose alpha is AO): darkens crevices
  scratches?: number; // metal mask (painted metal): bare steel shows through scratches
  metal?: number; // metal mask drives metalness (rusty steel: bare steel metallic, rust not)
  along?: 'x' | 'z'; // grain direction on horizontal faces (planks); default: texture u along x
}

export interface WornLayer extends DetailLayer {
  amount: number; // how far the worn texture spreads into the weathered areas (0..1)
}

export interface DetailRecipe {
  layer: DetailLayer;
  worn?: WornLayer;
}

// ------------------------------------------------------------------ building blocks

// No scratch mask on ship paint: on a dark hull its bare-steel chips read as a repeating polka-dot
// pattern. The paint keeps the map's subtle relief and roughness only.
const SHIP_PAINT: DetailLayer = {
  set: 'painted-metal',
  tile: 2.4,
  fade: 45,
  normal: 0.4,
  roughness: 0.4,
};

const CHIPPED: WornLayer = {
  set: 'painted-metal-worn',
  tile: 1.4,
  fade: 45,
  normal: 0.8,
  roughness: 0.6,
  ao: 0.5,
  amount: 0.8,
};

const RUST_THROUGH: WornLayer = {
  set: 'rusty-steel',
  tile: 0.8,
  fade: 30,
  normal: 0.8,
  roughness: 0.6,
  amount: 0.8,
};

const RUSTY_FITTINGS: DetailLayer = {
  set: 'rusty-steel',
  tile: 0.6,
  fade: 25,
  normal: 0.7,
  roughness: 0.6,
  albedo: 0.45,
  metal: 0.7,
};

const DIAMOND_PLATE: DetailLayer = {
  set: 'diamond-plate',
  tile: 0.3, // 10 repeats per tile: a ~3 cm pattern
  fade: 18,
  normal: 1,
  roughness: 0.3,
  ao: 0.7,
};

const TEAK_PLANKS: DetailLayer = {
  set: 'deck-planks',
  tile: 1.2, // 12 planks per tile: 10 cm planks
  fade: 12,
  normal: 0.8,
  roughness: 0.5,
  color: 0.7,
  ao: 0.8,
  along: 'z',
};

const GELCOAT: DetailLayer = {
  set: 'gelcoat',
  tile: 0.6,
  fade: 10,
  normal: 0.25,
  roughness: 0.35,
};

const RUBBER: DetailLayer = { set: 'rubber', tile: 0.25, fade: 6, normal: 0.7, roughness: 0.5 };

const ROPE: DetailLayer = { set: 'rope', tile: 0.02, fade: 5, normal: 1, roughness: 0.5, color: 0.6 };

const SAILCLOTH: DetailLayer = { set: 'sailcloth', tile: 0.08, fade: 9, normal: 0.3 };

const withLayer = (layer: DetailLayer, over: Partial<DetailLayer> = {}): DetailRecipe => ({
  layer: { ...layer, ...over },
});

// ------------------------------------------------------------------ per boat

// Keys are material names: kit slots (hull, deck, house, trim, machinery, steel, black, rope…) and
// the models' extra materials. Parts not listed keep the procedural look.
export const BOAT_DETAIL: Readonly<Record<BoatKind, Readonly<Record<string, DetailRecipe>>>> = {
  cargo: {
    hull: { layer: SHIP_PAINT, worn: { ...CHIPPED, amount: 0.6 } },
    house: { layer: SHIP_PAINT, worn: { ...CHIPPED, amount: 0.45 } },
    trim: withLayer(SHIP_PAINT),
    deck: { layer: { ...SHIP_PAINT, scratches: 0.3, normal: 0.7 }, worn: { ...CHIPPED, amount: 0.5 } },
    hatch: { layer: { ...SHIP_PAINT, scratches: 0.25 }, worn: { ...CHIPPED, amount: 0.5 } },
    machinery: { layer: { ...SHIP_PAINT, scratches: 0.25 }, worn: RUST_THROUGH },
    lashing: withLayer(SHIP_PAINT, { scratches: 0.3 }),
    funnel: withLayer(SHIP_PAINT),
    funnelBand: withLayer(SHIP_PAINT),
    red: withLayer(SHIP_PAINT, { scratches: 0.2 }),
    steel: withLayer(RUSTY_FITTINGS, { albedo: 0.35 }),
  },
  crab: {
    hull: { layer: SHIP_PAINT, worn: { ...CHIPPED, tile: 1, amount: 0.9 } },
    house: {
      layer: SHIP_PAINT,
      worn: { ...CHIPPED, tile: 1, amount: 0.6 },
    },
    trim: withLayer(SHIP_PAINT, { tile: 0.9, scratches: 0.3 }),
    deck: withLayer(DIAMOND_PLATE),
    machinery: {
      layer: { ...SHIP_PAINT, tile: 0.8, scratches: 0.4 },
      worn: { ...RUST_THROUGH, amount: 0.9 },
    },
    whaleTop: { layer: SHIP_PAINT, worn: { ...CHIPPED, tile: 1, amount: 0.8 } },
    cap: { layer: { ...SHIP_PAINT, scratches: 0.4 }, worn: { ...RUST_THROUGH, amount: 0.8 } },
    rubRail: { layer: { ...SHIP_PAINT, scratches: 0.5 }, worn: { ...RUST_THROUGH, amount: 0.9 } },
    crane: { layer: { ...SHIP_PAINT, tile: 0.8, scratches: 0.4 }, worn: { ...RUST_THROUGH, amount: 0.8 } },
    red: withLayer(SHIP_PAINT, { scratches: 0.3 }),
    steel: withLayer(RUSTY_FITTINGS, { albedo: 0.55 }),
    potFrame: withLayer(RUSTY_FITTINGS, { tile: 0.5, albedo: 0.5 }),
    rope: withLayer(ROPE, { tile: 0.03 }),
  },
  cruise: {
    hull: withLayer(SHIP_PAINT, { tile: 1.5, normal: 0.35, scratches: 0.04 }),
    house: withLayer(SHIP_PAINT, { tile: 1.5, normal: 0.3, scratches: 0.03 }),
    trim: withLayer(SHIP_PAINT, { normal: 0.35, scratches: 0.04 }),
    funnel: withLayer(SHIP_PAINT, { normal: 0.35, scratches: 0.04 }),
    teak: withLayer(TEAK_PLANKS, { tile: 1.5, fade: 20 }),
  },
  sail: {
    hull: withLayer(GELCOAT),
    house: withLayer(GELCOAT),
    gelcoat: withLayer(GELCOAT),
    teak: withLayer(TEAK_PLANKS),
    rope: withLayer(ROPE),
    sail: withLayer(SAILCLOTH),
  },
  powerboat: {
    hull: withLayer(GELCOAT),
    bottom: withLayer(GELCOAT),
    gelcoat: withLayer(GELCOAT),
    cowl: withLayer(GELCOAT, { normal: 0.2 }),
    black: withLayer(RUBBER),
  },
  pwc: {
    hull: withLayer(GELCOAT),
    deckPaint: withLayer(GELCOAT),
    black: withLayer(RUBBER),
    mat: withLayer(RUBBER, { tile: 0.2, normal: 0.9 }),
  },
  // The livery and the bottom; the small parts stay plain so they merge into one draw.
  hydro: {
    hull: withLayer(GELCOAT, { normal: 0.2 }),
    bottom: withLayer(GELCOAT),
  },
};

// ------------------------------------------------------------------ scale helpers

// Detail starts fading at this fraction of a layer's `fade` distance.
const FADE_START = 0.4;

export const fadeRange = (layer: DetailLayer): [number, number] => [layer.fade * FADE_START, layer.fade];

// Texture repeats per metre along the texture's u and v (u spans `aspect` times the tile).
export function tileScale(layer: DetailLayer): [number, number] {
  return [1 / (layer.tile * DETAIL_SET_INFO[layer.set].aspect), 1 / layer.tile];
}

// Size of one pattern cell in metres (plank width, diamond-plate pitch, weave thread), or null.
export function featureSize(layer: DetailLayer): number | null {
  const repeats = DETAIL_SET_INFO[layer.set].repeats;
  return repeats > 0 ? layer.tile / repeats : null;
}
