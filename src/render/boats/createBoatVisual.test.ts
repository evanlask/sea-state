// Template lifetimes: a template that is rebuilt (other detail textures) frees the textures it
// painted, and a builder chunk that fails to load is fetched again on the next call.

import { DataTexture, RGBAFormat } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { boatTemplate, loadBoatDrafts } from './createBoatVisual';
import { registerDetailMaps, resetDetailState, setDetailEnabled } from './detail/detail';

const chunk = vi.hoisted(() => ({ loads: 0 }));

// Reading the export is what fails, as a chunk that can't be fetched fails the import.
vi.mock('./models/cargo', () => ({
  get cargoDraft() {
    chunk.loads++;
    if (chunk.loads === 1) throw new Error('chunk failed');
    return () => ({});
  },
}));

// The hydroplane paints its livery on canvases: a do-nothing 2D context is enough here.
function stubDocument(): void {
  if (typeof globalThis.document !== 'undefined') return;
  const ctx: unknown = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'measureText') return () => ({ width: 10 });
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern')
          return () => ({ addColorStop: () => undefined });
        return () => undefined;
      },
      set: () => true,
    },
  );
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}

afterEach(() => resetDetailState());

describe('boat templates', () => {
  it('frees the textures of a template it replaces', async () => {
    stubDocument();
    await loadBoatDrafts(['hydro']);
    const first = boatTemplate('hydro')!;
    // The livery's side and top, and the AO volume.
    expect(first.textures!.length).toBeGreaterThanOrEqual(3);
    const disposed = first.textures!.map((texture) => vi.spyOn(texture, 'dispose'));
    setDetailEnabled(true);
    registerDetailMaps('gelcoat', {
      surface: new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat),
      color: null,
    });
    const second = boatTemplate('hydro')!;
    expect(second).not.toBe(first);
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
    expect(second.textures!.some((texture) => first.textures!.includes(texture))).toBe(false);
  });

  it('fetches a builder chunk again after it failed to load', async () => {
    await expect(loadBoatDrafts(['cargo'])).rejects.toThrow('chunk failed');
    await expect(loadBoatDrafts(['cargo'])).resolves.toBeUndefined();
  });
});
