import { afterEach, describe, expect, it } from 'vite-plus/test';

import credits from '../../../../CREDITS.md?raw';
import publicManifest from '../../../../public/assets-manifest.json';
import type { AssetManifest } from '../../../app/loading/manifest';
import { BOAT_KINDS } from '../../../sim/world/protocol';
import {
  boatDetail,
  detailEnabledFor,
  detailFiles,
  detailKey,
  type DetailMaps,
  detailSetsFor,
  type DetailTexture,
  pendingDetailSets,
  registerDetailMaps,
  resetDetailState,
  resolveRecipe,
  setDetailEnabled,
} from './detail';
import { DETAIL_SET_INFO, DETAIL_SETS, detailMapPath, type DetailSetId } from './sets';
import { BOAT_DETAIL, type DetailLayer, fadeRange, featureSize, tileScale } from './tuning';

const tex = (): DetailTexture => ({ isTexture: true });
const maps = (color = true): DetailMaps => ({ surface: tex(), color: color ? tex() : null });
const entry = { bytes: 1000, sha256: 'ab'.repeat(32), kind: 'texture' as const };
const manifestWith = (paths: string[]): AssetManifest => ({
  version: 1,
  assets: Object.fromEntries(paths.map((path) => [path, entry])),
});

afterEach(() => resetDetailState());

describe('texture selection per boat and quality', () => {
  it('skips detail on Low and uses it from Medium up', () => {
    expect(detailEnabledFor('low')).toBe(false);
    for (const quality of ['medium', 'high', 'ultra', 'custom'] as const)
      expect(detailEnabledFor(quality)).toBe(true);
    expect(detailSetsFor(BOAT_KINDS, 'low')).toEqual([]);
  });

  it('loads only the sets the boats on the water use', () => {
    expect(detailSetsFor(['crab'], 'high')).toEqual([
      'painted-metal',
      'painted-metal-worn',
      'rusty-steel',
      'diamond-plate',
      'rope',
    ]);
    expect(detailSetsFor(['sail'], 'medium')).toEqual(['deck-planks', 'sailcloth', 'rope', 'gelcoat']);
    expect(detailSetsFor(['powerboat', 'pwc'], 'ultra')).toEqual(['rubber', 'gelcoat']);
    expect(detailSetsFor(['cargo', 'cargo'], 'high')).toEqual([
      'painted-metal',
      'painted-metal-worn',
      'rusty-steel',
    ]);
  });

  it('uses every set somewhere and only known sets', () => {
    const used = new Set(detailSetsFor(BOAT_KINDS, 'high'));
    expect([...used].sort()).toEqual([...DETAIL_SETS].sort());
  });

  it('gives the working boats worn paint and the small craft gelcoat', () => {
    expect(BOAT_DETAIL.crab.hull?.worn?.set).toBe('painted-metal-worn');
    expect(BOAT_DETAIL.cargo.hull?.worn?.set).toBe('painted-metal-worn');
    expect(BOAT_DETAIL.cruise.hull?.worn).toBeUndefined();
    for (const kind of ['sail', 'powerboat', 'pwc'] as const)
      expect(BOAT_DETAIL[kind].hull?.layer.set).toBe('gelcoat');
    // Rusty steel only on the working boats.
    for (const kind of ['cruise', 'sail', 'powerboat', 'pwc'] as const)
      for (const recipe of Object.values(BOAT_DETAIL[kind])) {
        expect(recipe.layer.set).not.toBe('rusty-steel');
        expect(recipe.worn?.set).not.toBe('rusty-steel');
      }
  });
});

describe('tiling scale', () => {
  const layers = (): DetailLayer[] =>
    BOAT_KINDS.flatMap((kind) =>
      Object.values(BOAT_DETAIL[kind]).flatMap((recipe) =>
        recipe.worn ? [recipe.layer, recipe.worn] : [recipe.layer],
      ),
    );

  it('keeps tiles, fades and strengths in sensible ranges', () => {
    for (const layer of layers()) {
      expect(layer.tile).toBeGreaterThan(0.005);
      expect(layer.tile).toBeLessThan(3);
      expect(layer.fade).toBeGreaterThan(layer.tile * 4);
      for (const k of ['normal', 'roughness', 'color', 'albedo', 'ao', 'scratches', 'metal'] as const) {
        const value = layer[k] ?? 0;
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('has physically sized planks and diamond plate', () => {
    for (const kind of ['sail', 'cruise'] as const) {
      const plank = featureSize(BOAT_DETAIL[kind].teak!.layer)!;
      expect(plank).toBeGreaterThanOrEqual(0.09);
      expect(plank).toBeLessThanOrEqual(0.15);
    }
    const diamond = featureSize(BOAT_DETAIL.crab.deck!.layer)!;
    expect(diamond).toBeGreaterThan(0.025);
    expect(diamond).toBeLessThan(0.035);
    expect(featureSize(BOAT_DETAIL.crab.hull!.layer)).toBeNull();
  });

  it('scales non-square sets by their aspect and fades from 40% of the distance', () => {
    const rope: DetailLayer = { set: 'rope', tile: 0.02, fade: 5, normal: 1 };
    const [u, v] = tileScale(rope);
    expect(u).toBeCloseTo(25);
    expect(v).toBeCloseTo(50);
    expect(tileScale({ ...rope, set: 'gelcoat', tile: 0.5 })).toEqual([2, 2]);
    expect(fadeRange(rope)).toEqual([2, 5]);
  });
});

describe('manifest entries and fallback', () => {
  it('lists the files the manifest has, dropping sets without a surface map', () => {
    const manifest = manifestWith([
      detailMapPath('rusty-steel', 'surface'),
      detailMapPath('rusty-steel', 'color'),
      detailMapPath('rope', 'surface'), // no colour
      detailMapPath('deck-planks', 'color'), // no surface: unusable
    ]);
    const files = detailFiles(manifest, ['rusty-steel', 'rope', 'deck-planks', 'gelcoat']);
    expect(files.map((f) => `${f.set}/${f.map}`)).toEqual([
      'rusty-steel/surface',
      'rusty-steel/color',
      'rope/surface',
    ]);
    expect(files[0]!.entry.bytes).toBe(1000);
    expect(detailFiles({ version: 1, assets: {} }, ['rope'])).toEqual([]);
  });

  it('ships every map the sets need in public/assets-manifest.json', () => {
    const manifest = publicManifest as AssetManifest;
    const files = detailFiles(manifest, DETAIL_SETS);
    for (const set of DETAIL_SETS)
      for (const map of DETAIL_SET_INFO[set].maps)
        expect(
          files.some((f) => f.set === set && f.map === map),
          `${set}/${map}`,
        ).toBe(true);
    // Nothing shipped that no set reads.
    const shipped = Object.keys(manifest.assets).filter((path) => path.startsWith('textures/'));
    expect(shipped.sort()).toEqual(files.map((f) => f.path).sort());
  });

  it('resolves a recipe to null when its textures are missing, and keeps what is there', () => {
    const recipe = BOAT_DETAIL.crab.hull!;
    expect(resolveRecipe(recipe, () => null)).toBeNull();
    expect(resolveRecipe(undefined, () => maps())).toBeNull();
    const onlyBase = resolveRecipe(recipe, (set) => (set === 'painted-metal' ? maps(false) : null));
    expect(onlyBase?.base?.layer.set).toBe('painted-metal');
    expect(onlyBase?.base?.info.asset).toBe('PaintedMetal004');
    expect(onlyBase?.worn).toBeNull();
    const both = resolveRecipe(recipe, () => maps());
    expect(both?.worn?.layer.amount).toBeGreaterThan(0);
  });

  it('gives materials nothing until enabled and loaded', () => {
    expect(boatDetail('crab', 'hull')).toBeNull();
    expect(detailKey('crab')).toBe('off');
    setDetailEnabled(true);
    expect(boatDetail('crab', 'hull')).toBeNull();
    expect(detailKey('crab')).toBe('none');
    registerDetailMaps('painted-metal', maps(false));
    registerDetailMaps('painted-metal-worn', null); // failed
    expect(boatDetail('crab', 'hull')?.base?.maps.color).toBeNull();
    expect(boatDetail('crab', 'hull')?.worn).toBeNull();
    expect(boatDetail('crab', 'notAPart')).toBeNull();
    expect(detailKey('crab')).toBe('painted-metal');
    expect(detailKey('sail')).toBe('none');
    // Failed and loaded sets aren't retried.
    expect(pendingDetailSets(['painted-metal', 'painted-metal-worn', 'rope'] as DetailSetId[])).toEqual([
      'rope',
    ]);
    // Low quality: back to procedural without forgetting the textures.
    setDetailEnabled(false);
    expect(boatDetail('crab', 'hull')).toBeNull();
    expect(detailKey('crab')).toBe('off');
  });
});

describe('credits', () => {
  it('credits every ambientCG asset in CREDITS.md', () => {
    for (const set of DETAIL_SETS) expect(credits).toContain(`ambientCG ${DETAIL_SET_INFO[set].asset}`);
  });
});
