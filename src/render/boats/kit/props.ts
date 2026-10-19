// Detail props at real size (metres), each added to a PartBuilder under
// material slots so they merge with the rest of the vessel. Local frame: y up,
// −z forward (toward the bow when placed with yaw 0), origin on the deck.
//
// Slot names are conventions shared by all models (see SLOTS); a model maps
// each slot to a material. Rotating/animated parts (radar arrays, wipers) are
// returned as separate geometry for their own meshes.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BufferGeometry,
  Float32BufferAttribute,
  type Matrix4,
  Path,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';

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

export const SLOTS = {
  hull: 'hull',
  deck: 'deck',
  house: 'house', // superstructure paint
  trim: 'trim', // accent paint (funnel, mast bands)
  machinery: 'machinery', // deck machinery paint
  steel: 'steel', // galvanised / bare steel
  chrome: 'chrome',
  black: 'black', // rubber, black paint
  glass: 'glass',
  orange: 'orange', // survival craft GRP
  white: 'white', // GRP / white plastic
  red: 'red',
  lampWhite: 'lampWhite',
  lampRed: 'lampRed',
  lampGreen: 'lampGreen',
  flood: 'flood', // floodlight lenses
} as const;

const put = (b: PartBuilder, slot: string, g: BufferGeometry, m: Matrix4, local?: Matrix4): void => {
  b.add(slot, g, local ? m.clone().multiply(local) : m);
};

// Double bitts (mooring bollard) on a base plate; r = post radius.
export function bollard(b: PartBuilder, m: Matrix4, r = 0.2, slot: string = SLOTS.machinery): void {
  const h = r * 3;
  put(b, slot, bevelBox(r * 6, r * 0.25, r * 2.6, r * 0.08), m, at(0, r * 0.125, 0));
  const post = lathe(
    [
      [0, 0],
      [r, 0],
      [r, h * 0.82],
      [r * 1.35, h * 0.86],
      [r * 1.35, h],
      [0, h],
    ],
    14,
  );
  put(b, slot, post, m, at(-r * 1.6, r * 0.25, 0));
  put(b, slot, post, m, at(r * 1.6, r * 0.25, 0));
}

// Panama/closed chock in a bulwark or on deck: oval ring, w × h opening.
export function closedChock(
  b: PartBuilder,
  m: Matrix4,
  w = 0.6,
  h = 0.4,
  slot: string = SLOTS.machinery,
): void {
  const outer = roundedRect(w + 0.24, h + 0.24, (h + 0.24) / 2);
  const hole = new Path();
  const inner = roundedRect(w, h, h / 2);
  hole.setFromPoints(inner.getPoints(8));
  outer.holes.push(hole);
  put(b, slot, extrude(outer, 0.18, 'z', { bevel: 0.03 }), m, at(0, (h + 0.24) / 2, 0, 0, Math.PI / 2));
}

// Mooring winch / windlass: drum with flanges, gearbox, base; gypsy for chain when windlass.
export function winch(
  b: PartBuilder,
  m: Matrix4,
  o: { drum?: number; width?: number; windlass?: boolean; slot?: string } = {},
): void {
  const r = o.drum ?? 0.5;
  const w = o.width ?? 1.4;
  const slot = o.slot ?? SLOTS.machinery;
  put(b, slot, bevelBox(w + r * 2.4, r * 0.3, r * 2.6, 0.04), m, at(0, r * 0.15, 0));
  const drum = cylinder(r, w, 18);
  put(b, SLOTS.black, drum, m, at(0, r * 1.25, 0, 0, 0, Math.PI / 2));
  const flange = cylinder(r * 1.45, r * 0.12, 20);
  for (const x of [-w / 2, w / 2]) put(b, slot, flange, m, at(x, r * 1.25, 0, 0, 0, Math.PI / 2));
  // Gearbox and motor housing.
  put(b, slot, bevelBox(r * 1.4, r * 2.1, r * 2.1, 0.06), m, at(w / 2 + r * 0.9, r * 1.2, 0));
  put(b, slot, cylinder(r * 0.6, r * 1.2, 12), m, at(w / 2 + r * 2.1, r * 1.0, 0, 0, 0, Math.PI / 2));
  if (o.windlass) {
    const gypsy = cylinder(r * 1.05, r * 0.6, 10);
    put(b, SLOTS.steel, gypsy, m, at(-w / 2 - r * 0.6, r * 1.25, 0, 0, 0, Math.PI / 2));
    put(b, slot, bevelBox(r * 0.5, r * 2.2, r * 2.2, 0.05), m, at(-w / 2 - r * 1.2, r * 1.1, 0));
  }
  // Band brake strap.
  put(b, SLOTS.steel, cylinder(r * 1.04, r * 0.15, 18), m, at(-w * 0.3, r * 1.25, 0, 0, 0, Math.PI / 2));
}

// Vertical ladder with rails and rungs (bottom at origin, facing −z).
export function ladder(
  b: PartBuilder,
  m: Matrix4,
  height: number,
  width = 0.45,
  slot: string = SLOTS.steel,
): void {
  for (const x of [-width / 2, width / 2]) {
    put(b, slot, bevelBox(0.06, height, 0.012, 0.004), m, at(x, height / 2, 0));
  }
  const rung = cylinder(0.012, width, 6);
  for (let y = 0.3; y < height; y += 0.3) put(b, slot, rung, m, at(0, y, 0, 0, 0, Math.PI / 2));
}

// Mushroom or gooseneck ventilator.
export function vent(
  b: PartBuilder,
  m: Matrix4,
  o: { kind?: 'mushroom' | 'gooseneck'; r?: number; h?: number; slot?: string } = {},
): void {
  const r = o.r ?? 0.2;
  const h = o.h ?? 0.9;
  const slot = o.slot ?? SLOTS.machinery;
  if ((o.kind ?? 'mushroom') === 'mushroom') {
    put(
      b,
      slot,
      lathe(
        [
          [0, 0],
          [r, 0],
          [r, h],
          [r * 2, h + r * 0.15],
          [r * 2.05, h + r * 0.45],
          [r * 1.2, h + r * 0.75],
          [0, h + r * 0.8],
        ],
        14,
      ),
      m,
    );
  } else {
    const pts = [
      new Vector3(0, 0, 0),
      new Vector3(0, h, 0),
      new Vector3(0, h + r * 1.2, r * 0.6),
      new Vector3(0, h + r * 0.6, r * 1.8),
    ];
    put(b, slot, tube(pts, r, { radial: 10, segments: 10 }), m);
  }
}

// Whip antenna with a base.
export function whipAntenna(b: PartBuilder, m: Matrix4, length = 4, slot: string = SLOTS.white): void {
  put(b, SLOTS.black, cylinder(0.05, 0.25, 8), m, at(0, 0.125, 0));
  put(b, slot, cylinder(0.012, length, 5, 0.006), m, at(0, 0.25 + length / 2, 0));
}

// Dome antenna (GPS / satcom radome).
export function domeAntenna(b: PartBuilder, m: Matrix4, r = 0.15, slot: string = SLOTS.white): void {
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push([Math.cos(a) * r, r * 0.4 + Math.sin(a) * r * 1.1]);
  }
  pts.unshift([r, 0]);
  pts.unshift([0, 0]);
  pts.push([0, r * 1.5]);
  put(b, slot, lathe(pts, 16), m);
  if (r > 0.3) put(b, SLOTS.steel, cylinder(r * 0.25, r * 0.8, 8), m, at(0, -r * 0.4, 0));
}

// Radar: pedestal into the builder; returns the open-array geometry (centred, rotates about y).
export function radarScanner(
  b: PartBuilder,
  m: Matrix4,
  length = 2.4,
  slot: string = SLOTS.white,
): BufferGeometry {
  put(
    b,
    slot,
    lathe(
      [
        [0, 0],
        [0.22, 0],
        [0.2, 0.32],
        [0.14, 0.4],
        [0, 0.4],
      ],
      12,
    ),
    m,
  );
  const arm = normalizeGeometry(bevelBox(length, 0.16, 0.2, 0.05));
  arm.translate(0, 0.52, 0);
  const hub = normalizeGeometry(cylinder(0.1, 0.12, 10));
  hub.translate(0, 0.42, 0);
  return mergeGeometries([arm, hub], false)!;
}

// Lifebuoy in a bracket: orange ring with four white bands (local: ring faces ±z).
export function lifebuoy(b: PartBuilder, m: Matrix4, r = 0.33): void {
  const ring = new TorusGeometry(r, r * 0.22, 8, 24);
  put(b, SLOTS.orange, ring, m, at(0, 0, 0));
  for (let k = 0; k < 4; k++) {
    const band = new TorusGeometry(r, r * 0.235, 8, 3, Math.PI / 8);
    put(b, SLOTS.white, band, m, at(0, 0, 0, 0, 0, (k * Math.PI) / 2 - Math.PI / 16));
  }
  put(b, SLOTS.steel, bevelBox(0.12, 0.04, 0.08, 0.01), m, at(0, r * 1.15, -0.02));
}

// Liferaft canister in a cradle (axis along x).
export function liferaft(b: PartBuilder, m: Matrix4, length = 1.3, r = 0.33): void {
  const body = lathe(
    [
      [0, -length / 2],
      [r * 0.8, -length / 2],
      [r, -length / 2 + 0.08],
      [r, length / 2 - 0.08],
      [r * 0.8, length / 2],
      [0, length / 2],
    ],
    16,
  );
  put(b, SLOTS.white, body, m, at(0, r + 0.12, 0, 0, 0, Math.PI / 2));
  put(b, SLOTS.black, cylinder(r + 0.01, 0.06, 16), m, at(-length * 0.2, r + 0.12, 0, 0, 0, Math.PI / 2));
  put(b, SLOTS.black, cylinder(r + 0.01, 0.06, 16), m, at(length * 0.2, r + 0.12, 0, 0, 0, Math.PI / 2));
  for (const x of [-length * 0.32, length * 0.32]) {
    put(b, SLOTS.steel, bevelBox(0.06, 0.18, r * 2, 0.01), m, at(x, 0.09, 0));
  }
}

// Davit arm (single pivot) reaching outboard along +x by `reach`, height h.
export function davit(b: PartBuilder, m: Matrix4, h = 3, reach = 1.6, slot: string = SLOTS.house): void {
  const pts = [
    new Vector3(0, 0, 0),
    new Vector3(0, h * 0.75, 0),
    new Vector3(reach * 0.45, h, 0),
    new Vector3(reach, h * 0.92, 0),
  ];
  put(b, slot, tube(pts, 0.11 * (h / 3), { radial: 8, segments: 12 }), m);
  put(b, slot, bevelBox(0.5, 0.25, 0.5, 0.04), m, at(0, 0.12, 0));
  put(b, SLOTS.steel, cylinder(0.03, h * 0.5, 4), m, at(reach, h * 0.65, 0));
}

// Floodlight: box housing with a glowing lens facing −z (tilted by `tilt`), on a U-bracket.
export function floodlight(b: PartBuilder, m: Matrix4, size = 0.4, tilt = 0.5): void {
  const local = at(0, size * 0.5, 0, -tilt);
  put(b, SLOTS.steel, bevelBox(size * 1.1, 0.04, 0.06, 0.01), m, at(0, size * 0.1, 0));
  const mm = m.clone().multiply(local);
  put(b, SLOTS.black, bevelBox(size, size * 0.75, size * 0.45, size * 0.06), mm);
  put(b, SLOTS.flood, bevelBox(size * 0.85, size * 0.6, 0.02, 0.005), mm, at(0, 0, -size * 0.23));
  put(b, SLOTS.steel, bevelBox(0.03, size * 0.5, 0.03, 0.005), m, at(-size * 0.55, size * 0.3, 0));
  put(b, SLOTS.steel, bevelBox(0.03, size * 0.5, 0.03, 0.005), m, at(size * 0.55, size * 0.3, 0));
}

// Searchlight: a drum lamp on a yoke and pedestal, facing −z, standing on `m` (the deck or roof). The
// lens itself is drawn by the boat's lights (a searchlight marker at searchlightLens(r) from `m`).
export function searchlight(b: PartBuilder, m: Matrix4, r = 0.2): void {
  const ph = r * 2.2;
  const { y: cy } = searchlightLens(r);
  put(b, SLOTS.steel, cylinder(r * 0.3, ph, 10), m, at(0, ph / 2, 0));
  put(b, SLOTS.steel, bevelBox(r * 2.5, r * 0.22, r * 0.6, r * 0.05), m, at(0, ph + r * 0.11, 0));
  for (const side of [-1, 1])
    put(
      b,
      SLOTS.steel,
      bevelBox(r * 0.18, r * 1.2, r * 0.5, r * 0.04),
      m,
      at(side * r * 1.16, ph + r * 0.7, 0),
    );
  put(b, SLOTS.white, cylinder(r, r * 2.4, 16), m, at(0, cy, 0, Math.PI / 2));
  put(b, SLOTS.black, cylinder(r * 1.08, r * 0.2, 16), m, at(0, cy, -r * 1.2, Math.PI / 2));
  put(b, SLOTS.black, cylinder(r * 0.85, r * 0.3, 12), m, at(0, cy, r * 1.3, Math.PI / 2));
}

// Where a searchlight's lens sits, from the foot of its pedestal.
export const searchlightLens = (r: number): { y: number; z: number } => ({ y: r * 3.35, z: -r * 1.25 });

// Ship's horn / whistle: trumpet pointing −z.
export function horn(b: PartBuilder, m: Matrix4, length = 0.9, slot: string = SLOTS.house): void {
  const g = lathe(
    [
      [0, 0],
      [0.07, 0],
      [0.06, length * 0.6],
      [0.12, length * 0.85],
      [length * 0.28, length],
      [length * 0.26, length],
      [0, length * 0.7],
    ],
    14,
  );
  put(b, slot, g, m, at(0, 0.25, 0, -Math.PI / 2));
  put(b, slot, cylinder(0.05, 0.3, 8), m, at(0, 0.12, 0));
}

// Wiper arm + blade geometry pivoting at the origin, lying in the window plane (local xy), length l.
export function wiperGeometry(l = 0.9): BufferGeometry {
  const arm = normalizeGeometry(bevelBox(0.025, l, 0.02, 0.006));
  arm.translate(0, l / 2, 0.02);
  const blade = normalizeGeometry(bevelBox(0.02, l * 0.7, 0.03, 0.006));
  blade.translate(0, l * 0.62, 0.035);
  return mergeGeometries([arm, blade], false)!;
}

export interface RailingOptions {
  height?: number;
  spacing?: number; // stanchion spacing
  rails?: number; // horizontal rails including the top rail
  radius?: number; // stanchion radius
  topRadius?: number;
  slot?: string;
  closed?: boolean;
}

// Stanchions with horizontal rails along a body-frame polyline (points at deck height).
export function railing(b: PartBuilder, points: readonly Vector3[], o: RailingOptions = {}): void {
  if (points.length < 2) return;
  const h = o.height ?? 1.0;
  const spacing = o.spacing ?? 1.5;
  const slot = o.slot ?? SLOTS.steel;
  const rails = o.rails ?? 3;
  const r = o.radius ?? 0.022;
  const parts: BufferGeometry[] = [];
  const pts = o.closed ? [...points, points[0]!] : [...points];
  // Stanchions.
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[i + 1]!;
    const len = a.distanceTo(c);
    let d = carry;
    while (d <= len + 1e-6) {
      const p = a.clone().lerp(c, len > 0 ? d / len : 0);
      parts.push(normalizeGeometry(rod(p, p.clone().setY(p.y + h), r, 5)));
      d += spacing;
    }
    carry = d - len;
  }
  if (!o.closed) {
    const p = pts[pts.length - 1]!;
    parts.push(normalizeGeometry(rod(p, p.clone().setY(p.y + h), r, 5)));
  }
  // Rails (straight segments between the polyline points).
  for (let k = 1; k <= rails; k++) {
    const y = (h * k) / rails;
    const rr = k === rails ? (o.topRadius ?? r * 1.4) : r * 0.7;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]!.clone().setY(pts[i]!.y + y);
      const c = pts[i + 1]!.clone().setY(pts[i + 1]!.y + y);
      parts.push(normalizeGeometry(rod(a, c, rr, 5)));
    }
  }
  b.add(slot, mergeGeometries(parts, false)!);
}

// A navigation-light housing (small box + lens) at a mount point; lens slot picks the colour.
export function navLightHousing(b: PartBuilder, m: Matrix4, lens: string, size = 0.35): void {
  put(b, SLOTS.black, bevelBox(size * 0.7, size, size * 0.7, size * 0.08), m, at(0, size * 0.5, 0));
  put(b, lens, cylinder(size * 0.28, size * 0.55, 12), m, at(0, size * 0.55, 0));
  put(b, SLOTS.black, cylinder(size * 0.32, size * 0.06, 12), m, at(0, size * 0.86, 0));
}

// Plain pole mast with an optional yard (crosstree) at yardHeight.
export function poleMast(
  b: PartBuilder,
  m: Matrix4,
  o: { height: number; radius: number; top?: number; yard?: { y: number; span: number }; slot?: string },
): void {
  const slot = o.slot ?? SLOTS.house;
  put(b, slot, cylinder(o.radius, o.height, 14, o.top ?? o.radius * 0.6), m, at(0, o.height / 2, 0));
  if (o.yard) {
    put(b, slot, bevelBox(o.yard.span, 0.18, 0.25, 0.04), m, at(0, o.yard.y, 0));
  }
}

export const merge = (parts: BufferGeometry[]): BufferGeometry =>
  mergeGeometries(
    parts.map((g) => normalizeGeometry(g)),
    false,
  )!;

// Enclosed lifeboat / tender body (bow toward −z, keel at y = 0): lofted superellipse sections
// with a pointed bow, a fuller stern and a domed canopy.
export function enclosedLifeboat(
  length: number,
  beam: number,
  height: number,
  sections = 18,
  around = 16,
): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const hullDepth = height * 0.38;
  for (let i = 0; i <= sections; i++) {
    const t = i / sections; // 0 bow … 1 stern
    const u = 2 * t - 1;
    const fullness =
      t < 0.5 ? Math.sqrt(Math.max(0, 1 - Math.abs(u) ** 2.2)) : Math.sqrt(Math.max(0, 1 - Math.abs(u) ** 5));
    const halfW = (beam / 2) * Math.max(0.02, fullness);
    const top =
      hullDepth +
      (height - hullDepth) * Math.sqrt(Math.max(0, 1 - Math.abs(u) ** 3)) * (t < 0.08 ? t / 0.08 : 1);
    const keel = hullDepth * (1 - Math.max(0, fullness) ** 0.6);
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = Math.sign(c) * Math.abs(c) ** 0.6 * halfW;
      const y =
        s < 0 ? hullDepth + s * (hullDepth - keel) : hullDepth + Math.abs(s) ** 0.8 * (top - hullDepth);
      positions.push(x, y, -length / 2 + t * length);
    }
  }
  const cols = around + 1;
  for (let i = 0; i < sections; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * cols + j;
      indices.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}
