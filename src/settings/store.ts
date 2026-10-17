// SettingsStore: the single source of truth for player settings. Loads from an injected
// Storage-like backend, migrates and sanitizes whatever it finds, notifies subscribers on change,
// and writes back debounced so dragging a slider doesn't hammer localStorage.

import type { QualityPreset } from '../app/Scenario';
import { dbToGain, gainToVolume, volumeToGain } from '../audio/curves';
import { applyPreset, detectPreset, isQualityPreset } from './presets';
import {
  type DeepPartial,
  type DeepReadonly,
  defaultSettings,
  isPlainObject,
  type Settings,
  type SettingsSection,
  SETTINGS_SPEC,
  sanitizeWith,
} from './schema';

export const SETTINGS_STORAGE_KEY = 'sea-state:settings';

// The subset of the Web Storage API the store needs; tests pass an in-memory fake.
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type ReadonlySettings = DeepReadonly<Settings>;
export type SettingsListener = (settings: ReadonlySettings, previous: ReadonlySettings) => void;

// Dotted leaf paths, e.g. 'graphics.clouds.steps', with the matching value type.
export type SettingsPath<T = Settings> = {
  [K in keyof T & string]: T[K] extends object ? `${K}.${SettingsPath<T[K]>}` : K;
}[keyof T & string];
export type PathValue<T, P extends string> = P extends `${infer K}.${infer Rest}`
  ? K extends keyof T
    ? PathValue<T[K], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

// ---------------------------------------------------------------------------------------------
// Versioning. MIGRATIONS[n] upgrades version n data to version n + 1.

interface Envelope {
  version: number;
  settings: unknown;
}

// v0 was a flat, unversioned object written by early prototypes.
interface SettingsV0 {
  quality?: unknown;
  volume?: unknown;
  invertY?: unknown;
  mouseSensitivity?: unknown;
  units?: unknown; // 'metric' | 'imperial'
  showHud?: unknown;
  physics?: unknown;
}

// v2 calibrated the volume buses (audio/AudioEngine.ts's BUS_TRIM_DB, as of v2) so that 100 % is
// equally loud on each, so the same slider position plays this much louder than in v1.
const V2_BUS_TRIM_DB = { ambience: 1.5, effects: 7.5, engines: 4.5 } as const;

// Moves saved volumes down by the v2 trims so the game sounds exactly as before: v1's defaults
// (100 %) land on v2's.
function rescaleV1Volumes(data: unknown): unknown {
  if (!isPlainObject(data) || !isPlainObject(data.audio)) return data;
  const audio = { ...data.audio };
  for (const [bus, db] of Object.entries(V2_BUS_TRIM_DB)) {
    const volume = audio[bus];
    if (typeof volume !== 'number' || !Number.isFinite(volume)) continue; // the sanitizer decides
    const rescaled = gainToVolume(volumeToGain(volume) / dbToGain(db));
    audio[bus] = Math.round(rescaled * 1e6) / 1e6;
  }
  return { ...data, audio };
}

const MIGRATIONS: readonly ((data: unknown) => unknown)[] = [
  (data) => {
    const v0 = (isPlainObject(data) ? data : {}) as SettingsV0;
    const imperial = v0.units === 'imperial';
    // Invalid values are passed through as-is; the sanitizer replaces them per field later.
    return {
      graphics: { preset: v0.quality },
      hud: {
        mode: v0.showHud === false ? 'off' : 'full',
        units: imperial
          ? { speed: 'mph', length: 'ft', wind: 'kn' }
          : { speed: 'kn', length: 'm', wind: 'kn' },
      },
      audio: { master: v0.volume },
      controls: { invertY: v0.invertY, mouseSensitivity: v0.mouseSensitivity },
      physics: { mode: v0.physics },
    };
  },
  rescaleV1Volumes,
];

export const SETTINGS_VERSION = MIGRATIONS.length;

const isEnvelope = (value: unknown): value is Envelope =>
  isPlainObject(value) && typeof value.version === 'number' && Number.isInteger(value.version);

export function migrate(raw: unknown): unknown {
  let version = isEnvelope(raw) ? raw.version : 0;
  let data = isEnvelope(raw) ? raw.settings : raw;
  // A save from a newer build is read best-effort as the current shape.
  for (; version >= 0 && version < SETTINGS_VERSION; version++) data = MIGRATIONS[version]!(data);
  return data;
}

// Turns anything into valid Settings. Missing graphics values come from the saved preset (if any)
// rather than the global defaults, so `{ graphics: { preset: 'low' } }` really means Low.
function normalize(data: unknown, fallback: Settings = defaultSettings()): Settings {
  const source = isPlainObject(data) ? data : {};
  const savedPreset = isPlainObject(source.graphics) ? source.graphics.preset : undefined;
  const base = isQualityPreset(savedPreset) ? applyPreset(fallback, savedPreset) : fallback;
  const settings = sanitizeWith(SETTINGS_SPEC, source, base);
  settings.graphics.preset = detectPreset(settings.graphics);
  return settings;
}

// ---------------------------------------------------------------------------------------------

export interface SettingsStoreOptions {
  storage?: StorageLike | null; // default: localStorage when available; null = memory only
  key?: string;
  debounceMs?: number;
  firstRunPreset?: QualityPreset; // used when nothing is saved, and by reset('graphics')
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) deepMerge(current, value);
    else target[key] = value;
  }
}

const sameSettings = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function browserStorage(): StorageLike | null {
  try {
    // Accessing localStorage throws in some sandboxed iframes and privacy modes.
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export class SettingsStore {
  readonly #storage: StorageLike | null;
  readonly #key: string;
  readonly #debounceMs: number;
  readonly #defaults: Settings;
  readonly #listeners = new Set<SettingsListener>();
  #state: ReadonlySettings;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SettingsStoreOptions = {}) {
    this.#storage = options.storage === undefined ? browserStorage() : options.storage;
    this.#key = options.key ?? SETTINGS_STORAGE_KEY;
    this.#debounceMs = options.debounceMs ?? 250;
    const defaults = defaultSettings();
    this.#defaults = options.firstRunPreset ? applyPreset(defaults, options.firstRunPreset) : defaults;
    this.#state = deepFreeze(this.#load());
  }

  get(): ReadonlySettings {
    return this.#state;
  }

  // Accepts a deep partial or a recipe that mutates a draft copy. Choosing a named preset applies
  // its values; any other graphics change re-detects the preset (usually flipping to 'custom').
  update(change: DeepPartial<Settings> | ((draft: Settings) => void)): void {
    const current = this.#mutableCopy();
    let next: Settings;
    if (typeof change === 'function') {
      const draft = this.#mutableCopy();
      change(draft);
      const preset = draft.graphics.preset;
      next =
        preset !== current.graphics.preset && isQualityPreset(preset) ? applyPreset(draft, preset) : draft;
    } else {
      const preset = change.graphics?.preset;
      next = isQualityPreset(preset) ? applyPreset(current, preset) : current;
      const graphics: DeepPartial<Settings['graphics']> = { ...change.graphics };
      delete graphics.preset; // already handled, and 'custom' alone means nothing
      deepMerge(next as unknown as Record<string, unknown>, { ...change, graphics });
    }
    this.#commit(next);
  }

  set<P extends SettingsPath>(path: P, value: PathValue<Settings, P>): void {
    this.update((draft) => {
      const keys = path.split('.');
      let node = draft as unknown as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
      node[keys[keys.length - 1]!] = value;
    });
  }

  reset(section?: SettingsSection): void {
    const defaults = structuredClone(this.#defaults);
    const next = section ? this.#mutableCopy() : defaults;
    if (section) (next as unknown as Record<string, unknown>)[section] = defaults[section];
    this.#commit(next);
  }

  subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Writes any pending change now; call on pagehide so the last tweak isn't lost.
  flush(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#save();
  }

  dispose(): void {
    this.flush();
    this.#listeners.clear();
  }

  #mutableCopy(): Settings {
    return structuredClone(this.#state) as Settings;
  }

  #commit(candidate: Settings): void {
    const next = normalize(candidate, this.#mutableCopy());
    if (sameSettings(next, this.#state)) return;
    const previous = this.#state;
    this.#state = deepFreeze(next);
    this.#scheduleSave();
    for (const listener of this.#listeners) {
      try {
        listener(this.#state, previous);
      } catch (error) {
        // One broken subscriber must not stop the others; rethrow out-of-band so it still surfaces.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  #load(): Settings {
    let text: string | null = null;
    try {
      text = this.#storage?.getItem(this.#key) ?? null;
    } catch {
      // Unreadable storage behaves like a first run.
    }
    if (text === null) return structuredClone(this.#defaults);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return structuredClone(this.#defaults);
    }
    return normalize(migrate(raw), structuredClone(this.#defaults));
  }

  #scheduleSave(): void {
    if (!this.#storage) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#save();
    }, this.#debounceMs);
  }

  #save(): void {
    const envelope: Envelope = { version: SETTINGS_VERSION, settings: this.#state };
    try {
      this.#storage?.setItem(this.#key, JSON.stringify(envelope));
    } catch {
      // Quota exceeded or storage disabled: settings still work for this session.
    }
  }
}
