// Downloads and transcodes the detail textures (KTX2, Basis transcoder from libs/basis/). Imported
// on demand by preloadBoatDetail (and the jet ski rider's loader, which shares its KTX2 loader), so
// KTX2Loader stays out of the main bundle until it is needed.

import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  type CompressedTexture,
  NoColorSpace,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';

import type { LoadingManager } from '../../../app/loading/LoadingManager';
import { assetUrl } from '../../../app/loading/manifest';
import type { DetailFile, DetailMaps } from './detail';
import { DETAIL_SET_INFO, type DetailSetId } from './sets';

function parse(loader: KTX2Loader, buffer: ArrayBuffer): Promise<CompressedTexture> {
  return new Promise((resolve, reject) => {
    loader.parse(buffer, (texture) => resolve(texture as CompressedTexture), reject);
  });
}

function prepare(texture: Texture, file: DetailFile): Texture {
  texture.name = `detail:${file.set}:${file.map}`;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  // Colour is sRGB; the packed normal/roughness/AO map is linear data.
  texture.colorSpace = file.map === 'color' ? SRGBColorSpace : NoColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// Loads each set's files; a set whose surface map fails is reported as null (procedural fallback),
// a failed colour map just leaves that set without colour.
export async function loadDetailTextures(
  files: readonly DetailFile[],
  renderer: WebGPURenderer,
  loading: LoadingManager,
  base: string = import.meta.env.BASE_URL,
): Promise<Map<DetailSetId, DetailMaps | null>> {
  const buffers = await Promise.all(
    files.map((file) =>
      loading
        .download(
          {
            id: `detail:${file.path}`,
            label: `Downloading surface detail (${DETAIL_SET_INFO[file.set].description})`,
            kind: 'download',
            bytes: file.entry.bytes,
            url: assetUrl(base, file.path, file.entry),
          },
          { onError: 'throw', retries: 1 },
        )
        .catch((error: unknown) => {
          console.warn(`Detail texture ${file.path} failed to download; using the procedural look.`, error);
          return null;
        }),
    ),
  );
  // One loader (its transcoder workers and wasm) for every load: the menu's background preload and
  // each voyage would otherwise fetch and compile the transcoder again.
  const loader = sharedKtx2(renderer, base);
  const result = new Map<DetailSetId, DetailMaps | null>();
  await loading.run(
    { id: 'detail:decode', label: 'Decoding surface detail', kind: 'decode', weight: 0.3 },
    async () => {
      const textures = await Promise.all(
        files.map(async (file, i) => {
          const buffer = buffers[i];
          if (!buffer) return null;
          try {
            return prepare(await parse(loader, buffer), file);
          } catch (error) {
            console.warn(`Detail texture ${file.path} failed to decode; using the procedural look.`, error);
            return null;
          }
        }),
      );
      files.forEach((file, i) => {
        const texture = textures[i] ?? null;
        const maps = result.get(file.set) ?? null;
        if (file.map === 'surface') {
          result.set(file.set, texture ? { surface: texture, color: maps?.color ?? null } : null);
        } else if (texture) {
          // Colour arrives in file order after its surface map (DETAIL_SET_INFO lists surface first).
          if (maps) maps.color = texture;
          else texture.dispose();
        }
      });
    },
    { onError: 'throw' },
  );
  return result;
}

let ktx2: { loader: KTX2Loader; renderer: unknown } | null = null;

// The one KTX2 loader of the page (also used for the jet ski rider's textures).
export function sharedKtx2(renderer: Parameters<KTX2Loader['detectSupport']>[0], base: string): KTX2Loader {
  if (ktx2?.renderer !== renderer) {
    ktx2?.loader.dispose();
    ktx2 = {
      loader: new KTX2Loader().setTranscoderPath(`${base}libs/basis/`).detectSupport(renderer),
      renderer,
    };
  }
  return ktx2.loader;
}
