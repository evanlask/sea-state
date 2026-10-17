import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { Hydrostatics } from '../physics/hydrostatics';
import { flatOcean, SimWorld } from '../world/SimWorld';
import { CALIBRATION } from './calibration/index';
import { boatModel } from './drivetrains';
import { loadedBoatModel, loadingConditionFor, potStack } from './loading';
import { BOAT_SPECS } from './specs/index';

const crab = (pots: number) =>
  loadedBoatModel(
    boatModel('crab'),
    loadingConditionFor('crab', { crabPots: pots }),
    CALIBRATION.crab.stability.avs,
  );

// IMO 2008 IS Code / Torremolinos / 46 CFR 28.570 intact stability of a fishing vessel in a loading
// condition: GZ at 1° steps to 60° (free trim), the first downflooding angle θf through an opening
// that can't be closed weathertight (the engine-room vents, not the house doors), and the areas.
function criteria(pots: number) {
  const m = crab(pots);
  const hydro = new Hydrostatics(m.buoyant);
  const curve = hydro.gzCurve(m.cg, m.designVolume, { step: DEG, maxAngle: 60 * DEG });
  const gzAt = (deg: number): number => curve.gz[Math.round(deg)]!;
  let downflooding = 60;
  for (let deg = 0; deg <= 60 && downflooding === 60; deg++) {
    const eq = hydro.equilibrium(m.cg, m.designVolume, deg * DEG, true, curve.trim[deg]!);
    for (const o of (BOAT_SPECS.crab.openings ?? []).filter((o) => !o.weathertight)) {
      const p = { x: o.position.x - m.cg.x, y: o.position.y - m.cg.y, z: o.position.z - m.cg.z };
      const y = -p.x * Math.sin(deg * DEG) + p.y * Math.cos(deg * DEG);
      if (y * Math.cos(eq.trim) - p.z * Math.sin(eq.trim) + eq.height < 0) downflooding = deg;
    }
  }
  const area = (from: number, to: number): number => {
    let a = 0;
    for (let deg = from; deg < to; deg++) a += ((gzAt(deg) + gzAt(deg + 1)) / 2) * DEG;
    return a;
  };
  const to40 = Math.min(40, downflooding);
  return {
    gm: m.gm,
    gz30: gzAt(30),
    angleOfMaxGz: curve.angleOfMaxGz / DEG,
    area30: area(0, 30),
    area40: area(0, to40),
    area30to40: area(30, to40),
    downflooding,
    avs: m.avs / DEG,
  };
}

describe('loading conditions', () => {
  it('stacks pots tier by tier from the deck up', () => {
    const spec = BOAT_SPECS.crab.potStack!;
    expect(potStack(spec, 0)).toMatchObject({ count: 0, tiers: 0, lateralArea: 0 });
    const one = potStack(spec, spec.perTier);
    expect(one.tiers).toBe(1);
    expect(one.centreHeight).toBeCloseTo(spec.deckHeight + spec.tierHeight / 2);
    expect(potStack(spec, 200).tiers).toBe(9);
    expect(potStack(spec, 999).count).toBe(200);
    expect(potStack(spec, Number.NaN).count).toBe(0);
    expect(loadingConditionFor('crab', { crabPots: Number.NaN })).toBeNull();
    expect(potStack(spec, 200).lateralArea).toBeGreaterThan(potStack(spec, 100).lateralArea);
  });

  it('an empty deck and a laden ship are the design condition', () => {
    expect(loadingConditionFor('crab', { crabPots: 0 })).toBeNull();
    expect(loadingConditionFor('cargo', { cargo: 'laden' })).toBeNull();
    expect(loadingConditionFor('sail', { crabPots: 100, cargo: 'ballast' })).toBeNull();
    const design = crab(0);
    expect(design.gm).toBe(BOAT_SPECS.crab.gmTarget);
    expect(design.restHeight).toBe(0);
  });

  it('more pots on deck means a lower GM and AVS, a deeper draft and more windage', () => {
    const loads = [0, 60, 120, 200].map(crab);
    for (let i = 1; i < loads.length; i++) {
      expect(loads[i]!.gm).toBeLessThan(loads[i - 1]!.gm);
      expect(loads[i]!.restHeight).toBeLessThan(loads[i - 1]!.restHeight);
      expect(loads[i]!.spec.windage.lateralArea).toBeGreaterThan(loads[i - 1]!.spec.windage.lateralArea);
    }
    const full = loads[3]!;
    expect(full.mass).toBe(BOAT_SPECS.crab.mass + 200 * 340);
    expect(full.gm).toBeGreaterThan(0.35); // tender: the most the boat may carry
    expect(full.gm).toBeLessThan(0.9);
    expect(full.avs).toBeLessThan(CALIBRATION.crab.stability.avs - 5 * DEG);
  });

  it('with the default 120 pots the crab boat meets the fishing-vessel stability criteria', () => {
    const c = criteria(120);
    expect(c.gm).toBeGreaterThanOrEqual(0.35);
    expect(c.gz30).toBeGreaterThanOrEqual(0.2);
    expect(c.angleOfMaxGz).toBeGreaterThanOrEqual(25);
    expect(c.area30).toBeGreaterThanOrEqual(0.055);
    expect(c.area40).toBeGreaterThanOrEqual(0.09);
    expect(c.area30to40).toBeGreaterThanOrEqual(0.03);
    expect(c.avs).toBeGreaterThanOrEqual(60);
  });

  it('a full deck of 200 pots is an overload: below the criteria, the AVS down to about 50°', () => {
    const c = criteria(200);
    expect(c.gm).toBeGreaterThanOrEqual(0.35);
    expect(c.gz30).toBeLessThan(0.2);
    expect(c.angleOfMaxGz).toBeLessThan(25);
    expect(c.avs).toBeGreaterThan(40);
    expect(c.avs).toBeLessThan(60);
  });

  it('in ballast the container ship floats metres lighter, with less mass and windage', () => {
    const laden = boatModel('cargo');
    const ballast = loadedBoatModel(
      laden,
      loadingConditionFor('cargo', { cargo: 'ballast' }),
      CALIBRATION.cargo.stability.avs,
    );
    expect(ballast.mass).toBeLessThan(laden.mass - 1e7);
    expect(ballast.restHeight).toBeGreaterThan(2); // the design waterline rides 2+ m above the sea
    expect(ballast.restHeight).toBeLessThan(5);
    expect(ballast.gm).toBeGreaterThan(laden.gm); // stiffer: rolls quicker
    expect(ballast.spec.windage.lateralArea).toBeLessThan(laden.spec.windage.lateralArea);
  });

  it('a loaded boat spawns at its own waterline and stays there', () => {
    const world = new SimWorld(
      {
        seed: 1,
        physicsMode: 'arcade',
        boats: [{ id: 'p', kind: 'crab', x: 0, z: 0, heading: 0, load: { crabPots: 200 } }],
        wind: { speed: 0, from: 0, gustFactor: 1 },
        seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
        oceanQuality: 'low',
        wakes: false,
      },
      flatOcean,
    );
    const rest = crab(200).restHeight;
    let y = 0;
    for (let t = 0.25; t <= 6; t += 0.25) {
      const s = world.advance({
        type: 'advance',
        targetTime: t,
        controls: {},
        commands: [],
        probes: new Float64Array(),
      });
      y = s.boats[0]!.position.y;
      expect(Math.abs(y - rest)).toBeLessThan(0.25);
    }
    const t = world.boat('p')!.snapshot().telemetry;
    expect(t['crabPots']).toBe(200);
    expect(t['avs']).toBeCloseTo(crab(200).avs);
  });
});
