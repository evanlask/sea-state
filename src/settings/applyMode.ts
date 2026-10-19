// When each setting takes effect (pure). The settings screen badges fields from this table, and the
// app shows its "Applying graphics settings…" overlay when a `rebuild` setting changes. A test checks
// every schema leaf is classified.
//
//   instant     applies live, no hitch (uniforms, render scale, DOM, audio gains, sim commands)
//   rebuild     applies now, but three.js rebuilds pipelines (post graph, scene-pass outputs, ocean
//               material defines): a brief pause, run behind the overlay and a warm-up pass
//   nextVoyage  read only when a voyage is built (App.startSession → sceneGraphicsFor, SeaScene,
//               simConfigFor): takes effect when the next voyage starts

import type { Settings } from './schema';
import type { ReadonlySettings, SettingsPath } from './store';

export type ApplyMode = 'instant' | 'rebuild' | 'nextVoyage';

export const SETTING_APPLY_MODE: Readonly<Record<SettingsPath, ApplyMode>> = {
  // A preset sets every graphics field: its post-processing ones rebuild now, the rest wait for the
  // next voyage (see PRESET_APPLY_NOTE).
  'graphics.preset': 'rebuild',
  // FrameRuntime.apply / CameraRig.setFov.
  'graphics.renderScale': 'instant',
  'graphics.dynamicResolution': 'instant',
  'graphics.targetFps': 'instant',
  'graphics.fpsCap': 'instant',
  'graphics.fov': 'instant',
  // FpsCounter.setEnabled (DOM only).
  'graphics.showFps': 'instant',
  // SeaScene.applyPostSettings: post graph (PostPipeline), velocity output, ocean SSR / motion vectors.
  'graphics.aa': 'rebuild',
  'graphics.bloom': 'rebuild',
  'graphics.ao': 'rebuild',
  'graphics.lensDroplets': 'rebuild',
  'graphics.reflections': 'rebuild',
  // Built into the voyage's simulation (detail cascades) or scene (meshes, buffers, shadow maps).
  'graphics.visualDetailCascades.count': 'nextVoyage',
  'graphics.visualDetailCascades.resolution': 'nextVoyage',
  'graphics.clipmapRings': 'nextVoyage',
  'graphics.clouds.resolution': 'nextVoyage',
  'graphics.clouds.steps': 'nextVoyage',
  'graphics.shadows.mapSize': 'nextVoyage',
  'graphics.shadows.cascades': 'nextVoyage',
  'graphics.particleBudget': 'nextVoyage',
  'graphics.sailCloth.cols': 'nextVoyage',
  'graphics.sailCloth.rows': 'nextVoyage',
  // Hud.setSettings.
  'hud.mode': 'instant',
  'hud.scale': 'instant',
  'hud.nightDimming': 'instant',
  'hud.redNightTint': 'instant',
  'hud.controlHints': 'instant',
  'hud.radar': 'instant',
  'hud.units.speed': 'instant',
  'hud.units.length': 'instant',
  'hud.units.wind': 'instant',
  // AudioEngine.applySettings.
  'audio.master': 'instant',
  'audio.ambience': 'instant',
  'audio.effects': 'instant',
  'audio.engines': 'instant',
  'audio.muteWhenHidden': 'instant',
  // InputManager.updateSettings.
  'controls.mouseSensitivity': 'instant',
  'controls.invertY': 'instant',
  // Sim commands (setPhysicsMode, setCapsizeAssist) and the panel's visibility.
  'physics.mode': 'instant',
  'physics.capsizeAssist': 'instant',
  'physics.telemetryPanel': 'instant',
  'physics.dayLength': 'instant',
};

export const APPLY_MODE_LABEL: Readonly<Record<Exclude<ApplyMode, 'instant'>, string>> = {
  rebuild: 'Brief pause to apply',
  nextVoyage: 'Applies next voyage',
};

export const PRESET_APPLY_NOTE =
  'A new preset pauses briefly to rebuild shaders; its ocean, cloud, shadow, particle and sail ' +
  'options apply from the next voyage.';

export function applyModeOf(path: string): ApplyMode {
  return SETTING_APPLY_MODE[path as SettingsPath] ?? 'instant';
}

// Leaf paths whose values differ between two settings objects.
export function changedPaths(
  previous: ReadonlySettings | Settings,
  next: ReadonlySettings | Settings,
): SettingsPath[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, prefix: string): void => {
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      for (const key of Object.keys(b)) {
        walk(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          prefix ? `${prefix}.${key}` : key,
        );
      }
      return;
    }
    if (a !== b) out.push(prefix);
  };
  walk(previous, next, '');
  return out as SettingsPath[];
}

// Whether going from `previous` to `next` changes any setting that rebuilds pipelines. The preset
// name alone doesn't: it only matters through the fields it sets.
export function needsRebuild(
  previous: ReadonlySettings | Settings,
  next: ReadonlySettings | Settings,
): boolean {
  return changedPaths(previous, next).some(
    (path) => path !== 'graphics.preset' && SETTING_APPLY_MODE[path] === 'rebuild',
  );
}
