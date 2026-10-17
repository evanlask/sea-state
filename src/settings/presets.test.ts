// Quality presets: the table, preset detection and the first-run hardware guess.

import { describe, expect, it } from 'vite-plus/test';

import {
  applyPreset,
  detectPreset,
  PRESET_ORDER,
  presetValues,
  QUALITY_PRESET_VALUES,
  type PresetValues,
  suggestInitialPreset,
} from './presets';
import { defaultSettings } from './schema';

describe('quality presets', () => {
  it('match the plan §13 table', () => {
    const row = (pick: (p: Readonly<PresetValues>) => unknown) =>
      PRESET_ORDER.map((preset) => pick(QUALITY_PRESET_VALUES[preset]));
    expect(row((p) => p.renderScale)).toEqual([0.67, 0.8, 1, 1]);
    expect(row((p) => `${p.visualDetailCascades.count}x${p.visualDetailCascades.resolution}`)).toEqual([
      '1x128',
      '1x256',
      '2x256',
      '2x512',
    ]);
    expect(row((p) => p.clipmapRings)).toEqual([6, 8, 9, 10]);
    expect(row((p) => `${p.clouds.resolution}-${p.clouds.steps}`)).toEqual([
      'quarter-48',
      'quarter-64',
      'half-96',
      'half-128',
    ]);
    expect(row((p) => `${p.shadows.mapSize}x${p.shadows.cascades}`)).toEqual([
      '1024x2',
      '2048x3',
      '2048x4',
      '4096x4',
    ]);
    expect(row((p) => p.reflections)).toEqual(['env', 'env', 'ssr-half', 'ssr-full']);
    expect(row((p) => `${p.ao}/${p.aa}`)).toEqual([
      'off/fxaa',
      'off/smaa',
      'gtao-half/traa',
      'gtao-full/traa',
    ]);
    expect(row((p) => p.particleBudget)).toEqual([16384, 49152, 131072, 262144]);
    expect(row((p) => `${p.sailCloth.cols}x${p.sailCloth.rows}`)).toEqual([
      '10x14',
      '14x20',
      '18x26',
      '24x34',
    ]);
  });

  it('defaults are exactly the High preset', () => {
    expect(detectPreset(defaultSettings().graphics)).toBe('high');
    expect(defaultSettings().graphics.preset).toBe('high');
  });

  it('round-trips applyPreset → detectPreset for every preset', () => {
    for (const preset of PRESET_ORDER) {
      const applied = applyPreset(defaultSettings(), preset);
      expect(applied.graphics.preset).toBe(preset);
      expect(detectPreset(applied.graphics)).toBe(preset);
    }
  });

  it('keeps personal preferences when switching presets', () => {
    const settings = defaultSettings();
    settings.graphics.fov = 75;
    settings.graphics.lensDroplets = false;
    const low = applyPreset(settings, 'low');
    expect(low.graphics.fov).toBe(75);
    expect(low.graphics.lensDroplets).toBe(false);
    expect(settings.graphics.renderScale).toBe(1); // input not mutated
  });

  it('detects custom when any single value differs, and the preset again once it matches', () => {
    const graphics = applyPreset(defaultSettings(), 'medium').graphics;
    graphics.clouds.steps = 65;
    expect(detectPreset(graphics)).toBe('custom');
    graphics.clouds.steps = 64;
    expect(detectPreset(graphics)).toBe('medium');
    graphics.aa = 'fxaa';
    expect(detectPreset(graphics)).toBe('custom');
  });

  it('applying custom leaves values untouched', () => {
    const applied = applyPreset(applyPreset(defaultSettings(), 'low'), 'custom');
    expect(applied.graphics.preset).toBe('custom');
    expect(applied.graphics.renderScale).toBe(0.67);
  });

  it('presetValues returns an independent copy', () => {
    const values = presetValues('ultra');
    values.sailCloth.cols = 1;
    expect(QUALITY_PRESET_VALUES.ultra.sailCloth.cols).toBe(24);
  });
});

describe('suggestInitialPreset', () => {
  it('picks low on mobile regardless of specs', () => {
    expect(suggestInitialPreset({ isMobile: true, hardwareConcurrency: 8, deviceMemory: 8 })).toBe('low');
  });

  it('picks low on very weak hardware', () => {
    expect(suggestInitialPreset({ hardwareConcurrency: 2 })).toBe('low');
    expect(suggestInitialPreset({ hardwareConcurrency: 8, deviceMemory: 2 })).toBe('low');
  });

  it('picks medium on modest or unknown hardware', () => {
    expect(suggestInitialPreset({})).toBe('medium');
    expect(suggestInitialPreset({ hardwareConcurrency: 4, deviceMemory: 8 })).toBe('medium');
    expect(suggestInitialPreset({ hardwareConcurrency: 12, deviceMemory: 4 })).toBe('medium');
  });

  it('picks high on strong hardware and never ultra', () => {
    expect(suggestInitialPreset({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe('high');
    expect(suggestInitialPreset({ hardwareConcurrency: 32 })).toBe('high'); // no deviceMemory (Safari)
    expect(suggestInitialPreset({ hardwareConcurrency: 128, deviceMemory: 64 })).toBe('high');
  });
});
