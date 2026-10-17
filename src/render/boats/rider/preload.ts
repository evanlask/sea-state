// Before a session builds its boats: loads the jet ski rider when a jet ski is on the water and the
// asset manifest lists the character, and registers it (asset.ts) for the jet ski model. Once per
// page; anything missing or failing leaves the procedural rider.

import type { WebGPURenderer } from 'three/webgpu';

import { LoadCancelledError, type LoadingManager } from '../../../app/loading/LoadingManager';
import { assetEntry, loadAssetManifest } from '../../../app/loading/manifest';
import type { BoatKind } from '../../../sim/world/protocol';
import { setRiderAsset } from './asset';

const RIDER_MODEL = 'models/characters/rider/model.glb';

let settled = false; // loaded, or failed and left procedural for this page

export async function preloadRider(
  kinds: Iterable<BoatKind>,
  renderer: WebGPURenderer,
  loading: LoadingManager,
  base: string = import.meta.env.BASE_URL,
): Promise<void> {
  if (settled || ![...kinds].includes('pwc')) return;
  const manifest = await loadAssetManifest(base);
  const entry = assetEntry(manifest, RIDER_MODEL);
  if (!entry || entry.kind !== 'model') return;
  try {
    const { loadRider } = await import('./load');
    setRiderAsset(await loadRider({ path: RIDER_MODEL, entry }, renderer, loading, base));
    settled = true;
  } catch (error) {
    if (error instanceof LoadCancelledError) throw error;
    settled = true;
    console.warn('The jet ski rider failed to load; using the procedural rider.', error);
  }
}
