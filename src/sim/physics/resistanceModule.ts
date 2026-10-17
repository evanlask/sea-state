// Calibrated calm-water resistance: the towing tank (towingTank.ts) measures
// what the hull model alone gives at each speed; the difference to the target
// resistance (Holtrop-Mennen, ITTC + DSYHS-style, Savitsky) is stored per m² of
// wetted surface and applied here against the surge velocity, scaled by the
// wetted area of the moment — so it vanishes when the hull is airborne.
// For the MMG ships (no Kerner horizontal drag) this is the whole R₀.
//
// Telemetry: resistance (N, this module's surge force), froude (Fn on LWL).

import { qRotate, qRotateInverse, vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import type { ForceContext, ForceModule } from './modules';
import { interpolate } from './resistance';

export interface ResidualTable {
  speeds: readonly number[]; // m/s, ascending, starting at 0
  perArea: readonly number[]; // N/m² of wetted area
}

const vBody = vec3();
const fBody = vec3();
const fWorld = vec3();
const pBody = vec3();
const pWorld = vec3();

export class ResidualResistance implements ForceModule {
  readonly table: ResidualTable;
  readonly depth: number; // body y of the line of action
  readonly lwl: number;
  force = 0;
  froude = 0;

  constructor(table: ResidualTable, depth: number, lwl: number) {
    this.table = table;
    this.depth = depth;
    this.lwl = lwl;
  }

  apply(ctx: ForceContext): void {
    const body = ctx.body;
    const wetted = ctx.hull?.wettedArea ?? 0;
    qRotateInverse(vBody, body.orientation, body.velocity);
    const u = -vBody.z;
    const speed = Math.abs(u);
    this.froude = speed / Math.sqrt(GRAVITY * this.lwl);
    if (wetted <= 0 || speed < 1e-4) {
      this.force = 0;
      return;
    }
    const r = interpolate(this.table.speeds, this.table.perArea, speed) * wetted;
    // Linear ramp at walking pace so the force goes smoothly through zero.
    const f = -Math.sign(u) * r * Math.min(1, speed / 0.05);
    this.force = f;
    const k = ctx.tuning?.timeCompression ?? 1;
    fBody.x = 0;
    fBody.y = 0;
    fBody.z = -f;
    qRotate(fWorld, body.orientation, fBody);
    pBody.x = 0;
    pBody.y = this.depth;
    pBody.z = body.cg.z;
    body.bodyToWorldPoint(pWorld, pBody);
    body.addForceAtPointXYZ(fWorld.x, fWorld.y, fWorld.z, pWorld.x, pWorld.y, pWorld.z);
    if (k !== 1) {
      body.force.x += (k - 1) * fWorld.x;
      body.force.z += (k - 1) * fWorld.z;
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    out['resistance'] = -this.force;
    out['froude'] = this.froude;
  }
}
