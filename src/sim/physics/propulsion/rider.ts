// The jet ski's rider: a sit-on craft with GM of a few centimetres is only
// stable because the rider keeps balancing it. Modelled as weight shift with
// a limited reach (±0.35 m sideways, 0.4 m fore-aft) driven by a PD balance
// reflex on heel and on trim above a comfortable running trim. Inactive once
// the craft is past ~60° (the rider has fallen off / is hanging on).
// Turning, the rider leans into the turn: with the bars over, the balance
// target is the coordinated bank of the turn the craft is making (TurnSense
// and helmTurn, capped like the hull's carve, see ../planingCarve.ts) rather
// than upright. Running straight the rider keeps it level, whatever the chop
// does to its heading. Thrown off in a capsize (setRider), he balances nothing
// until Recover puts him back.
//
// Telemetry: riderLean (−1..1, + leaning to starboard).

import { attitudeFromQuat } from '../../core/attitude';
import { qRotate, qRotateInverse, vec3 } from '../../core/math';
import { GRAVITY } from '../../core/units';
import type { ForceContext, ForceModule } from '../modules';
import { helmTurn, TurnSense } from '../planingCarve';
import { clamp } from './common';

const wb = vec3();
const vb = vec3();
const tb = vec3();
const tw = vec3();

export class RiderBalance implements ForceModule {
  readonly riderMass: number;
  readonly maxBank: number;
  lean = 0;
  aboard = true;
  private readonly turn = new TurnSense();
  private readonly attitude = { heading: 0, pitch: 0, roll: 0 };

  constructor(riderMass = 90, maxBank = 0) {
    this.riderMass = riderMass;
    this.maxBank = maxBank;
  }

  apply(ctx: ForceContext): void {
    const body = ctx.body;
    const att = attitudeFromQuat(body.orientation, this.attitude);
    const turnBank = this.turn.update(body.velocity, ctx.dt);
    if (!this.aboard || Math.abs(att.roll) > 1.05) {
      this.lean = 0;
      return;
    }
    qRotateInverse(wb, body.orientation, body.angularVelocity);
    qRotateInverse(vb, body.orientation, body.velocity);
    const w = this.riderMass * GRAVITY;
    // Roll: + roll is starboard down = rotation about −z (bow axis), so a righting
    // torque about +z body pushes starboard up. A starboard turn is a rotation about −y.
    const bank = -vb.z > 0 ? clamp(turnBank, -this.maxBank, this.maxBank) * helmTurn(ctx.controls.steer) : 0;
    this.lean = clamp(-(2.5 * (att.roll - bank) - 0.6 * wb.z), -1, 1);
    tb.z = -this.lean * w * 0.35;
    // Pitch: lean forward when the bow rides higher than ~4°.
    tb.x = -clamp((att.pitch - 0.07) * 6 + 0.3 * wb.x, 0, 1) * w * 0.4;
    tb.y = 0;
    qRotate(tw, body.orientation, tb);
    body.addTorque(tw);
  }

  writeTelemetry(out: Record<string, number>): void {
    out['riderLean'] = this.lean;
  }

  setRider(aboard: boolean): void {
    this.aboard = aboard;
    this.lean = 0;
  }

  reset(): void {
    this.lean = 0;
    this.turn.reset();
  }
}
