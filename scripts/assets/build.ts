// Asset pipeline: optimizes raw sources into public/ and rewrites public/assets-manifest.json
// (path, bytes, SHA-256 and kind of every file under public/{models,textures,ui,audio,data}).
//
// Usage: node scripts/assets/build.ts [source-dir] [--draco] [--no-lods] [--no-ktx2]
//   source-dir defaults to assets-src/ (gitignored; raw downloads are never committed):
//     models/<kind>/model.glb|.gltf (+ align.json, credits.json)  → public/models/<kind>/
//     textures/**/*.png|jpg|webp|tif                             → public/textures/**.ktx2
//       (a set's normal / roughness / AO / metalness maps are packed: see texturePacking.ts)
//     ui/**/*.png|jpg|webp                                        → public/ui/**.webp
//     audio/**/*.wav|flac|aiff|mp3|ogg                            → public/audio/**.webm + .m4a
//       (files under a loops/ folder are seamless loops: see audio.ts and loops.ts)
// With no sources it only re-hashes what's already in public/ (e.g. the star catalogue). To drop
// an asset, delete it from public/ and run this again.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeAudio, findAacEncoder, findFfmpeg } from './audio.ts';
import type { LoopPoints } from './loops.ts';
import { buildManifest, readManifest, scanPublic, serializeManifest } from './manifest.ts';
import { planTextureJobs } from './texturePacking.ts';
import { encodePackedTexture, encodeTexture, encodeUiImage } from './textures.ts';

const BOAT_KINDS = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc', 'hydro'];
const repo = fileURLToPath(new URL('../../', import.meta.url));
const publicDir = join(repo, 'public');
const manifestPath = join(publicDir, 'assets-manifest.json');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const sourceDir = args.find((a) => !a.startsWith('--')) ?? join(repo, 'assets-src');
const options = { draco: flags.has('--draco'), lods: !flags.has('--no-lods'), ktx2: !flags.has('--no-ktx2') };

// The Basis encoder's WASM logs every mip level whatever its debug flag; it binds console.log on
// first use, so filter its lines out from the start.
const log = console.log.bind(console);
const BASIS_NOISE = /^(Total slices|Slice: |Mode: |Encoding slice|basis_compressor)/;
console.log = (...data: unknown[]): void => {
  if (!(typeof data[0] === 'string' && BASIS_NOISE.test(data[0]))) log(...data);
};

// Output path (relative to public/) → bytes of the source it came from, for the size report.
const sources = new Map<string, number>();
// Output path → loop points of seamless audio loops (audio/**/loops/).
const loops = new Map<string, LoopPoints>();
const posix = (path: string): string => path.split(sep).join('/');

function filesUnder(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, pattern));
    else if (pattern.test(name)) out.push(full);
  }
  return out;
}

function write(path: string, data: Uint8Array, sourceBytes?: number): void {
  const full = join(publicDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, data);
  if (sourceBytes !== undefined) sources.set(path, sourceBytes);
  console.log(`  → public/${path}`);
}

const dirBytes = (dir: string): number =>
  filesUnder(dir, /./)
    .filter((file) => !/(align|credits)\.json$/.test(file))
    .reduce((sum, file) => sum + statSync(file).size, 0);

async function optionalSharp(): Promise<typeof import('sharp').default | null> {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

async function models(): Promise<void> {
  const root = join(sourceDir, 'models');
  if (!existsSync(root)) return;
  const { optimizeModel } = await import('./models.ts');
  for (const kind of readdirSync(root).sort()) {
    const dir = join(root, kind);
    if (!statSync(dir).isDirectory()) continue;
    if (!BOAT_KINDS.includes(kind)) {
      console.warn(`models/${kind}: not a boat kind (${BOAT_KINDS.join(', ')}); skipped`);
      continue;
    }
    const source = ['model.glb', 'model.gltf']
      .map((name) => join(dir, name))
      .find((file) => existsSync(file));
    if (!source) {
      console.warn(`models/${kind}: no model.glb or model.gltf; skipped`);
      continue;
    }
    console.log(`models/${kind}/${basename(source)}`);
    const outputs = await optimizeModel(source, options);
    outputs.forEach(({ name, data }, i) =>
      write(`models/${kind}/${name}`, data, i === 0 ? dirBytes(dir) : undefined),
    );
    for (const name of ['align.json', 'credits.json']) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      // Checked to be JSON; the runtime validates align.json field by field.
      const json = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')) as unknown, null, 2);
      write(`models/${kind}/${name}`, new TextEncoder().encode(`${json}\n`), statSync(file).size);
    }
  }
}

async function images(): Promise<void> {
  const textures = filesUnder(join(sourceDir, 'textures'), /\.(png|jpe?g|webp|tiff?)$/i);
  const ui = filesUnder(join(sourceDir, 'ui'), /\.(png|jpe?g|webp)$/i);
  if (textures.length + ui.length === 0) return;
  const sharp = await optionalSharp();
  if (!sharp) {
    console.warn('sharp is not installed: textures and UI images skipped.');
    return;
  }
  const read = (rel: string): Uint8Array => readFileSync(join(sourceDir, rel));
  for (const job of planTextureJobs(textures.map((file) => posix(relative(sourceDir, file))))) {
    const inputs = job.kind === 'single' ? [job.source] : Object.values(job.sources);
    console.log(inputs.join(' + '));
    try {
      const out =
        job.kind === 'single'
          ? await encodeTexture(sharp, read(job.source), basename(job.source), job)
          : await encodePackedTexture(sharp, job, read);
      write(
        job.output,
        out,
        inputs.reduce((sum, rel) => sum + statSync(join(sourceDir, rel)).size, 0),
      );
    } catch (error) {
      console.warn(`  KTX2 encoding failed (${String(error)}); skipped`);
    }
  }
  for (const file of ui) {
    const rel = posix(relative(sourceDir, file));
    console.log(rel);
    write(
      rel.replace(/\.[^.]+$/, '.webp'),
      await encodeUiImage(sharp, readFileSync(file)),
      statSync(file).size,
    );
  }
}

async function audio(): Promise<void> {
  const files = filesUnder(join(sourceDir, 'audio'), /\.(wav|flac|aiff?|mp3|ogg|m4a|opus)$/i);
  if (files.length === 0) return;
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    console.warn('ffmpeg not found (set FFMPEG=/path/to/ffmpeg): audio skipped.');
    return;
  }
  const aac = await findAacEncoder(ffmpeg);
  for (const file of files) {
    const rel = posix(relative(sourceDir, file));
    console.log(rel);
    const base = rel.slice(0, -extname(rel).length);
    mkdirSync(dirname(join(publicDir, base)), { recursive: true });
    const { outputs, loop } = await encodeAudio(ffmpeg, file, join(publicDir, base), rel, aac);
    for (const output of outputs) {
      const path = posix(relative(publicDir, output));
      sources.set(path, statSync(file).size);
      if (loop) loops.set(path, loop);
      console.log(
        `  → public/${path}${loop ? ` (loop ${loop.start.toFixed(3)}–${loop.end.toFixed(3)} s)` : ''}`,
      );
    }
  }
}

if (existsSync(sourceDir)) {
  console.log(`Sources: ${sourceDir}`);
  await models();
  await images();
  await audio();
} else {
  console.log(`No source directory at ${sourceDir}; re-hashing public/ only.`);
}

const previous = readManifest(manifestPath);
const manifest = buildManifest(scanPublic(publicDir), previous, sources, loops);
writeFileSync(manifestPath, serializeManifest(manifest));
console.log(`public/assets-manifest.json: ${Object.keys(manifest.assets).length} assets`);
