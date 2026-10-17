// SettingsStore: persistence, recovery from bad data, migrations, presets and subscriptions.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { BUS_TRIM_DB } from '../audio/AudioEngine';
import { dbToGain, volumeToGain } from '../audio/curves';
import { dayLengthTimeScale, defaultSettings } from './schema';
import { migrate, SETTINGS_STORAGE_KEY, SETTINGS_VERSION, SettingsStore, type StorageLike } from './store';

class MemoryStorage implements StorageLike {
  readonly data = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const withText = (text: string): MemoryStorage => {
  const storage = new MemoryStorage();
  storage.data.set(SETTINGS_STORAGE_KEY, text);
  return storage;
};
const saved = (settings: unknown, version = SETTINGS_VERSION): MemoryStorage =>
  withText(JSON.stringify({ version, settings }));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SettingsStore defaults', () => {
  it('starts from defaults with arcade physics and no capsize assist', () => {
    const store = new SettingsStore({ storage: new MemoryStorage() });
    expect(store.get()).toEqual(defaultSettings());
    expect(store.get().physics.mode).toBe('arcade');
    expect(store.get().physics.capsizeAssist).toBe(false);
  });

  it('uses the first-run preset only when nothing is saved', () => {
    const fresh = new SettingsStore({ storage: new MemoryStorage(), firstRunPreset: 'low' });
    expect(fresh.get().graphics.preset).toBe('low');
    const storage = saved({ graphics: { preset: 'ultra' } });
    expect(new SettingsStore({ storage, firstRunPreset: 'low' }).get().graphics.preset).toBe('ultra');
  });

  it('returns frozen snapshots', () => {
    const store = new SettingsStore({ storage: null });
    expect(Object.isFrozen(store.get().graphics.clouds)).toBe(true);
  });
});

describe('SettingsStore persistence', () => {
  it('round-trips through storage with a version envelope, debounced', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore({ storage, debounceMs: 100 });
    store.update({ audio: { master: 0.3 } });
    store.set('hud.units.speed', 'kmh');
    store.update((draft) => {
      draft.controls.invertY = true;
    });
    expect(storage.writes).toBe(0);
    vi.advanceTimersByTime(100);
    expect(storage.writes).toBe(1);

    const envelope = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
    expect(envelope.version).toBe(SETTINGS_VERSION);

    const reloaded = new SettingsStore({ storage });
    expect(reloaded.get()).toEqual(store.get());
    expect(reloaded.get().audio.master).toBe(0.3);
    expect(reloaded.get().hud.units.speed).toBe('kmh');
    expect(reloaded.get().controls.invertY).toBe(true);
  });

  it('flush writes a pending change immediately', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore({ storage });
    store.update({ hud: { scale: 1.5 } });
    store.flush();
    expect(storage.writes).toBe(1);
    vi.runAllTimers();
    expect(storage.writes).toBe(1);
  });

  it('does not write when nothing changed', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore({ storage });
    store.update({ audio: { master: defaultSettings().audio.master } });
    vi.runAllTimers();
    expect(storage.writes).toBe(0);
  });

  it('survives storage that throws', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    const store = new SettingsStore({ storage: broken });
    store.update({ audio: { master: 0.5 } });
    expect(() => store.flush()).not.toThrow();
    expect(store.get().audio.master).toBe(0.5);
  });
});

describe('SettingsStore recovery', () => {
  it('falls back to defaults on corrupt JSON', () => {
    const storage = withText('{"version":1,"settings":{"aud');
    expect(new SettingsStore({ storage }).get()).toEqual(defaultSettings());
  });

  it('falls back on non-object JSON', () => {
    for (const text of ['null', '42', '"hi"', '[1,2]', '{"version":1,"settings":null}']) {
      expect(new SettingsStore({ storage: withText(text) }).get()).toEqual(defaultSettings());
    }
  });

  it('clamps out-of-range values and replaces invalid ones per field', () => {
    const storage = saved({
      graphics: {
        renderScale: 9,
        fov: -5,
        shadows: { mapSize: 3000, cascades: 2.6 },
        aa: 'msaa',
        bloom: 'yes',
      },
      hud: { scale: 0.01, mode: 'minimal', units: { speed: 'mph', wind: 'furlongs' } },
      audio: { master: 2, effects: -1, engines: '0.25', ambience: null },
      controls: { gamepadDeadZone: 0.9, rumble: false },
      physics: { mode: 'simcade', telemetryPanel: 'on', dayLength: 'forever' },
      extra: { junk: true },
    });
    const s = new SettingsStore({ storage }).get();
    const d = defaultSettings();
    expect(s.graphics.renderScale).toBe(2);
    expect(s.graphics.fov).toBe(30);
    expect(s.graphics.shadows).toEqual({ mapSize: 2048, cascades: 3 }); // snapped / rounded
    expect(s.graphics.aa).toBe(d.graphics.aa);
    expect(s.graphics.bloom).toBe(d.graphics.bloom);
    expect(s.graphics.preset).toBe('custom');
    expect(s.hud.scale).toBe(0.5);
    expect(s.hud.mode).toBe('minimal');
    expect(s.hud.units).toEqual({ speed: 'mph', length: d.hud.units.length, wind: d.hud.units.wind });
    expect(s.audio).toMatchObject({ master: 1, effects: 0, engines: 0.25, ambience: d.audio.ambience });
    expect(s.controls).toMatchObject({ gamepadDeadZone: 0.5, rumble: false });
    expect(s.physics).toEqual({
      mode: 'arcade',
      capsizeAssist: false,
      telemetryPanel: 'on',
      dayLength: '1h',
    });
    expect('extra' in s).toBe(false);
  });

  it('fills missing graphics values from the saved preset', () => {
    const s = new SettingsStore({ storage: saved({ graphics: { preset: 'low', fov: 70 } }) }).get();
    expect(s.graphics.preset).toBe('low');
    expect(s.graphics.renderScale).toBe(0.67);
    expect(s.graphics.fov).toBe(70);
  });

  it('gives a setting added since the save its default, keeping the rest', () => {
    // A save without graphics.showFps (a field added after it was written).
    const { showFps: _, ...older } = { ...defaultSettings().graphics, fpsCap: 60 };
    const s = new SettingsStore({ storage: saved({ graphics: older }) }).get();
    expect(s.graphics.showFps).toBe(false);
    expect(s.graphics.fpsCap).toBe(60);
    expect(s.graphics.preset).toBe(defaultSettings().graphics.preset);
  });

  it('sanitizes values passed to update', () => {
    const store = new SettingsStore({ storage: null });
    store.update({ audio: { master: 7 }, hud: { mode: 'huge' as never } });
    expect(store.get().audio.master).toBe(1);
    expect(store.get().hud.mode).toBe('full');
  });

  it('snaps a saved detail-wave resolution the menu no longer offers to the largest supported one', () => {
    // 1024 is past the GPU FFT's 512 limit.
    const graphics = { ...defaultSettings().graphics, visualDetailCascades: { count: 2, resolution: 1024 } };
    const s = new SettingsStore({ storage: saved({ graphics }) }).get();
    expect(s.graphics.visualDetailCascades).toEqual({ count: 2, resolution: 512 });
    expect(s.graphics.preset).toBe('custom');
    expect(s.graphics.fov).toBe(graphics.fov);
  });
});

describe('SettingsStore migrations', () => {
  it('upgrades a flat v0 object', () => {
    const storage = withText(
      JSON.stringify({ quality: 'medium', volume: 0.4, invertY: true, units: 'imperial', showHud: false }),
    );
    const s = new SettingsStore({ storage }).get();
    expect(s.graphics.preset).toBe('medium');
    expect(s.graphics.renderScale).toBe(0.8);
    expect(s.audio.master).toBe(0.4);
    expect(s.controls.invertY).toBe(true);
    expect(s.hud.units).toEqual({ speed: 'mph', length: 'ft', wind: 'kn' });
    expect(s.hud.mode).toBe('off');
    expect(s.physics.mode).toBe('arcade');
  });

  it('recovers per field from a garbage v0 object', () => {
    expect(migrate({ quality: 'insane', volume: 'loud' })).toMatchObject({ graphics: { preset: 'insane' } });
    const storage = withText(JSON.stringify({ quality: 'insane', volume: 'loud' }));
    expect(new SettingsStore({ storage }).get()).toEqual(defaultSettings());
  });

  it('keeps a v1 save sounding the same through the v2 volume calibration', () => {
    const v1 = { audio: { master: 0.6, ambience: 1, effects: 0.5, engines: 0.05, muteWhenHidden: false } };
    const s = new SettingsStore({ storage: saved(v1, 1) }).get();
    expect(s.audio.master).toBe(0.6);
    expect(s.audio.muteWhenHidden).toBe(false);
    for (const bus of ['ambience', 'effects', 'engines'] as const) {
      const heard = dbToGain(BUS_TRIM_DB[bus]) * volumeToGain(s.audio[bus]);
      expect(heard).toBeCloseTo(volumeToGain(v1.audio[bus]), 5);
    }
    expect(s.audio.effects).toBeCloseTo(0.25, 6); // 7.5 dB is five 5 % steps
  });

  it('moves v1 players on the old defaults (every bus at 100 %) onto the new defaults', () => {
    const v1 = { audio: { master: 0.8, ambience: 1, effects: 1, engines: 1, muteWhenHidden: true } };
    expect(new SettingsStore({ storage: saved(v1, 1) }).get().audio).toEqual(defaultSettings().audio);
    // A v1 save without the volumes gets the new defaults, which sound like v1's.
    expect(new SettingsStore({ storage: saved({ hud: {} }, 1) }).get().audio).toEqual(
      defaultSettings().audio,
    );
  });

  it('reads a save from a newer version best-effort', () => {
    const s = new SettingsStore({ storage: saved({ audio: { master: 0.2 } }, SETTINGS_VERSION + 5) }).get();
    expect(s.audio.master).toBe(0.2);
  });
});

describe('SettingsStore presets', () => {
  it('choosing a preset applies its values', () => {
    const store = new SettingsStore({ storage: null });
    store.update({ graphics: { preset: 'ultra' } });
    expect(store.get().graphics.preset).toBe('ultra');
    expect(store.get().graphics.shadows.mapSize).toBe(4096);
    store.set('graphics.preset', 'low');
    expect(store.get().graphics.clipmapRings).toBe(6);
  });

  it('editing one graphics field flips to custom, restoring it flips back', () => {
    const store = new SettingsStore({ storage: null });
    store.update({ graphics: { preset: 'medium' } });
    store.set('graphics.clipmapRings', 7);
    expect(store.get().graphics.preset).toBe('custom');
    store.update({ graphics: { clipmapRings: 8 } });
    expect(store.get().graphics.preset).toBe('medium');
  });

  it('non-preset graphics preferences do not affect the preset', () => {
    const store = new SettingsStore({ storage: null });
    store.update({ graphics: { fov: 80, lensDroplets: false, fpsCap: 60 } });
    expect(store.get().graphics.preset).toBe('high');
  });
});

describe('SettingsStore subscriptions and reset', () => {
  it('notifies subscribers with the new and previous settings until unsubscribed', () => {
    const store = new SettingsStore({ storage: null });
    const seen: string[] = [];
    const unsubscribe = store.subscribe((next, previous) =>
      seen.push(`${previous.hud.mode}->${next.hud.mode}`),
    );
    store.update({ hud: { mode: 'minimal' } });
    store.update({ hud: { mode: 'minimal' } }); // no change, no notification
    unsubscribe();
    store.update({ hud: { mode: 'off' } });
    expect(seen).toEqual(['full->minimal']);
  });

  it('a throwing listener does not block the others', () => {
    const store = new SettingsStore({ storage: null });
    const good = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(good);
    const microtask = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation(() => undefined);
    store.update({ audio: { master: 0.1 } });
    expect(good).toHaveBeenCalledTimes(1);
    expect(microtask).toHaveBeenCalledTimes(1); // error rethrown out-of-band
    microtask.mockRestore();
  });

  it('resets one section or everything', () => {
    const store = new SettingsStore({ storage: null, firstRunPreset: 'medium' });
    store.update({ audio: { master: 0.1 }, hud: { scale: 2 }, graphics: { preset: 'ultra' } });
    store.reset('audio');
    expect(store.get().audio).toEqual(defaultSettings().audio);
    expect(store.get().hud.scale).toBe(2);
    store.reset('graphics');
    expect(store.get().graphics.preset).toBe('medium');
    store.reset();
    expect(store.get().hud.scale).toBe(1);
  });
});

describe('day length', () => {
  it('turns a day length into a sky clock speed', () => {
    expect(dayLengthTimeScale('1h')).toBe(24);
    expect(dayLengthTimeScale('30m')).toBe(48);
    expect(dayLengthTimeScale('real')).toBe(1);
    expect(dayLengthTimeScale('15m')).toBe(96);
    expect(dayLengthTimeScale('frozen')).toBe(0);
  });
});
