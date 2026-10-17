// The particles' hull volumes: points in the hull, its open cockpit and its superstructure are
// inside; points beside, under, ahead of and astern of it are not.
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import type { BoatKind } from '../../sim/world/protocol';
import { HULL_BOXES, hullHalfBreadth, hullStation, hullVolume, insideHull } from './hullVolumes';

const KINDS: BoatKind[] = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc'];
const p = (x: number, y: number, z: number) => ({ x, y, z });

describe('hull volumes', () => {
  it.each(KINDS)('%s: solid amidships, open water around it', (kind) => {
    const v = hullVolume(kind);
    const d = BOAT_SPECS[kind].dimensions;
    expect(v.boxes.length).toBeLessThanOrEqual(HULL_BOXES);
    expect(insideHull(v, p(0, 0, 0))).toBe(true); // the waterline amidships
    expect(insideHull(v, p(0, -0.5 * d.draft, 0))).toBe(true);
    expect(insideHull(v, p(d.beam / 2 + 0.05, 0, 0))).toBe(false); // just outside the side
    expect(insideHull(v, p(-d.beam / 2 - 0.05, 0, 0))).toBe(false);
    expect(insideHull(v, p(0, -d.draft - 0.2, 0))).toBe(false); // under the keel
    expect(insideHull(v, p(0, 0, v.zBow - 0.1))).toBe(false); // ahead of the stem
    expect(insideHull(v, p(0, 0, v.zStern + 0.1))).toBe(false); // astern of the transom
    expect(insideHull(v, p(0, 80, 0))).toBe(false); // well above everything solid
    // The bounding sphere holds every station.
    for (let z = v.zBow; z <= v.zStern; z += (v.zStern - v.zBow) / 50) {
      const st = hullStation(v, z)!;
      expect(Math.hypot(st.deckHalf, Math.max(-st.keelY, st.deckY), z)).toBeLessThanOrEqual(v.radius + 1e-6);
    }
  });

  it('follows the hull lines: narrow at the bow, full amidships, flaring to the deck', () => {
    const v = hullVolume('cargo');
    const bow = -0.42 * BOAT_SPECS.cargo.dimensions.lwl;
    expect(hullHalfBreadth(v, bow, 0)).toBeLessThan(hullHalfBreadth(v, 0, 0) * 0.5);
    expect(hullHalfBreadth(v, bow, 8)).toBeGreaterThan(hullHalfBreadth(v, bow, 0)); // bow flare
    expect(hullHalfBreadth(v, 0, 0)).toBeCloseTo(BOAT_SPECS.cargo.dimensions.beam / 2, 0);
  });

  it('includes the superstructure, clipped to the deck', () => {
    const cargo = hullVolume('cargo');
    expect(insideHull(cargo, p(0, 30, 72))).toBe(true); // accommodation block
    expect(insideHull(cargo, p(0, 30, 0))).toBe(false); // above the deck stacks
    expect(insideHull(cargo, p(0, 20, 0))).toBe(true); // in the deck stacks
    expect(insideHull(cargo, p(16.5, 20, 0))).toBe(false); // outboard of them
    const cruise = hullVolume('cruise');
    expect(insideHull(cruise, p(0, 35, 0))).toBe(true);
    expect(insideHull(cruise, p(0, 35, -150))).toBe(false); // ahead of the superstructure
    const crab = hullVolume('crab');
    expect(insideHull(crab, p(0, 7, -9))).toBe(true); // wheelhouse
    expect(insideHull(crab, p(0, 3, 8))).toBe(false); // above the working deck, inside the bulwarks
  });

  it('counts an open cockpit as solid only up to the gunwale', () => {
    const v = hullVolume('powerboat');
    expect(insideHull(v, p(0.5, 0.6, 2))).toBe(true);
    expect(insideHull(v, p(0.5, 1.3, 2))).toBe(false);
    expect(insideHull(v, p(0, 1.3, -0.8))).toBe(true); // the console
  });
});
