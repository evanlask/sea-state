// Debug overlay (?debug → lil-gui "collision shapes"): wireframes of every boat's collision prisms
// (sim/world/collisionShapes.ts), placed as the collision code places them: each prism's reference
// point through the boat's full pose, its outline turned by the heading only, upright between its
// height limits, with a ring at the waterline. Built lazily.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicNodeMaterial,
  LineSegments,
  Quaternion,
  Vector3,
} from 'three/webgpu';

import { type CollisionPiece, collisionShapeFor } from '../../sim/world/collisionShapes';
import type { BoatKind, BoatSnapshot } from '../../sim/world/protocol';

const COLOURS: Record<string, number> = {
  bow: 0xff453a,
  'bow-low': 0xff9f0a,
  'bow-high': 0xff453a,
  aft: 0x32d74b,
  'aft-low': 0x64d2ff,
  'aft-high': 0x32d74b,
};
const OTHER = 0xbf5af2;
const Y_AXIS = new Vector3(0, 1, 0);

interface PlacedPrism {
  lines: LineSegments;
  zc: number;
}

// Line-segment wireframe of a prism around its reference point (0, 0, zc): bottom, waterline and
// top rings and the vertical edges.
function prismGeometry(p: CollisionPiece): BufferGeometry {
  const n = p.xs.length;
  const levels = [p.y0, p.y1];
  if (p.y0 < 0 && p.y1 > 0) levels.push(0);
  const pos: number[] = [];
  for (const y of levels) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      pos.push(p.xs[i]!, y, p.zs[i]! - p.zc, p.xs[j]!, y, p.zs[j]! - p.zc);
    }
  }
  for (let i = 0; i < n; i++) pos.push(p.xs[i]!, p.y0, p.zs[i]! - p.zc, p.xs[i]!, p.y1, p.zs[i]! - p.zc);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  return g;
}

const q = new Quaternion();
const yaw = new Quaternion();
const v = new Vector3();

export class CollisionOverlay {
  readonly group = new Group();
  private readonly materials = new Map<number, LineBasicNodeMaterial>();
  private readonly geometries = new Map<
    BoatKind,
    { geometry: BufferGeometry; colour: number; zc: number }[]
  >();
  private readonly boats = new Map<string, PlacedPrism[]>();

  constructor() {
    this.group.name = 'collision-shapes';
  }

  private material(colour: number): LineBasicNodeMaterial {
    let m = this.materials.get(colour);
    if (!m) {
      // Drawn over everything, so the prisms show through the hulls they wrap.
      m = new LineBasicNodeMaterial({
        color: colour,
        depthTest: false,
        depthWrite: false,
        transparent: true,
      });
      this.materials.set(colour, m);
    }
    return m;
  }

  private prisms(kind: BoatKind): PlacedPrism[] {
    let shapes = this.geometries.get(kind);
    if (!shapes) {
      shapes = collisionShapeFor(kind).pieces.map((p) => ({
        geometry: prismGeometry(p),
        colour: COLOURS[p.name] ?? OTHER,
        zc: p.zc,
      }));
      this.geometries.set(kind, shapes);
    }
    return shapes.map((s) => {
      const lines = new LineSegments(s.geometry, this.material(s.colour));
      lines.renderOrder = 1000;
      lines.frustumCulled = false;
      this.group.add(lines);
      return { lines, zc: s.zc };
    });
  }

  update(boats: readonly BoatSnapshot[]): void {
    for (const boat of boats) {
      let placed = this.boats.get(boat.id);
      if (!placed) {
        placed = this.prisms(boat.kind);
        this.boats.set(boat.id, placed);
      }
      q.set(boat.orientation.x, boat.orientation.y, boat.orientation.z, boat.orientation.w);
      // Heading only for the outline (as sim/world/collisions.ts does).
      v.set(0, 0, -1).applyQuaternion(q);
      yaw.setFromAxisAngle(Y_AXIS, Math.atan2(-v.x, -v.z));
      for (const prism of placed) {
        // The prism's reference point through the full pose (the snapshot is the body origin).
        v.set(0, 0, prism.zc).applyQuaternion(q);
        prism.lines.position.set(boat.position.x + v.x, boat.position.y + v.y, boat.position.z + v.z);
        prism.lines.quaternion.copy(yaw);
      }
    }
    for (const [id, placed] of this.boats) {
      if (boats.some((b) => b.id === id)) continue;
      for (const prism of placed) prism.lines.removeFromParent();
      this.boats.delete(id);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const shapes of this.geometries.values()) for (const s of shapes) s.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.boats.clear();
  }
}
