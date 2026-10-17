// Drop-in boat models: before a session builds its boats, loads any model the asset manifest
// lists for the kinds on the water and registers it in place of the procedural template. Nothing
// is fetched for kinds without a listed model. A failed load keeps the procedural model and raises
// a short HUD notice.

import type { WebGPURenderer } from 'three/webgpu';

import type { LoadingManager } from '../../../app/loading/LoadingManager';
import { loadAssetManifest } from '../../../app/loading/manifest';
import type { BoatKind } from '../../../sim/world/protocol';
import type { HudAlert } from '../../../ui/hud/model';
import { setModelTemplate } from '../createBoatVisual';
import { boatModelFiles, MODEL_LABELS } from './files';

const NOTICE_SECONDS = 10;

const settled = new Set<BoatKind>(); // loaded, or failed and left procedural for this page
const notices: { kind: BoatKind; shownAt: number | null }[] = [];

export async function preloadBoatModels(
  kinds: Iterable<BoatKind>,
  renderer: WebGPURenderer,
  loading: LoadingManager,
): Promise<void> {
  const wanted = [...new Set(kinds)].filter((kind) => !settled.has(kind));
  if (wanted.length === 0) return;
  const manifest = await loadAssetManifest();
  const listed = wanted.flatMap((kind) => {
    const files = boatModelFiles(manifest, kind);
    return files ? [{ kind, files }] : [];
  });
  if (listed.length === 0) return;
  const { loadBoatTemplate } = await import('./loadBoatTemplate');
  await Promise.all(
    listed.map(async ({ kind, files }) => {
      settled.add(kind);
      try {
        setModelTemplate(kind, await loadBoatTemplate(kind, files, renderer, loading));
      } catch (error) {
        console.warn(`Drop-in ${kind} model failed to load; using the procedural model.`, error);
        notices.push({ kind, shownAt: null });
      }
    }),
  );
}

// HUD alerts for failed models, each shown for a few seconds from when the HUD first asks.
export function boatModelNotices(now = performance.now() / 1000): HudAlert[] {
  const out: HudAlert[] = [];
  for (const notice of notices) {
    notice.shownAt ??= now;
    if (now - notice.shownAt < NOTICE_SECONDS)
      out.push({
        id: `model-fallback:${notice.kind}`,
        severity: 'info',
        text: `Couldn't load the ${MODEL_LABELS[notice.kind]} model`,
        detail: 'Showing the simpler built-in one',
      });
  }
  return out;
}
