// Surface-detail selection and state: which texture sets a scenario needs, which of their files the
// asset manifest lists, and the loaded textures the material factories look up while a boat
// template is built. Missing sets (not in the manifest, failed to load, or Low quality) resolve to
// null and the materials keep their procedural look. No three.js runtime imports: unit-tested.

import type { AssetEntry, AssetManifest } from '../../../app/loading/manifest';
import { assetEntry } from '../../../app/loading/manifest';
import type { QualityPreset } from '../../../app/Scenario';
import type { BoatKind } from '../../../sim/world/protocol';
import {
  DETAIL_SET_INFO,
  DETAIL_SETS,
  type DetailMapKind,
  detailMapPath,
  type DetailSetId,
  type DetailSetInfo,
} from './sets';
import { BOAT_DETAIL, type DetailLayer, type DetailRecipe, type WornLayer } from './tuning';

// Structural stand-in for a three.js Texture, so this module stays free of three at runtime.
export interface DetailTexture {
  readonly isTexture: true;
}

export interface DetailMaps {
  surface: DetailTexture;
  color: DetailTexture | null;
}

export interface DetailBinding<L extends DetailLayer = DetailLayer> {
  layer: L;
  info: DetailSetInfo;
  maps: DetailMaps;
}

// What a material gets: either layer may be missing (then that part stays procedural).
export interface ResolvedDetail {
  base: DetailBinding | null;
  worn: DetailBinding<WornLayer> | null;
}

// Low skips detail textures (procedural only); Medium and up use them. Custom counts as High.
export const detailEnabledFor = (quality: QualityPreset | 'custom'): boolean => quality !== 'low';

function recipeSets(recipe: DetailRecipe): DetailSetId[] {
  return recipe.worn && recipe.worn.set !== recipe.layer.set
    ? [recipe.layer.set, recipe.worn.set]
    : [recipe.layer.set];
}

// Sets the boats on the water use, in DETAIL_SETS order; none on Low.
export function detailSetsFor(
  kinds: Iterable<BoatKind>,
  quality: QualityPreset | 'custom',
  table: Readonly<Record<BoatKind, Readonly<Record<string, DetailRecipe>>>> = BOAT_DETAIL,
): DetailSetId[] {
  if (!detailEnabledFor(quality)) return [];
  const wanted = new Set<DetailSetId>();
  for (const kind of kinds)
    for (const recipe of Object.values(table[kind])) for (const set of recipeSets(recipe)) wanted.add(set);
  return DETAIL_SETS.filter((set) => wanted.has(set));
}

export interface DetailFile {
  set: DetailSetId;
  map: DetailMapKind;
  path: string;
  entry: AssetEntry;
}

// The files of each set the manifest lists. A set without its surface map is left out entirely;
// a missing colour map only drops the colour effects.
export function detailFiles(manifest: AssetManifest, sets: readonly DetailSetId[]): DetailFile[] {
  const out: DetailFile[] = [];
  for (const set of sets) {
    const files = DETAIL_SET_INFO[set].maps.flatMap((map) => {
      const path = detailMapPath(set, map);
      const entry = assetEntry(manifest, path);
      return entry && entry.kind === 'texture' ? [{ set, map, path, entry }] : [];
    });
    if (files.some((file) => file.map === 'surface')) out.push(...files);
  }
  return out;
}

export function resolveRecipe(
  recipe: DetailRecipe | undefined,
  available: (set: DetailSetId) => DetailMaps | null,
): ResolvedDetail | null {
  if (!recipe) return null;
  const bind = <L extends DetailLayer>(layer: L): DetailBinding<L> | null => {
    const maps = available(layer.set);
    return maps ? { layer, info: DETAIL_SET_INFO[layer.set], maps } : null;
  };
  const base = bind(recipe.layer);
  const worn = recipe.worn ? bind(recipe.worn) : null;
  return base || worn ? { base, worn } : null;
}

// ------------------------------------------------------------------ state

let enabled = false;
const loaded = new Map<DetailSetId, DetailMaps>();
const failed = new Set<DetailSetId>();

export function setDetailEnabled(on: boolean): void {
  enabled = on;
}

export function registerDetailMaps(set: DetailSetId, maps: DetailMaps | null): void {
  if (maps) {
    loaded.set(set, maps);
    failed.delete(set);
  } else failed.add(set);
}

// Sets still worth trying: not loaded and not already failed on this page.
export const pendingDetailSets = (sets: readonly DetailSetId[]): DetailSetId[] =>
  sets.filter((set) => !loaded.has(set) && !failed.has(set));

const available = (set: DetailSetId): DetailMaps | null => (enabled ? (loaded.get(set) ?? null) : null);

// The detail for one material of a boat, or null for the procedural look.
export function boatDetail(kind: BoatKind, part: string): ResolvedDetail | null {
  return resolveRecipe(BOAT_DETAIL[kind][part], available);
}

// Changes whenever the detail a boat's materials would get changes, so cached templates rebuild.
export function detailKey(kind: BoatKind): string {
  if (!enabled) return 'off';
  const sets = new Set<DetailSetId>();
  for (const recipe of Object.values(BOAT_DETAIL[kind])) for (const set of recipeSets(recipe)) sets.add(set);
  return DETAIL_SETS.filter((set) => sets.has(set) && loaded.has(set)).join(',') || 'none';
}

// For tests.
export function resetDetailState(): void {
  enabled = false;
  loaded.clear();
  failed.clear();
}
