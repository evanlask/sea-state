import { DataTexture, RGBAFormat, type WebGPURenderer } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { LoadingManager } from '../../../app/loading/LoadingManager';
import type { DetailMaps } from './detail';
import { resetDetailState } from './detail';
import { preloadBoatDetail } from './preload';

const mocks = vi.hoisted(() => ({
  release: null as (() => void) | null,
  loads: [] as string[][],
}));

vi.mock('../../../app/loading/manifest', async (original) => {
  const real = await original<typeof import('../../../app/loading/manifest')>();
  return {
    ...real,
    loadAssetManifest: async () => ({
      version: 1,
      assets: Object.fromEntries(
        ['painted-metal', 'gelcoat'].map((set) => [
          `textures/${set}/surface.ktx2`,
          { bytes: 1, sha256: 'a'.repeat(64), kind: 'texture' },
        ]),
      ),
    }),
  };
});

vi.mock('./loadDetailTextures', () => ({
  loadDetailTextures: async (files: { set: string; map: string }[]) => {
    mocks.loads.push(files.map((file) => file.set));
    await new Promise<void>((resolve) => (mocks.release = resolve));
    const texture = new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);
    return new Map<string, DetailMaps>(files.map((file) => [file.set, { surface: texture, color: null }]));
  },
}));

afterEach(() => resetDetailState());

describe('preloading surface detail', () => {
  it('downloads a set once when two preloads overlap', async () => {
    const renderer = {} as WebGPURenderer;
    const first = preloadBoatDetail(['hydro'], 'high', renderer, new LoadingManager());
    const second = preloadBoatDetail(['hydro'], 'high', renderer, new LoadingManager());
    await vi.waitFor(() => expect(mocks.release).not.toBeNull());
    mocks.release!();
    await Promise.all([first, second]);
    expect(mocks.loads).toEqual([['gelcoat']]);
  });
});
