import { describe, expect, it } from 'vite-plus/test';

import {
  ambientSpray,
  bowSprayWash,
  greenWaterSplash,
  lensSpray,
  type LensSpray,
  type LensSprayInputs,
  lensViewFor,
  rainExposure,
  sprayImpulse,
} from './lensWetness';

describe('rain on the glass', () => {
  it('reaches glass facing into it most, and always some', () => {
    expect(rainExposure('lens', 1)).toBeGreaterThan(rainExposure('lens', 0));
    expect(rainExposure('lens', 0)).toBeGreaterThan(rainExposure('lens', -1));
    expect(rainExposure('lens', -1)).toBeGreaterThan(0);
    expect(rainExposure('window', 0)).toBeLessThan(rainExposure('lens', 0)); // under the overhang
    expect(rainExposure('none', 1)).toBe(0);
  });
});

describe('spray on the lens', () => {
  it('soaks the lens from hard slams close by, not light or distant ones', () => {
    expect(sprayImpulse([{ distance: 3, strength: 7 }])).toBeGreaterThan(0.2);
    expect(sprayImpulse([{ distance: 3, strength: 1 }])).toBe(0);
    expect(sprayImpulse([{ distance: 60, strength: 8 }])).toBe(0);
    expect(sprayImpulse(Array.from({ length: 20 }, () => ({ distance: 1, strength: 8 })))).toBe(1);
  });

  it('washes a low camera, and blows spume onto it in a gale', () => {
    expect(ambientSpray(0.3, 5).wash).toBeGreaterThan(0);
    expect(ambientSpray(0.3, 5).spume).toBe(0);
    expect(ambientSpray(10, 30)).toEqual({ spume: 0, wash: 0 });
    expect(ambientSpray(3, 25).spume).toBeGreaterThan(ambientSpray(3, 10).spume);
  });

  it('wets a camera at the bow in its bow spray, not one a few metres off', () => {
    expect(bowSprayWash(1, 0.5)).toBeGreaterThan(0.5);
    expect(bowSprayWash(1, 8)).toBe(0);
    expect(bowSprayWash(0, 0)).toBe(0);
  });

  it('splashes a camera near green water coming aboard', () => {
    expect(greenWaterSplash(0.1, 2, 10, 1.5)).toBeGreaterThan(0.3);
    expect(greenWaterSplash(0.01, 2, 10, 1.5)).toBe(0); // a trickle
    expect(greenWaterSplash(0.1, 40, 10, 1.5)).toBe(0); // a chase camera far off
    expect(greenWaterSplash(0.5, 20, 300, 33)).toBe(0); // a ship's bridge, high above the deck
  });

  const calm: LensSprayInputs = {
    mode: 'window',
    heightAboveWater: 33,
    windSpeed: 5,
    slams: [],
    bowSpray: 0,
    distanceToBow: 42,
    greenWater: 0,
  };
  const out = (): LensSpray => ({ spume: 1, wash: 1, splashes: [1] });

  it('puts nothing on dry glass', () => {
    expect(lensSpray(calm, out())).toEqual({ spume: 0, wash: 0, splashes: [] });
    expect(lensSpray({ ...calm, mode: 'lens' }, out())).toEqual({ spume: 0, wash: 0, splashes: [] });
  });

  it('keeps waves, spume and bow spray off the bridge windows', () => {
    const low = { ...calm, heightAboveWater: 0.3, windSpeed: 30, bowSpray: 1, distanceToBow: 0 };
    expect(lensSpray(low, out())).toEqual({ spume: 0, wash: 0, splashes: [] });
    const lens = lensSpray({ ...low, mode: 'lens' }, out());
    expect(lens.wash).toBeGreaterThan(0.5);
    expect(lens.spume).toBeGreaterThan(0.5);
    // A hard slam right in front of the bridge still lands.
    const slam = lensSpray({ ...calm, slams: [{ distance: 2, strength: 8 }] }, out());
    expect(slam.splashes.length).toBe(1);
  });
});

describe('which glass', () => {
  it('uses the lens for external cameras and the windows from a wheelhouse helm', () => {
    expect(lensViewFor('chase', 'pwc').mode).toBe('lens');
    expect(lensViewFor('drone', 'cargo').mode).toBe('lens');
    expect(lensViewFor('helm', 'cargo')).toMatchObject({ mode: 'window' });
    expect(lensViewFor('helm', 'crab').windowDistance).toBeGreaterThan(0);
  });

  it('has no glass for an open helm or the bridge wings', () => {
    expect(lensViewFor('helm', 'pwc').mode).toBe('none');
    expect(lensViewFor('helm', 'sail').mode).toBe('none');
    expect(lensViewFor('bridge-port', 'cargo').mode).toBe('none');
  });
});
