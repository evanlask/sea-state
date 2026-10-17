import { describe, expect, it } from 'vite-plus/test';

import { REGION_IDS, REGIONS } from '../sim/astro/regions';
import { DEG } from '../sim/core/conventions';
import { msToKnots } from '../sim/core/units';
import { getWeatherPreset } from '../sim/weather/presets';
import { resolveSeaState } from '../sim/weather/seaState';
import { defaultSetup } from '../ui/menu/setup';
import { loadedStability } from './hudModel';
import { defaultScenario, formation } from './Scenario';
import {
  blendSceneWeather,
  cloudMorph,
  CONDITION_TRANSITIONS,
  conditionsCommand,
  conditionsFor,
  joiningSpawn,
  loadFor,
  regionSwell,
  sceneWeatherFor,
  seaStateFor,
  simConfigFor,
  weatherChanged,
  windFor,
  withConditions,
} from './scenarioConfig';

describe('scenario config', () => {
  it('uses the preset wind and sea for a deep-linked scenario', () => {
    const scenario = { ...defaultScenario(), weather: 'gale' };
    expect(msToKnots(windFor(scenario).speed)).toBeCloseTo(38);
    expect(seaStateFor(scenario).mode).toBe('auto');
  });

  it('reads the custom weather panel', () => {
    const setup = defaultSetup();
    setup.weather = 'custom';
    setup.customWeather = { ...setup.customWeather, windKn: 20, gustKn: 30, windFromDeg: 90 };
    const wind = windFor(setup);
    expect(msToKnots(wind.speed)).toBeCloseTo(20);
    expect(wind.gustFactor).toBeCloseTo(1.5);
    expect(wind.from).toBeCloseTo(90 * DEG);
  });

  it('keeps a hurricane preset’s short fetch in auto mode', () => {
    const setup = defaultSetup();
    setup.weather = 'hurricane-3';
    const sea = seaStateFor(setup);
    expect(sea.mode === 'auto' && sea.fetch).toBe(250_000);
  });

  it('maps manual sea controls', () => {
    const setup = defaultSetup();
    setup.sea.mode = 'manual';
    setup.sea.manual = { ...setup.sea.manual, spec: 'hs', hs: 4, swellHeight: 0 };
    const sea = seaStateFor(setup);
    expect(sea.mode).toBe('manual');
    expect(sea.mode === 'manual' && sea.height).toEqual({ kind: 'hs', hs: 4 });
    expect(sea.swell).toBeNull();
  });

  it('runs the region’s swell under presets without one, in auto sea only', () => {
    const swellOf = (choices: Parameters<typeof seaStateFor>[0]) => seaStateFor(choices).swell;
    for (const region of REGION_IDS) {
      const expected = regionSwell(region);
      expect(expected.height).toBe(REGIONS[region].swell.height);
      expect(expected.from).toBeCloseTo(REGIONS[region].swell.fromDeg * DEG);
      // Setup (auto sea), deep link (no sea setup) and custom weather all take the region's swell.
      expect(swellOf({ ...defaultSetup(), region, weather: 'breezy' })).toEqual(expected);
      expect(swellOf({ ...defaultScenario(), region, weather: 'gale' })).toEqual(expected);
      expect(swellOf({ ...defaultSetup(), region, weather: 'custom' })).toEqual(expected);
      // Presets with a swell of their own keep it.
      for (const weather of ['glassy-calm', 'fog-bank', 'long-swell', 'cross-seas']) {
        expect(swellOf({ ...defaultSetup(), region, weather })).toEqual(
          getWeatherPreset(weather).seaState.swell,
        );
        expect(swellOf({ ...defaultScenario(), region, weather })).toEqual(
          getWeatherPreset(weather).seaState.swell,
        );
      }
    }
    // Manual sea ignores the region: the player's swell or none.
    const manual = { ...defaultSetup(), region: 'southern-ocean' as const };
    manual.sea.mode = 'manual';
    manual.sea.manual.swellHeight = 0;
    expect(swellOf(manual)).toBeNull();
    // Unknown regions fall back to the North Atlantic's swell.
    expect(swellOf({ ...defaultScenario(), region: 'atlantis' })).toEqual(regionSwell('north-atlantic'));
  });

  it('leaves a storm sea dominated by the wind sea', () => {
    for (const weather of ['storm', 'hurricane-3']) {
      const choices = { ...defaultSetup(), region: 'southern-ocean' as const, weather };
      const wind = windFor(choices);
      const sea = resolveSeaState(seaStateFor(choices), wind.speed, wind.from);
      const bare = resolveSeaState(getWeatherPreset(weather).seaState, wind.speed, wind.from);
      expect(sea.hs).toBeCloseTo(bare.hs);
      expect(sea.totalHs / bare.totalHs).toBeLessThan(1.1);
    }
  });

  it('spawns the fleet in formation with the player first', () => {
    const setup = { ...defaultSetup(), playerBoat: 'sail' as const, fleet: ['pwc' as const] };
    const config = simConfigFor(setup, 'low');
    expect(config.boats.map((boat) => boat.id)).toEqual(['player', 'fleet-1']);
    expect(config.boats[0]?.kind).toBe('sail');
  });

  it('builds the voyage with the detail layout and capsize assist from the settings', () => {
    const config = simConfigFor(defaultSetup(), { count: 1, resolution: 512 }, true);
    expect(config.oceanQuality).toEqual({ count: 1, resolution: 512 });
    expect(config.capsizeAssist).toBe(true);
    expect(simConfigFor(defaultSetup(), 'low').capsizeAssist).toBe(false);
  });
});

describe('live conditions', () => {
  it('maps conditions onto a setConditions command with the mode’s transition times', () => {
    const choices = withConditions(defaultScenario(), {
      ...conditionsFor(defaultScenario()),
      weather: 'gale',
    });
    const arcade = conditionsCommand(choices, 'arcade');
    const realistic = conditionsCommand(choices, 'realistic');
    if (arcade.type !== 'setConditions' || realistic.type !== 'setConditions')
      throw new Error('wrong command');
    expect(msToKnots(arcade.wind.speed)).toBeCloseTo(38);
    expect(arcade.seaState).toEqual(seaStateFor(choices));
    expect(arcade.seaTransition).toBe(CONDITION_TRANSITIONS.arcade.sea);
    expect(arcade.seaTransition).toBeLessThanOrEqual(5);
    // In Realistic mode the sea lags the wind by a lot more.
    expect(realistic.seaTransition).toBeGreaterThanOrEqual(60);
    expect(realistic.seaTransition).toBeGreaterThan(realistic.windTransition);
  });

  it('carries the custom panel and manual sea into the command', () => {
    const setup = defaultSetup();
    const conditions = conditionsFor(setup);
    conditions.weather = 'custom';
    conditions.customWeather = { ...conditions.customWeather, windKn: 30, gustKn: 45, windFromDeg: 180 };
    conditions.sea = {
      ...conditions.sea,
      mode: 'manual',
      manual: { ...conditions.sea.manual, spec: 'hs', hs: 6 },
    };
    const command = conditionsCommand(withConditions(setup, conditions), 'arcade');
    if (command.type !== 'setConditions') throw new Error('wrong command');
    expect(msToKnots(command.wind.speed)).toBeCloseTo(30);
    expect(command.wind.gustFactor).toBeCloseTo(1.5);
    expect(command.wind.from).toBeCloseTo(Math.PI);
    expect(command.seaState.mode === 'manual' && command.seaState.height).toEqual({ kind: 'hs', hs: 6 });
  });

  it('gives a deep link’s preset the default sea, which leaves the preset’s sea unchanged', () => {
    const scenario = { ...defaultScenario(), weather: 'long-swell', timeOfDay: 18.5 };
    const conditions = conditionsFor(scenario);
    expect(conditions.weather).toBe('long-swell');
    expect(conditions.timeOfDay).toBe(18.5);
    expect(seaStateFor(withConditions(scenario, conditions))).toEqual(seaStateFor(scenario));
  });

  it('tells a weather change from a time change', () => {
    const a = conditionsFor(defaultSetup());
    expect(weatherChanged(a, { ...a, timeOfDay: 3 })).toBe(false);
    expect(weatherChanged(a, { ...a, weather: 'storm' })).toBe(true);
    expect(weatherChanged(a, { ...a, sea: { ...a.sea, fetchKm: 50 } })).toBe(true);
  });

  it('blends the scene weather, stepping the clouds', () => {
    const fair = sceneWeatherFor({ ...defaultScenario(), weather: 'fair' });
    const storm = sceneWeatherFor({ ...defaultScenario(), weather: 'storm' });
    expect(blendSceneWeather(fair, storm, 0)).toEqual(fair);
    expect(blendSceneWeather(fair, storm, 1)).toEqual(storm);
    const mid = blendSceneWeather(fair, storm, 0.53);
    expect(mid.visibility).toBeCloseTo(fair.visibility + (storm.visibility - fair.visibility) * 0.53);
    expect(mid.clouds.type).toBe(storm.clouds.type);
    expect(mid.clouds.coverage).toBeCloseTo(
      fair.clouds.coverage + (storm.clouds.coverage - fair.clouds.coverage) * 0.5,
    );
    // The cloud type morphs continuously rather than switching halfway.
    expect(mid.clouds).toMatchObject({ type: storm.clouds.type, morphFrom: fair.clouds.type, morph: 0.53 });
    expect(blendSceneWeather(fair, storm, 0.44).clouds.morph).toBeCloseTo(0.44);
  });

  it('carries a cloud morph on, turns it back or re-aims it without a jump', () => {
    const a = {
      type: 'cumulonimbus' as const,
      coverage: 0.6,
      base: 700,
      morphFrom: 'cumulus' as const,
      morph: 0.3,
    };
    // A new change towards the same type carries on from 30 %.
    expect(cloudMorph(a, 'cumulonimbus', 0)).toEqual({
      type: 'cumulonimbus',
      morphFrom: 'cumulus',
      morph: 0.3,
    });
    expect(cloudMorph(a, 'cumulonimbus', 0.5).morph).toBeCloseTo(0.65);
    // Turning back starts 70 % of the way to cumulus.
    expect(cloudMorph(a, 'cumulus', 0)).toEqual({ type: 'cumulus', morphFrom: 'cumulonimbus', morph: 0.7 });
    expect(cloudMorph(a, 'cumulus', 1)).toEqual({ type: 'cumulus' });
    // A third type starts from the nearer of the two.
    expect(cloudMorph(a, 'stratus', 0.2)).toEqual({ type: 'stratus', morphFrom: 'cumulus', morph: 0.2 });
    expect(cloudMorph({ ...a, morph: 0.8 }, 'stratus', 0.2).morphFrom).toBe('cumulonimbus');
    // Nothing to morph.
    expect(cloudMorph({ type: 'cumulus', coverage: 0.3, base: 900 }, 'cumulus', 0.5)).toEqual({
      type: 'cumulus',
    });
  });
});

describe('boats joining mid-voyage', () => {
  const player = { kind: 'crab' as const, x: 100, z: -50, heading: 0 };

  it('take the next slot of the formation, starboard then port', () => {
    const first = joiningSpawn('fleet-1', 'pwc', player, []);
    const slots = formation('crab', ['pwc', 'sail']);
    expect(first.x - player.x).toBeCloseTo(slots[1]!.x);
    expect(first.z).toBeCloseTo(player.z);
    const second = joiningSpawn('fleet-2', 'sail', player, [{ ...first }]);
    expect(second.x - player.x).toBeCloseTo(slots[2]!.x);
    expect(second.id).toBe('fleet-2');
    expect(second.heading).toBe(0);
  });

  it('measure the line in the player’s frame and keep clear of the biggest boat', () => {
    // Heading east: starboard is south (+z).
    const east = { ...player, heading: Math.PI / 2 };
    const spawn = joiningSpawn('fleet-3', 'pwc', east, []);
    expect(spawn.x).toBeCloseTo(east.x);
    expect(spawn.z).toBeGreaterThan(east.z + 30);
    // A cargo ship already on the starboard side pushes the newcomer to port.
    const ship = { kind: 'cargo' as const, x: east.x, z: east.z + 120, heading: east.heading };
    const next = joiningSpawn('fleet-4', 'pwc', east, [ship]);
    expect(next.z).toBeLessThan(east.z - 30);
  });
});

describe('loading condition', () => {
  it('reaches every cargo ship and crab boat in the fleet, and boats joining later', () => {
    const choices = {
      ...defaultScenario(),
      playerBoat: 'crab' as const,
      fleet: ['cargo' as const, 'pwc' as const],
      loading: { cargo: 'ballast' as const, crabPots: 0 },
    };
    const boats = simConfigFor(choices, 'low').boats;
    expect(boats.map((b) => b.load)).toEqual([{ crabPots: 0 }, { cargo: 'ballast' }, undefined]);
    const spawn = joiningSpawn(
      'fleet-9',
      'crab',
      { kind: 'crab', x: 0, z: 0, heading: 0 },
      [],
      loadFor('crab', choices),
    );
    expect(spawn.load).toEqual({ crabPots: 0 });
  });

  it('defaults to the setup screen’s loading when a deep link has none', () => {
    expect(loadFor('crab', defaultScenario())).toEqual({ crabPots: defaultSetup().loading.crabPots });
  });

  it('pulls the HUD danger zone in with a loaded boat’s smaller AVS', () => {
    const base = { dangerHeel: 40 * DEG, avs: 72 * DEG };
    expect(loadedStability(base, undefined)).toBe(base);
    expect(loadedStability(base, 72 * DEG)).toBe(base);
    const loaded = loadedStability(base, 36 * DEG);
    expect(loaded.avs).toBeCloseTo(36 * DEG);
    expect(loaded.dangerHeel).toBeCloseTo(20 * DEG);
  });
});
