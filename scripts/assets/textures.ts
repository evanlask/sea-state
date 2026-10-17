// Standalone images: material textures become KTX2 (Basis Universal, mipmapped, capped at 2048 px),
// UI images and sprites become lossless WebP. The codec per texture comes from its file name:
// normal, ORM / surface / roughness / metalness / AO, height and mask maps are UASTC + Zstandard
// (near-lossless); anything else is treated as colour and gets ETC1S. Texture sets' data maps are
// packed first (see texturePacking.ts).

import {
  cappedSize,
  type ChannelSource,
  MAX_TEXTURE_SIZE,
  type PackChannel,
  packChannels,
  type PackedTextureJob,
} from './texturePacking.ts';

type Sharp = typeof import('sharp').default;

export type TextureCodec = 'uastc' | 'etc1s';

const LINEAR_DATA =
  /(^|[._-])(normal|nrm|nor|orm|arm|surface|rough(ness)?|metal(ness|lic)?|ao|occlusion|height|disp(lacement)?|mask)([._-]|$)/i;

export function textureCodec(fileName: string): TextureCodec {
  return LINEAR_DATA.test(fileName.replace(/\.[^.]+$/, '')) ? 'uastc' : 'etc1s';
}

const isNormalMap = (fileName: string): boolean => /(^|[._-])(normal|nrm|nor)([._-]|$)/i.test(fileName);

export interface EncodeOptions {
  maxSize?: number; // longest side, px
  rdo?: number | null; // UASTC rate-distortion optimisation quality; null/undefined = off
}

export async function encodeTexture(
  sharp: Sharp,
  input: Uint8Array,
  fileName: string,
  options: EncodeOptions = {},
): Promise<Uint8Array> {
  const { encodeToKTX2 } = await import('ktx2-encoder');
  const max = Math.min(MAX_TEXTURE_SIZE, options.maxSize ?? MAX_TEXTURE_SIZE);
  const png = await sharp(input)
    .resize(max, max, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  const imageDecoder = async (buffer: Uint8Array) => {
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  };
  const codec = textureCodec(fileName);
  return encodeToKTX2(new Uint8Array(png), {
    isUASTC: codec === 'uastc',
    needSupercompression: codec === 'uastc',
    isNormalMap: isNormalMap(fileName),
    isPerceptual: codec === 'etc1s',
    isSetKTX2SRGBTransferFunc: codec === 'etc1s',
    qualityLevel: 160,
    compressionLevel: 3,
    generateMipmap: true,
    enableDebug: false,
    ...(codec === 'uastc' && options.rdo ? { enableRDO: true, rdoQualityLevel: options.rdo } : {}),
    imageDecoder,
  });
}

// Packs a set's data maps (read from disk by `read`) into one RGBA image and encodes it.
export async function encodePackedTexture(
  sharp: Sharp,
  job: PackedTextureJob,
  read: (source: string) => Uint8Array,
): Promise<Uint8Array> {
  const roles = Object.keys(job.sources) as PackChannel[];
  const first = await sharp(read(job.sources[roles[0]!]!)).metadata();
  const { width, height } = cappedSize(first.width ?? 1, first.height ?? 1, job.maxSize);
  const maps: Partial<Record<PackChannel, ChannelSource>> = {};
  for (const role of roles) {
    const { data, info } = await sharp(read(job.sources[role]!))
      .resize(width, height, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    maps[role] = { data: new Uint8Array(data), channels: info.channels };
  }
  const rgba = packChannels(job.layout, width * height, maps);
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
  return encodeTexture(sharp, new Uint8Array(png), `${job.layout}.png`, {
    maxSize: job.maxSize,
    rdo: job.rdo,
  });
}

export async function encodeUiImage(sharp: Sharp, input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await sharp(input).webp({ lossless: true, effort: 6 }).toBuffer());
}
