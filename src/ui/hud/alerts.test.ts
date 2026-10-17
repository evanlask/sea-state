import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../../sim/core/conventions';
import { type AlertInput, evaluateAlerts, sortAlerts } from './alerts';
import type { FleetEntry } from './model';

const base: AlertInput = {
  kind: 'crab',
  speed: 5,
  heading: 0,
  cog: 0,
  roll: 0,
  stability: { dangerHeel: 30 * DEG, avs: 60 * DEG },
  isNight: false,
  navLights: false,
};

const ids = (input: Partial<AlertInput>, previous?: ReadonlySet<string>): string[] =>
  evaluateAlerts({ ...base, ...input }, previous).map((a) => a.id);
const first = (input: Partial<AlertInput>) => evaluateAlerts({ ...base, ...input })[0];

describe('heel alerts', () => {
  it('is quiet when upright in daylight', () => {
    expect(evaluateAlerts(base)).toEqual([]);
  });

  it('escalates heeling hard → about to capsize, one at a time', () => {
    expect(ids({ roll: 26 * DEG })).toEqual([]);
    expect(ids({ roll: -32 * DEG })).toEqual(['heeling']);
    expect(ids({ roll: 46 * DEG })).toEqual(['capsize-risk']);
    expect(first({ roll: 46 * DEG }).severity).toBe('danger');
  });

  it('says how far and which way, with something to do about it', () => {
    expect(first({ roll: -32 * DEG })).toMatchObject({
      text: 'Heeling hard — 32° to port',
      detail: 'Slow down and turn into the waves',
    });
  });

  it('warns the big ships about heavy rolling instead', () => {
    expect(ids({ kind: 'cargo', roll: 16 * DEG })).toEqual(['heavy-roll']);
    expect(first({ kind: 'cargo', roll: 16 * DEG }).detail).toBe('Change course or slow down');
    expect(first({ kind: 'cargo', roll: 16 * DEG, hs: 6, waveFrom: 90 * DEG }).detail).toBe(
      'Turn so the waves meet the bow',
    );
    expect(ids({ kind: 'pwc', roll: 26 * DEG })).toEqual([]);
  });

  it('holds an alert until the value drops clearly below the threshold', () => {
    const held = new Set(['heeling']);
    expect(ids({ roll: 28 * DEG })).toEqual([]);
    expect(ids({ roll: 28 * DEG }, held)).toEqual(['heeling']);
    expect(ids({ roll: 25 * DEG }, held)).toEqual([]);
  });

  it('names the likeliest cause in the action line', () => {
    const heel = 32 * DEG;
    const action = (input: Partial<AlertInput>) => first({ roll: heel, ...input }).detail;
    const beam = { hs: 5, waveFrom: 90 * DEG };
    expect(action(beam)).toBe('Turn to meet the waves bow-first');
    expect(action({ ...beam, breakingHit: true })).toBe('Breaking waves on your side — turn into them');
    expect(action({ deckWater: 0.2 })).toBe('Water on deck — slow down and let it drain');
    expect(action({ kind: 'powerboat', speed: 8, rudder: { angle: 25 * DEG, max: 30 * DEG } })).toBe(
      'Ease the turn and slow down',
    );
    expect(action({ kind: 'sail' })).toBe('Let fly (Space) or reef to spill wind');
    expect(action({ kind: 'sail', device: 'gamepad' })).toBe('Ease the sheets or reef to spill wind');
  });

  it("drops the cause's own alert while the heel alert explains it", () => {
    expect(ids({ roll: 32 * DEG, hs: 5, waveFrom: 90 * DEG })).toEqual(['heeling']);
    expect(ids({ roll: 32 * DEG, deckWater: 0.2 })).toEqual(['heeling']);
  });
});

describe('sea alerts', () => {
  it('flags big waves on the side of a small boat', () => {
    expect(ids({ hs: 5, waveFrom: 90 * DEG })).toEqual(['beam-seas']);
    expect(first({ hs: 5, waveFrom: -100 * DEG })).toMatchObject({
      text: 'Big waves on your side',
      detail: 'Turn to meet them bow-first',
    });
    expect(ids({ hs: 3, waveFrom: 90 * DEG })).toEqual([]);
    expect(ids({ hs: 5, waveFrom: 20 * DEG })).toEqual([]);
    expect(ids({ kind: 'cargo', hs: 10, waveFrom: 90 * DEG })).toEqual([]);
  });

  it('calls out breaking waves hitting the side, even in a smaller sea', () => {
    expect(first({ hs: 3, waveFrom: 90 * DEG, breakingHit: true }).text).toBe(
      'Breaking waves hitting your side',
    );
    expect(ids({ hs: 5, waveFrom: 0, breakingHit: true })).toEqual([]);
  });

  it('widens the beam sector once the alert is up', () => {
    const held = new Set(['beam-seas']);
    expect(ids({ hs: 5, waveFrom: 128 * DEG })).toEqual([]);
    expect(ids({ hs: 5, waveFrom: 128 * DEG }, held)).toEqual(['beam-seas']);
  });

  it('flags running too fast before big following seas', () => {
    // 8 s waves travel at 12.5 m/s: from 5 m/s along their path a boat starts to surf.
    const following = { kind: 'powerboat' as const, hs: 2, tp: 8, waveFrom: Math.PI };
    expect(ids({ ...following, speed: 8 })).toEqual(['following-seas']);
    expect(first({ ...following, speed: 8 })).toMatchObject({
      text: 'Too fast with big waves behind',
      detail: 'Slow down, or a wave can spin you sideways',
    });
    expect(ids({ ...following, speed: 4 })).toEqual([]);
    expect(ids({ ...following, speed: 4.5 }, new Set(['following-seas']))).toEqual(['following-seas']);
    expect(ids({ ...following, speed: 8, hs: 0.5 })).toEqual([]);
  });

  it('flags launching off big waves, not jumps in a calm', () => {
    expect(ids({ kind: 'pwc', airborne: true })).toEqual([]);
    expect(ids({ kind: 'pwc', airborne: true, hs: 1.5 })).toEqual(['airborne']);
    expect(ids({ kind: 'cargo', airborne: true, hs: 8 })).toEqual([]);
  });
});

describe('water alerts', () => {
  it('flags water on deck, then a swamped deck', () => {
    expect(ids({ deckWater: 0.1 })).toEqual([]);
    expect(ids({ deckWater: 0.2 })).toEqual(['deck-water']);
    expect(ids({ deckWater: 0.13 }, new Set(['deck-water']))).toEqual(['deck-water']);
    expect(ids({ deckWater: 0.5 })).toEqual(['deck-awash']);
    expect(first({ deckWater: 0.5 }).severity).toBe('danger');
  });

  it('flags flooding as danger while water comes in, then a warning', () => {
    expect(first({ flooding: 0.12, floodingRising: true })).toMatchObject({
      id: 'flooding',
      severity: 'danger',
      text: 'Taking on water — 12% flooded',
    });
    expect(first({ flooding: 0.12 })).toMatchObject({ severity: 'warning', text: 'Hull 12% flooded' });
  });
});

describe('sailing and lights alerts', () => {
  it('flags in irons and accidental gybes on the sailboat, explained', () => {
    expect(ids({ kind: 'sail', inIrons: true })).toEqual(['in-irons']);
    expect(first({ kind: 'sail', inIrons: true })).toMatchObject({
      text: 'In irons — stuck head to wind',
      detail: 'Steer away from the wind to fill the sails',
    });
    expect(ids({ kind: 'sail', accidentalGybe: true })).toEqual(['accidental-gybe']);
    expect(ids({ kind: 'crab', inIrons: true })).toEqual([]);
  });

  it('reminds about navigation lights after dark with the key for the device, except on a jet ski', () => {
    expect(first({ isNight: true })).toMatchObject({
      id: 'nav-lights-off',
      severity: 'info',
      detail: 'Press 1 so other boats can see you',
    });
    expect(first({ isNight: true, device: 'gamepad' }).detail).toBe(
      'Tap D-pad up so other boats can see you',
    );
    expect(ids({ isNight: true, navLights: true })).toEqual([]);
    expect(ids({ isNight: true, kind: 'pwc' })).toEqual([]);
  });

  it('sorts danger before warnings before info', () => {
    const alerts = evaluateAlerts({
      ...base,
      kind: 'powerboat',
      airborne: true,
      hs: 2,
      isNight: true,
      flooding: 0.5,
      floodingRising: true,
    });
    expect(alerts.map((a) => a.severity)).toEqual(['danger', 'warning', 'info']);
  });

  it('sorts merged alert lists stably by severity', () => {
    const sorted = sortAlerts([
      { id: 'a', severity: 'info', text: '' },
      { id: 'b', severity: 'warning', text: '' },
      { id: 'c', severity: 'danger', text: '' },
      { id: 'd', severity: 'warning', text: '' },
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['c', 'b', 'd', 'a']);
  });
});

describe('collision alerts', () => {
  const own: FleetEntry = {
    id: 'own',
    name: 'Own',
    kind: 'crab',
    bearing: 0,
    range: 0,
    speed: 5,
    heading: 0,
    active: true,
  };
  const contact = (patch: Partial<FleetEntry>): FleetEntry => ({
    id: 'b',
    name: 'Aurora',
    kind: 'cargo',
    bearing: 0,
    range: 1000,
    speed: 5,
    heading: Math.PI,
    active: false,
    ...patch,
  });

  it('warns about a vessel closing head-on with where it is and how close it gets', () => {
    const alerts = evaluateAlerts({ ...base, fleet: [own, contact({})] });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      id: 'collision-b',
      text: 'Aurora on a collision course',
      detail: '0.5 nm ahead · closest 0 m in 1:40',
    });
  });

  it('escalates to danger when the closest approach is small and soon', () => {
    const alerts = evaluateAlerts({ ...base, fleet: [own, contact({ range: 400 })] });
    expect(alerts[0].severity).toBe('danger');
  });

  it('ignores vessels that pass wide or have already passed', () => {
    const wide = contact({ bearing: 90 * DEG, range: 2000, heading: 0 });
    const opening = contact({ bearing: Math.PI, range: 800, heading: Math.PI, speed: 6 });
    expect(evaluateAlerts({ ...base, fleet: [own, wide, opening] })).toEqual([]);
  });

  it('stays quiet about companions keeping station in formation', () => {
    // Abeam and on a parallel course, slightly faster or slower: CPA is about the current range.
    const abeam = contact({ kind: 'sail', bearing: 90 * DEG, range: 260, heading: 0, speed: 5.5 });
    const astern = contact({ kind: 'cargo', bearing: 270 * DEG, range: 150, heading: 0, speed: 5.2 });
    expect(evaluateAlerts({ ...base, fleet: [own, abeam, astern] })).toEqual([]);
  });

  it('still warns about a boat right alongside', () => {
    const alongside = contact({ kind: 'pwc', bearing: 90 * DEG, range: 30, heading: 0, speed: 5 });
    const [alert] = evaluateAlerts({ ...base, fleet: [own, alongside] });
    expect(alert).toMatchObject({ text: 'Aurora very close', detail: '30 m off starboard beam' });
  });

  it('describes a crossing vessel by its sector', () => {
    // From the starboard bow, crossing ahead to port.
    const crossing = contact({ bearing: 45 * DEG, range: 700, heading: 270 * DEG, speed: 5 });
    const [alert] = evaluateAlerts({ ...base, fleet: [own, crossing] });
    expect(alert.detail).toMatch(/^0\.4 nm off starboard bow · closest \d+ m in /);
  });
});
