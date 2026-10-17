import { describe, expect, it } from 'vite-plus/test';

import { defaultSetup, type ScenarioSetup } from './setup';
import { setupFromSearch, setupSearch } from './setupLink';

describe('setup deep links', () => {
  it('round-trips survival mode, custom weather, manual sea and loading', () => {
    const base = defaultSetup();
    const setup: ScenarioSetup = {
      ...base,
      playerBoat: 'crab',
      fleet: ['cargo'],
      weather: 'custom',
      customWeather: { ...base.customWeather, windKn: 55, gustKn: 70, windFromDeg: 250, rain: 0.8 },
      sea: {
        ...base.sea,
        mode: 'manual',
        manual: { ...base.sea.manual, spec: 'hs', hs: 7.5, tp: 11, crest: 'long' },
      },
      loading: { cargo: 'ballast', crabPots: 180 },
    };
    const search = setupSearch(setup, '?debug');
    expect(search).toContain('pots=180');
    expect(search).toContain('debug');
    expect(setupFromSearch(search)).toEqual(setup);
  });

  it('round-trips Storm Survival', () => {
    const setup: ScenarioSetup = { ...defaultSetup(), mode: 'storm-survival', weather: 'hurricane-3' };
    const search = setupSearch(setup);
    expect(search).toContain('mode=storm-survival');
    expect(setupFromSearch(search)).toEqual(setup);
  });

  it('keeps everyday links short', () => {
    const search = setupSearch({ ...defaultSetup(), playerBoat: 'sail', weather: 'breezy' });
    expect(search).not.toMatch(/mode=|cargo=|pots=|wx=|sea=/);
    expect(setupFromSearch(search)).toEqual({ ...defaultSetup(), playerBoat: 'sail', weather: 'breezy' });
  });

  it('clamps and ignores nonsense', () => {
    const setup = setupFromSearch('?boat=pwc&mode=bogus&pots=9999&sea=mode:manual,hs:500,crest:wavy');
    expect(setup.mode).toBe('free-sail');
    expect(setup.loading.crabPots).toBe(200);
    expect(setup.sea.mode).toBe('manual');
    expect(setup.sea.manual.hs).toBe(20);
    expect(setup.sea.manual.crest).toBe(defaultSetup().sea.manual.crest);
  });

  it('strips everything for the main menu', () => {
    expect(setupSearch(null, '?boat=crab&mode=storm-survival&sea=mode:manual&quality=low')).toBe(
      '?quality=low',
    );
  });
});
