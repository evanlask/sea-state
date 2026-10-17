// Which boats smoke, how much and how dark, from the engine load.
import { describe, expect, it } from 'vite-plus/test';

import {
  idleWisp,
  LoadTracker,
  SMOKE_PROFILES,
  type SmokeProfile,
  smokePuffOpacity,
  stackOutput,
} from './exhaust';
import { hullVolume, insideHull } from './hullVolumes';

const profile = (kind: keyof typeof SMOKE_PROFILES): SmokeProfile => SMOKE_PROFILES[kind]!;
const main = (kind: keyof typeof SMOKE_PROFILES) => profile(kind).stacks[0]!;

describe('exhaust smoke', () => {
  it('smokes from the ships and the outboards only', () => {
    expect(Object.keys(SMOKE_PROFILES).sort()).toEqual(['cargo', 'crab', 'cruise', 'powerboat']);
    expect(SMOKE_PROFILES.pwc).toBeUndefined(); // exhausts into the jet
    expect(SMOKE_PROFILES.sail).toBeUndefined();
  });

  it('starts above every stack, clear of the hull and superstructure', () => {
    for (const kind of ['cargo', 'cruise', 'crab', 'powerboat'] as const) {
      for (const stack of profile(kind).stacks) {
        expect(insideHull(hullVolume(kind), { ...stack.local, y: stack.local.y + 0.05 })).toBe(false);
      }
    }
  });

  it('is thicker and darker under load', () => {
    for (const kind of ['cargo', 'cruise', 'crab'] as const) {
      const idle = stackOutput(profile(kind), main(kind), 0, 0);
      const full = stackOutput(profile(kind), main(kind), 1, 0);
      expect(full.rate).toBeGreaterThan(idle.rate);
      expect(full.exit).toBeGreaterThan(idle.exit);
      expect(full.tone).toBeGreaterThan(idle.tone);
    }
  });

  it('gives an idling engine a few percent to a fifth of the smoke of full load: thin and light', () => {
    // Smoke made: puffs a second × how long they last × how dense each is.
    const amount = (kind: 'cargo' | 'cruise' | 'crab', load: number, wind: number): number => {
      const out = stackOutput(profile(kind), main(kind), load, 0, 1, wind);
      return out.rate * out.life * smokePuffOpacity(out.tone);
    };
    for (const kind of ['cargo', 'cruise', 'crab'] as const) {
      for (const wind of [4, 12, 25]) {
        const ratio = amount(kind, 0.03, wind) / amount(kind, 0.95, wind);
        expect(ratio).toBeGreaterThan(0.02);
        expect(ratio).toBeLessThan(0.2);
      }
    }
    const idle = stackOutput(profile('crab'), main('crab'), 0.03, 0).tone;
    expect(idle).toBeLessThan(0.1); // light grey
    expect(smokePuffOpacity(idle)).toBeLessThan(0.07); // and nearly transparent
    expect(smokePuffOpacity(stackOutput(profile('crab'), main('crab'), 0.95, 0).tone)).toBeGreaterThan(0.55);
  });

  it('runs clean on the cruise ship, dark on the crab boat', () => {
    const tone = (kind: 'cargo' | 'cruise' | 'crab') => stackOutput(profile(kind), main(kind), 0.8, 0).tone;
    expect(tone('cruise')).toBeLessThan(0.25);
    expect(tone('cargo')).toBeGreaterThan(tone('cruise') + 0.25);
    expect(tone('crab')).toBeGreaterThan(tone('cargo'));
  });

  it('puffs darker for a while after the load rises, and settles back', () => {
    const tracker = new LoadTracker();
    tracker.update(0.2, 0.1);
    for (let t = 0; t < 30; t += 0.1) tracker.update(0.2, 0.1);
    expect(tracker.surge).toBeCloseTo(0, 3);
    const steady = stackOutput(profile('cargo'), main('cargo'), tracker.load, tracker.surge);
    for (let t = 0; t < 5; t += 0.1) tracker.update(1, 0.1); // full ahead
    const surging = stackOutput(profile('cargo'), main('cargo'), tracker.load, tracker.surge);
    expect(tracker.surge).toBeGreaterThan(0.3);
    expect(surging.tone).toBeGreaterThan(stackOutput(profile('cargo'), main('cargo'), tracker.load, 0).tone);
    expect(surging.rate).toBeGreaterThan(steady.rate);
    for (let t = 0; t < 40; t += 0.1) tracker.update(1, 0.1);
    expect(tracker.surge).toBeLessThan(0.05);
    // Easing off doesn't surge.
    const easing = new LoadTracker();
    easing.update(1, 0.1);
    for (let t = 0; t < 5; t += 0.1) easing.update(0.2, 0.1);
    expect(easing.surge).toBe(0);
  });

  it('keeps the plume continuous in any wind: puffs a fraction of their size apart', () => {
    for (const kind of ['cargo', 'cruise', 'crab'] as const) {
      for (const wind of [0, 5, 10, 20, 30, 45, 70]) {
        const out = stackOutput(profile(kind), main(kind), 0.8, 0, 1, wind);
        const spacing = Math.hypot(wind, 0.5 * out.exit) / out.rate; // m of gas between puffs
        const radius = main(kind).radius * out.size * 1.2; // mean starting radius
        // (Up to the puff-rate cap, as a small stack's in a hurricane; stretched along the wind
        // there, the puffs still overlap.)
        expect(spacing).toBeLessThanOrEqual(radius * (out.rate >= 80 ? 1.5 : 1.2));
        expect(out.rate).toBeLessThanOrEqual(80);
      }
    }
  });

  it('mixes the plume out faster in a strong wind', () => {
    const at = (wind: number) => stackOutput(profile('crab'), main('crab'), 0.9, 0, 1, wind);
    expect(at(30).size).toBeGreaterThan(at(8).size * 1.5); // diluted at once into bigger puffs
    expect(at(30).life).toBeLessThan(at(8).life * 0.75); // and torn apart sooner
    expect(at(70).rate * at(70).life).toBeLessThan(80 * 1.01);
  });

  it("keeps the generators' stack steady", () => {
    const aux = profile('cargo').stacks[1]!;
    expect(aux.aux).toBe(true);
    expect(stackOutput(profile('cargo'), aux, 0, 0)).toEqual(stackOutput(profile('cargo'), aux, 1, 1));
  });

  it('gives the outboards only a wisp at idle and nothing under way', () => {
    expect(idleWisp(650, 650, 0)).toBe(1);
    expect(idleWisp(650, 650, 3)).toBe(0);
    expect(idleWisp(2500, 650, 0)).toBe(0);
    expect(idleWisp(0, 650, 0)).toBe(0); // engine off
    const wisp = stackOutput(profile('powerboat'), main('powerboat'), 0.05, 0, idleWisp(650, 650, 0));
    expect(wisp.rate).toBeGreaterThan(0);
    expect(wisp.tone).toBeLessThan(0.2);
    expect(main('powerboat').radius).toBeLessThan(main('crab').radius / 2); // a relief port, not a stack
    expect(stackOutput(profile('powerboat'), main('powerboat'), 0.8, 0, idleWisp(5000, 650, 15)).rate).toBe(
      0,
    );
  });
});
