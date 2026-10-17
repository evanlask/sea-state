import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import { KNOT } from '../../sim/core/units';
import type { BoatKind } from '../../sim/world/protocol';
import {
  deliveredPower,
  hullBreaking,
  stampRate,
  TRAIL_MAX,
  TRAIL_TAU_FAST,
  WAKE_CREST_SLOPE,
  wakeFoam,
  wakeFoamHull,
} from './wakeFoam';

const hull = (kind: BoatKind) => wakeFoamHull(BOAT_SPECS[kind]);
const foamAt = (kind: BoatKind, knots: number, power: number) => {
  const f = wakeFoam(hull(kind), knots * KNOT, power, false);
  return { ...f, total: f.hull + f.wash };
};

describe('wake foam injection', () => {
  it('leaves nothing behind a boat at rest with the engine off or idling', () => {
    for (const kind of Object.keys(BOAT_SPECS) as BoatKind[]) {
      const f = foamAt(kind, 0, 0.05);
      expect(f.total, kind).toBe(0);
    }
  });

  it('gives a displacement yacht at 6–7 kn only a faint strip, and more near hull speed', () => {
    const cruising = foamAt('sail', 6.5, 0);
    expect(cruising.wash).toBe(0); // no engine
    expect(cruising.hull).toBeGreaterThan(0.05);
    expect(cruising.hull).toBeLessThan(0.35); // scattered bubbles, not a white sheet
    // About a beam wide (half-width 0.6 beam, profile falling from 0.4 of it).
    expect(cruising.hullWidth).toBeLessThan(0.7 * BOAT_SPECS.sail.dimensions.beam);
    const surfing = foamAt('sail', 9, 0);
    expect(surfing.hull).toBeGreaterThan(2 * cruising.hull);
    expect(surfing.hull).toBeLessThan(TRAIL_MAX);
  });

  it('follows the Froude number: nothing breaks slow, most at the hump, less on the plane', () => {
    const lwl = 10;
    const at = (fn: number) => hullBreaking(fn * Math.sqrt(9.80665 * lwl), lwl);
    expect(at(0.15)).toBe(0);
    expect(at(0.3)).toBeLessThan(at(0.5));
    expect(at(0.6)).toBeGreaterThan(0.8);
    expect(at(2.5)).toBeLessThan(at(0.6));
    expect(at(2.5)).toBeGreaterThan(0.4);
  });

  it('scales by the size of the waves: a jet ski at the hump spills more than it whitens', () => {
    // Same Froude number (0.5), very different bow wave heights.
    const pwc = hullBreaking(0.5 * Math.sqrt(9.80665 * 2.9), 2.9);
    const ship = hullBreaking(0.5 * Math.sqrt(9.80665 * 230), 230);
    expect(pwc).toBeLessThan(0.7 * ship);
  });

  it('makes a planing center console at full throttle a bright white trail', () => {
    const full = foamAt('powerboat', 40, 1);
    expect(full.total).toBeGreaterThan(1);
    expect(full.wash).toBeGreaterThan(0.4);
    expect(foamAt('powerboat', 40, 0.3).wash).toBeLessThan(full.wash);
  });

  it('makes a jet ski at speed a bright narrow trail', () => {
    const f = foamAt('pwc', 50, 1);
    expect(f.total).toBeGreaterThan(1.2);
    expect(f.washWidth).toBeLessThan(1.2);
  });

  it('makes ships at service speed an aerated, not solid, wake that lingers', () => {
    const cargo = foamAt('cargo', 24, 1);
    expect(cargo.hull).toBeGreaterThan(0.15); // bow wave breaking along the hull
    expect(cargo.total).toBeGreaterThan(0.4);
    expect(cargo.total).toBeLessThan(1);
    expect(cargo.persistent).toBeGreaterThan(0.6);
    // A deep propeller whitens far less of the same energy than a surface drive.
    const deep = wakeFoam({ ...hull('powerboat'), propDepth: 10 }, 20, 1, false);
    expect(deep.wash).toBeLessThan(0.3 * foamAt('powerboat', 20 / KNOT, 1).wash);
    // A small boat's turbulence fades within tens of metres; a ship's does not.
    expect(foamAt('sail', 6.5, 0).persistent).toBeLessThan(0.15);
    expect(6.5 * KNOT * TRAIL_TAU_FAST).toBeLessThan(50);
  });

  it('takes the delivered power from telemetry, nothing for a sailboat or an emerged prop', () => {
    expect(deliveredPower({})).toBe(0);
    expect(deliveredPower({ load: 0.8 })).toBeCloseTo(0.8);
    expect(deliveredPower({ load: 0.8, propEmersion: 1 })).toBe(0);
  });

  it('is nothing when airborne', () => {
    const f = wakeFoam(hull('pwc'), 25, 1, true);
    expect(f.hull + f.wash).toBe(0);
  });

  it('stamps at the rate that leaves the deposit on water the boat passes', () => {
    // A texel on the centreline spends (length + 1.4·width)/V in the stamp.
    const deposit = 0.3;
    const rate = stampRate(deposit, 4, 8, 2);
    expect(rate * ((8 + 1.4 * 2) / 4)).toBeCloseTo(deposit);
    expect(stampRate(deposit, 0, 8, 2)).toBe(0);
    expect(stampRate(deposit, 0, 1, 2, 0.5)).toBeGreaterThan(0); // churn in place
  });

  it('whitens wake crests only near breaking steepness', () => {
    // A yacht's Kelvin waves reach |∇η| ≈ 0.14 at 6.5 kn on its eWave grid: no foam.
    expect(WAKE_CREST_SLOPE[0]).toBeGreaterThan(0.15);
    expect(WAKE_CREST_SLOPE[1]).toBeLessThan(0.45);
  });
});
