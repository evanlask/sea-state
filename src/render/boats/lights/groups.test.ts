import { describe, expect, it } from 'vite-plus/test';

import { BOAT_KINDS, type BoatKind } from '../../../sim/world/protocol';
import { EXTRA_LIGHTS, hasLightGroup, type LightGroup, lightFittings } from './groups';
import { deckGroupOf, defaultDeckMounts } from './mounts';

const GROUPS: readonly LightGroup[] = ['nav', 'deck', 'cabin', 'signals', 'extra'];
const fitted = (kind: BoatKind): LightGroup[] => GROUPS.filter((g) => hasLightGroup(kind, g));

describe('light groups', () => {
  it('gives each boat the switches it has fittings for', () => {
    expect(fitted('cargo')).toEqual(GROUPS);
    expect(fitted('cruise')).toEqual(GROUPS);
    expect(fitted('crab')).toEqual(GROUPS);
    expect(fitted('sail')).toEqual(['nav', 'deck', 'cabin', 'signals']);
    expect(fitted('powerboat')).toEqual(['nav', 'deck', 'signals', 'extra']);
    expect(fitted('pwc')).toEqual(['nav', 'extra']);
  });

  it('names every boat’s extras', () => {
    for (const kind of BOAT_KINDS) {
      const extra = lightFittings(kind).extra;
      if (extra !== null) expect(extra).toBe(EXTRA_LIGHTS[kind]?.short);
    }
    expect(lightFittings('crab').extra).toBe('Search');
    expect(lightFittings('powerboat').extra).toBe('Underwater');
  });

  it('puts searchlights, underwater LEDs and the headlight on the extras, floods on the deck switch', () => {
    const typesIn = (group: 'deck' | 'extra'): string[] =>
      [
        ...new Set(
          BOAT_KINDS.flatMap((k) => defaultDeckMounts(k))
            .filter((m) => deckGroupOf(m.type) === group)
            .map((m) => m.type),
        ),
      ].sort();
    expect(typesIn('extra')).toEqual(['funnel', 'headlight', 'searchlight', 'underwater']);
    expect(typesIn('deck')).toEqual(['courtesy', 'flood', 'spreader']);
  });

  it('aims the searchlights ahead and down onto the water, a little outboard', () => {
    for (const kind of ['cargo', 'cruise', 'crab'] as const) {
      const lights = defaultDeckMounts(kind).filter((m) => m.type === 'searchlight');
      expect(lights, kind).toHaveLength(2);
      for (const m of lights) {
        expect(m.target.y).toBe(0);
        expect(m.target.z).toBeLessThan(m.position.z - 50);
        expect(Math.sign(m.target.x)).toBe(Math.sign(m.position.x));
        expect(m.shadow).toBe(false);
      }
    }
  });
});
