// Graphics settings → what the scene is built with. Presets set every field to their table values
// (settings/presets.ts), so the scene reads the fields themselves; the preset name only picks the
// tier for knobs the settings don't expose (ocean shading, light budgets, sky). For Custom that tier
// is the preset its fields most resemble. Pure.

import { type PostSettings, postSettingsFrom } from '../render/post/postSettings';
import { PRESET_ORDER, QUALITY_PRESET_VALUES } from '../settings/presets';
import type { GraphicsSettings } from '../settings/schema';
import type { QualityPreset } from './Scenario';

export interface SceneGraphics {
  quality: QualityPreset;
  clipmapRings: number;
  particleBudget: number;
  sailCloth: readonly [number, number];
  shadows: { mapSize: number; cascades: number };
  clouds: GraphicsSettings['clouds'] | undefined; // only overrides the tier for Custom
  post: PostSettings; // AA, bloom, GTAO, lens droplets, ocean SSR
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// The preset sharing the most fields with these settings (a tie goes to High if it is among them, else the lowest tier).
export function nearestPreset(graphics: Readonly<GraphicsSettings>): QualityPreset {
  let best: QualityPreset = 'high';
  let bestScore = -1;
  for (const preset of PRESET_ORDER) {
    const values = QUALITY_PRESET_VALUES[preset];
    const score = (Object.keys(values) as (keyof typeof values)[]).filter((key) =>
      same(values[key], graphics[key]),
    ).length;
    if (score > bestScore || (score === bestScore && preset === 'high')) {
      best = preset;
      bestScore = score;
    }
  }
  return best;
}

export function sceneGraphicsFor(graphics: Readonly<GraphicsSettings>): SceneGraphics {
  const custom = graphics.preset === 'custom';
  return {
    quality: custom ? nearestPreset(graphics) : graphics.preset,
    clipmapRings: graphics.clipmapRings,
    particleBudget: graphics.particleBudget,
    sailCloth: [graphics.sailCloth.cols, graphics.sailCloth.rows],
    shadows: { mapSize: graphics.shadows.mapSize, cascades: graphics.shadows.cascades },
    clouds: custom ? graphics.clouds : undefined,
    post: postSettingsFrom(graphics),
  };
}
