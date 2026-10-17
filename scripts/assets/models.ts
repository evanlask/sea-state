// Model optimization for the drop-in boat slot (gltf-transform): clean-up (dedup, instance, prune,
// weld), textures capped at 2048 px and turned into KTX2 (UASTC + Zstandard for normal / ORM maps,
// ETC1S for colour), simplified LODs for distant boats, and lossless Meshopt compression — or
// quantized Draco when asked for and clearly smaller.

import { type Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  draco,
  instance,
  prune,
  reorder,
  simplify,
  textureCompress,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

export interface ModelOptions {
  draco: boolean; // try quantized Draco and keep it when it saves enough
  lods: boolean;
  ktx2: boolean;
}

export interface ModelOutput {
  name: string; // model.glb, model.lod1.glb…
  data: Uint8Array;
}

// LOD1 and LOD2: share of triangles kept, the error the simplifier may accept (of the mesh extent),
// and a smaller texture cap, since each LOD file carries its own copy of the textures.
const LOD_LEVELS = [
  { ratio: 0.3, error: 0.004, maxTexture: 512 },
  { ratio: 0.08, error: 0.02, maxTexture: 256 },
] as const;

// Draco has to beat lossless Meshopt by this much to be worth its quantization and decode cost.
const DRACO_MIN_GAIN = 0.15;

const MAX_TEXTURE = 2048;

type Sharp = typeof import('sharp').default;

async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  try {
    const draco3d = (await import('draco3dgltf')).default;
    io.registerDependencies({
      'draco3d.decoder': await draco3d.createDecoderModule(),
      'draco3d.encoder': await draco3d.createEncoderModule(),
    });
  } catch {
    // Without draco3dgltf, Draco-compressed sources can't be read and --draco is skipped.
  }
  return io;
}

let ioPromise: Promise<NodeIO> | null = null;

// One reader/writer (with the Meshopt and, when installed, Draco codecs) for every model of a run.
export function modelIO(): Promise<NodeIO> {
  ioPromise ??= createIO();
  return ioPromise;
}

async function optionalSharp(): Promise<Sharp | null> {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

async function compressTextures(
  document: Document,
  sharp: Sharp | null,
  ktx2: boolean,
  maxSize: number,
): Promise<void> {
  if (document.getRoot().listTextures().length === 0) return;
  if (!sharp) {
    console.warn('  sharp is not installed: textures are left as they are.');
    return;
  }
  await document.transform(textureCompress({ encoder: sharp, resize: [maxSize, maxSize] }));
  if (ktx2) await ktx2Textures(document, sharp);
}

// Every texture to KTX2: normal / occlusion / metal-rough maps as UASTC + Zstandard (`rdo` turns on
// rate-distortion optimisation at that quality for smaller files), colour as ETC1S.
export async function ktx2Textures(
  document: Document,
  sharp: Sharp,
  rdo: number | null = null,
): Promise<void> {
  let ktx2Transform: typeof import('ktx2-encoder/gltf-transform').ktx2;
  try {
    ktx2Transform = (await import('ktx2-encoder/gltf-transform')).ktx2;
  } catch {
    console.warn('  ktx2-encoder is not installed: textures stay PNG/JPEG.');
    return;
  }
  const imageDecoder = async (buffer: Uint8Array) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  await document.transform(
    ktx2Transform({
      slots: /^(normalTexture|occlusionTexture|metallicRoughnessTexture)$/,
      isUASTC: true,
      needSupercompression: true,
      isPerceptual: false,
      isNormalMap: false,
      generateMipmap: true,
      enableDebug: false,
      ...(rdo ? { enableRDO: true, rdoQualityLevel: rdo } : {}),
      imageDecoder,
    }),
    ktx2Transform({
      slots: /^(baseColorTexture|emissiveTexture)$/,
      isUASTC: false,
      isPerceptual: true,
      isSetKTX2SRGBTransferFunc: true,
      qualityLevel: 160,
      compressionLevel: 3,
      generateMipmap: true,
      enableDebug: false,
      imageDecoder,
    }),
  );
}

// Lossless: reorder for compressibility, then Meshopt's byte codec with no quantization or filters.
async function meshoptLossless(document: Document): Promise<void> {
  await document.transform(reorder({ encoder: MeshoptEncoder, target: 'size' }));
  document
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
}

export async function encode(
  io: NodeIO,
  document: Document,
  options: ModelOptions,
  label: string,
): Promise<Uint8Array> {
  const meshopt = cloneDocument(document);
  await meshoptLossless(meshopt);
  const lossless = await io.writeBinary(meshopt);
  if (!options.draco) return lossless;
  try {
    const compressed = cloneDocument(document);
    await compressed.transform(draco());
    const quantized = await io.writeBinary(compressed);
    const gain = 1 - quantized.byteLength / lossless.byteLength;
    const verdict = gain >= DRACO_MIN_GAIN ? 'keeping Draco' : 'keeping Meshopt';
    console.log(`  ${label}: Draco ${(gain * 100).toFixed(1)}% smaller than lossless Meshopt — ${verdict}`);
    return gain >= DRACO_MIN_GAIN ? quantized : lossless;
  } catch (error) {
    console.warn(`  ${label}: Draco unavailable (${String(error)}); keeping Meshopt.`);
    return lossless;
  }
}

export async function optimizeModel(source: string, options: ModelOptions): Promise<ModelOutput[]> {
  const io = await modelIO();
  const document = await io.read(source);
  await document.transform(dedup(), instance({ min: 2 }), prune({ keepLeaves: true }), weld());
  const sharp = await optionalSharp();
  const levels = [{ name: 'model.glb', document, maxTexture: MAX_TEXTURE }];
  if (options.lods)
    for (const [i, level] of LOD_LEVELS.entries()) {
      const lod = cloneDocument(document);
      await lod.transform(
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio: level.ratio, error: level.error }),
        prune({ keepLeaves: true }),
      );
      levels.push({ name: `model.lod${i + 1}.glb`, document: lod, maxTexture: level.maxTexture });
    }
  const outputs: ModelOutput[] = [];
  for (const [i, level] of levels.entries()) {
    await compressTextures(level.document, sharp, options.ktx2, level.maxTexture);
    outputs.push({ name: level.name, data: await encode(io, level.document, options, `LOD${i}`) });
  }
  return outputs;
}
