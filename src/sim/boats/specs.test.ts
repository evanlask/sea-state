import { describe, expect, it } from 'vite-plus/test';

import type { BoatKind } from '../world/protocol';
import { CALIBRATION } from './calibration/index';
import { BOAT_SPECS } from './specs/index';

const KINDS = Object.keys(BOAT_SPECS) as BoatKind[];

describe('boat specs and calibration data are consistent', () => {
  for (const kind of KINDS) {
    it(`${kind}: openings name real compartments; the rider is lighter than the craft`, () => {
      const spec = BOAT_SPECS[kind];
      const compartments = spec.compartments?.length ?? 0;
      for (const o of spec.openings ?? []) {
        expect(o.compartment, o.name).toBeGreaterThanOrEqual(0);
        expect(o.compartment, o.name).toBeLessThan(compartments);
      }
      if (spec.rider) expect(spec.rider.mass).toBeLessThan(spec.mass);
    });

    it(`${kind}: calibration tables line up and speeds ascend from zero`, () => {
      const cal = CALIBRATION[kind];
      const n = cal.speeds.length;
      expect(cal.speeds[0]).toBe(0);
      for (let i = 1; i < n; i++) expect(cal.speeds[i]!).toBeGreaterThan(cal.speeds[i - 1]!);
      expect(cal.residualPerArea.length).toBe(n);
      expect(cal.modelResistance.length).toBe(n);
      expect(cal.sinkage.length).toBe(n);
      expect(cal.trim.length).toBe(n);
      expect(cal.stability.gz.length).toBe(cal.stability.heel.length);
    });
  }
});
