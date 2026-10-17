// Appendage foils as force modules: fixed keels/skegs, and helm-driven foil
// rudders (sailboat spade rudder) with a rate limit.
//
// Telemetry: HelmFoil writes rudderOrder, rudderAngle, rudderMax (rad, + starboard helm).

import { applyFoil, foilState, type FoilSpec } from '../foils';
import type { ForceContext, ForceModule } from '../modules';
import { clamp, rateLimit } from './common';

export class FixedFoil implements ForceModule {
  readonly foil: FoilSpec;
  private readonly state = foilState();

  constructor(foil: FoilSpec) {
    this.foil = foil;
  }

  apply(ctx: ForceContext): void {
    applyFoil(ctx.body, this.foil, 0, ctx.water, ctx.time, this.state);
  }

  writeTelemetry(): void {}
}

export class HelmFoil implements ForceModule {
  readonly foil: FoilSpec;
  readonly maxAngle: number;
  readonly rate: number;
  angle = 0;
  order = 0;
  private readonly state = foilState();

  constructor(foil: FoilSpec, maxAngle: number, rate: number) {
    this.foil = foil;
    this.maxAngle = maxAngle;
    this.rate = rate;
  }

  apply(ctx: ForceContext): void {
    this.order = clamp(ctx.controls.steer, -1, 1) * this.maxAngle;
    this.angle = rateLimit(this.angle, this.order, this.rate, ctx.dt);
    // Positive foil deflection swings the trailing edge to port (a port turn), so negate.
    applyFoil(ctx.body, this.foil, -this.angle, ctx.water, ctx.time, this.state);
    const k = ctx.tuning?.timeCompression ?? 1;
    if (k !== 1) {
      const f = this.state.worldForce;
      const p = this.state.worldPoint;
      ctx.body.addForceAtPointXYZ((k - 1) * f.x, 0, (k - 1) * f.z, p.x, ctx.body.position.y, p.z);
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    out['rudderOrder'] = this.order;
    out['rudderAngle'] = this.angle;
    out['rudderMax'] = this.maxAngle;
  }

  reset(): void {
    this.angle = 0;
  }
}
