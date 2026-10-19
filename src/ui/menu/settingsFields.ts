// Settings screen field descriptors: label, description, performance hint and control type for
// every leaf of the settings schema, plus pure helpers to read, format and convert values.
// A test checks every schema leaf is covered, so a new setting can't silently miss the menu.

import {
  defaultSettings,
  SETTINGS_SPEC,
  type Field,
  type Settings,
  type SettingsSection,
} from '../../settings/schema';
import type { ReadonlySettings, SettingsPath, SettingsStore } from '../../settings/store';

type ControlKind =
  | { kind: 'toggle' }
  | { kind: 'choice'; options: readonly { value: string | number; label: string }[] }
  | { kind: 'range'; min: number; max: number; step: number; format: (value: number) => string };

export interface SettingDescriptor {
  path: SettingsPath;
  label: string;
  description: string;
  hint?: string; // performance cost, shown under the description
  control: ControlKind;
}

// A tab can show fields from other sections (the HUD tab has the FPS counter); `section` names it.
export interface SettingsTab {
  section: SettingsSection;
  title: string;
  groups: { title: string; fields: SettingDescriptor[] }[];
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const times = (v: number): string => `${v.toFixed(2).replace(/\.?0+$/, '')}×`;
const toggle = { kind: 'toggle' } as const;
const opts = <T extends string | number>(...pairs: [T, string][]): ControlKind => ({
  kind: 'choice',
  options: pairs.map(([value, label]) => ({ value, label })),
});
const range = (min: number, max: number, step: number, format: (v: number) => string): ControlKind => ({
  kind: 'range',
  min,
  max,
  step,
  format,
});
const kParticles = (v: number): string => (v >= 1024 * 1024 ? `${v / (1024 * 1024)}M` : `${v / 1024}k`);

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    section: 'physics',
    title: 'Gameplay',
    groups: [
      {
        title: 'Simulation',
        fields: [
          {
            path: 'physics.mode',
            label: 'Physics mode',
            description:
              'Arcade compresses time for the helm: ships answer in seconds. Realistic: real masses, ' +
              'rates and stopping distances — for the nerds. The same choice as in voyage setup.',
            control: opts(['arcade', 'Arcade'], ['realistic', 'Realistic']),
          },
          {
            path: 'physics.capsizeAssist',
            label: 'Capsize assist',
            description: 'A gentle righting aid for casual play. Storms are meant to be a challenge.',
            control: toggle,
          },
        ],
      },
      {
        title: 'World',
        fields: [
          {
            path: 'physics.dayLength',
            label: 'Day length',
            description:
              'How long a full day and night takes while you play. \\ fast-forwards for a while; [ and ] jump half an hour.',
            control: opts(
              ['real', 'Real time'],
              ['6h', '6 hours'],
              ['1h', '1 hour'],
              ['30m', '30 minutes'],
              ['15m', '15 minutes'],
              ['frozen', 'Frozen'],
            ),
          },
        ],
      },
      {
        title: 'Camera',
        fields: [
          {
            path: 'graphics.fov',
            label: 'Field of view',
            description: 'Vertical field of view.',
            control: range(30, 110, 1, (v) => `${Math.round(v)}°`),
          },
        ],
      },
    ],
  },
  {
    section: 'graphics',
    title: 'Graphics',
    groups: [
      {
        title: 'Resolution and frame rate',
        fields: [
          {
            path: 'graphics.renderScale',
            label: 'Render scale',
            description:
              'Internal resolution relative to the screen: below 1× is upscaled, above 1× supersampled.',
            hint: 'Biggest single performance lever.',
            control: range(0.25, 2, 0.05, times),
          },
          {
            path: 'graphics.dynamicResolution',
            label: 'Dynamic resolution',
            description:
              'Lowers the render scale (down to 70%) when frames run late, and raises it again when there is headroom. F3 shows the current scale.',
            control: toggle,
          },
          {
            path: 'graphics.targetFps',
            label: 'Target frame rate',
            description:
              "What dynamic resolution aims for (never above the frame rate cap). Keep it at or below your display's refresh rate.",
            control: opts([30, '30'], [60, '60'], [90, '90'], [120, '120'], [144, '144']),
          },
          {
            path: 'graphics.fpsCap',
            label: 'Frame rate cap',
            description: 'Limit frames per second to save power and heat.',
            control: opts([0, 'Off'], [30, '30'], [60, '60'], [120, '120'], [144, '144']),
          },
        ],
      },
      {
        title: 'Image',
        fields: [
          {
            path: 'graphics.aa',
            label: 'Anti-aliasing',
            description: 'TRAA is sharpest on the ocean; FXAA is cheapest.',
            control: opts(['fxaa', 'FXAA'], ['smaa', 'SMAA'], ['traa', 'TRAA']),
          },
          {
            path: 'graphics.ao',
            label: 'Ambient occlusion',
            description: 'Soft contact shadows in corners and under fittings.',
            control: opts(['off', 'Off'], ['gtao-half', 'Half'], ['gtao-full', 'Full']),
          },
          {
            path: 'graphics.bloom',
            label: 'Bloom',
            description: 'Glow around the sun, lightning and navigation lights.',
            control: toggle,
          },
          {
            path: 'graphics.lensDroplets',
            label: 'Lens droplets',
            description: 'Rain and spray on the camera lens and bridge windows.',
            control: toggle,
          },
        ],
      },
      {
        title: 'Ocean',
        fields: [
          {
            path: 'graphics.visualDetailCascades.count',
            label: 'Detail wave layers',
            description: 'Extra short-wave FFT layers that only affect looks, never physics.',
            hint: 'Moderate GPU cost.',
            control: opts([1, '1'], [2, '2']),
          },
          {
            path: 'graphics.visualDetailCascades.resolution',
            label: 'Detail wave resolution',
            description: 'FFT size of the detail layers; sharper ripples and foam.',
            hint: 'Cost grows with the square of the size.',
            control: opts([64, '64'], [128, '128'], [256, '256'], [512, '512']),
          },
          {
            path: 'graphics.clipmapRings',
            label: 'Ocean mesh detail',
            description:
              'Levels of ocean mesh around the camera; each one halves the vertex spacing up close. The sea reaches the horizon at any setting.',
            hint: 'Low cost per level.',
            control: range(4, 12, 1, (v) => `${v} levels`),
          },
          {
            path: 'graphics.reflections',
            label: 'Reflections',
            description: 'Sky and clouds always; screen-space reflections (SSR) add the boats on the water.',
            hint: 'Fine SSR traces twice the samples, further out.',
            control: opts(['env', 'Sky only'], ['ssr-half', 'SSR'], ['ssr-full', 'SSR fine']),
          },
          {
            path: 'graphics.particleBudget',
            label: 'Spray and rain particles',
            description: 'Maximum live particles for spray, spume and rain.',
            hint: 'Mostly matters in storms.',
            control: opts(
              [16 * 1024, '16k'],
              [48 * 1024, '48k'],
              [128 * 1024, '128k'],
              [256 * 1024, '256k'],
              [512 * 1024, '512k'],
            ),
          },
        ],
      },
      {
        title: 'Sky and lighting',
        fields: [
          {
            path: 'graphics.clouds.resolution',
            label: 'Cloud resolution',
            description: 'Volumetric clouds are traced at a fraction of the screen and reprojected.',
            hint: 'Up to 96 ray steps half reprojects and costs little more than quarter; above that, about 4×.',
            control: opts(['quarter', 'Quarter'], ['half', 'Half']),
          },
          {
            path: 'graphics.clouds.steps',
            label: 'Cloud ray steps',
            description: 'Samples per ray through the cloud layer; fewer can look grainy.',
            hint: 'Scales cloud cost linearly.',
            control: range(16, 256, 8, (v) => `${v}`),
          },
          {
            path: 'graphics.shadows.mapSize',
            label: 'Shadow resolution',
            description: 'Size of each shadow cascade texture.',
            control: opts([512, '512'], [1024, '1k'], [2048, '2k'], [4096, '4k']),
          },
          {
            path: 'graphics.shadows.cascades',
            label: 'Shadow cascades',
            description: 'More cascades keep distant shadows sharp.',
            hint: 'Each cascade redraws the boats.',
            control: opts([1, '1'], [2, '2'], [3, '3'], [4, '4']),
          },
        ],
      },
      {
        title: 'Boats',
        fields: [
          {
            path: 'graphics.sailCloth.cols',
            label: 'Sail cloth columns',
            description: 'Horizontal resolution of the simulated sail cloth.',
            hint: 'CPU cost; only on the sailboat.',
            control: range(6, 48, 1, (v) => `${v}`),
          },
          {
            path: 'graphics.sailCloth.rows',
            label: 'Sail cloth rows',
            description: 'Vertical resolution of the simulated sail cloth.',
            hint: 'CPU cost; only on the sailboat.',
            control: range(8, 64, 1, (v) => `${v}`),
          },
        ],
      },
    ],
  },
  {
    section: 'audio',
    title: 'Audio',
    groups: [
      {
        title: 'Volume',
        fields: [
          {
            path: 'audio.master',
            label: 'Master',
            description: 'Everything.',
            control: range(0, 1, 0.05, pct),
          },
          {
            path: 'audio.ambience',
            label: 'Ambience',
            description: 'Wind, sea, rain and thunder.',
            control: range(0, 1, 0.05, pct),
          },
          {
            path: 'audio.effects',
            label: 'Effects',
            description: 'Water along the hull, splashes, slams, horns, winches and sail flogging.',
            control: range(0, 1, 0.05, pct),
          },
          {
            path: 'audio.engines',
            label: 'Engines',
            description: 'Diesels, outboards and jet drives.',
            control: range(0, 1, 0.05, pct),
          },
          {
            path: 'audio.muteWhenHidden',
            label: 'Mute in background',
            description: 'Silence the game when its tab or window is hidden.',
            control: toggle,
          },
        ],
      },
    ],
  },
  {
    section: 'controls',
    title: 'Controls',
    groups: [
      {
        title: 'Mouse',
        fields: [
          {
            path: 'controls.mouseSensitivity',
            label: 'Mouse sensitivity',
            description: 'Free-look and orbit speed.',
            control: range(0.1, 5, 0.1, times),
          },
          {
            path: 'controls.invertY',
            label: 'Invert Y',
            description: 'Push forward to look down.',
            control: toggle,
          },
        ],
      },
    ],
  },
  {
    section: 'hud',
    title: 'HUD',
    groups: [
      {
        title: 'Display',
        fields: [
          {
            path: 'hud.mode',
            label: 'HUD',
            description: 'Full instruments, a minimal set, or nothing (H cycles in game).',
            control: opts(['full', 'Full'], ['minimal', 'Minimal'], ['off', 'Off']),
          },
          {
            path: 'hud.scale',
            label: 'HUD scale',
            description: 'Size of the instruments.',
            control: range(0.5, 2, 0.05, times),
          },
          {
            path: 'hud.nightDimming',
            label: 'Night dimming',
            description: 'Dims the instruments after dark, like a real bridge.',
            control: opts(['auto', 'Auto'], ['off', 'Off']),
          },
          {
            path: 'hud.redNightTint',
            label: 'Red night-vision tint',
            description: 'Turns the instruments red at night to keep your eyes dark-adapted.',
            control: toggle,
          },
          {
            path: 'hud.controlHints',
            label: 'Control hints',
            description: 'Context-sensitive key and button hints at the bottom of the screen.',
            control: toggle,
          },
          {
            path: 'hud.radar',
            label: 'Plotter',
            description: 'The small radar plotter showing the fleet and the wind.',
            control: toggle,
          },
        ],
      },
      {
        title: 'Panels',
        fields: [
          {
            path: 'graphics.showFps',
            label: 'FPS counter',
            description: 'Shows frames per second in the top-right corner while you play.',
            control: toggle,
          },
          {
            path: 'physics.telemetryPanel',
            label: 'Telemetry panel',
            description:
              'Engineering readouts for the boat at the helm: RPM, resistance, Froude number, GM, sail CL/CD. G toggles it.',
            control: opts(['off', 'Off'], ['on', 'On']),
          },
        ],
      },
      {
        title: 'Units',
        fields: [
          {
            path: 'hud.units.speed',
            label: 'Speed',
            description: 'Boat speed.',
            control: opts(['kn', 'Knots'], ['mph', 'mph'], ['kmh', 'km/h']),
          },
          {
            path: 'hud.units.length',
            label: 'Length and height',
            description: 'Wave heights, distances and depths.',
            control: opts(['m', 'Metres'], ['ft', 'Feet']),
          },
          {
            path: 'hud.units.wind',
            label: 'Wind',
            description: 'Wind speed.',
            control: opts(['kn', 'Knots'], ['ms', 'm/s'], ['beaufort', 'Beaufort']),
          },
        ],
      },
    ],
  },
];

export function allDescriptors(): SettingDescriptor[] {
  return SETTINGS_TABS.flatMap((tab) => tab.groups.flatMap((g) => g.fields));
}

// Every leaf path in the schema, for the coverage test.
export function schemaLeafPaths(): string[] {
  const out: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (typeof node === 'object' && node !== null && 'kind' in node) {
      out.push(prefix);
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(SETTINGS_SPEC, '');
  return out;
}

export function specAt(path: string): Field {
  let node: unknown = SETTINGS_SPEC;
  for (const key of path.split('.')) node = (node as Record<string, unknown>)[key];
  return node as Field;
}

export function getAtPath(settings: ReadonlySettings | Settings, path: string): unknown {
  let node: unknown = settings;
  for (const key of path.split('.')) node = (node as Record<string, unknown>)[key];
  return node;
}

// The value a control holds, in the type the store expects; null if it can't be used.
export function coerceForPath(path: string, raw: unknown): string | number | boolean | null {
  const spec = specAt(path);
  switch (spec.kind) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'enum':
      return typeof raw === 'string' && spec.values.includes(raw) ? raw : null;
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return null;
      const clamped = Math.min(spec.max, Math.max(spec.min, n));
      return spec.integer ? Math.round(clamped) : Number(clamped.toFixed(4));
    }
  }
}

export function formatSetting(descriptor: SettingDescriptor, value: unknown): string {
  const { control } = descriptor;
  if (control.kind === 'toggle') return value ? 'On' : 'Off';
  if (control.kind === 'range') return control.format(Number(value));
  return control.options.find((o) => o.value === value)?.label ?? String(value);
}

// Choice values not in the option list (e.g. a custom fps cap from a hand-edited save) still need
// a visible state; the screen shows them as an extra option.
export function choiceOptionsWith(
  descriptor: SettingDescriptor,
  value: unknown,
): readonly { value: string | number; label: string }[] {
  const control = descriptor.control;
  if (control.kind !== 'choice') return [];
  if (control.options.some((o) => o.value === value)) return control.options;
  if (typeof value !== 'number' && typeof value !== 'string') return control.options;
  const label =
    typeof value === 'number' && descriptor.path === 'graphics.particleBudget'
      ? kParticles(value)
      : String(value);
  return [...control.options, { value, label }].sort((a, b) =>
    typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : 0,
  );
}

// Writes one leaf through the store's typed path API; coerceForPath guarantees the value's type.
export function writeSetting(store: Pick<SettingsStore, 'set'>, path: SettingsPath, raw: unknown): boolean {
  const value = coerceForPath(path, raw);
  if (value === null) return false;
  store.set(path, value as never);
  return true;
}

// Back to the defaults for exactly the fields a tab shows (and the quality preset on Graphics).
export function resetTab(store: Pick<SettingsStore, 'update'>, tab: SettingsTab): void {
  const defaults = defaultSettings();
  const paths = tab.groups.flatMap((g) => g.fields.map((f) => f.path as string));
  if (tab.section === 'graphics') paths.push('graphics.preset');
  store.update((draft) => {
    for (const path of paths) {
      const keys = path.split('.');
      const last = keys.pop()!;
      let parent = draft as unknown as Record<string, unknown>;
      for (const key of keys) parent = parent[key] as Record<string, unknown>;
      parent[last] = structuredClone(getAtPath(defaults, path));
    }
  });
}
