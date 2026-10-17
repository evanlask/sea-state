import { describe, expect, it } from 'vite-plus/test';

import { REGIONS } from '../sim/astro/regions';
import { defaultScenario, formation, parseLaunchOptions, parseTimeOfDay, scenarioSearch } from './Scenario';

describe('parseTimeOfDay', () => {
  it('accepts clock and decimal forms', () => {
    expect(parseTimeOfDay('18:30')).toBe(18.5);
    expect(parseTimeOfDay('6.25')).toBe(6.25);
  });

  it('rejects nonsense', () => {
    expect(parseTimeOfDay('25:00')).toBeNull();
    expect(parseTimeOfDay('dawn')).toBeNull();
  });
});

describe('parseLaunchOptions', () => {
  it('starts the night preset at night unless a time is given', () => {
    expect(parseLaunchOptions('?boat=sail&weather=night-thunderstorm').scenario.timeOfDay).toBe(23);
    expect(parseLaunchOptions('?boat=sail&weather=night-thunderstorm&time=14:00').scenario.timeOfDay).toBe(
      14,
    );
  });

  it('reads a full deep link', () => {
    const options = parseLaunchOptions(
      '?boat=cargo&fleet=pwc,sail,bogus&weather=gale&time=18:30&cam=helm&quality=high&seed=7&physics=realistic&sim=local&debug',
    );
    expect(options.scenario.playerBoat).toBe('cargo');
    expect(options.scenario.fleet).toEqual(['pwc', 'sail']);
    expect(options.scenario.weather).toBe('gale');
    expect(options.scenario.timeOfDay).toBe(18.5);
    expect(options.scenario.camera).toBe('helm');
    expect(options.scenario.seed).toBe(7);
    expect(options.scenario.physicsMode).toBe('realistic');
    expect(options.quality).toBe('high');
    expect(options.simLocal).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.skipMenu).toBe(true);
  });

  it('falls back to defaults and stays in the menu without a boat', () => {
    const options = parseLaunchOptions('?quality=potato');
    expect(options.scenario).toEqual(defaultScenario());
    expect(options.quality).toBeNull();
    expect(options.skipMenu).toBe(false);
  });

  it('sails a deep-linked region in its own season unless a date is given', () => {
    const arctic = parseLaunchOptions('?region=arctic&weather=fair&time=00:30&boat=sail').scenario;
    expect(arctic.region).toBe('arctic');
    expect(arctic.date).toBe(REGIONS.arctic.defaultDate);
    expect(parseLaunchOptions('?region=arctic&date=2026-12-21').scenario.date).toBe('2026-12-21');
    // Unknown regions keep the default date (and fall back to the North Atlantic downstream).
    expect(parseLaunchOptions('?region=atlantis').scenario.date).toBe(defaultScenario().date);
    expect(defaultScenario().region).toBe('north-atlantic');
  });
});

describe('formation', () => {
  it('puts the player at the origin and keeps companions apart', () => {
    const slots = formation('sail', ['cargo', 'pwc', 'crab']);
    expect(slots[0]).toEqual({ kind: 'sail', x: 0, z: 0 });
    const xs = slots.map((slot) => slot.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThan(30);
  });

  it('gives hydroplanes room to swerve at speed', () => {
    const slots = formation('powerboat', ['hydro', 'hydro', 'pwc']);
    expect(slots[1]!.x).toBeGreaterThan(60);
    expect(slots[2]!.x).toBeLessThan(-60);
    const fleet = formation('hydro', ['hydro']);
    expect(fleet[1]!.x).toBeGreaterThan(90);
  });
});

describe('scenarioSearch', () => {
  it('round-trips through parseLaunchOptions and keeps unrelated flags', () => {
    const scenario = {
      ...defaultScenario(),
      playerBoat: 'crab' as const,
      fleet: ['cargo' as const, 'pwc' as const],
      weather: 'gale',
      timeOfDay: 18.75,
      physicsMode: 'realistic' as const,
      seed: 4,
    };
    const search = scenarioSearch(scenario, '?debug&boat=sail&quality=low');
    expect(search).toContain('fleet=cargo,pwc');
    expect(search).toContain('time=18:45');
    const options = parseLaunchOptions(search);
    expect(options.scenario).toEqual(scenario);
    expect(options.skipMenu).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.quality).toBe('low');
  });

  it('strips the scenario for the main menu', () => {
    expect(scenarioSearch(null, '?boat=cargo&weather=gale&debug')).toBe('?debug');
    expect(scenarioSearch(null, '?boat=cargo')).toBe('');
  });
});
