// Boat visual factory: a drop-in GLB model when one has been loaded (glb/boatModels.ts), else the
// procedural model, else (while its builder loads) a box placeholder. Templates are built once per
// kind and load and shared by every visual of it (geometry, materials, AO volume). They are rebuilt
// when the surface-detail textures they use change (detail/detail.ts) or, for the jet ski, when its
// skinned rider loads (rider/).

import { BoxGeometry, Group, type Material, Mesh, MeshStandardNodeMaterial } from 'three/webgpu';

import { BOAT_LENGTH } from '../../app/Scenario';
import type { BoatKind } from '../../sim/world/protocol';
import { detailKey } from './detail/detail';
import { bakeAoVolumeAsync } from './kit/aoBaker';
import { aoBakeInput, assemble, assembleWithAo, type ModelDraft } from './kit/assemble';
import { BoatVisual, type BoatTemplate } from './kit/BoatVisual';
import { collectTextures } from './kit/textures';
import { DEFAULT_POT_COUNT } from './models/crabLoad';
import { riderKey, SHARED_GEOMETRY } from './rider/asset';

// What a boat is carrying, from its telemetry (sim/world/telemetry.ts: crabPots, ballast).
export interface BoatVariant {
  crabPots?: number;
  ballast?: boolean;
}

export function variantFromTelemetry(kind: BoatKind, t: Readonly<Record<string, number>>): BoatVariant {
  if (kind === 'crab') return { crabPots: Math.round(t['crabPots'] ?? DEFAULT_POT_COUNT) };
  if (kind === 'cargo') return { ballast: (t['ballast'] ?? 0) > 0.5 };
  return {};
}

const variantKey = (kind: BoatKind, v: BoatVariant): string =>
  kind === 'crab'
    ? `crab:${v.crabPots ?? DEFAULT_POT_COUNT}`
    : kind === 'cargo' && v.ballast
      ? 'cargo:ballast'
      : kind;

type DraftOf = (v: BoatVariant) => ModelDraft;

// Procedural models are built per load (a crab boat's pot stack, the container ship's tiers). Each
// model's builder is a chunk of its own, fetched the first time a template of it is loaded.
const DRAFT_MODULES: Partial<Record<BoatKind, () => Promise<DraftOf>>> = {
  cargo: async () => {
    const { cargoDraft } = await import('./models/cargo');
    return (v) => cargoDraft(v.ballast ?? false);
  },
  cruise: async () => {
    const { cruiseDraft } = await import('./models/cruise');
    return () => cruiseDraft();
  },
  crab: async () => {
    const { crabDraft } = await import('./models/crab');
    return (v) => crabDraft(v.crabPots ?? DEFAULT_POT_COUNT);
  },
  sail: async () => (await import('./models/sail')).sailDraft,
  powerboat: async () => (await import('./models/powerboat')).powerboatDraft,
  pwc: async () => (await import('./models/pwc')).pwcDraft,
  hydro: async () => (await import('./models/hydro')).hydroDraft,
};
const drafts = new Map<BoatKind, DraftOf>(); // builders loaded so far
const draftLoads = new Map<BoatKind, Promise<DraftOf | null>>();

function loadDraft(kind: BoatKind): Promise<DraftOf | null> {
  const loaded = drafts.get(kind);
  if (loaded) return Promise.resolve(loaded);
  let promise = draftLoads.get(kind);
  if (!promise) {
    const load = DRAFT_MODULES[kind];
    promise = load
      ? load().then(
          (draftOf) => {
            drafts.set(kind, draftOf);
            return draftOf;
          },
          (error: unknown) => {
            // A failed chunk fetch mustn't be remembered: the next call tries again.
            draftLoads.delete(kind);
            throw error;
          },
        )
      : Promise.resolve(null);
    draftLoads.set(kind, promise);
  }
  return promise;
}

// The draft for a variant, with the textures it painted (freed with the template).
function buildDraft(draftOf: DraftOf, variant: BoatVariant): ModelDraft {
  const { result, textures } = collectTextures(() => draftOf(variant));
  result.textures = textures;
  return result;
}

// Fetches the procedural model builders up front (dev labs that build visuals synchronously).
export async function loadBoatDrafts(
  kinds: Iterable<BoatKind> = Object.keys(DRAFT_MODULES) as BoatKind[],
): Promise<void> {
  await Promise.all([...kinds].map(loadDraft));
}

// What a procedural template was built with: the detail-texture sets, and the jet ski's rider.
const buildKey = (kind: BoatKind): string =>
  kind === 'pwc' ? `${detailKey(kind)}|${riderKey()}` : detailKey(kind);

// Per kind and load (variantKey), with the build key (detail sets, rider) each was built for.
const templates = new Map<string, { template: BoatTemplate; detail: string }>();
const loading = new Map<string, Promise<BoatTemplate | null>>();
const modelTemplates = new Map<BoatKind, BoatTemplate>();

// A loaded drop-in model replaces the procedural template for visuals created from now on.
export function setModelTemplate(kind: BoatKind, template: BoatTemplate | null): void {
  if (template) modelTemplates.set(kind, template);
  else modelTemplates.delete(kind);
}

export const hasProceduralModel = (kind: BoatKind): boolean => kind in DRAFT_MODULES;

// Drop-in models have one look; procedural ones are built once per load and detail set.
export function boatTemplate(kind: BoatKind, variant: BoatVariant = {}): BoatTemplate | null {
  const model = modelTemplates.get(kind);
  if (model) return model;
  const key = variantKey(kind, variant);
  const detail = buildKey(kind);
  const cached = templates.get(key);
  if (cached?.detail === detail) return cached.template;
  // Synchronous, so only with the builder already loaded (loadBoatTemplate loads it).
  const draftOf = drafts.get(kind);
  if (!draftOf) return null;
  // Called between sessions (the old scene is gone), so nothing still draws the old template.
  if (cached) disposeTemplate(cached.template);
  const template = assemble(buildDraft(draftOf, variant));
  templates.set(key, { template, detail });
  return template;
}

function disposeTemplate(template: BoatTemplate): void {
  const materials = new Set<Material>();
  for (const lod of template.lods)
    lod.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      // The skinned rider's geometry belongs to the loaded character, which outlives templates.
      if (!object.userData[SHARED_GEOMETRY]) object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        materials.add(material as Material);
    });
  for (const material of materials) material.dispose();
  for (const texture of template.textures ?? []) texture.dispose();
  template.waterMask.dispose();
}

export const hasBoatTemplate = (kind: BoatKind, variant: BoatVariant = {}): boolean =>
  modelTemplates.has(kind) || templates.get(variantKey(kind, variant))?.detail === buildKey(kind);

// Builds (once) the procedural template off the critical path: the model's geometry on this thread
// in its own task, the AO bake (most of the time) in a worker. Loading screens and the menu's idle
// preloading await this so the first frame with the boat doesn't build it inline.
export function loadBoatTemplate(kind: BoatKind, variant: BoatVariant = {}): Promise<BoatTemplate | null> {
  if (hasBoatTemplate(kind, variant)) return Promise.resolve(boatTemplate(kind, variant));
  if (!hasProceduralModel(kind)) return Promise.resolve(null);
  const key = variantKey(kind, variant);
  let promise = loading.get(key);
  if (!promise) {
    promise = (async () => {
      const draftOf = await loadDraft(kind);
      if (!draftOf) return null;
      await nextTask();
      const detail = buildKey(kind);
      const draft = buildDraft(draftOf, variant);
      const ao = await bakeAoVolumeAsync(aoBakeInput(draft));
      await nextTask();
      // A synchronous build may have won the race (boatTemplate() from a frame), or the detail set
      // changed meanwhile (then boatTemplate() rebuilds it).
      if (hasBoatTemplate(kind, variant) || buildKey(kind) !== detail) return boatTemplate(kind, variant);
      const old = templates.get(key);
      if (old) disposeTemplate(old.template);
      const template = assembleWithAo(draft, ao);
      templates.set(key, { template, detail });
      return template;
    })().finally(() => loading.delete(key));
    loading.set(key, promise);
  }
  return promise;
}

// Every model these boats need, before the first frame; reports kinds done of total.
export async function prepareBoatModels(
  boats: Iterable<{ kind: BoatKind; variant?: BoatVariant }>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const unique = [...new Map([...boats].map((b) => [variantKey(b.kind, b.variant ?? {}), b])).values()];
  let done = 0;
  await Promise.all(
    unique.map(async ({ kind, variant }) => {
      await loadBoatTemplate(kind, variant);
      onProgress?.(++done, unique.length);
    }),
  );
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The visual for a boat kind; `root` is positioned from BoatSnapshot (body origin) each frame.
export function createBoatVisual(kind: BoatKind, variant: BoatVariant = {}): BoatVisual | Group {
  const template = boatTemplate(kind, variant);
  if (template) return new BoatVisual(template);
  return createBoatBox(kind);
}

function createBoatBox(kind: BoatKind): Group {
  const length = BOAT_LENGTH[kind];
  const mesh = new Mesh(
    new BoxGeometry(length * 0.16, length * 0.08, length),
    new MeshStandardNodeMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
  );
  mesh.geometry.translate(0, length * 0.04, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new Group();
  group.add(mesh);
  return group;
}
