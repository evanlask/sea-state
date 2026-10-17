import { describe, expect, it } from 'vite-plus/test';

import { crabSpec } from '../../../sim/boats/specs/crab';
import { variantFromTelemetry } from '../createBoatVisual';
import { crabPotsPerTier } from '../models/crab';

describe('loaded boat visuals', () => {
  it('stacks pots as the physics does: the same number to a tier', () => {
    expect(crabPotsPerTier()).toBe(crabSpec.potStack!.perTier);
  });

  it('reads the load from the telemetry', () => {
    expect(variantFromTelemetry('crab', { crabPots: 0 })).toEqual({ crabPots: 0 });
    expect(variantFromTelemetry('cargo', { ballast: 1 })).toEqual({ ballast: true });
    expect(variantFromTelemetry('sail', { crabPots: 5 })).toEqual({});
  });
});
