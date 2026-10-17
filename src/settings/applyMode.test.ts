// The apply-mode table: complete, and consistent with what the app applies live.

import { describe, expect, it } from 'vite-plus/test';

import { postSettingsFrom } from '../render/post/postSettings';
import { applyModeOf, changedPaths, needsRebuild, SETTING_APPLY_MODE } from './applyMode';
import { applyPreset } from './presets';
import { defaultSettings, sanitizeWith, SETTINGS_SPEC } from './schema';

function leafPaths(node: unknown, prefix = ''): string[] {
  if (typeof node === 'object' && node !== null && 'kind' in node) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe('setting apply modes', () => {
  it('classifies every setting, and nothing else', () => {
    expect(Object.keys(SETTING_APPLY_MODE).sort()).toEqual(leafPaths(SETTINGS_SPEC).sort());
  });

  it('marks every post-processing setting as a rebuild', () => {
    const post = postSettingsFrom(defaultSettings().graphics);
    for (const key of Object.keys(post)) expect(applyModeOf(`graphics.${key}`)).toBe('rebuild');
  });

  it('drops the retired recorded-ambience switch from old saves', () => {
    const old = sanitizeWith(
      SETTINGS_SPEC,
      { audio: { master: 0.5, recordedAmbience: false } },
      defaultSettings(),
    );
    expect(old.audio).toEqual({ ...defaultSettings().audio, master: 0.5 });
  });

  it('lists changed leaves', () => {
    const a = defaultSettings();
    const b = structuredClone(a);
    b.graphics.clouds.steps = 32;
    b.hud.radar = !a.hud.radar;
    expect(changedPaths(a, b).sort()).toEqual(['graphics.clouds.steps', 'hud.radar']);
    expect(changedPaths(a, structuredClone(a))).toEqual([]);
  });

  it('needs a rebuild only when a rebuild setting changes', () => {
    const a = defaultSettings();
    const live = structuredClone(a);
    live.graphics.renderScale = 0.5;
    live.graphics.shadows.mapSize = 1024;
    live.graphics.showFps = true;
    expect(needsRebuild(a, live)).toBe(false);
    const aa = structuredClone(a);
    aa.graphics.aa = 'fxaa';
    expect(needsRebuild(a, aa)).toBe(true);
    // A preset counts through the fields it changes.
    expect(needsRebuild(a, applyPreset(structuredClone(a), 'low'))).toBe(true);
    const renamed = structuredClone(a);
    renamed.graphics.preset = 'custom';
    expect(needsRebuild(a, renamed)).toBe(false);
  });
});
