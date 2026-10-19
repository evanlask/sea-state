import { describe, expect, it } from 'vite-plus/test';

import { FLASH_ABOVE_BASE, flashGlowAlong, flashSkyGlow, flashSourceHeight } from './flashLight';

const BASE = 1000;
const source = { x: 0, y: flashSourceHeight(0, BASE), z: 0 };

describe('flash light', () => {
  it('puts the source inside the cloud base', () => {
    expect(flashSourceHeight(0, BASE)).toBe(BASE + FLASH_ABOVE_BASE);
    expect(flashSourceHeight(3000, BASE)).toBe(3000);
  });

  it('glows brightest straight under the flash and fades along the base', () => {
    const up = { x: 0, y: 1, z: 0 };
    const under = flashGlowAlong({ x: 0, y: 0, z: 0 }, up, source, BASE);
    const away = flashGlowAlong({ x: 3000, y: 0, z: 0 }, up, source, BASE);
    expect(under).toBeCloseTo(Math.exp(-1.4 * 0.4), 5);
    expect(away).toBeLessThan(under * 0.05);
    // From a point off to the side, looking toward the flash beats looking away from it.
    const from = { x: 3000, y: 0, z: 0 };
    const toward = flashGlowAlong(from, { x: -0.6, y: 0.8, z: 0 }, source, BASE);
    const back = flashGlowAlong(from, { x: 0.6, y: 0.8, z: 0 }, source, BASE);
    expect(toward).toBeGreaterThan(back * 5);
  });

  it('sees nothing of a base below the observer', () => {
    expect(flashGlowAlong({ x: 0, y: 2000, z: 0 }, { x: 0, y: 1, z: 0 }, source, BASE)).toBe(0);
  });

  it('lights the sky less with distance from the strike', () => {
    const near = flashSkyGlow({ x: 0, y: 0, z: 0 }, source, BASE);
    const far = flashSkyGlow({ x: 8000, y: 0, z: 0 }, source, BASE);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(1);
    expect(far).toBeLessThan(near * 0.2);
  });
});
