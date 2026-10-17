// A boat's view of the sea: the ocean surface plus every *other* boat's wake (sim/ocean/wake/
// WakeField.ts). Wraps the SurfaceQuery its HullWater grid samples, so hull forces, foils, the
// propeller and openings all feel other boats' wakes — and never the boat's own.

import type { SurfaceQuery } from '../../physics/hullWater';
import { createSurfaceSample, type DeepSample, type SurfaceSample } from '../OceanSurface';
import { type BoatWake, type WakeField, wakeSample } from './WakeField';

export class WakeSurface implements SurfaceQuery {
  readonly base: SurfaceQuery;
  readonly field: WakeField;
  readonly exclude: BoatWake | null; // this boat's own grid
  private readonly wake = wakeSample();
  private readonly scratch = createSurfaceSample();

  constructor(base: SurfaceQuery, field: WakeField, exclude: BoatWake | null) {
    this.base = base;
    this.field = field;
    this.exclude = exclude;
  }

  query(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth = 0,
    mask?: number,
    warmStart?: boolean,
  ): SurfaceSample {
    this.base.query(x, z, time, out, depth, mask, warmStart);
    return this.addWakes(x, z, time, out, depth);
  }

  // The sea at the surface and `depth` below it (the base's queryWithDepth, or two queries), plus
  // the wakes at both.
  queryWithDepth(
    x: number,
    z: number,
    time: number,
    out: SurfaceSample,
    depth: number,
    deep: DeepSample,
    mask?: number,
    warmStart?: boolean,
  ): SurfaceSample {
    const base = this.base;
    if (base.queryWithDepth) base.queryWithDepth(x, z, time, out, depth, deep, mask, warmStart);
    else {
      base.query(x, z, time, out, 0, mask, warmStart);
      const s = this.scratch;
      s.lagrangianX = out.lagrangianX;
      s.lagrangianZ = out.lagrangianZ;
      base.query(x, z, time, s, depth, mask, true);
      deep.pressureHead = s.pressureHead;
      deep.velocityX = s.velocityX;
      deep.velocityY = s.velocityY;
      deep.velocityZ = s.velocityZ;
    }
    const w = this.field.sample(x, z, time, this.exclude, depth, this.wake);
    if (w.count > 0) {
      deep.pressureHead += w.pressure;
      deep.velocityY += w.velocityY;
    }
    return this.addWakes(x, z, time, out, 0);
  }

  private addWakes(x: number, z: number, time: number, out: SurfaceSample, depth: number): SurfaceSample {
    const w = this.field.sample(x, z, time, this.exclude, depth, this.wake);
    if (w.count === 0) return out;
    out.height += w.height;
    out.pressureHead += w.pressure;
    out.velocityY += w.velocityY;
    // Slopes add: n ∝ (−∂η/∂x, 1, −∂η/∂z).
    const ny = out.normalY > 1e-3 ? out.normalY : 1e-3;
    const gx = -out.normalX / ny + w.slopeX;
    const gz = -out.normalZ / ny + w.slopeZ;
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.normalX = -gx * inv;
    out.normalY = inv;
    out.normalZ = -gz * inv;
    return out;
  }
}
