// Builds the two sails' cloth frames (corners, apparent wind, model load) from a sailboat snapshot's
// 'sail.*' telemetry and the rig geometry, so the render side can drive the cloth without the sim.

import type { Vec3 } from '../sim/core/math';
import { CC115_RIG, genoaPlan, mainCut, type RigSpec } from '../sim/sail/rig';
import { SAIL_KEYS as K } from '../sim/sail/telemetry';
import type { SailFrame } from './SailCloth';

const v = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export const sailFrame = (): SailFrame => ({
  tack: v(),
  clew: v(),
  head: v(),
  headLeech: v(),
  air: v(),
  fill: 1,
  force: 0,
  gravity: { x: 0, y: -9.81, z: 0 },
});

const mainScratch = mainCut(CC115_RIG, 0);
const genoaScratch = genoaPlan(CC115_RIG, 0);
const copy = (out: Vec3, a: Vec3): void => {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
};
const get = (t: Readonly<Record<string, number>>, key: string, fallback = 0): number => t[key] ?? fallback;

// Fills `main` and `jib` from telemetry; gravity (body frame) comes from the boat's render pose.
// Returns the genoa's furl fraction (the caller hides it when fully rolled).
export function sailFramesFromTelemetry(
  t: Readonly<Record<string, number>>,
  gravity: Vec3,
  main: SailFrame,
  jib: SailFrame,
  rig: RigSpec = CC115_RIG,
): number {
  const beta = get(t, K.boomAngle);
  // The main as cut (pointed head with a small headboard, roached leech), not the aero trapezoid: the
  // same area, and the cloth's load is scaled to the model's force anyway.
  const cut = mainCut(rig, get(t, K.reefProgress), mainScratch);
  main.tack.x = 0;
  main.tack.y = rig.boomY;
  main.tack.z = rig.mastZ;
  main.clew.x = Math.sin(beta) * cut.foot;
  main.clew.y = rig.boomY;
  main.clew.z = rig.mastZ + Math.cos(beta) * cut.foot;
  main.head.x = 0;
  main.head.y = rig.boomY + cut.luff;
  main.head.z = rig.mastZ;
  main.headLeech.x = Math.sin(beta) * cut.headboard;
  main.headLeech.y = main.head.y;
  main.headLeech.z = rig.mastZ + Math.cos(beta) * cut.headboard;
  main.roach = cut.roach;
  main.roachFrom = cut.from;
  main.air.x = get(t, K.mainAwX);
  main.air.y = get(t, K.mainAwY);
  main.air.z = get(t, K.mainAwZ);
  main.fill = get(t, K.mainFill, 1);
  main.force = get(t, K.mainForce);

  const furl = get(t, K.jibFurl);
  const g = genoaPlan(rig, furl, genoaScratch);
  jib.tack.x = rig.tack.x;
  jib.tack.y = rig.tack.y;
  jib.tack.z = rig.tack.z;
  jib.head.x = g.head.x;
  jib.head.y = g.head.y;
  jib.head.z = g.head.z;
  jib.clew.x = get(t, K.jibClewX);
  jib.clew.y = get(t, K.jibClewY, rig.tack.y + rig.genoaClewHeight);
  jib.clew.z = get(t, K.jibClewZ, rig.mastZ);
  // A genoa comes to a point at the head.
  copy(jib.headLeech, g.head);
  jib.air.x = get(t, K.jibAwX);
  jib.air.y = get(t, K.jibAwY);
  jib.air.z = get(t, K.jibAwZ);
  jib.fill = get(t, K.jibFill, 1);
  jib.force = get(t, K.jibForce);
  copy(main.gravity, gravity);
  copy(jib.gravity, gravity);
  return furl;
}
