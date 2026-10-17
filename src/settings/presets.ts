// Graphics quality presets, preset detection, and a first-run guess
// from coarse hardware hints. Physics never depends on any of this.

import type { QualityPreset } from '../app/Scenario';
import type { GraphicsPreset, GraphicsSettings, Settings } from './schema';

// The subset of graphics settings a preset controls; everything else (FOV, bloom, FPS cap…) is
// a personal preference that survives switching presets.
export type PresetValues = Pick<
  GraphicsSettings,
  | 'renderScale'
  | 'visualDetailCascades'
  | 'clipmapRings'
  | 'clouds'
  | 'shadows'
  | 'reflections'
  | 'ao'
  | 'aa'
  | 'particleBudget'
  | 'sailCloth'
>;

export const PRESET_ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

const K = 1024;

export const QUALITY_PRESET_VALUES: Readonly<Record<QualityPreset, Readonly<PresetValues>>> = {
  low: {
    renderScale: 0.67,
    visualDetailCascades: { count: 1, resolution: 128 },
    clipmapRings: 6,
    clouds: { resolution: 'quarter', steps: 48 },
    shadows: { mapSize: 1024, cascades: 2 },
    reflections: 'env',
    ao: 'off',
    aa: 'fxaa',
    particleBudget: 16 * K,
    sailCloth: { cols: 10, rows: 14 },
  },
  medium: {
    renderScale: 0.8,
    visualDetailCascades: { count: 1, resolution: 256 },
    clipmapRings: 8,
    clouds: { resolution: 'quarter', steps: 64 },
    shadows: { mapSize: 2048, cascades: 3 },
    reflections: 'env',
    ao: 'off',
    aa: 'smaa',
    particleBudget: 48 * K,
    sailCloth: { cols: 14, rows: 20 },
  },
  high: {
    renderScale: 1,
    visualDetailCascades: { count: 2, resolution: 256 },
    clipmapRings: 9,
    clouds: { resolution: 'half', steps: 96 },
    shadows: { mapSize: 2048, cascades: 4 },
    reflections: 'ssr-half', // env map plus half-res SSR
    ao: 'gtao-half',
    aa: 'traa',
    particleBudget: 128 * K,
    sailCloth: { cols: 18, rows: 26 },
  },
  ultra: {
    renderScale: 1,
    visualDetailCascades: { count: 2, resolution: 512 },
    clipmapRings: 10,
    clouds: { resolution: 'half', steps: 128 },
    shadows: { mapSize: 4096, cascades: 4 },
    reflections: 'ssr-full',
    ao: 'gtao-full',
    aa: 'traa',
    particleBudget: 256 * K,
    sailCloth: { cols: 24, rows: 34 },
  },
};

export function presetValues(preset: QualityPreset): PresetValues {
  return structuredClone(QUALITY_PRESET_VALUES[preset]) as PresetValues;
}

export const isQualityPreset = (value: unknown): value is QualityPreset =>
  typeof value === 'string' && (PRESET_ORDER as readonly string[]).includes(value);

// Returns new settings with the preset's values applied; `custom` leaves values untouched.
export function applyPreset(settings: Settings, preset: GraphicsPreset): Settings {
  const graphics: GraphicsSettings = isQualityPreset(preset)
    ? { ...structuredClone(settings.graphics), ...presetValues(preset), preset }
    : { ...structuredClone(settings.graphics), preset };
  return { ...settings, graphics };
}

// Tolerance absorbs float noise from sliders (e.g. a render scale of 0.6700000001).
const matches = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ra = a as Record<string, unknown>;
    return Object.keys(b).every((key) => matches(ra[key], (b as Record<string, unknown>)[key]));
  }
  return a === b;
};

export function detectPreset(graphics: Readonly<PresetValues>): GraphicsPreset {
  return PRESET_ORDER.find((preset) => matches(graphics, QUALITY_PRESET_VALUES[preset])) ?? 'custom';
}

export interface HardwareHints {
  hardwareConcurrency?: number; // navigator.hardwareConcurrency
  deviceMemory?: number; // navigator.deviceMemory in GB (Chromium only, capped at 8)
  isMobile?: boolean;
}

// Deliberately conservative: a too-low guess costs a menu visit, a too-high one a slideshow.
// Ultra is never auto-picked because no CPU/RAM hint says anything reliable about the GPU.
export function suggestInitialPreset(hints: HardwareHints = {}): QualityPreset {
  if (hints.isMobile) return 'low';
  const cores = hints.hardwareConcurrency;
  const memory = hints.deviceMemory;
  if ((cores !== undefined && cores <= 2) || (memory !== undefined && memory <= 2)) return 'low';
  const strongCores = cores !== undefined && cores >= 8;
  const strongMemory = memory === undefined || memory >= 8; // Safari/Firefox don't report it
  return strongCores && strongMemory ? 'high' : 'medium';
}
