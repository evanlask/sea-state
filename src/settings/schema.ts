// Player settings: the typed shape, a declarative field spec (defaults + valid ranges), and a
// sanitizer that turns any untrusted value (old saves, hand-edited JSON) into a valid Settings.

import type { PhysicsMode } from '../sim/world/protocol';

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';
export type CloudResolution = 'quarter' | 'half';
export type ReflectionMode = 'env' | 'ssr-half' | 'ssr-full';
export type AmbientOcclusion = 'off' | 'gtao-half' | 'gtao-full';
export type AntiAliasing = 'fxaa' | 'smaa' | 'traa';
export type HudMode = 'full' | 'minimal' | 'off';
type NightDimming = 'auto' | 'off';
export type SpeedUnit = 'kn' | 'mph' | 'kmh';
export type LengthUnit = 'm' | 'ft';
export type WindUnit = 'kn' | 'ms' | 'beaufort';
type TelemetryPanel = 'on' | 'off'; // the engineering readouts for the boat at the helm
// How long a full day and night takes in play; 'real' is a real 24 hours, 'frozen' stops the sun.
export type DayLength = 'real' | '6h' | '1h' | '30m' | '15m' | 'frozen';

export interface GraphicsSettings {
  preset: GraphicsPreset;
  renderScale: number;
  dynamicResolution: boolean;
  targetFps: number; // dynamic-resolution target
  visualDetailCascades: { count: number; resolution: number };
  clipmapRings: number;
  clouds: { resolution: CloudResolution; steps: number };
  shadows: { mapSize: number; cascades: number };
  reflections: ReflectionMode;
  ao: AmbientOcclusion;
  aa: AntiAliasing;
  particleBudget: number;
  sailCloth: { cols: number; rows: number };
  bloom: boolean;
  lensDroplets: boolean;
  fov: number; // vertical, degrees
  fpsCap: number; // 0 = uncapped
  showFps: boolean; // the player-facing FPS counter
}

export interface HudSettings {
  mode: HudMode;
  scale: number;
  nightDimming: NightDimming;
  redNightTint: boolean;
  controlHints: boolean;
  radar: boolean; // the fleet plotter
  units: { speed: SpeedUnit; length: LengthUnit; wind: WindUnit };
}

export interface AudioSettings {
  master: number;
  ambience: number;
  effects: number;
  engines: number;
  muteWhenHidden: boolean;
}

export interface ControlSettings {
  mouseSensitivity: number;
  invertY: boolean;
  gamepadDeadZone: number;
  gamepadSensitivity: number;
  rumble: boolean;
}

interface PhysicsSettings {
  mode: PhysicsMode;
  capsizeAssist: boolean;
  telemetryPanel: TelemetryPanel;
  dayLength: DayLength;
}

export interface Settings {
  graphics: GraphicsSettings;
  hud: HudSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  physics: PhysicsSettings;
}

export type SettingsSection = keyof Settings;

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };

// ---------------------------------------------------------------------------------------------
// Field spec

interface NumberField {
  kind: 'number';
  default: number;
  min: number;
  max: number;
  integer?: boolean;
  oneOf?: readonly number[]; // discrete values (e.g. texture sizes); input snaps to the nearest
}
interface BooleanField {
  kind: 'boolean';
  default: boolean;
}
interface EnumField<T extends string> {
  kind: 'enum';
  default: T;
  values: readonly T[];
}
export type Field = NumberField | BooleanField | EnumField<string>;

// Mirrors the settings tree; [T] wrappers stop boolean/union distribution.
export type Spec<T> = [T] extends [boolean]
  ? BooleanField
  : [T] extends [number]
    ? NumberField
    : [T] extends [string]
      ? EnumField<T>
      : { readonly [K in keyof T]: Spec<T[K]> };

const num = (value: number, min: number, max: number, extra: Partial<NumberField> = {}): NumberField => ({
  kind: 'number',
  default: value,
  min,
  max,
  ...extra,
});
const int = (value: number, min: number, max: number): NumberField => num(value, min, max, { integer: true });
const bool = (value: boolean): BooleanField => ({ kind: 'boolean', default: value });
const oneOf = <T extends string>(value: T, values: readonly T[]): EnumField<T> => ({
  kind: 'enum',
  default: value,
  values,
});
const pick = (value: number, values: readonly number[]): NumberField =>
  num(value, Math.min(...values), Math.max(...values), { oneOf: values });

// Graphics defaults equal the High preset (see presets.ts); first-run code usually overrides
// them with suggestInitialPreset().
export const SETTINGS_SPEC: Spec<Settings> = {
  graphics: {
    preset: oneOf<GraphicsPreset>('high', ['low', 'medium', 'high', 'ultra', 'custom']),
    renderScale: num(1, 0.25, 2),
    dynamicResolution: bool(true),
    targetFps: int(60, 30, 240),
    visualDetailCascades: { count: int(2, 1, 2), resolution: pick(256, [64, 128, 256, 512]) }, // GpuFft: N ≤ 512
    clipmapRings: int(9, 4, 12),
    clouds: { resolution: oneOf<CloudResolution>('half', ['quarter', 'half']), steps: int(96, 16, 256) },
    shadows: { mapSize: pick(2048, [512, 1024, 2048, 4096]), cascades: int(4, 1, 4) },
    reflections: oneOf<ReflectionMode>('ssr-half', ['env', 'ssr-half', 'ssr-full']),
    ao: oneOf<AmbientOcclusion>('gtao-half', ['off', 'gtao-half', 'gtao-full']),
    aa: oneOf<AntiAliasing>('traa', ['fxaa', 'smaa', 'traa']),
    particleBudget: int(128 * 1024, 1024, 1024 * 1024),
    sailCloth: { cols: int(18, 6, 48), rows: int(26, 8, 64) },
    bloom: bool(true),
    lensDroplets: bool(true),
    fov: num(60, 30, 110),
    fpsCap: int(0, 0, 360),
    showFps: bool(false),
  },
  hud: {
    mode: oneOf<HudMode>('full', ['full', 'minimal', 'off']),
    scale: num(1, 0.5, 2),
    nightDimming: oneOf<NightDimming>('auto', ['auto', 'off']),
    redNightTint: bool(false),
    controlHints: bool(true),
    radar: bool(true),
    units: {
      speed: oneOf<SpeedUnit>('kn', ['kn', 'mph', 'kmh']),
      length: oneOf<LengthUnit>('m', ['m', 'ft']),
      wind: oneOf<WindUnit>('kn', ['kn', 'ms', 'beaufort']),
    },
  },
  // At 100 % the three buses play equally loud (audio/AudioEngine.ts's BUS_TRIM_DB); the defaults
  // are our mix. Master leaves 6 dB to turn up.
  audio: {
    master: num(0.8, 0, 1),
    ambience: num(0.95, 0, 1),
    effects: num(0.75, 0, 1),
    engines: num(0.85, 0, 1),
    muteWhenHidden: bool(true),
  },
  controls: {
    mouseSensitivity: num(1, 0.1, 5),
    invertY: bool(false),
    gamepadDeadZone: num(0.15, 0, 0.5),
    gamepadSensitivity: num(1, 0.1, 5),
    rumble: bool(true),
  },
  physics: {
    mode: oneOf<PhysicsMode>('arcade', ['arcade', 'realistic']),
    capsizeAssist: bool(false),
    telemetryPanel: oneOf<TelemetryPanel>('off', ['off', 'on']),
    dayLength: oneOf<DayLength>('1h', ['real', '6h', '1h', '30m', '15m', 'frozen']),
  },
};

// ---------------------------------------------------------------------------------------------
// Defaults and sanitizing

const isField = (node: unknown): node is Field =>
  typeof node === 'object' && node !== null && 'kind' in node && typeof node.kind === 'string';

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function defaultsOf(spec: unknown): unknown {
  if (isField(spec)) return spec.default;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(spec as Record<string, unknown>)) out[key] = defaultsOf(child);
  return out;
}

export function defaultSettings(): Settings {
  return defaultsOf(SETTINGS_SPEC) as Settings;
}

function sanitizeField(field: Field, value: unknown, fallback: unknown): unknown {
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? value : fallback;
    case 'enum':
      return typeof value === 'string' && field.values.includes(value) ? value : fallback;
    case 'number': {
      // Numeric strings are accepted because hand-edited JSON often quotes them.
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n) || (typeof value === 'string' && value.trim() === '')) return fallback;
      if (field.oneOf) {
        return field.oneOf.reduce((best, v) => (Math.abs(v - n) < Math.abs(best - n) ? v : best));
      }
      const clamped = Math.min(field.max, Math.max(field.min, n));
      return field.integer ? Math.round(clamped) : clamped;
    }
  }
}

// Walks the spec, taking each field from `value` when valid and from `fallback` otherwise.
// Unknown keys are dropped, so stale fields from old versions never leak through.
export function sanitizeWith<T>(spec: Spec<T>, value: unknown, fallback: T): T {
  if (isField(spec)) return sanitizeField(spec, value, fallback) as T;
  const source = isPlainObject(value) ? value : {};
  const base = fallback as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(spec as Record<string, unknown>)) {
    out[key] = sanitizeWith(child as Spec<unknown>, source[key], base[key]);
  }
  return out as T;
}

// Sky clock speed (simulated seconds per real second) for a day length: an hour a day is 24×.
const DAY_LENGTH_MINUTES: Readonly<Record<DayLength, number>> = {
  real: 24 * 60,
  '6h': 360,
  '1h': 60,
  '30m': 30,
  '15m': 15,
  frozen: Infinity,
};

export const dayLengthTimeScale = (dayLength: DayLength): number => (24 * 60) / DAY_LENGTH_MINUTES[dayLength];
