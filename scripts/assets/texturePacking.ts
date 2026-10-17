// Texture-set planning for `npm run assets`: which KTX2 files a folder of source maps becomes.
// Pure (no sharp, no disk) so it is unit-tested; build.ts runs the plan.
//
// A texture set is a folder of maps named by role, optionally with a shared prefix
// (`deck-planks/normal.jpg` or `teak_normal.png`). Data maps are packed so a material needs fewer
// samplers and downloads:
//  - a normal map plus any of roughness / AO / metalness → `surface.ktx2`:
//      R, G = normal X, Y (OpenGL convention, +Y up; Z is rebuilt in the shader)
//      B    = roughness (1 when absent)
//      A    = ambient occlusion, or metalness when the set has no AO map (1 when neither)
//  - roughness / AO / metalness without a normal map → `orm.ktx2` (glTF layout):
//      R = AO (1 when absent), G = roughness (1), B = metalness (0)
// Everything else (colour, masks, a lone normal map) is encoded on its own. Per-set options in
// TEXTURE_SET_OPTIONS cap the size and leave out maps the game doesn't use.

export type PackChannel = 'normal' | 'roughness' | 'ao' | 'metalness';
export type PackLayout = 'surface' | 'orm';

interface SingleTextureJob {
  kind: 'single';
  source: string; // path relative to the source dir, forward slashes
  output: string; // path relative to public/
  maxSize: number;
  rdo: number | null; // UASTC rate-distortion quality (smaller zstd files), null = off
}

export interface PackedTextureJob {
  kind: 'pack';
  layout: PackLayout;
  sources: Partial<Record<PackChannel, string>>;
  output: string;
  maxSize: number;
  rdo: number | null;
}

export type TextureJob = SingleTextureJob | PackedTextureJob;

export interface TextureSetOptions {
  maxSize?: number; // longest side, px (default MAX_TEXTURE_SIZE)
  colorSize?: number; // longest side for colour maps, if different
  skip?: readonly string[]; // map roles or file stems to leave out, e.g. ['color']
  rdo?: number | null; // UASTC RDO quality for the data maps (default DEFAULT_RDO, null = off)
}

export const MAX_TEXTURE_SIZE = 2048;
// UASTC rate-distortion optimisation at basisu's default level: smooth maps shrink a lot under
// Zstandard (gelcoat 254 → ~95 KB, sailcloth 199 → ~140 KB), busy ones 2–15%, with no visible loss
// on tiling detail maps.
const DEFAULT_RDO: number | null = 1;

// Options per set folder under textures/ (the ambientCG detail sets, see src/render/boats/detail).
// A 1K packed UASTC map is ~1 MB, a 512 one ~0.3 MB. 512 already gives 0.6 mm/px on diamond plate
// and ~2 mm/px on paint, so only the two most visible sets stay at 1K; colour maps the shaders don't
// read are skipped (painted metal and diamond plate keep the procedural colours).
const TEXTURE_SET_OPTIONS: Readonly<Record<string, TextureSetOptions>> = {
  'painted-metal': { maxSize: 1024, skip: ['color'] },
  'painted-metal-worn': { maxSize: 512, skip: ['color'] },
  'rusty-steel': { maxSize: 512 },
  'deck-planks': { maxSize: 1024 },
  'diamond-plate': { maxSize: 512, skip: ['color'] },
  sailcloth: { maxSize: 512, skip: ['color'] },
  rope: { maxSize: 512, skip: ['metalness'] },
  rubber: { maxSize: 256, skip: ['color'] },
  gelcoat: { maxSize: 512, skip: ['color'] },
};

const ROLES: readonly [PackChannel | 'color', RegExp][] = [
  ['normal', /^(normal|normalgl|nrm|nor)$/i],
  ['roughness', /^rough(ness)?$/i],
  ['ao', /^(ao|occlusion|ambientocclusion)$/i],
  ['metalness', /^metal(ness|lic)?$/i],
  ['color', /^(color|colour|albedo|basecolor|diffuse)$/i],
];

// Splits a file name into its set prefix and role: 'teak_normal.png' → { stem: 'teak_', role: 'normal' }.
export function textureRole(fileName: string): { stem: string; role: PackChannel | 'color' | null } {
  const base = fileName.replace(/\.[^.]+$/, '');
  const match = /^(.*[._-])?([^._-]+)$/.exec(base);
  const stem = match?.[1] ?? '';
  const word = match?.[2] ?? base;
  for (const [role, pattern] of ROLES) if (pattern.test(word)) return { stem, role };
  return { stem: '', role: null };
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const toKtx2 = (path: string): string => path.replace(/\.[^.]+$/, '.ktx2');

// Options for a source folder (path relative to the source dir, e.g. 'textures/rubber').
function setOptions(dir: string): TextureSetOptions {
  const key = dir.replace(/^textures\/?/, '');
  return TEXTURE_SET_OPTIONS[key] ?? {};
}

// Plans the KTX2 outputs for texture sources (paths relative to the source dir, e.g.
// 'textures/rubber/normal.jpg'). Output paths are relative to public/.
export function planTextureJobs(
  sources: readonly string[],
  options: (dir: string) => TextureSetOptions = setOptions,
): TextureJob[] {
  const jobs: TextureJob[] = [];
  const groups = new Map<string, { dir: string; stem: string; maps: Partial<Record<PackChannel, string>> }>();
  for (const source of [...sources].sort()) {
    const dir = dirOf(source);
    const name = nameOf(source);
    const opts = options(dir);
    const { stem, role } = textureRole(name);
    const fileStem = name.replace(/\.[^.]+$/, '');
    if (opts.skip?.some((s) => s === role || s === fileStem)) continue;
    const maxSize = Math.min(MAX_TEXTURE_SIZE, opts.maxSize ?? MAX_TEXTURE_SIZE);
    if (role === null || role === 'color') {
      const size = role === 'color' ? (opts.colorSize ?? maxSize) : maxSize;
      jobs.push({ kind: 'single', source, output: toKtx2(source), maxSize: size, rdo: null });
      continue;
    }
    const key = `${dir}/${stem}`;
    let group = groups.get(key);
    if (!group) {
      group = { dir, stem, maps: {} };
      groups.set(key, group);
    }
    group.maps[role] ??= source;
  }
  for (const { dir, stem, maps } of groups.values()) {
    const opts = options(dir);
    const maxSize = Math.min(MAX_TEXTURE_SIZE, opts.maxSize ?? MAX_TEXTURE_SIZE);
    const rdo = opts.rdo === undefined ? DEFAULT_RDO : opts.rdo;
    const data = (['roughness', 'ao', 'metalness'] as const).filter((role) => maps[role]);
    const prefix = dir ? `${dir}/${stem}` : stem;
    if (data.length === 0) {
      // A lone normal map: encoded as it is.
      jobs.push({ kind: 'single', source: maps.normal!, output: toKtx2(maps.normal!), maxSize, rdo });
    } else if (maps.normal) {
      jobs.push({
        kind: 'pack',
        layout: 'surface',
        sources: maps,
        output: `${prefix}surface.ktx2`,
        maxSize,
        rdo,
      });
    } else {
      jobs.push({ kind: 'pack', layout: 'orm', sources: maps, output: `${prefix}orm.ktx2`, maxSize, rdo });
    }
  }
  return jobs.sort((a, b) => (a.output < b.output ? -1 : a.output > b.output ? 1 : 0));
}

// One channel of a decoded map: `data` holds `channels` interleaved bytes per pixel; the first is used.
export interface ChannelSource {
  data: Uint8Array;
  channels: number;
}

const pick = (src: ChannelSource | undefined, i: number, offset = 0, fallback = 255): number =>
  src ? src.data[i * src.channels + Math.min(offset, src.channels - 1)]! : fallback;

// Interleaves the maps of a set (all already resized to width × height) into RGBA for the layout.
export function packChannels(
  layout: PackLayout,
  pixels: number,
  maps: Partial<Record<PackChannel, ChannelSource>>,
): Uint8Array {
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (layout === 'surface') {
      out[o] = pick(maps.normal, i, 0, 128);
      out[o + 1] = pick(maps.normal, i, 1, 128);
      out[o + 2] = pick(maps.roughness, i);
      out[o + 3] = maps.ao ? pick(maps.ao, i) : pick(maps.metalness, i);
    } else {
      out[o] = pick(maps.ao, i);
      out[o + 1] = pick(maps.roughness, i);
      out[o + 2] = pick(maps.metalness, i, 0, 0);
      out[o + 3] = 255;
    }
  }
  return out;
}

// Output size for a source of width × height capped at maxSize on the longer side.
export function cappedSize(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSize / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
