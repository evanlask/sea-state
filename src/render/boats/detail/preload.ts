// Before a session builds its boats: loads the surface-detail texture sets the boats on the water
// use (only those, only when the quality preset wants them and the asset manifest lists them), and
// registers them for the material factories. Anything missing or failing leaves the procedural look.

import type { WebGPURenderer } from 'three/webgpu';

import { LoadCancelledError, type LoadingManager } from '../../../app/loading/LoadingManager';
import { loadAssetManifest } from '../../../app/loading/manifest';
import type { QualityPreset } from '../../../app/Scenario';
import type { BoatKind } from '../../../sim/world/protocol';
import {
  detailEnabledFor,
  detailFiles,
  detailSetsFor,
  pendingDetailSets,
  registerDetailMaps,
  setDetailEnabled,
} from './detail';

// One load at a time: the menu's background preload and a voyage's own can overlap, and a set both
// found pending would be downloaded twice (the second texture replacing the first, which leaks).
let queue: Promise<unknown> = Promise.resolve();

export function preloadBoatDetail(
  kinds: Iterable<BoatKind>,
  quality: QualityPreset | 'custom',
  renderer: WebGPURenderer,
  loading: LoadingManager,
): Promise<void> {
  const wanted = [...kinds];
  const run = queue.then(() => loadBoatDetail(wanted, quality, renderer, loading));
  queue = run.catch(() => undefined);
  return run;
}

async function loadBoatDetail(
  kinds: readonly BoatKind[],
  quality: QualityPreset | 'custom',
  renderer: WebGPURenderer,
  loading: LoadingManager,
): Promise<void> {
  const enabled = detailEnabledFor(quality);
  setDetailEnabled(enabled);
  if (!enabled) return;
  const sets = pendingDetailSets(detailSetsFor(kinds, quality));
  if (sets.length === 0) return;
  try {
    const manifest = await loadAssetManifest();
    const files = detailFiles(manifest, sets);
    const listed = new Set(files.map((file) => file.set));
    for (const set of sets) if (!listed.has(set)) registerDetailMaps(set, null);
    if (files.length === 0) return;
    const { loadDetailTextures } = await import('./loadDetailTextures');
    for (const [set, maps] of await loadDetailTextures(files, renderer, loading))
      registerDetailMaps(set, maps);
  } catch (error) {
    if (error instanceof LoadCancelledError) throw error;
    console.warn('Surface detail textures unavailable; using the procedural look.', error);
  }
}
