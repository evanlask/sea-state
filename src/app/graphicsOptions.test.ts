import { describe, expect, it } from 'vite-plus/test';

import { DEFAULT_OCEAN_MESH, oceanMeshFor, selectNodes } from '../render/ocean/OceanMesh';
import { fxBudgetFor, FX_BUDGETS } from '../render/particles/budgets';
import { applyPreset, PRESET_ORDER, QUALITY_PRESET_VALUES } from '../settings/presets';
import { defaultSettings, type GraphicsSettings } from '../settings/schema';
import { nearestPreset, sceneGraphicsFor } from './graphicsOptions';

const graphicsFor = (preset: GraphicsSettings['preset']): GraphicsSettings =>
  applyPreset(defaultSettings(), preset).graphics;

describe('sceneGraphicsFor', () => {
  it('builds each preset from its table values', () => {
    for (const preset of PRESET_ORDER) {
      const scene = sceneGraphicsFor(graphicsFor(preset));
      const table = QUALITY_PRESET_VALUES[preset];
      expect(scene.quality).toBe(preset);
      expect(scene.clipmapRings).toBe(table.clipmapRings);
      expect(scene.particleBudget).toBe(table.particleBudget);
      expect(scene.sailCloth).toEqual([table.sailCloth.cols, table.sailCloth.rows]);
      expect(scene.shadows).toEqual(table.shadows);
      expect(scene.clouds).toBeUndefined();
    }
  });

  it('builds Custom from its own fields, not High', () => {
    const graphics: GraphicsSettings = {
      ...graphicsFor('low'),
      preset: 'custom',
      clipmapRings: 12,
      particleBudget: 300_000,
      sailCloth: { cols: 30, rows: 40 },
      shadows: { mapSize: 512, cascades: 1 },
    };
    const scene = sceneGraphicsFor(graphics);
    expect(scene.quality).toBe('low'); // most fields still Low's
    expect(scene.clipmapRings).toBe(12);
    expect(scene.particleBudget).toBe(300_000);
    expect(scene.sailCloth).toEqual([30, 40]);
    expect(scene.shadows).toEqual({ mapSize: 512, cascades: 1 });
    expect(scene.clouds).toEqual(graphics.clouds);
  });

  it('picks the nearest tier for Custom', () => {
    expect(nearestPreset({ ...graphicsFor('ultra'), preset: 'custom', fov: 70 })).toBe('ultra');
    expect(nearestPreset({ ...graphicsFor('medium'), preset: 'custom', clipmapRings: 11 })).toBe('medium');
  });
});

describe('preset plumbing', () => {
  it('particle budgets: presets keep the effect table, Custom resizes the pool', () => {
    for (const preset of PRESET_ORDER) {
      expect(fxBudgetFor(preset, QUALITY_PRESET_VALUES[preset].particleBudget)).toEqual(FX_BUDGETS[preset]);
    }
    const big = fxBudgetFor('high', 2 * FX_BUDGETS.high.particles);
    expect(big.particles).toBe(2 * FX_BUDGETS.high.particles);
    expect(big.emitPerFrame).toBe(2 * FX_BUDGETS.high.emitPerFrame);
    expect(big.rainDrops).toBe(FX_BUDGETS.high.rainDrops);
    expect(fxBudgetFor('low', 10).particles).toBe(1024);
  });

  it('clipmap rings: one level per ring, the same far reach, coarser near field', () => {
    const reach = (rings: number): number => {
      const o = oceanMeshFor(rings);
      return o.baseNodeSize * 2 ** (o.levels - 1);
    };
    const original = DEFAULT_OCEAN_MESH.baseNodeSize * 2 ** (DEFAULT_OCEAN_MESH.levels - 1);
    for (const rings of [6, 8, 9, 10, 11]) {
      expect(oceanMeshFor(rings).levels).toBe(rings);
      expect(reach(rings)).toBe(original);
    }
    expect(oceanMeshFor(11)).toEqual(DEFAULT_OCEAN_MESH);
    expect(oceanMeshFor(9).baseNodeSize).toBe(32);
    // Fewer rings draw fewer nodes from the same camera.
    const count = (rings: number): number => selectNodes(0, 3, 0, oceanMeshFor(rings)).length;
    expect(count(6)).toBeLessThan(count(9));
    expect(count(9)).toBeLessThan(count(11));
  });
});
