// The asset manifest (public/assets-manifest.json, written by `npm run assets`): every optimized
// file under public/ with its size, SHA-256 and kind. The loading screen takes download sizes from
// it, URLs carry the hash for cache-busting, and optional assets (drop-in boat models) are only
// fetched when listed, so a build without them makes no requests that would 404.

export type AssetKind = 'model' | 'align' | 'credits' | 'texture' | 'image' | 'audio' | 'data';

export interface AssetEntry {
  bytes: number;
  sha256: string; // hex
  kind: AssetKind;
  sourceBytes?: number; // size of the raw source it was built from, for `npm run assets:report`
  // Seamless audio loops: loop between these times (seconds); the file pads the loop on both sides.
  loop?: { start: number; end: number };
}

export interface AssetManifest {
  version: 1;
  // Keyed by path relative to public/, with forward slashes.
  assets: Record<string, AssetEntry>;
}

export const EMPTY_MANIFEST: AssetManifest = { version: 1, assets: {} };

function isAssetManifest(value: unknown): value is AssetManifest {
  if (typeof value !== 'object' || value === null) return false;
  const { version, assets } = value as Partial<AssetManifest>;
  return version === 1 && typeof assets === 'object' && assets !== null;
}

export function assetEntry(manifest: AssetManifest, path: string): AssetEntry | null {
  return Object.hasOwn(manifest.assets, path) ? manifest.assets[path]! : null;
}

// `base` is import.meta.env.BASE_URL; the hash query lets the HTTP cache keep a file until it changes.
export function assetUrl(base: string, path: string, entry: AssetEntry | null): string {
  const url = `${base}${path}`;
  return entry ? `${url}?v=${entry.sha256.slice(0, 12)}` : url;
}

let pending: Promise<AssetManifest> | null = null;

// Fetched once per page; an unreachable or malformed manifest reads as empty (nothing optional loads).
export function loadAssetManifest(base: string = import.meta.env.BASE_URL): Promise<AssetManifest> {
  pending ??= fetch(`${base}assets-manifest.json`, { cache: 'no-cache' })
    .then((response) => (response.ok ? response.json() : null))
    .then((json: unknown) => (isAssetManifest(json) ? json : EMPTY_MANIFEST))
    .catch((error: unknown) => {
      console.warn('Asset manifest unavailable; optional assets are skipped.', error);
      return EMPTY_MANIFEST;
    });
  return pending;
}
