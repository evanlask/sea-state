// Pose interpolation between two simulation snapshots.
import { qSlerp } from '../sim/core/math';
import type { BoatSnapshot, Snapshot } from '../sim/world/protocol';
import type { Bracket } from './RenderClock';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// The blended boats are written into objects kept per boat id, in two sets used on alternate calls,
// so a frame allocates nothing and last frame's boats stay as they were for one more frame.
const pools = [new Map<string, BoatSnapshot>(), new Map<string, BoatSnapshot>()] as const;
const results: [BoatSnapshot[], BoatSnapshot[]] = [[], []];
let flip = 0;

const blank = (): BoatSnapshot => ({
  id: '',
  kind: 'cargo',
  position: { x: 0, y: 0, z: 0 },
  orientation: { x: 0, y: 0, z: 0, w: 1 },
  velocity: { x: 0, y: 0, z: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  telemetry: {},
});

// Boats present in both snapshots are blended; boats only in `b` (just spawned) appear as-is.
export function interpolateBoats(bracket: Bracket<Snapshot>): readonly BoatSnapshot[] {
  const { a, b, alpha } = bracket;
  if (a === b || alpha <= 0) return a.boats;
  flip ^= 1;
  const pool = pools[flip as 0 | 1];
  const out = results[flip as 0 | 1];
  let count = 0; // (out.length = 0 would free the array's storage)
  for (const next of b.boats) {
    let prev: BoatSnapshot | undefined;
    for (const boat of a.boats) {
      if (boat.id === next.id) {
        prev = boat;
        break;
      }
    }
    if (!prev) {
      out[count++] = next;
      continue;
    }
    let boat = pool.get(next.id);
    if (!boat) pool.set(next.id, (boat = blank()));
    boat.id = next.id;
    boat.kind = next.kind;
    boat.angularVelocity = next.angularVelocity;
    boat.telemetry = next.telemetry;
    const p = boat.position;
    p.x = lerp(prev.position.x, next.position.x, alpha);
    p.y = lerp(prev.position.y, next.position.y, alpha);
    p.z = lerp(prev.position.z, next.position.z, alpha);
    qSlerp(boat.orientation, prev.orientation, next.orientation, alpha);
    const v = boat.velocity;
    v.x = lerp(prev.velocity.x, next.velocity.x, alpha);
    v.y = lerp(prev.velocity.y, next.velocity.y, alpha);
    v.z = lerp(prev.velocity.z, next.velocity.z, alpha);
    out[count++] = boat;
  }
  out.length = count;
  // Boats gone from the fleet.
  if (pool.size > count) {
    for (const id of pool.keys()) if (!b.boats.some((boat) => boat.id === id)) pool.delete(id);
  }
  return out;
}
