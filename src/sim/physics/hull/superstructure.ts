// Places watertight superstructure volumes (deckhouse, bridge, wheelhouse,
// cabin trunk, console) on the generated deck as closed frustum meshes.

import { frustumMesh, type TriMesh } from '../mesh';
import type { HullBuild } from './generateHull';
import type { SuperstructureSpec } from './types';

export function buildSuperstructure(hull: HullBuild, spec: SuperstructureSpec): TriMesh {
  const z0 = spec.z - spec.length / 2;
  const z1 = spec.z + spec.length / 2;
  // Sit on the highest deck point under the footprint: no overlap with the hull
  // (no double-counted volume), at the cost of a sliver gap under a sheer.
  let deck = -Infinity;
  let halfBreadth = Infinity;
  for (let i = 0; i <= 8; i++) {
    const z = z0 + ((z1 - z0) * i) / 8;
    deck = Math.max(deck, hull.deckHeightAt(z));
    halfBreadth = Math.min(halfBreadth, hull.deckHalfBreadthAt(z));
  }
  const x = spec.x ?? 0;
  const width = Math.min(spec.width, 2 * Math.max(0.05, 0.98 * halfBreadth - Math.abs(x)));
  const scale = width / spec.width;
  return frustumMesh({
    cx: x,
    cz: spec.z,
    y0: deck + (spec.baseOffset ?? 0),
    length: spec.length,
    width,
    height: spec.height,
    topLength: spec.topLength,
    topWidth: spec.topWidth !== undefined ? spec.topWidth * scale : undefined,
    topShiftZ: spec.topShiftZ,
  });
}
