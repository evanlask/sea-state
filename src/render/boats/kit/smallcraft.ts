// Small-craft deck hardware at real size for the sailboat, center console and
// jet ski: sailing winches, horn cleats, flush hatches, stanchions with wire
// lifelines, rod holders, grab rails, pulpits from polylines, steering wheels
// and a few generic shapes (rounded slabs, capsules). Same conventions as
// props.ts: local y up, −z forward, origin on the mounting surface.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type BufferGeometry, type Matrix4, Quaternion, TorusGeometry, Vector3 } from 'three/webgpu';

import {
  at,
  bevelBox,
  cylinder,
  extrude,
  lathe,
  normalizeGeometry,
  type PartBuilder,
  rod,
  roundedRect,
  tube,
} from './geometry';
import { SLOTS } from './props';

const put = (b: PartBuilder, slot: string, g: BufferGeometry, m: Matrix4, local?: Matrix4): void => {
  b.add(slot, g, local ? m.clone().multiply(local) : m);
};

// Self-tailing sheet winch: base flange, waisted drum, black tailer jaws and top cap; r = drum radius.
export function sailWinch(
  b: PartBuilder,
  m: Matrix4,
  r = 0.075,
  o: { drum?: string; segments?: number } = {},
): void {
  const h = r * 2.4;
  const seg = o.segments ?? 18;
  put(
    b,
    o.drum ?? SLOTS.chrome,
    lathe(
      [
        [0, 0],
        [r * 1.4, 0],
        [r * 1.38, h * 0.08],
        [r * 1.02, h * 0.14],
        [r * 0.94, h * 0.4],
        [r * 1.0, h * 0.62],
        [r * 1.04, h * 0.66],
      ],
      seg,
    ),
    m,
  );
  put(
    b,
    SLOTS.black,
    lathe(
      [
        [r * 1.04, h * 0.66],
        [r * 1.12, h * 0.7],
        [r * 1.12, h * 0.86],
        [r * 0.8, h * 0.9],
      ],
      seg,
    ),
    m,
  );
  put(
    b,
    o.drum ?? SLOTS.chrome,
    lathe(
      [
        [r * 0.8, h * 0.9],
        [r * 0.78, h * 0.98],
        [r * 0.25, h],
        [0, h],
      ],
      seg,
    ),
    m,
  );
}

// Horn cleat (length along local x).
export function hornCleat(b: PartBuilder, m: Matrix4, length = 0.2, slot: string = SLOTS.chrome): void {
  const h = length * 0.22;
  put(b, slot, bevelBox(length * 0.35, h * 0.7, length * 0.22, length * 0.04), m, at(0, h * 0.35, 0));
  put(
    b,
    slot,
    tube(
      [
        new Vector3(-length / 2, h * 0.95, 0),
        new Vector3(-length * 0.2, h * 1.05, 0),
        new Vector3(length * 0.2, h * 1.05, 0),
        new Vector3(length / 2, h * 0.95, 0),
      ],
      length * 0.06,
      { radial: 8, segments: 10, caps: true },
    ),
    m,
  );
}

// Flush deck hatch: aluminium frame and a smoked acrylic lens (w across, l fore-aft).
export function deckHatch(
  b: PartBuilder,
  m: Matrix4,
  w: number,
  l: number,
  o: { frame?: string; lens?: string } = {},
): void {
  put(b, o.frame ?? 'alu', bevelBox(w, 0.03, l, 0.012), m, at(0, 0.015, 0));
  put(b, o.lens ?? 'acrylic', bevelBox(w - 0.05, 0.012, l - 0.05, 0.005), m, at(0, 0.034, 0));
  // Hinges on the forward edge and two dogs aft.
  for (const x of [-w * 0.3, w * 0.3]) {
    put(b, SLOTS.black, bevelBox(0.05, 0.02, 0.03, 0.005), m, at(x, 0.04, -l / 2 + 0.01));
    put(b, SLOTS.black, bevelBox(0.03, 0.03, 0.05, 0.008), m, at(x, 0.04, l / 2 - 0.03));
  }
}

// Polyline rail (pulpits, pushpits, grab rails, T-top frames) as a smooth stainless tube; `caps` closes
// ends that stand free (else they show as hollow rings).
export function rail(
  b: PartBuilder,
  points: readonly Vector3[],
  radius = 0.0125,
  o: { slot?: string; sharp?: boolean; radial?: number; caps?: boolean } = {},
): void {
  if (points.length < 2) return;
  b.add(
    o.slot ?? SLOTS.chrome,
    tube(points, radius, {
      radial: o.radial ?? 8,
      segments: points.length * 6,
      sharp: o.sharp,
      caps: o.caps,
    }),
  );
}

// Stanchions with wire lifelines through a body-frame polyline of base points.
export function lifelines(
  b: PartBuilder,
  bases: readonly Vector3[],
  o: { height?: number; wires?: readonly number[]; post?: string; wire?: string; lod?: number } = {},
): void {
  const h = o.height ?? 0.61;
  const post = o.post ?? SLOTS.chrome;
  const parts: BufferGeometry[] = [];
  const radial = (o.lod ?? 0) === 0 ? 8 : 5;
  for (const p of bases) {
    parts.push(normalizeGeometry(rod(p, p.clone().setY(p.y + h), 0.0125, radial)));
    // Base socket.
    parts.push(normalizeGeometry(cylinder(0.025, 0.06, radial).translate(p.x, p.y + 0.03, p.z)));
  }
  b.add(post, mergeGeometries(parts, false)!);
  const wires: BufferGeometry[] = [];
  for (const y of o.wires ?? [h * 0.55, h]) {
    for (let i = 0; i + 1 < bases.length; i++) {
      const a = bases[i]!.clone().setY(bases[i]!.y + y);
      const c = bases[i + 1]!.clone().setY(bases[i + 1]!.y + y);
      wires.push(normalizeGeometry(rod(a, c, 0.0035, 4)));
    }
  }
  if (wires.length) b.add(o.wire ?? 'wire', mergeGeometries(wires, false)!);
}

// Steering wheel geometry (separate mesh so it can turn): rim, spokes and hub in the local xy plane,
// facing +z (toward the helmsman aft). r = rim radius.
export function steeringWheelGeometry(
  r: number,
  o: { spokes?: number; rim?: number; segments?: number; dish?: number } = {},
): BufferGeometry {
  const spokes = o.spokes ?? 6;
  const rim = o.rim ?? r * 0.028;
  const dish = o.dish ?? r * 0.12;
  const parts: BufferGeometry[] = [
    normalizeGeometry(new TorusGeometry(r, rim, 8, o.segments ?? 48)).translate(0, 0, dish),
  ];
  for (let k = 0; k < spokes; k++) {
    const a = (k / spokes) * Math.PI * 2;
    parts.push(
      normalizeGeometry(
        rod(
          new Vector3(Math.cos(a) * 0.04, Math.sin(a) * 0.04, 0),
          new Vector3(Math.cos(a) * r, Math.sin(a) * r, dish),
          rim * 0.6,
          5,
        ),
      ),
    );
  }
  parts.push(normalizeGeometry(cylinder(0.05, 0.08, 12).rotateX(Math.PI / 2)));
  return mergeGeometries(parts, false)!;
}

// Flush-mount rod holder: chrome rim ring and a tube angled aft (local −z forward).
export function rodHolder(b: PartBuilder, m: Matrix4, tilt = 0.25, slot: string = SLOTS.chrome): void {
  put(b, slot, cylinder(0.035, 0.012, 10), m, at(0, 0.006, 0));
  put(b, SLOTS.black, cylinder(0.026, 0.014, 10), m, at(0, 0.008, 0));
  put(b, slot, cylinder(0.028, 0.22, 8), m, at(0, -0.1, 0.025, -tilt));
}

// Rounded slab: a rounded-rectangle plan extruded upward with bevelled edges (cushions, hatches, tops).
export function slab(w: number, l: number, h: number, corner = 0.05, bevel = 0.02): BufferGeometry {
  return extrude(roundedRect(w, l, corner), h, 'y', { bevel: Math.min(bevel, h / 2.2), curveSegments: 4 });
}

// Capsule between two points (limbs, grips, fender bodies).
export function capsule(from: Vector3, to: Vector3, radius: number, segments = 8): BufferGeometry {
  const len = from.distanceTo(to);
  const steps = 3;
  const profile: [number, number][] = [[0, -radius]];
  for (let i = 1; i <= steps; i++) {
    const a = -Math.PI / 2 + (i / steps) * (Math.PI / 2);
    profile.push([Math.cos(a) * radius, Math.sin(a) * radius]);
  }
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    profile.push([Math.cos(a) * radius, len + Math.sin(a) * radius]);
  }
  const g = lathe(profile, segments);
  const dir = to.clone().sub(from).normalize();
  g.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
  g.translate(from.x, from.y, from.z);
  return g;
}
