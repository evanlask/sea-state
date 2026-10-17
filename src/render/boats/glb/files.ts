// Which drop-in model files the asset manifest lists for a boat: models/<kind>/model.glb, the
// optional simplified LODs model.lod1.glb / model.lod2.glb for distant boats, and align.json.

import { type AssetEntry, type AssetManifest, assetEntry } from '../../../app/loading/manifest';
import type { BoatKind } from '../../../sim/world/protocol';

export interface ListedAsset {
  path: string;
  entry: AssetEntry;
}

export interface BoatModelFiles {
  lods: ListedAsset[]; // LOD0 first; LODs only while consecutive
  align: ListedAsset | null;
}

// For loading-screen steps and notices.
export const MODEL_LABELS: Record<BoatKind, string> = {
  cargo: 'container ship',
  cruise: 'cruise ship',
  crab: 'crab boat',
  sail: 'sailboat',
  powerboat: 'center console',
  pwc: 'jet ski',
  hydro: 'hydroplane',
};

const MAX_MODEL_LODS = 3;

const modelPath = (kind: BoatKind, lod = 0): string =>
  `models/${kind}/${lod === 0 ? 'model.glb' : `model.lod${lod}.glb`}`;

export function boatModelFiles(manifest: AssetManifest, kind: BoatKind): BoatModelFiles | null {
  const lods: ListedAsset[] = [];
  for (let lod = 0; lod < MAX_MODEL_LODS; lod++) {
    const path = modelPath(kind, lod);
    const entry = assetEntry(manifest, path);
    if (!entry || entry.kind !== 'model') break;
    lods.push({ path, entry });
  }
  if (lods.length === 0) return null;
  const alignPath = `models/${kind}/align.json`;
  const align = assetEntry(manifest, alignPath);
  return { lods, align: align ? { path: alignPath, entry: align } : null };
}
