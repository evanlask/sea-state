// Default light mounts against the Annex I positioning rules, the light budget, and the glow sizing.

import { describe, expect, it } from 'vite-plus/test';

import { BOAT_KINDS, type BoatKind } from '../../../sim/world/protocol';
import { type NavRole, navRoles, NO_SIGNALS, VESSEL_LIGHTS } from './colregs';
import { glowProfile, lightExtinction, pixelAngle } from './glowMath';
import { allocateLights, LIGHT_BUDGET } from './lightBudget';
import {
  defaultDeckMounts,
  defaultMounts,
  HULL_HEIGHT,
  mergeMounts,
  mountLight,
  mountsForRole,
} from './mounts';

const DEG = Math.PI / 180;

const one = (kind: BoatKind, role: NavRole) => {
  const m = mountsForRole(defaultMounts(kind), role)[0];
  if (!m) throw new Error(`${kind} has no ${role} mount`);
  return m;
};
const aboveHull = (kind: BoatKind, role: NavRole): number => one(kind, role).position.y - HULL_HEIGHT[kind];

describe('default mounts', () => {
  it('cover every role each boat can show', () => {
    const combos: Partial<typeof NO_SIGNALS>[] = [
      {},
      { nuc: true },
      { ram: true },
      { fishing: true },
      { anchor: true },
      { tricolour: true },
      { ram: true, anchor: true },
    ];
    for (const kind of BOAT_KINDS) {
      const mounts = defaultMounts(kind);
      for (const signals of combos) {
        for (const makingWay of [true, false]) {
          for (const role of navRoles(kind, { on: true, makingWay, signals })) {
            expect(mountsForRole(mounts, role).length, `${kind} ${role}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('have unique names', () => {
    for (const kind of BOAT_KINDS) {
      const names = defaultMounts(kind).map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
      const deck = defaultDeckMounts(kind).map((m) => m.name);
      expect(new Set(deck).size).toBe(deck.length);
    }
  });

  it('put red to port and green to starboard', () => {
    for (const kind of BOAT_KINDS) {
      for (const m of defaultMounts(kind)) {
        const { colour, kind: lantern } = mountLight(m);
        if (lantern === 'port') expect(colour).toBe('red');
        if (lantern === 'starboard') expect(colour).toBe('green');
        if (lantern === 'port' && m.position.x !== 0) expect(m.position.x).toBeLessThan(0);
        if (lantern === 'starboard' && m.position.x !== 0) expect(m.position.x).toBeGreaterThan(0);
      }
    }
  });

  it('ships ≥ 50 m: after masthead ≥ 4.5 m above the forward one, aft by ≥ L/2 (≤ 100 m)', () => {
    for (const kind of ['cargo', 'cruise'] as const) {
      const fwd = one(kind, 'masthead').position;
      const aft = one(kind, 'mastheadAft').position;
      const length = VESSEL_LIGHTS[kind].length;
      expect(aft.y - fwd.y).toBeGreaterThanOrEqual(4.5);
      expect(aft.z - fwd.z).toBeGreaterThanOrEqual(Math.min(length / 2, 100));
      // Forward masthead ≥ 6 m and ≥ the breadth (capped at 12 m) above the hull, within L/4 of the stem.
      expect(fwd.y - HULL_HEIGHT[kind]).toBeGreaterThanOrEqual(12);
      expect(fwd.z + length / 2).toBeLessThanOrEqual(length / 4 + 10);
      // Seen from sea level 1000 m ahead of the stem, the after light shows above the forward one.
      const stem = -length / 2;
      const angle = (p: { y: number; z: number }) => Math.atan2(p.y, p.z - (stem - 1000));
      expect(angle(aft)).toBeGreaterThan(angle(fwd));
    }
  });

  it('sidelights at ≤ ¾ of the forward masthead height and not forward of it (≥ 20 m)', () => {
    for (const kind of ['cargo', 'cruise', 'crab'] as const) {
      for (const side of ['port', 'starboard'] as const) {
        expect(aboveHull(kind, side)).toBeLessThanOrEqual(0.75 * aboveHull(kind, 'masthead'));
        expect(one(kind, side).position.z).toBeGreaterThanOrEqual(one(kind, 'masthead').position.z);
      }
    }
  });

  it('crabber: masthead ≥ breadth above the hull; fishing white ≥ 2 × spacing above the sidelights', () => {
    expect(aboveHull('crab', 'masthead')).toBeGreaterThanOrEqual(8.8);
    const red = one('crab', 'signalRedUpper').position.y;
    const white = one('crab', 'signalWhite').position.y;
    const spacing = red - white;
    expect(spacing).toBeGreaterThanOrEqual(2);
    expect(white - one('crab', 'port').position.y).toBeGreaterThanOrEqual(2 * spacing - 1e-9);
    expect(aboveHull('crab', 'signalRedLower')).toBeGreaterThanOrEqual(4);
  });

  it('ship signals: 2 m spacing, lowest ≥ 4 m above the hull; anchor lights 4.5 m apart', () => {
    for (const kind of ['cargo', 'cruise'] as const) {
      const ys = (['signalRedUpper', 'signalWhite', 'signalRedLower'] as const).map(
        (r) => one(kind, r).position.y,
      );
      expect(ys[0]! - ys[1]!).toBeGreaterThanOrEqual(2);
      expect(ys[1]! - ys[2]!).toBeGreaterThanOrEqual(2);
      expect(aboveHull(kind, 'signalRedLower')).toBeGreaterThanOrEqual(4);
      expect(aboveHull(kind, 'anchorForward')).toBeGreaterThanOrEqual(6);
      expect(
        one(kind, 'anchorForward').position.y - one(kind, 'anchorAft').position.y,
      ).toBeGreaterThanOrEqual(4.5);
      expect(one(kind, 'anchorForward').position.z).toBeLessThan(one(kind, 'anchorAft').position.z);
    }
  });

  it('< 12 m: the all-round white ≥ 1 m above the sidelights', () => {
    const pole = one('powerboat', 'allRoundWhite').position.y;
    expect(pole - one('powerboat', 'port').position.y).toBeGreaterThanOrEqual(1);
    expect(one('powerboat', 'anchorForward').name).toBe(one('powerboat', 'allRoundWhite').name);
    expect(one('pwc', 'allRoundWhite').position.y).toBeGreaterThan(HULL_HEIGHT.pwc + 0.5);
  });

  it('sailboat: tricolour and anchor light at the masthead, sidelights forward, sternlight aft', () => {
    for (const r of ['tricolourPort', 'tricolourStarboard', 'tricolourStern', 'anchorForward'] as const) {
      expect(one('sail', r).position.y).toBeGreaterThan(16.5);
    }
    expect(one('sail', 'anchorForward').position.y).toBeGreaterThan(one('sail', 'tricolourStern').position.y);
    expect(one('sail', 'port').position.z).toBeLessThan(-5);
    expect(one('sail', 'stern').position.z).toBeGreaterThan(5);
  });

  it('crabber floods are many, the first ones shadowed and aimed down at the deck', () => {
    const floods = defaultDeckMounts('crab');
    expect(floods.length).toBeGreaterThanOrEqual(12);
    for (const f of floods) expect(f.target.y).toBeLessThan(f.position.y);
    expect(defaultDeckMounts('powerboat').some((m) => m.type === 'underwater' && !m.lamp)).toBe(true);
  });

  it('merge model overrides by name', () => {
    const merged = mergeMounts(defaultMounts('crab'), [
      { name: 'masthead', roles: ['masthead'], position: { x: 0, y: 15, z: -12 } },
      { name: 'extra', roles: ['allRoundWhite'], position: { x: 0, y: 3, z: 0 } },
    ]);
    expect(merged.find((m) => m.name === 'masthead')?.position.y).toBe(15);
    expect(merged.some((m) => m.name === 'extra')).toBe(true);
    expect(merged.length).toBe(defaultMounts('crab').length + 1);
  });
});

describe('light budget', () => {
  it('grows with quality, shadows the highest-priority eligible spots first', () => {
    expect(LIGHT_BUDGET.low.deckShadows).toBe(0);
    expect(LIGHT_BUDGET.ultra.deckLights).toBeGreaterThanOrEqual(LIGHT_BUDGET.high.deckLights);
    const picked = allocateLights(defaultDeckMounts('crab'), 4, 2);
    expect(picked.length).toBe(4);
    expect(picked.filter((p) => p.shadow).length).toBe(2);
    expect(picked[0]?.item.name).toBe('mast-flood-port');
    expect(picked.every((p) => p.item.light !== 'none')).toBe(true);
  });
});

describe('glow', () => {
  const px = pixelAngle(55 * DEG, 1080);
  const night = 9; // pre-exposure on a dark night (EV100 ≈ −3.4)
  const noon = 2.5e-5; // EV100 ≈ 15
  const glowAt = (cd: number, distance: number, pre: number) =>
    glowProfile({
      illuminance: cd / distance ** 2,
      lensAngle: 0.08 / distance,
      pixelAngle: px,
      preExposure: pre,
      lensDrawn: true,
    });

  it('a 12 cd sidelight at 2 nm is a visible pinpoint at night', () => {
    const g = glowAt(12, 2 * 1852, night);
    expect(g.quadRadius / px).toBeLessThanOrEqual(4);
    expect(g.corePeak).toBeGreaterThan(1.6); // above the bloom threshold
  });

  it('keeps a pixel-sized core at any range and never a disc larger than the glare cap', () => {
    for (const d of [50, 200, 1000, 5000, 11_000]) {
      const g = glowAt(94, d, night);
      expect(g.coreSigma / px).toBeCloseTo(0.75);
      expect(g.quadRadius / px).toBeLessThanOrEqual(48 + 1e-9);
    }
  });

  it('glows up close at night and is nearly invisible at noon', () => {
    const close = glowAt(12, 30, night);
    expect(close.haloAt(5 * px)).toBeGreaterThan(1);
    const day = glowAt(12, 30, noon);
    expect(day.haloAt(5 * px)).toBeLessThan(0.01);
    expect(day.quadRadius / px).toBeLessThanOrEqual(3 + 1e-9);
    expect(glowAt(12, 2 * 1852, noon).corePeak).toBeLessThan(0.01);
  });

  it('hands the core to the lens mesh once the lens is resolved', () => {
    expect(glowAt(12, 30, night).coreWeight).toBe(0);
    expect(glowAt(12, 3000, night).coreWeight).toBe(1);
  });

  it('dims with haze and fog, reddening slightly', () => {
    const clear = lightExtinction(1);
    expect(Math.exp(-clear[1] * 3704)).toBeGreaterThan(0.9);
    expect(clear[2]).toBeGreaterThan(clear[0]);
    const fog = lightExtinction(1, 500);
    expect(Math.exp(-fog[1] * 1000)).toBeLessThan(0.001);
  });
});
