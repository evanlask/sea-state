// Added-mass Coriolis terms for the Kerner (non-MMG) hulls. The rigid body
// integrates in the world frame with per-axis body added mass (RigidBody.ts),
// so a steady turn costs a side force (m + m_y)·u·r and the drift couples into
// surge as (m + m_x)·v·r. Kirchhoff's equations for a body in a fluid want them
// the other way round: (m + m_x)·u·r in sway and (m + m_y)·v·r in surge. This
// adds the difference, scaled with immersion like the added mass itself:
//
//   Y = (m_y − m_x)·u·r,   X = (m_y − m_x)·v·r    (body axes, x starboard, u forward)
//
// The sway term matters off the plane, where a boat turning tightly would
// otherwise need a third more side force than it does; the surge term is the
// extra drag of a drifting turn (v·r < 0 in a turn). Same correction as the
// MMG ships make in mmg.ts. Acts at the CG (it is inertia), and is not time-
// compressed in Arcade.

import { qRotate, qRotateInverse, vec3 } from '../core/math';
import type { ForceContext, ForceModule } from './modules';

const vb = vec3();
const wb = vec3();
const fb = vec3();
const fw = vec3();

export class AddedMassCoriolis implements ForceModule {
  apply(ctx: ForceContext): void {
    const body = ctx.body;
    const a = body.addedMass;
    const dm = (a.sway - a.surge) * body.mass * body.immersion;
    if (dm === 0) return;
    qRotateInverse(vb, body.orientation, body.velocity);
    qRotateInverse(wb, body.orientation, body.angularVelocity);
    const r = -wb.y; // + bow to starboard
    fb.x = dm * -vb.z * r;
    fb.y = 0;
    fb.z = -dm * vb.x * r;
    qRotate(fw, body.orientation, fb);
    body.force.x += fw.x;
    body.force.y += fw.y;
    body.force.z += fw.z;
  }

  writeTelemetry(): void {}
}
