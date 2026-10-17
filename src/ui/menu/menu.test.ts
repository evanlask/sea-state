// Pure menu logic: presets, sea-state estimates, setup building/validation, help tables and
// settings-field bindings.

import { describe, expect, it } from 'vite-plus/test';

import { describeBindings } from '../../input/bindings';
import { POLL_CONTEXTS } from '../../input/contexts';
import { defaultSettings } from '../../settings/schema';
import { SettingsStore } from '../../settings/store';
import { REGION_IDS, REGIONS } from '../../sim/astro/regions';
import { BOAT_SPECS } from '../../sim/boats/specs';
import { BOAT_KINDS } from '../../sim/world/protocol';
import { BOAT_CARDS, formatMass, formatPower, helmClasses, statRows } from './boats';
import { buildHelpTables, keyTokens } from './helpTables';
import {
  allDescriptors,
  choiceOptionsWith,
  coerceForPath,
  formatSetting,
  getAtPath,
  resetTab,
  schemaLeafPaths,
  SETTINGS_TABS,
  specAt,
  writeSetting,
} from './settingsFields';
import {
  buildScenarioSetup,
  dateFromDayOfYear,
  dayOfYear,
  daylight,
  defaultSetup,
  describeDaylight,
  describeRegionClimate,
  nightTimeFor,
  formatClock,
  loadingRelevance,
  loadLastSetup,
  manualHs,
  MAX_FLEET,
  regionSwellText,
  sanitizeSetup,
  saveLastSetup,
  typicalWeatherFor,
  validateSetup,
  withRegion,
} from './setup';
import {
  beaufort,
  describePreset,
  douglasCode,
  estimateSea,
  HS_CAP_M,
  hsForDouglas,
  presetDetail,
  stormPresets,
  validateCustomWeather,
  WEATHER_PRESET_IDS,
  WEATHER_PRESETS,
  weatherPresets,
} from './weather';

const plain = (text: string): string => text.replaceAll('\u00a0', ' ');

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('boat order', () => {
  it('lists the boats smallest to largest', () => {
    const lengths = BOAT_KINDS.map((kind) => BOAT_SPECS[kind].dimensions.loa);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });
});

describe('weather presets', () => {
  it('lists every plan preset in order, custom last', () => {
    expect(weatherPresets().map((p) => p.id)).toEqual([...WEATHER_PRESET_IDS]);
    expect(WEATHER_PRESET_IDS.at(-1)).toBe('custom');
    expect(WEATHER_PRESET_IDS).toHaveLength(16);
  });

  it('runs from calm to hurricane, then the specials', () => {
    expect(WEATHER_PRESET_IDS.slice(0, 9)).toEqual([
      'glassy-calm',
      'fair',
      'breezy',
      'near-gale',
      'gale',
      'storm',
      'hurricane-1',
      'hurricane-3',
      'hurricane-5',
    ]);
  });

  it('describes wind, Beaufort force and Hs', () => {
    expect(plain(describePreset(WEATHER_PRESETS.breezy))).toBe('18 kn (F5) · Hs ~2 m');
    expect(plain(describePreset(WEATHER_PRESETS.squalls))).toBe('24 kn gusting 35 (F6) · Hs ~3.5 m');
    expect(plain(describePreset(WEATHER_PRESETS['glassy-calm']))).toBe('0–2 kn (F1) · Hs ~0.3 m');
    expect(plain(describePreset(WEATHER_PRESETS.gale))).toBe('38 kn (F8) · Hs ~6.5 m');
    expect(plain(describePreset(WEATHER_PRESETS['near-gale']))).toBe('30 kn (F7) · Hs ~5 m');
    // Hurricane cards show the 10-minute mean the wind model uses, and the category's 1-minute wind.
    expect(plain(describePreset(WEATHER_PRESETS['hurricane-5']))).toContain('135 kn (F12)');
    expect(plain(presetDetail(WEATHER_PRESETS['hurricane-5']))).toContain('1-min sustained 145 kn');
    expect(plain(presetDetail(WEATHER_PRESETS['cross-seas']))).toContain('4.5 m swell, 12 s');
  });

  it('keeps value and unit together when cards wrap', () => {
    expect(describePreset(WEATHER_PRESETS.fair)).toContain('8\u00a0kn');
  });

  it('marks storms for Storm Survival', () => {
    const ids = stormPresets().map((p) => p.id);
    expect(ids).toContain('gale');
    expect(ids).toContain('hurricane-5');
    expect(ids).toContain('near-gale');
    expect(ids).not.toContain('cross-seas');
    expect(ids).not.toContain('fair');
    expect(ids).not.toContain('custom');
  });

  it('maps Beaufort boundaries', () => {
    expect(beaufort(0)).toBe(0);
    expect(beaufort(8)).toBe(3);
    expect(beaufort(38)).toBe(8);
    expect(beaufort(64)).toBe(12);
  });
});

describe('sea state', () => {
  it('maps Douglas codes both ways', () => {
    expect(douglasCode(0)).toBe(0);
    expect(douglasCode(2)).toBe(4);
    expect(douglasCode(5.5)).toBe(6);
    expect(douglasCode(30)).toBe(9);
    for (let code = 1; code <= 9; code++) expect(douglasCode(hsForDouglas(code))).toBe(code);
  });

  it('takes the smaller of PM and JONSWAP, and caps hurricanes', () => {
    const breezy = estimateSea(18, 400, false);
    // Pierson-Moskowitz from the 19.5 m wind: Hs = 0.21·U19.5²/g ≈ 0.0225·U10².
    expect(breezy.hs).toBeCloseTo(0.0225 * (18 * 0.514444) ** 2, 1);
    const shortFetch = estimateSea(38, 20, false);
    expect(shortFetch.hs).toBeLessThan(estimateSea(38, 20, true).hs);
    const cat5 = estimateSea(145, 400, false);
    expect(cat5.hs).toBeLessThanOrEqual(HS_CAP_M);
    expect(cat5.hs).toBeGreaterThan(17);
    expect(cat5.tp).toBeLessThan(20);
  });

  it('derives manual Hs from Douglas or Hs', () => {
    const manual = defaultSetup().sea.manual;
    expect(manualHs({ ...manual, spec: 'douglas', douglas: 5 })).toBeCloseTo(3.25);
    expect(manualHs({ ...manual, spec: 'hs', hs: 7.2 })).toBe(7.2);
  });
});

describe('custom weather validation', () => {
  it('passes good input through untouched', () => {
    const { value, issues } = validateCustomWeather({
      windKn: 30,
      windFromDeg: 90,
      gustKn: 40,
      cloudCover: 0.9,
      cloudType: 'cumulonimbus',
      rain: 0.6,
      visibilityKm: 2,
      lightning: 0.5,
    });
    expect(issues).toEqual([]);
    expect(value.windKn).toBe(30);
    expect(value.cloudType).toBe('cumulonimbus');
  });

  it('clamps ranges, raises gusts and fixes inconsistent sky', () => {
    const { value, issues } = validateCustomWeather({
      windKn: 500,
      gustKn: 10,
      windFromDeg: -45,
      cloudType: 'stratus',
      lightning: 0.3,
      visibilityKm: 'nope',
    });
    expect(value.windKn).toBe(160);
    expect(value.gustKn).toBe(160);
    expect(value.windFromDeg).toBe(0);
    expect(value.cloudType).toBe('cumulonimbus');
    expect(value.visibilityKm).toBe(20);
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('clears rain and lightning under clear skies', () => {
    const { value } = validateCustomWeather({ cloudType: 'clear', rain: 1, lightning: 1, cloudCover: 0.5 });
    expect(value).toMatchObject({ cloudType: 'clear', rain: 0, lightning: 0, cloudCover: 0 });
  });

  it('survives garbage', () => {
    expect(validateCustomWeather(null).value.windKn).toBe(15);
    expect(validateCustomWeather('x').issues).toEqual([]);
  });
});

describe('scenario setup', () => {
  it('defaults to Free Sail, Arcade, auto sea', () => {
    const setup = defaultSetup();
    expect(setup.mode).toBe('free-sail');
    expect(setup.physicsMode).toBe('arcade');
    expect(setup.sea.mode).toBe('auto');
    expect(validateSetup(setup)).toEqual([]);
  });

  it('sanitizes anything into a complete setup', () => {
    const setup = sanitizeSetup({
      playerBoat: 'zeppelin',
      fleet: ['cargo', 'nope', 'sail', 'pwc', 'pwc', 'pwc', 'pwc', 'pwc', 'pwc'],
      weather: 'tornado',
      timeOfDay: 30,
      date: '2026-02-31',
      region: 'caribbean',
      sea: { mode: 'manual', manual: { douglas: 12.4, crest: 'long', hs: -1 } },
      loading: { crabPots: 999 },
    });
    const base = defaultSetup();
    expect(setup.playerBoat).toBe(base.playerBoat);
    expect(setup.fleet).toHaveLength(MAX_FLEET);
    expect(setup.fleet.slice(0, 2)).toEqual(['cargo', 'sail']);
    expect(setup.weather).toBe(base.weather);
    expect(setup.timeOfDay).toBe(24);
    expect(setup.date).toBe(base.date);
    expect(setup.region).toBe('caribbean');
    expect(setup.sea.mode).toBe('manual');
    expect(setup.sea.manual).toMatchObject({ douglas: 9, crest: 'long', hs: 0 });
    expect(setup.loading.crabPots).toBe(200);
    expect(sanitizeSetup(undefined)).toEqual(base);
  });

  it('requires a storm for Storm Survival, and the builder enforces it', () => {
    const setup = { ...defaultSetup(), mode: 'storm-survival' as const, weather: 'fair' as const };
    expect(validateSetup(setup).map((i) => i.field)).toEqual(['weather']);
    expect(buildScenarioSetup(setup).weather).toBe('gale');
    expect(validateSetup({ ...setup, weather: 'hurricane-3' })).toEqual([]);
  });

  it('reports custom-weather problems', () => {
    const setup = defaultSetup();
    setup.weather = 'custom';
    setup.customWeather.cloudType = 'clear';
    setup.customWeather.rain = 1;
    expect(validateSetup(setup).some((i) => i.field === 'customWeather')).toBe(true);
  });

  it('builds a detached copy', () => {
    const draft = defaultSetup();
    const built = buildScenarioSetup(draft);
    built.fleet.push('cargo');
    built.sea.manual.hs = 9;
    expect(draft.fleet).toEqual([]);
    expect(draft.sea.manual.hs).not.toBe(9);
  });

  it('moves the date to the region season', () => {
    const setup = withRegion(defaultSetup(), 'bering-sea');
    expect(setup.region).toBe('bering-sea');
    expect(setup.date).toBe(REGIONS['bering-sea'].defaultDate);
    for (const id of REGION_IDS) expect(withRegion(defaultSetup(), id).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('says which loading controls apply', () => {
    expect(loadingRelevance(['powerboat'])).toEqual({ cargo: false, crabPots: false });
    expect(loadingRelevance(['powerboat', 'crab', 'cargo'])).toEqual({ cargo: true, crabPots: true });
  });

  it('round-trips the last setup through storage', () => {
    const storage = new MemoryStorage();
    expect(loadLastSetup(storage)).toBeNull();
    const setup = { ...defaultSetup(), playerBoat: 'crab' as const, weather: 'storm' as const };
    saveLastSetup(storage, setup);
    expect(loadLastSetup(storage)).toEqual(setup);
    storage.setItem('sea-state:last-setup', '{broken');
    expect(loadLastSetup(storage)).toBeNull();
    expect(loadLastSetup(null)).toBeNull();
  });

  it('formats clock and day-of-year dates', () => {
    expect(formatClock(10.5)).toBe('10:30');
    expect(formatClock(23.999)).toBe('00:00');
    expect(formatClock(24)).toBe('00:00');
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-12-31')).toBe(365);
    expect(dateFromDayOfYear(2028, 366)).toBe('2028-12-31');
    expect(dateFromDayOfYear(2026, 400)).toBe('2026-12-31');
    expect(dateFromDayOfYear(2026, dayOfYear('2026-07-15'))).toBe('2026-07-15');
  });

  it('gives a sunrise and sunset in local solar time', () => {
    const light = daylight('caribbean', '2026-03-20');
    expect(light.sunrise!).toBeGreaterThan(5.5);
    expect(light.sunrise!).toBeLessThan(6.5);
    expect(light.sunset!).toBeGreaterThan(17.5);
    expect(describeDaylight(light)).toMatch(/^Sunrise 0\d:\d\d · Sunset 1\d:\d\d$/);
    expect(describeDaylight(daylight('southern-ocean', '2026-06-21'))).not.toBe('');
  });

  it('moves a daytime clock to night for the night preset, and leaves a dark one alone', () => {
    const light = { sunrise: 6, sunset: 18, polar: null };
    expect(nightTimeFor(light, 12)).toBe(20.5);
    expect(nightTimeFor(light, 18.5)).toBe(20.5);
    expect(nightTimeFor(light, 22)).toBe(22);
    expect(nightTimeFor(light, 3)).toBe(3);
    expect(nightTimeFor({ sunrise: 4, sunset: 22.5, polar: null }, 12)).toBe(1);
    expect(nightTimeFor({ sunrise: null, sunset: null, polar: null }, 12)).toBe(23);
  });

  it('finds the darkest time under short nights, the midnight sun and polar night', () => {
    // A three-hour night: its middle, not 2.5 h after sunset (which would be after sunrise).
    expect(nightTimeFor({ sunrise: 1.5, sunset: 22.5, polar: null }, 12)).toBe(0);
    // Midnight sun: local midnight, when the sun is lowest.
    const summer = daylight('arctic', '2026-06-21');
    expect(summer).toEqual({ sunrise: null, sunset: null, polar: 'polar-day' });
    expect(nightTimeFor(summer, 12)).toBe(0);
    // Polar night: dark already, except for the twilight round noon.
    const winter = daylight('arctic', '2026-12-21');
    expect(winter.polar).toBe('polar-night');
    expect(nightTimeFor(winter, 2)).toBe(2);
    expect(nightTimeFor(winter, 12)).toBe(23);
  });

  it('describes the Arctic midnight sun and polar night', () => {
    expect(describeDaylight(daylight('arctic', '2026-06-21'))).toBe('Midnight sun: the sun never sets');
    expect(describeDaylight(daylight('arctic', REGIONS.arctic.defaultDate))).toBe(
      'Midnight sun: the sun never sets',
    );
    expect(describeDaylight(daylight('arctic', '2026-12-21'))).toBe('Polar night: the sun never rises');
    // The equinox has an ordinary day there, every number finite.
    const equinox = daylight('arctic', '2026-03-20');
    expect(equinox.polar).toBeNull();
    expect(Number.isFinite(equinox.sunrise!) && Number.isFinite(equinox.sunset!)).toBe(true);
    expect(describeDaylight(equinox)).toMatch(/^Sunrise \d\d:\d\d · Sunset \d\d:\d\d$/);
    // Every day of the year gives either times or a polar condition, never NaN.
    for (let day = 1; day <= 365; day++) {
      const light = daylight('arctic', dateFromDayOfYear(2026, day));
      if (light.polar === null) {
        expect(Number.isFinite(light.sunrise!) && Number.isFinite(light.sunset!)).toBe(true);
      }
      expect(describeDaylight(light)).not.toBe('');
      expect(Number.isFinite(nightTimeFor(light, 12))).toBe(true);
    }
  });
});

describe('regional climate in setup', () => {
  it('switches to the region’s typical weather until the player picks one', () => {
    const fresh = withRegion(defaultSetup(), 'caribbean');
    expect(fresh.weather).toBe(REGIONS.caribbean.typicalWeather);
    expect(withRegion(fresh, 'arctic').weather).toBe('fair');
    // A deliberate choice survives switching region.
    const picked = { ...defaultSetup(), weather: 'storm' as const };
    expect(withRegion(picked, 'mediterranean', { keepWeather: true }).weather).toBe('storm');
    expect(withRegion(picked, 'mediterranean', { keepWeather: true }).date).toBe(
      REGIONS.mediterranean.defaultDate,
    );
  });

  it('only suggests storm weather in Storm Survival', () => {
    expect(typicalWeatherFor('arctic', 'storm-survival')).toBeNull();
    expect(typicalWeatherFor('bering-sea', 'storm-survival')).toBe('gale');
    const survival = { ...defaultSetup(), mode: 'storm-survival' as const, weather: 'storm' as const };
    expect(withRegion(survival, 'arctic').weather).toBe('storm');
    expect(validateSetup(withRegion(survival, 'caribbean'))).toEqual([]);
    for (const id of REGION_IDS) expect(typicalWeatherFor(id, 'free-sail')).toBe(REGIONS[id].typicalWeather);
  });

  it('describes each region’s swell and weather for its card', () => {
    expect(describeRegionClimate('caribbean')).toBe('Trade-wind swell 1.2 m · 8 s from ENE · usually Breezy');
    expect(regionSwellText('north-atlantic')).toBe('2.5 m swell, 12 s from W (North Atlantic)');
    for (const id of REGION_IDS) expect(describeRegionClimate(id)).toMatch(/\d\.\d m · \d+ s from [NESW]+/);
  });
});

describe('boat cards', () => {
  it('covers every boat with four stats', () => {
    for (const kind of BOAT_KINDS) {
      const rows = statRows(BOAT_CARDS[kind]);
      expect(rows.map((r) => r.label)).toEqual([
        'Length',
        'Mass',
        kind === 'sail' ? 'Sail area' : 'Power',
        'Top speed',
      ]);
    }
  });

  it('formats masses and powers sensibly', () => {
    expect(formatMass(53_330_000)).toBe('53,330 t');
    expect(formatMass(5_572)).toBe('5,572 kg');
    expect(formatPower(67_200)).toBe('67.2 MW');
    expect(formatPower(448)).toBe('448 kW');
  });

  it('groups boats into helm classes covering every kind once', () => {
    const kinds = helmClasses().flatMap((c) => c.boats);
    expect([...kinds].sort()).toEqual([...BOAT_KINDS].sort());
    expect(helmClasses().find((c) => c.context === 'ship')!.boats).toEqual(['crab', 'cargo']);
  });
});

describe('help tables', () => {
  it('groups every describeBindings row, boat first then camera then global', () => {
    for (const context of POLL_CONTEXTS) {
      const tables = buildHelpTables(context);
      expect(tables.flatMap((t) => t.rows)).toEqual(describeBindings(context));
      if (context !== 'menu') expect(tables.map((t) => t.group)).toEqual([context, 'camera', 'global']);
    }
  });

  it('shows the sail context controls', () => {
    const sail = buildHelpTables('sail')[0]!;
    expect(sail.title).toBe('Helm · sailboat');
    expect(sail.rows.map((r) => r.id)).toContain('reefIn');
  });

  it('splits key text into caps and separators', () => {
    expect(keyTokens('W / S')).toEqual([
      { text: 'W', cap: true },
      { text: '/', cap: false },
      { text: 'S', cap: true },
    ]);
    expect(keyTokens('Left stick X')).toEqual([{ text: 'Left stick X', cap: true }]);
    expect(keyTokens('↑ ↓ ← →').filter((t) => t.cap)).toHaveLength(4);
    expect(keyTokens('—')).toEqual([{ text: '—', cap: false }]);
  });
});

describe('settings fields', () => {
  it('covers every schema leaf except the preset (which has its own buttons)', () => {
    const covered = allDescriptors().map((d) => d.path);
    const leaves = schemaLeafPaths().filter((p) => p !== 'graphics.preset');
    expect([...covered].sort()).toEqual([...leaves].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('matches control types and ranges to the schema', () => {
    for (const d of allDescriptors()) {
      const spec = specAt(d.path);
      if (d.control.kind === 'toggle') expect(spec.kind).toBe('boolean');
      if (d.control.kind === 'range') {
        expect(spec.kind).toBe('number');
        if (spec.kind === 'number') {
          expect(d.control.min).toBeGreaterThanOrEqual(spec.min);
          expect(d.control.max).toBeLessThanOrEqual(spec.max);
        }
      }
      if (d.control.kind === 'choice') {
        for (const o of d.control.options) expect(coerceForPath(d.path, o.value)).toBe(o.value);
      }
      expect(d.description.length).toBeGreaterThan(0);
    }
  });

  it('every default value is shown by its control', () => {
    const settings = defaultSettings();
    for (const d of allDescriptors()) {
      const value = getAtPath(settings, d.path);
      if (d.control.kind === 'choice') expect(d.control.options.some((o) => o.value === value)).toBe(true);
    }
  });

  it('coerces raw control values to the schema type', () => {
    expect(coerceForPath('graphics.clipmapRings', '7.6')).toBe(8);
    expect(coerceForPath('graphics.renderScale', 9)).toBe(2);
    expect(coerceForPath('hud.mode', 'loud')).toBeNull();
    expect(coerceForPath('controls.invertY', 'true')).toBeNull();
    expect(coerceForPath('controls.invertY', true)).toBe(true);
  });

  it('formats values for display', () => {
    const scale = allDescriptors().find((d) => d.path === 'graphics.renderScale')!;
    expect(formatSetting(scale, 0.67)).toBe('0.67×');
    const fps = allDescriptors().find((d) => d.path === 'graphics.fpsCap')!;
    expect(formatSetting(fps, 0)).toBe('Off');
  });

  it('adds an off-list choice so odd saved values stay visible', () => {
    const fps = allDescriptors().find((d) => d.path === 'graphics.fpsCap')!;
    const options = choiceOptionsWith(fps, 75);
    expect(options.map((o) => o.value)).toEqual([0, 30, 60, 75, 120, 144]);
    expect(choiceOptionsWith(fps, 60)).toHaveLength(5);
  });

  it('writes through the store, flipping the preset to custom', () => {
    const store = new SettingsStore({ storage: null });
    expect(writeSetting(store, 'graphics.clouds.steps', 200)).toBe(true);
    expect(store.get().graphics.clouds.steps).toBe(200);
    expect(store.get().graphics.preset).toBe('custom');
    expect(writeSetting(store, 'hud.units.wind', 'furlongs')).toBe(false);
    expect(store.get().hud.units.wind).toBe('kn');
    store.dispose();
  });

  it('resets exactly the fields a tab shows, wherever they live in the schema', () => {
    const store = new SettingsStore({ storage: null });
    store.update({ graphics: { showFps: true, renderScale: 0.5 }, hud: { scale: 1.4 } });
    resetTab(
      store,
      SETTINGS_TABS.find((t) => t.section === 'hud')!,
    );
    expect(store.get().graphics.showFps).toBe(false);
    expect(store.get().hud.scale).toBe(1);
    expect(store.get().graphics.renderScale).toBe(0.5);
    store.dispose();
  });

  it('orders the tabs Gameplay, Graphics, Audio, Controls, HUD', () => {
    expect(SETTINGS_TABS.map((t) => t.title)).toEqual(['Gameplay', 'Graphics', 'Audio', 'Controls', 'HUD']);
  });
});

describe('fleet autopilot choices', () => {
  it('offers a wind angle to sailboats and a course to everything else', async () => {
    const { autopilotModes } = await import('./screens/pauseScreens');
    expect(autopilotModes('sail').map(([m]) => m)).toEqual(['follow', 'windAngle', 'circle', 'drift']);
    expect(autopilotModes('cargo').map(([m]) => m)).toEqual(['follow', 'hold', 'circle', 'drift']);
  });
});
