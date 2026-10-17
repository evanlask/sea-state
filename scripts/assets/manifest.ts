// Asset manifest building for `npm run assets`: hashes every managed file under public/ and
// writes public/assets-manifest.json (see src/app/loading/manifest.ts for the runtime side).
// The pure parts (kinds, entry building, merging) are unit-tested; scanning touches the disk.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import type { AssetEntry, AssetKind, AssetManifest } from '../../src/app/loading/manifest.ts';

// Top-level directories of public/ the pipeline owns. favicon.svg and the like are left alone.
const MANAGED_DIRS = ['models', 'textures', 'ui', 'audio', 'data'] as const;

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

// Kind of a public/-relative path, or null for files the manifest leaves out (licence text, notes).
export function kindForPath(path: string): AssetKind | null {
  const [root, ...rest] = path.split('/');
  const name = rest.at(-1) ?? '';
  if (/\.(txt|md)$/i.test(name) || name.startsWith('.')) return null;
  switch (root) {
    case 'models':
      if (/\.(glb|gltf)$/i.test(name)) return 'model';
      if (name === 'align.json') return 'align';
      if (name === 'credits.json') return 'credits';
      return /\.(ktx2|webp|png|jpe?g|bin)$/i.test(name) ? 'texture' : null;
    case 'textures':
      return 'texture';
    case 'ui':
      return 'image';
    case 'audio':
      return 'audio';
    case 'data':
      return 'data';
    default:
      return null;
  }
}

export interface FileRecord {
  path: string; // relative to public/, forward slashes
  data: Uint8Array;
}

// Builds the manifest from the files on disk. `sources` gives this run's source sizes by output
// path and `loops` its audio loop points; other files keep what the previous manifest recorded
// for the same content.
export function buildManifest(
  files: readonly FileRecord[],
  previous: AssetManifest | null,
  sources: ReadonlyMap<string, number> = new Map(),
  loops: ReadonlyMap<string, NonNullable<AssetEntry['loop']>> = new Map(),
): AssetManifest {
  const assets: Record<string, AssetEntry> = {};
  for (const { path, data } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const kind = kindForPath(path);
    if (!kind) continue;
    const hash = sha256(data);
    const entry: AssetEntry = { bytes: data.byteLength, sha256: hash, kind };
    const old = previous?.assets[path];
    const same = old?.sha256 === hash;
    const sourceBytes = sources.get(path) ?? (same ? old.sourceBytes : undefined);
    if (sourceBytes !== undefined) entry.sourceBytes = sourceBytes;
    const loop = loops.get(path) ?? (same ? old.loop : undefined);
    if (loop) entry.loop = { start: loop.start, end: loop.end };
    assets[path] = entry;
  }
  return { version: 1, assets };
}

export function scanPublic(publicDir: string): FileRecord[] {
  const out: FileRecord[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(publicDir, full).split(sep).join('/'), data: readFileSync(full) });
    }
  };
  for (const dir of MANAGED_DIRS) if (existsSync(join(publicDir, dir))) walk(join(publicDir, dir));
  return out;
}

export function readManifest(path: string): AssetManifest | null {
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, 'utf8')) as AssetManifest;
    return json.version === 1 && typeof json.assets === 'object' ? json : null;
  } catch {
    return null;
  }
}

export const serializeManifest = (manifest: AssetManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;
