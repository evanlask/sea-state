// H1 Unlimited hydroplane "U-7 Sea Fury" (9.4 × 4.3 m) on the physics hydroplane hull
// (sim/physics/hull/hydroplane.ts, mirrored in kit/hullLines.ts): two sponsons with flat planing
// pads and spoon noses, the tunnel (air trap) between them, the sponsons' step, and the
// after-planing hull narrowing to the transom, with a rounded deck edge. On the deck: the enclosed
// safety capsule forward (a modern unlimited's driver sits ahead of the engine) with its Lexan
// canopy, the seat and wheel inside; the engine cowling behind it with the
// turbine's air-intake scoop, louvres and the exhaust stack aft; twin fins carrying the adjustable
// wing (horizontal stabiliser) with end plates; under the transom the gearcase and its strut, the
// surface-piercing cleaver propeller and the rudder on its bracket; the skid fin under the right
// sponson, raked and toed as the physics one is; sidelights on the sponson
// noses and an all-round white on the wing. The race livery (base colour, stripes, fictional sponsor
// blocks and the race number) is painted on two canvases projected from the side and from above, so
// the painted parts draw in one call.
//
// Animated (drives): 'wing-pivot' (wingAngle), 'rudder' (rudderAngle), 'prop' (rpm), 'helm' (steering).

import {
  Color,
  type ColorRepresentation,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalNodeMaterial,
  type Object3D,
  type Texture,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';

import { BOAT_CAMERA_INFO } from '../../../camera/boatCameraInfo';
import { DRIVE_CONFIGS } from '../../../sim/boats/driveConfig';
import { hydroSpec } from '../../../sim/boats/specs/hydro';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
import type { HydroplaneHullParams } from '../../../sim/physics/hull/types';
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { type N, tsl } from '../../tsl';
import { boatDetail, type ResolvedDetail } from '../detail/detail';
import { applyDetail, detailNormal } from '../detail/nodes';
import type { TelemetryDrive } from '../kit/animate';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { LightMountSpec } from '../kit/BoatVisual';
import { at, bevelBox, cylinder, extrude, lathe, PartBuilder, rod, shapeFrom } from '../kit/geometry';
import { createHullLines, type HullLines, hydroplaneKeys, hydroplaneStep } from '../kit/hullLines';
import { computeNormals, type MeshData } from '../kit/loft';
import {
  type AoVolume,
  aoNode,
  bodyNormal,
  bodyPosition,
  glassMaterial,
  hullPaintMaterial,
  simpleMaterial,
} from '../kit/materials';
import { wellVolume } from '../kit/plan';
import { merge, SLOTS, whipAntenna } from '../kit/props';
import { foilLoft, loftRings, nacaHalfThickness, sculpt, type SuperSection, type V3 } from '../kit/sculpt';
import { rail, slab, steeringWheelGeometry } from '../kit/smallcraft';
import { canvasTexture, context2d, createCanvas, drawFittedText } from '../kit/textures';

const { abs, clamp, float, mix, select, smoothstep, texture, vec2, vec3 } = tsl;

const spec = hydroSpec;
const FILLET = 0.04; // deck-edge radius

// The safety capsule: nose, canopy front and back, the tail (inside the cowling), the rings' centre
// height, the canopy's sill at its front and back (it wraps down at the front like a fighter's, so
// the driver sees the nose and the decks over the dash), the canopy's crown, and the capsule's
// half-width. The canopy meets the sill at both ends.
export const CAPSULE = {
  nose: -3.75,
  front: -3.15,
  aft: -1.75,
  tail: -1.2,
  yc: 0.62,
  sillFront: 0.74,
  sill: 0.86,
  crown: 1.18,
  half: 0.5,
  floor: 0.32,
};

// The canopy's sill height at body z.
export function capsuleSill(z: number): number {
  const c = CAPSULE;
  const t = Math.min(1, Math.max(0, (z - c.front) / (c.aft - c.front)));
  return c.sill - (c.sill - c.sillFront) * (1 - t) ** 1.5;
}
const CAPSULE_N = 3; // superellipse exponents: top, bottom
const CAPSULE_NB = 4;
const HOLE = 0.49; // the deck's opening under the capsule, half-width
const COWL = { front: -1.7, aft: 4.35, yc: 0.62 };
const SCOOP = { mouth: -1.05, end: 0.9, yc: 1.0 };
const FIN = { x: 0.72, thickness: 0.05 };
const WING = { y: 1.5, z: 4.42, span: 3.0, chord: 0.68, le: 0.17 }; // pivot at the quarter chord
// The node the wing's drive turns. It must differ from the 'wing' slot mesh inside it, or the drive
// would turn that mesh a second time about the body origin, 4.6 m away.
export const WING_PIVOT = 'wing-pivot';
// The physics skid fin (specs/hydro.ts), drawn at its position and angles.
const SKID_FIN = hydroSpec.foils.find((f) => f.name === 'skid fin')!;
const PROP =
  DRIVE_CONFIGS.hydro.kind === 'surfaceProp' ? DRIVE_CONFIGS.hydro.position : { x: 0, y: -0.07, z: 5.05 };
const RUDDER_Z = 5.32;
const NAV = { x: 1.7, z: -4.25 }; // the sidelights' pods on the sponson noses
const EYE = BOAT_CAMERA_INFO.hydro.eye;

// The livery canvases' extents: from the side (body z × y) and from above (x × z).
const SIDE = { z0: -4.75, z1: 4.85, y0: -0.32, y1: 1.72, w: 2048, h: 768 };
const TOP = { x0: -2.2, x1: 2.2, z0: -4.75, z1: 5.8, w: 768, h: 1664 };
// The wing's art is painted this far aft of it on the top canvas (past the transom), so the deck under
// the wing doesn't show it too; the material looks it up there above `y`.
const WING_ART = { shift: 0.85, y: 1.25 };
const PAINT = {
  base: '#b0101a',
  dark: '#121316',
  gold: '#d9a935',
  white: '#f3f2ee',
};

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Catmull-Rom through (z, value) nodes, flat beyond the ends.
function curve(nodes: readonly [number, number][], z: number): number {
  const n = nodes.length;
  if (z <= nodes[0]![0]) return nodes[0]![1];
  if (z >= nodes[n - 1]![0]) return nodes[n - 1]![1];
  let i = 0;
  while (z > nodes[i + 1]![0]) i++;
  const [z1, p1] = nodes[i]!;
  const [z2, p2] = nodes[i + 1]!;
  const p0 = nodes[Math.max(0, i - 1)]![1];
  const p3 = nodes[Math.min(n - 1, i + 2)]![1];
  const t = (z - z1) / (z2 - z1);
  const t2 = t * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t2 * t)
  );
}

// Reverses a mesh's faces (an inside lining from an outward loft).
function flipped(data: MeshData): MeshData {
  const indices = Uint32Array.from(data.indices);
  for (let t = 0; t < indices.length; t += 3) {
    const k = indices[t + 1]!;
    indices[t + 1] = indices[t + 2]!;
    indices[t + 2] = k;
  }
  return { ...data, indices, normals: computeNormals(data.positions, indices) };
}

// A flat fan over a planar loop of points, facing `facing`.
function fan(points: readonly V3[], facing: V3): MeshData {
  const n = points.length;
  const c: V3 = [0, 0, 0];
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += p[k]! / n;
  const positions: number[] = [...c];
  for (const p of points) positions.push(...p);
  const indices: number[] = [];
  for (let k = 0; k + 1 < n; k++) indices.push(0, k + 1, k + 2);
  if (n > 2) indices.push(0, n, 1);
  // Orient: the first triangle with any area decides.
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const d = indices[t + 2]! * 3;
    const u = [
      positions[b]! - positions[a]!,
      positions[b + 1]! - positions[a + 1]!,
      positions[b + 2]! - positions[a + 2]!,
    ];
    const v = [
      positions[d]! - positions[a]!,
      positions[d + 1]! - positions[a + 1]!,
      positions[d + 2]! - positions[a + 2]!,
    ];
    const nrm = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const dot = nrm[0]! * facing[0] + nrm[1]! * facing[1] + nrm[2]! * facing[2];
    if (Math.abs(dot) < 1e-12) continue;
    if (dot < 0) {
      for (let s = 0; s < indices.length; s += 3) {
        const k = indices[s + 1]!;
        indices[s + 1] = indices[s + 2]!;
        indices[s + 2] = k;
      }
    }
    break;
  }
  const normals = new Float32Array(positions.length);
  const l = Math.hypot(...facing) || 1;
  for (let i = 0; i < positions.length; i += 3) normals.set([facing[0] / l, facing[1] / l, facing[2] / l], i);
  const uvs = new Float32Array((positions.length / 3) * 2);
  return { positions: new Float32Array(positions), normals, uvs, indices: new Uint32Array(indices) };
}

// ------------------------------------------------------------------------- hull

interface HullRes {
  fore: number; // stations from the noses to the step
  aft: number; // from the step to the transom
  roof: number; // samples across the tunnel roof's half
  pad: number;
  side: number;
  fillet: number;
}

const HULL_RES: readonly HullRes[] = [
  { fore: 40, aft: 30, roof: 5, pad: 4, side: 3, fillet: 4 },
  { fore: 18, aft: 12, roof: 2, pad: 2, side: 1, fillet: 2 },
  { fore: 9, aft: 6, roof: 1, pad: 1, side: 1, fillet: 1 },
];

// Hull stations: dense at the spoon noses and across the step's two stations.
function hullStations(p: HydroplaneHullParams, res: HullRes): { fore: number[]; aft: number[] } {
  const zBow = -p.length / 2;
  const zStern = p.length / 2;
  const step = hydroplaneStep(p);
  const fore = Array.from(
    { length: res.fore + 1 },
    (_, i) => zBow + (step.fore - zBow) * (i / res.fore) ** 1.6,
  );
  const aft = Array.from(
    { length: res.aft + 1 },
    (_, i) => step.aft + (zStern - step.aft) * (i / res.aft) ** 1.25,
  );
  return { fore, aft };
}

// The starboard half of a section, outer deck edge → centreline, as the hull's surfaces: the deck-edge
// fillet, the side, the bottom (pad), the tunnel wall and the roof. Port mirrors.
// The deck-edge fillet's radius at a section (smaller where the spoon noses are thinner than it).
const filletRadius = (k: { deck: number; bottom: number }): number =>
  Math.min(FILLET, Math.max(0, k.deck - k.bottom - 0.002));

function sectionParts(p: HydroplaneHullParams, z: number, res: HullRes) {
  const k = hydroplaneKeys(p, z);
  const r = filletRadius(k);
  const fillet: [number, number][] = [];
  for (let j = 0; j <= res.fillet; j++) {
    const a = (Math.PI / 2) * (j / res.fillet);
    fillet.push([k.xo - r + r * Math.cos(a), k.deck - r + r * Math.sin(a)]);
  }
  fillet.reverse(); // deck → side
  const side: [number, number][] = [];
  for (let j = 0; j <= res.side; j++)
    side.push([k.xo, k.deck - r + (k.bottom - k.deck + r) * (j / res.side)]);
  const pad: [number, number][] = [];
  for (let j = 0; j <= res.pad; j++) pad.push([k.xo + (k.xw - k.xo) * (j / res.pad), k.bottom]);
  const wall: [number, number][] = [
    [k.xw, k.bottom],
    [k.xi, k.roof],
  ];
  const roof: [number, number][] = [];
  for (let j = 0; j <= res.roof; j++) roof.push([k.xi * (1 - j / res.roof), k.roof]);
  return { k, r, fillet, side, pad, wall, roof };
}

type Part = 'fillet' | 'side' | 'pad' | 'wall' | 'roof';

function strip(
  p: HydroplaneHullParams,
  zs: readonly number[],
  res: HullRes,
  part: Part,
  side: number,
  inside: V3,
): MeshData {
  const rings = zs.map((z) => sectionParts(p, z, res)[part].map(([x, y]): V3 => [side * x, y, z]));
  return loftRings(rings, { closed: false, inside });
}

// The tunnel roof across both sides (the centre of the after-planing bottom aft of the tunnel).
function roofStrip(p: HydroplaneHullParams, zs: readonly number[], res: HullRes): MeshData {
  const rings = zs.map((z) => {
    const half = sectionParts(p, z, res).roof;
    // `half` runs from the roof's edge in to the centreline: port edge → centre → starboard edge.
    return [
      ...half.map(([x, y]): V3 => [-x, y, z]),
      ...[...half]
        .reverse()
        .slice(1)
        .map(([x, y]): V3 => [x, y, z]),
    ];
  });
  return loftRings(rings, { closed: false, inside: [0, 10, 0] });
}

// A section's whole girth, port deck edge → round the bottom → starboard deck edge.
function girth(p: HydroplaneHullParams, z: number, res: HullRes): V3[] {
  const s = sectionParts(p, z, res);
  const half: [number, number][] = [
    ...s.fillet,
    ...s.side.slice(1),
    ...s.pad.slice(1),
    ...s.wall.slice(1),
    ...s.roof.slice(1),
  ];
  return [
    ...half.map(([x, y]): V3 => [-x, y, z]),
    ...[...half]
      .reverse()
      .slice(1)
      .map(([x, y]): V3 => [x, y, z]),
  ];
}

// The face between a section's girth and the deck line above it (the noses' thin front, the transom).
function endCap(p: HydroplaneHullParams, z: number, res: HullRes, facing: number): MeshData {
  const low = girth(p, z, res);
  const deck = hydroplaneKeys(p, z).deck;
  const high = low.map(([x, , zz]): V3 => [x, deck, zz]);
  return loftRings([low, high], { closed: false, inside: [0, 0.3, z - facing * 10] });
}

function hullParts(b: PartBuilder, lines: HullLines, lod: number): void {
  const p = lines.params as HydroplaneHullParams;
  const res = HULL_RES[lod]!;
  const { fore, aft } = hullStations(p, res);
  const all = [...fore, ...aft];
  for (const side of [-1, 1]) {
    b.addData(SLOTS.hull, strip(p, all, res, 'fillet', side, [0, 0, 0]));
    b.addData(SLOTS.hull, strip(p, all, res, 'side', side, [0, 0.3, 0]));
    b.addData('bottom', strip(p, all, res, 'wall', side, [side * 10, 0, 0]));
    b.addData('bottom', strip(p, fore, res, 'pad', side, [0, 10, 0]));
    b.addData('bottom', strip(p, aft, res, 'pad', side, [0, 10, 0]));
    // The step: the pads' transoms, from the pad line up to the after-planing bottom.
    const z0 = fore[fore.length - 1]!;
    const z1 = aft[0]!;
    const riser = [z0, z1].map((z) => sectionParts(p, z, res).pad.map(([x, y]): V3 => [side * x, y, z]));
    b.addData('bottom', loftRings(riser, { closed: false, inside: [side, 0, z0 - 10] }));
  }
  b.addData('bottom', roofStrip(p, all, res));
  b.addData(SLOTS.hull, endCap(p, lines.zBow, res, -1));
  b.addData(SLOTS.hull, endCap(p, lines.zStern, res, 1));
  // The deck, flat, open under the capsule (its cockpit tub goes down into the hull).
  const deckRow = (z: number, x0: number, x1: number, n: number): V3[] => {
    const y = hydroplaneKeys(p, z).deck;
    return Array.from({ length: n + 1 }, (_, j): V3 => [x0 + ((x1 - x0) * j) / n, y, z]);
  };
  const edge = (z: number): number => {
    const k = hydroplaneKeys(p, z);
    return k.xo - filletRadius(k);
  };
  const across = [10, 5, 3][lod]!;
  const between = (a: number, c: number): number[] => [
    a,
    ...all.filter((z) => z > a + 1e-6 && z < c - 1e-6),
    c,
  ];
  const up = { closed: false, inside: [0, -10, 0] as V3 };
  b.addData(
    SLOTS.hull,
    loftRings(
      between(lines.zBow, CAPSULE.front).map((z) => deckRow(z, -edge(z), edge(z), across)),
      up,
    ),
  );
  b.addData(
    SLOTS.hull,
    loftRings(
      between(CAPSULE.aft, lines.zStern).map((z) => deckRow(z, -edge(z), edge(z), across)),
      up,
    ),
  );
  for (const side of [-1, 1]) {
    b.addData(
      SLOTS.hull,
      loftRings(
        between(CAPSULE.front, CAPSULE.aft).map((z) =>
          side > 0 ? deckRow(z, HOLE, edge(z), 3) : deckRow(z, -edge(z), -HOLE, 3),
        ),
        up,
      ),
    );
  }
}

// ---------------------------------------------------------------------- capsule

const capsuleTop = (z: number): number => {
  const c = CAPSULE;
  if (z <= c.front) return 0.645 + (c.sillFront - 0.645) * Math.sqrt(smooth(c.nose, c.front, z));
  if (z <= c.aft) {
    const t = (z - c.front) / (c.aft - c.front);
    const sill = capsuleSill(z);
    return sill + (c.crown - sill) * Math.sin(Math.PI * t ** 1.3) ** 0.6;
  }
  return c.sill + 0.06 * smooth(c.aft, c.tail, z);
};

const capsuleHalf = (z: number): number =>
  Math.max(0.035, CAPSULE.half * Math.sqrt(Math.min(1, (z - CAPSULE.nose) / 0.55)));

const capsuleBottom = (z: number): number =>
  CAPSULE.floor + (0.5 - CAPSULE.floor) * (1 - smooth(CAPSULE.nose, CAPSULE.nose + 0.5, z));

function capsuleSection(z: number): SuperSection {
  const c = CAPSULE;
  return {
    z,
    y: c.yc,
    hw: capsuleHalf(z),
    top: capsuleTop(z) - c.yc,
    bottom: c.yc - capsuleBottom(z),
    n: CAPSULE_N,
    nBottom: CAPSULE_NB,
  };
}

// A point round a superellipse section, as sculpt's superRing places them (θ from starboard, up).
function superPoint(s: SuperSection, theta: number, scale = 1): V3 {
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const up = sn >= 0;
  const e = 2 / (up ? (s.n ?? 2.5) : (s.nBottom ?? s.n ?? 2.5));
  return [
    (s.x ?? 0) + scale * s.hw * Math.sign(c) * Math.abs(c) ** e,
    s.y + scale * (up ? s.top : s.bottom) * Math.sign(sn) * Math.abs(sn) ** e,
    s.z,
  ];
}

// Angle above the starboard side where a capsule section crosses the canopy's sill (π/2: the section
// stays under it, or is ahead of or behind the canopy).
function sillAngle(s: SuperSection): number {
  if (s.z <= CAPSULE.front || s.z >= CAPSULE.aft) return Math.PI / 2;
  const sill = capsuleSill(s.z);
  const rise = sill - s.y;
  if (s.y + s.top <= sill + 1e-6 || rise <= 0) return Math.PI / 2;
  return Math.asin(Math.min(1, (rise / s.top) ** ((s.n ?? 2.5) / 2)));
}

// The part of a section under the sill (port sill → under the bottom → starboard sill) and the part
// above it (the canopy, starboard → over the top → port).
// The lower arc has points at its widest (θ = π, 2π), so it reaches its full width at the deck's
// opening at every level of detail, and the same number of points between those and the sills at
// every station, so the lofts don't twist where the canopy opens.
function lowerArc(s: SuperSection, n: number, scale = 1): V3[] {
  const a = sillAngle(s);
  const end = Math.max(1, Math.round(n / 4));
  const mid = Math.max(2, n - 2 * end);
  const thetas: number[] = [];
  for (let k = 0; k < end; k++) thetas.push(Math.PI - a + (a * k) / end);
  for (let k = 0; k < mid; k++) thetas.push(Math.PI + (Math.PI * k) / mid);
  for (let k = 0; k <= end; k++) thetas.push(2 * Math.PI + (a * k) / end);
  const m = thetas.length - 1;
  return thetas.map((theta, k) => {
    const f = scale === 1 ? 1 : 1 - (1 - scale) * Math.sin((Math.PI * k) / m) ** 0.3;
    return superPoint(s, theta, f);
  });
}

function upperArc(s: SuperSection, n: number): V3[] {
  const a = sillAngle(s);
  return Array.from({ length: n + 1 }, (_, k) => superPoint(s, a + ((Math.PI - 2 * a) * k) / n));
}

function capsuleStations(n: number, from: number, to: number): number[] {
  return Array.from(
    { length: n + 1 },
    (_, i) => from + (to - from) * (0.5 - 0.5 * Math.cos((Math.PI * i) / n)),
  );
}

function capsuleParts(b: PartBuilder, lod: number): void {
  const c = CAPSULE;
  const around = [30, 16, 10][lod]!;
  const top = [14, 8, 4][lod]!;
  const nose = capsuleStations([8, 4, 2][lod]!, c.nose, c.front);
  const canopy = capsuleStations([16, 8, 4][lod]!, c.front, c.aft);
  const tail = capsuleStations([5, 3, 1][lod]!, c.aft, c.tail);
  const all = [...nose, ...canopy.slice(1), ...tail.slice(1)];
  // The body under the sill, closed at the nose and inside the cowling.
  b.addData(
    SLOTS.hull,
    loftRings(
      all.map((z) => lowerArc(capsuleSection(z), around)),
      { closed: false, capStart: true, capEnd: true },
    ),
  );
  // The canopy over the cockpit.
  b.addData(
    SLOTS.glass,
    loftRings(
      canopy.map((z) => upperArc(capsuleSection(z), top)),
      { closed: false, inside: [0, c.yc, -2.4] },
    ),
  );
  // The cockpit tub's lining and its two bulkheads (the dash forward, behind the seat aft).
  b.addData(
    'cockpit',
    flipped(
      loftRings(
        canopy.map((z) => lowerArc(capsuleSection(z), around, 0.96)),
        { closed: false },
      ),
    ),
  );
  b.addData('cockpit', fan(lowerArc(capsuleSection(c.front), around, 0.96).slice(0, -1), [0, 0, 1]));
  b.addData('cockpit', fan(lowerArc(capsuleSection(c.aft), around, 0.96).slice(0, -1), [0, 0, -1]));
  // The canopy's frame along the sills.
  if (lod < 2) {
    for (const side of [-1, 1]) {
      const pts = canopy.map((z) => {
        const s = capsuleSection(z);
        const [x, y] = superPoint(s, side > 0 ? sillAngle(s) : Math.PI - sillAngle(s));
        return new Vector3(x, y + 0.004, z);
      });
      rail(b, pts, 0.014, { slot: 'carbon', radial: lod === 0 ? 8 : 5, caps: true });
    }
  }
}

// The empty seat, the wheel mount and the dash, seen through the canopy.
function cockpitInterior(b: PartBuilder, lod: number): void {
  // Seat shell and headrest.
  b.add(SLOTS.black, bevelBox(0.52, 0.66, 0.06, 0.02), at(0, 0.66, -1.84, -0.22));
  b.add(SLOTS.black, bevelBox(0.34, 0.2, 0.07, 0.03), at(0, 1.0, -1.93, -0.1));
  if (lod === 0) {
    // The wheel's column and the dash cluster.
    b.add(SLOTS.black, rod(new Vector3(0, 0.66, -2.98), new Vector3(0, 0.77, -2.66), 0.02, 8, true));
    b.add('carbon', bevelBox(0.42, 0.12, 0.05, 0.015), at(0, 0.66, -3.0, -0.5));
    for (const x of [-0.12, 0, 0.12]) {
      b.add(SLOTS.chrome, new TorusGeometry(0.03, 0.006, 6, 14), at(x, 0.67, -2.97, -0.5 + Math.PI / 2));
      b.add(SLOTS.black, cylinder(0.028, 0.01, 12), at(x, 0.67, -2.975, -0.5 - Math.PI / 2));
    }
  }
}

// ------------------------------------------------------------------ cowling etc.

const COWL_TOP: [number, number][] = [
  [-1.7, 0.92],
  [-1.2, 1.04],
  [-0.6, 1.12],
  [0.5, 1.15],
  [2.0, 1.1],
  [3.0, 0.98],
  [3.8, 0.84],
  [4.35, 0.68],
];
const COWL_HALF: [number, number][] = [
  [-1.7, 0.53],
  [-1.0, 0.64],
  [0, 0.68],
  [1.5, 0.66],
  [3.0, 0.55],
  [4.35, 0.3],
];

function cowlSection(z: number): SuperSection {
  return {
    z,
    y: COWL.yc,
    hw: curve(COWL_HALF, z),
    top: curve(COWL_TOP, z) - COWL.yc,
    bottom: 0.1,
    n: 3.2,
    nBottom: 6,
  };
}

// The cowling's half-width at height y (on its upper surface).
function cowlHalfAt(z: number, y: number): number {
  const s = cowlSection(z);
  const v = Math.min(1, Math.max(0, (y - s.y) / s.top));
  return s.hw * (1 - v ** 3.2) ** (1 / 3.2);
}

// The cowling's upper surface height at (z, x).
function cowlYAt(z: number, x: number): number {
  const s = cowlSection(z);
  const u = Math.min(1, Math.abs(x) / s.hw);
  return s.y + s.top * (1 - u ** 3.2) ** (1 / 3.2);
}

function scoopSection(z: number): SuperSection {
  const t = (z - SCOOP.mouth) / (SCOOP.end - SCOOP.mouth);
  return {
    z,
    y: SCOOP.yc,
    hw: 0.3 - 0.12 * t * t,
    top: 0.34 - 0.21 * smooth(0, 1, t),
    bottom: 0.1,
    n: 3,
  };
}

function cowlParts(b: PartBuilder, lod: number): void {
  const n = [30, 14, 7][lod]!;
  const around = [32, 18, 10][lod]!;
  const zs = Array.from({ length: n + 1 }, (_, i) => COWL.front + (COWL.aft - COWL.front) * (i / n));
  b.addData(SLOTS.hull, sculpt(zs.map(cowlSection), around, { capStart: true, capEnd: true }));
  // The turbine's air-intake scoop behind the canopy: open at the front, a dark duct inside.
  const ns = [10, 5, 3][lod]!;
  const ss = Array.from({ length: ns + 1 }, (_, i) => SCOOP.mouth + (SCOOP.end - SCOOP.mouth) * (i / ns));
  const ar = [24, 14, 8][lod]!;
  const ring = (s: SuperSection, scale = 1): V3[] =>
    Array.from({ length: ar }, (_, k) => superPoint(s, (2 * Math.PI * k) / ar, scale));
  b.addData(
    SLOTS.hull,
    loftRings(
      ss.map((z) => ring(scoopSection(z))),
      { capEnd: true },
    ),
  );
  const mouth = scoopSection(SCOOP.mouth);
  const inner = ring(mouth, 0.86);
  const back = ring({ ...mouth, z: SCOOP.mouth + 0.32 }, 0.86);
  b.addData('carbon', loftRings([ring(mouth), inner], { inside: [0, SCOOP.yc, SCOOP.mouth + 1] }));
  b.addData(SLOTS.black, flipped(loftRings([inner, back])));
  b.addData(SLOTS.black, fan(back, [0, 0, -1]));
  if (lod === 0) {
    // Screen bars across the mouth.
    for (let k = -3; k <= 3; k++) {
      const x = k * 0.07;
      b.add(
        SLOTS.chrome,
        rod(new Vector3(x, 0.93, SCOOP.mouth + 0.03), new Vector3(x, 1.3, SCOOP.mouth + 0.03), 0.005, 4),
      );
    }
  }
  // The exhaust stack out of the back of the cowling, turned up and aft, with its dark throat.
  const ex0 = new Vector3(0, 0.84, 3.15);
  const ex1 = new Vector3(0, 1.08, 4.0);
  const dir = ex1.clone().sub(ex0).normalize();
  const pitch = Math.atan2(dir.z, dir.y); // from +y toward +z
  const seg = lod === 0 ? 24 : 12;
  const outside: [number, number][] = [
    [0.13, 0],
    [0.145, 0.55],
    [0.16, 0.86],
    [0.175, 0.88],
    [0.15, 0.89],
  ];
  // The throat: the pipe's inside, sooty, closed some way down.
  const throat: [number, number][] = [
    [0.15, 0.89],
    [0.14, 0.86],
    [0.13, 0.62],
    [0, 0.62],
  ];
  b.add('exhaust', lathe(outside, seg), at(ex0.x, ex0.y, ex0.z, pitch));
  b.add(SLOTS.black, lathe(throat, seg), at(ex0.x, ex0.y, ex0.z, pitch));
  if (lod === 0) {
    // Louvres on the cowling's sides over the engine, and an antenna.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const z = 1.4 + k * 0.2;
        const y = 0.9;
        b.add(
          SLOTS.black,
          bevelBox(0.012, 0.05, 0.15, 0.004),
          at(side * (cowlHalfAt(z, y) + 0.002), y, z, 0, 0, side * 0.35),
        );
      }
    }
    whipAntenna(b, at(0.32, cowlYAt(0.6, 0.32) - 0.02, 0.6), 0.8, SLOTS.black);
  }
}

// The twin fins standing on the after deck, which carry the wing.
function finParts(b: PartBuilder, lod: number): void {
  const profile = shapeFrom([
    [3.45, 0.5],
    [4.72, 0.5],
    [4.8, 1.64],
    [4.1, 1.64],
    [3.85, 1.25],
  ]);
  const fin = extrude(profile, FIN.thickness, 'x', {
    bevel: lod < 2 ? 0.012 : 0,
    bevelSegments: lod === 0 ? 2 : 1,
  });
  for (const side of [-1, 1]) b.add(SLOTS.hull, fin, at(side * FIN.x, 0, 0));
}

// Gearcase and strut under the transom, the rudder's bracket, the skid fin, and deck hardware.
function runningGear(b: PartBuilder, lines: HullLines, lod: number): void {
  const around = [16, 10, 6][lod]!;
  const torp: SuperSection[] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const r = 0.058 * (1 - 0.35 * t * t);
    torp.push({ z: lines.zStern - 0.1 + 0.4 * t, y: PROP.y, hw: r, top: r, bottom: r, n: 2 });
  }
  b.addData('gearcase', sculpt(torp, around, { capStart: true, capEnd: true }));
  // The strut that carries it down from the after-bottom, so the propeller sits deep enough to be
  // under water at rest and partly out of it at speed.
  b.addData(
    'gearcase',
    foilLoft(
      [
        { y: lines.keelY(lines.zStern) + 0.05, chord: 0.34, le: lines.zStern - 0.3, thickness: 0.1 },
        { y: PROP.y, chord: 0.3, le: lines.zStern - 0.14, thickness: 0.12 },
      ],
      [14, 8, 6][lod]!,
      { capEnd: false },
    ),
  );
  b.addData(
    'gearcase',
    foilLoft(
      [
        { y: PROP.y - 0.02, chord: 0.24, le: lines.zStern - 0.06, thickness: 0.12 },
        { y: -0.3, chord: 0.13, le: lines.zStern + 0.06, thickness: 0.1 },
      ],
      [14, 8, 6][lod]!,
    ),
  );
  if (lod < 2) {
    // The rudder's bracket over the propeller, off the transom.
    b.add(
      'gearcase',
      bevelBox(0.06, 0.05, RUDDER_Z - lines.zStern + 0.06, 0.012),
      at(0, 0.2, (lines.zStern + RUDDER_Z) / 2),
    );
    b.add('gearcase', cylinder(0.028, 0.1, 10), at(0, 0.16, RUDDER_Z));
  }
  // The skid fin under the right sponson's inboard edge, just aft of the step, as the physics has it
  // (specs/hydro.ts 'skid fin': centre z −0.6, 0.2 m deep, 0.07 m², its tip raked outboard and its
  // leading edge toed in to port): the sections lean outboard by the rake, the whole fin turned
  // about its own centre by the toe.
  const pad = lines.keelY(-1.6);
  const root = Math.max(pad, lines.keelY(-0.6)) + 0.02;
  const tip = pad - 0.2;
  const rake = SKID_FIN.spanAxis.x / -SKID_FIN.spanAxis.y; // outboard per metre down
  const toe = Math.atan2(SKID_FIN.chordAxis.x, SKID_FIN.chordAxis.z); // + leading edge to port
  const finX = (y: number): number => SKID_FIN.centre.x + rake * (SKID_FIN.centre.y - y);
  const finMid = new Vector3(SKID_FIN.centre.x, (root + tip) / 2, -0.6);
  b.addData(
    'gearcase',
    foilLoft(
      [
        { y: root, chord: 0.38, le: -0.79, x: finX(root), thickness: 0.06 },
        { y: tip, chord: 0.26, le: -0.71, x: finX(tip), thickness: 0.06 },
      ],
      [14, 8, 6][lod]!,
    ),
    new Matrix4()
      .makeTranslation(finMid.x, finMid.y, finMid.z)
      .multiply(new Matrix4().makeRotationY(toe))
      .multiply(new Matrix4().makeTranslation(-finMid.x, -finMid.y, -finMid.z)),
  );
  const deck = lines.deckY(0);
  // Sidelights in low pods on the sponson noses.
  if (lod < 2) {
    for (const side of [-1, 1]) {
      b.add(SLOTS.black, bevelBox(0.09, 0.035, 0.07, 0.01), at(side * NAV.x, deck + 0.017, NAV.z));
      b.add(
        side < 0 ? SLOTS.lampRed : SLOTS.lampGreen,
        bevelBox(0.06, 0.02, 0.045, 0.006),
        at(side * NAV.x, deck + 0.044, NAV.z),
      );
    }
  }
  if (lod === 0) {
    // Lifting eyes, fuel filler, flush NACA vents on the after deck.
    for (const [x, z] of [
      [1.4, -3.4],
      [1.0, 3.0],
    ] as const) {
      for (const side of [-1, 1]) {
        b.add(
          SLOTS.chrome,
          new TorusGeometry(0.035, 0.009, 6, 14),
          at(side * x, deck + 0.03, z, 0, Math.PI / 2),
        );
        b.add(SLOTS.chrome, cylinder(0.04, 0.008, 12), at(side * x, deck + 0.004, z));
      }
    }
    b.add(SLOTS.chrome, cylinder(0.06, 0.014, 16), at(1.15, deck + 0.007, 1.2));
    b.add(SLOTS.black, cylinder(0.045, 0.016, 16), at(1.15, deck + 0.008, 1.2));
    for (const side of [-1, 1]) {
      b.add(SLOTS.black, slab(0.16, 0.34, 0.006, 0.05, 0.002), at(side * 1.25, deck + 0.0005, 0.7));
    }
  }
}

function structure(lines: HullLines, lod: number): PartBuilder {
  const b = new PartBuilder();
  hullParts(b, lines, lod);
  capsuleParts(b, lod);
  if (lod < 2) cockpitInterior(b, lod);
  cowlParts(b, lod);
  finParts(b, lod);
  runningGear(b, lines, lod);
  return b;
}

// --------------------------------------------------------------- moving parts

// The wing on its pivot, in body coordinates under a group offset back by the pivot (so the livery
// and the AO, which look up body positions, see it where it is): NACA 0012 sections across the span,
// end plates, and the all-round white on a stalk on top.
function wingGroup(lod: number, materials: Record<string, Material>): Object3D {
  const b = new PartBuilder();
  const n = [24, 14, 8][lod]!;
  const spanN = [12, 6, 2][lod]!;
  const half = WING.span / 2;
  const le = WING.z - WING.le;
  const section = (x: number): V3[] => {
    const ring: V3[] = [];
    for (let k = 0; k < n; k++) {
      // Round the section: upper surface LE → TE, then the lower one back.
      const a = (2 * Math.PI * k) / n;
      const u = 0.5 + 0.5 * Math.cos(a); // 1 at the LE (a = 0), 0 at the TE
      const t = nacaHalfThickness(1 - u, 0.12) * WING.chord;
      ring.push([x, WING.y + Math.sign(Math.sin(a) || 1) * t, le + (1 - u) * WING.chord]);
    }
    return ring;
  };
  const xs = Array.from({ length: spanN + 1 }, (_, i) => -half + (WING.span * i) / spanN);
  b.addData('wing', loftRings(xs.map(section), { capStart: true, capEnd: true }));
  if (lod < 2) {
    // End plates, raked like the fins.
    const plate = extrude(
      shapeFrom([
        [le - 0.04, WING.y - 0.12],
        [le + 0.74, WING.y - 0.14],
        [le + 0.82, WING.y + 0.17],
        [le + 0.14, WING.y + 0.17],
      ]),
      0.024,
      'x',
      { bevel: 0.008, bevelSegments: 1 },
    );
    for (const side of [-1, 1]) b.add('wing', plate, at(side * (half + 0.012), 0, 0));
    b.add(SLOTS.lampWhite, cylinder(0.022, 0.05, 12), at(0, WING.y + 0.135, WING.z));
  }
  if (lod === 0) b.add(SLOTS.black, cylinder(0.012, 0.09, 8), at(0, WING.y + 0.07, WING.z));
  const built = b.build(materials, { shadows: lod < 2 }).group;
  built.position.set(0, -WING.y, -WING.z);
  const wing = new Group();
  wing.name = WING_PIVOT;
  wing.position.set(0, WING.y, WING.z);
  wing.add(built);
  return wing;
}

function rudderGroup(lod: number, materials: Record<string, Material>): Object3D {
  const b = new PartBuilder();
  b.add('gearcase', rod(new Vector3(0, 0.15, 0), new Vector3(0, -0.12, 0), 0.014, 8, true));
  b.addData(
    'gearcase',
    foilLoft(
      [
        { y: -0.1, chord: 0.15, le: -0.045, thickness: 0.09 },
        { y: -0.48, chord: 0.11, le: -0.02, thickness: 0.09 },
      ],
      lod === 0 ? 14 : 8,
    ),
  );
  const g = new Group();
  g.name = 'rudder';
  g.position.set(0, 0, RUDDER_Z);
  g.add(b.build(materials, { shadows: lod < 2 }).group);
  return g;
}

// The surface-piercing propeller: four cleaver blades (wide, square tips, a straight trailing edge)
// on a hub with a cone.
function propGroup(lod: number, materials: Record<string, Material>): Object3D {
  const b = new PartBuilder();
  const R = (DRIVE_CONFIGS.hydro.kind === 'surfaceProp' ? DRIVE_CONFIGS.hydro.diameter : 0.41) / 2;
  b.add(
    'propMetal',
    // Bottom up, so the lathe faces outward.
    lathe(
      [
        [0, -0.05],
        [0.05, -0.05],
        [0.055, 0],
        [0.05, 0.05],
        [0.03, 0.1],
        [0, 0.12],
      ],
      lod === 0 ? 18 : 10,
    ).rotateX(Math.PI / 2),
  );
  const outline = shapeFrom([
    [0.04, -0.035],
    [R * 0.7, -0.06],
    [R, -0.055],
    [R, 0.055],
    [R * 0.6, 0.05],
    [0.04, 0.03],
  ]);
  const blade = extrude(outline, 0.008, 'z', { bevel: lod === 0 ? 0.003 : 0, bevelSegments: 1 });
  for (let k = 0; k < 4; k++) {
    const g = blade
      .clone()
      .rotateX(0.62)
      .rotateZ((k / 4) * Math.PI * 2);
    b.add('propMetal', g);
  }
  const g = new Group();
  g.name = 'prop';
  g.position.set(PROP.x, PROP.y, PROP.z);
  g.add(b.build(materials, { shadows: lod < 2 }).group);
  return g;
}

function wheel(materials: Record<string, Material>): Object3D {
  const tilt = new Group();
  tilt.position.set(0, 0.78, -2.63);
  tilt.rotation.x = -0.75;
  const w = new Mesh(
    steeringWheelGeometry(0.15, { spokes: 3, rim: 0.013, dish: 0.02, segments: 28 }),
    materials[SLOTS.black],
  );
  w.name = 'helm';
  w.castShadow = true;
  tilt.add(w);
  return tilt;
}

// ----------------------------------------------------------------------- livery

type Paint = (
  ctx: CanvasRenderingContext2D,
  P: (a: number, b: number) => [number, number],
  scale: number,
) => void;

function fitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  [x, y]: [number, number],
  width: number,
  height: number,
  color: string,
  weight = 'italic 900',
): void {
  ctx.fillStyle = color;
  drawFittedText(ctx, text, x, y, width, height, { weight, spacing: 0.04 });
}

function poly(
  ctx: CanvasRenderingContext2D,
  P: (a: number, b: number) => [number, number],
  pts: readonly [number, number][],
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  pts.forEach(([a, b], i) => (i === 0 ? ctx.moveTo(...P(a, b)) : ctx.lineTo(...P(a, b))));
  ctx.closePath();
  ctx.fill();
}

// The side art in body (z, y), drawn once per side so the lettering reads on both: the dark lower band
// following the sponson nose up, a gold pinstripe and a white speed stripe under the deck edge, the
// boat's name on the sponsons, sponsor blocks on the after-body and the cowling, the driver's name
// under the canopy and the race number on the fins.
const paintSide: Paint = (ctx, P, s) => {
  const band = (z: number): number => (z > -1.1 ? 0.04 : 0.04 + 0.46 * Math.min(1, (-1.1 - z) / 3.6) ** 2.4);
  const zs = Array.from({ length: 41 }, (_, i) => SIDE.z0 + ((SIDE.z1 - SIDE.z0) * i) / 40);
  poly(
    ctx,
    P,
    [[SIDE.z0, SIDE.y0], ...zs.map((z): [number, number] => [z, band(z)]), [SIDE.z1, SIDE.y0]],
    PAINT.dark,
  );
  poly(
    ctx,
    P,
    [
      ...zs.map((z): [number, number] => [z, band(z) + 0.035]),
      ...[...zs].reverse().map((z): [number, number] => [z, band(z) + 0.06]),
    ],
    PAINT.gold,
  );
  poly(
    ctx,
    P,
    [
      [-4.55, 0.47],
      [-3.8, 0.43],
      [4.55, 0.43],
      [4.62, 0.5],
      [-3.8, 0.51],
    ],
    PAINT.white,
  );
  fitted(ctx, 'SEA FURY', P(-2.75, 0.25), 2.7 * s, 0.27 * s, PAINT.white);
  fitted(ctx, 'TIDEPOINT ENERGY', P(1.35, 0.23), 4.0 * s, 0.22 * s, PAINT.white, 'italic 800');
  // Cowling: gold stripe along its foot and a white sponsor panel with dark lettering.
  poly(
    ctx,
    P,
    [
      [-1.6, 0.66],
      [4.2, 0.66],
      [4.2, 0.69],
      [-1.6, 0.7],
    ],
    PAINT.gold,
  );
  ctx.fillStyle = PAINT.white;
  const [ax, ay] = P(0.0, 1.0);
  const [bx, by] = P(2.4, 0.74);
  ctx.beginPath();
  ctx.roundRect?.(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay), 0.06 * s);
  ctx.fill();
  fitted(ctx, 'NORTHWIND', P(1.2, 0.87), 2.1 * s, 0.19 * s, PAINT.dark, 'italic 900');
  fitted(ctx, 'C. ALDEN', P(-2.55, 0.72), 0.8 * s, 0.09 * s, PAINT.white, '700');
  // The fins: a white number panel raked with their leading edges, the number in black.
  poly(
    ctx,
    P,
    [
      [3.78, 0.86],
      [4.68, 0.86],
      [4.73, 1.52],
      [4.08, 1.52],
    ],
    PAINT.white,
  );
  fitted(ctx, 'U-7', P(4.3, 1.18), 0.6 * s, 0.5 * s, PAINT.dark, 'italic 900');
};

// The top art in body (x, z), read from astern (the chase camera): stripes along the sponsons that
// converge toward the transom, the race number on the forward deck, sponsor names beside the capsule
// and the cowling, a centre stripe along the cowling, and the boat's name on the wing.
const paintTop: Paint = (ctx, P, s) => {
  const edge = (z: number): number => (z < -1.1 ? 2.15 : 2.15 - ((z + 1.1) / 5.8) * 0.95);
  for (const [inset, width, color] of [
    [0.22, 0.05, PAINT.white],
    [0.32, 0.03, PAINT.gold],
  ] as const) {
    for (const side of [-1, 1]) {
      const zs = Array.from({ length: 30 }, (_, i) => -4.45 + (9.05 * i) / 29);
      poly(
        ctx,
        P,
        [
          ...zs.map((z): [number, number] => [side * (edge(z) - inset), z]),
          ...[...zs].reverse().map((z): [number, number] => [side * (edge(z) - inset - width), z]),
        ],
        color,
      );
    }
  }
  fitted(ctx, 'U-7', P(0, -4.2), 1.5 * s, 0.6 * s, PAINT.white);
  fitted(ctx, 'TIDEPOINT', P(-1.25, -2.4), 1.1 * s, 0.24 * s, PAINT.white, 'italic 800');
  fitted(ctx, 'NORTHWIND', P(1.25, -2.4), 1.1 * s, 0.24 * s, PAINT.white, 'italic 800');
  fitted(ctx, 'KESTREL', P(-1.2, 1.2), 0.9 * s, 0.2 * s, PAINT.white, 'italic 800');
  fitted(ctx, 'MARINE', P(1.2, 1.2), 0.9 * s, 0.2 * s, PAINT.white, 'italic 800');
  poly(
    ctx,
    P,
    [
      [-0.1, -1.6],
      [0.1, -1.6],
      [0.06, 4.3],
      [-0.06, 4.3],
    ],
    PAINT.white,
  );
  for (const side of [-1, 1]) {
    poly(
      ctx,
      P,
      [
        [side * 0.13, -1.6],
        [side * 0.15, -1.6],
        [side * 0.09, 4.3],
        [side * 0.08, 4.3],
      ],
      PAINT.gold,
    );
  }
  fitted(ctx, 'SEA FURY', P(0, WING.z + 0.1 + WING_ART.shift), 2.3 * s, 0.34 * s, PAINT.base);
};

function sideTexture(): Texture {
  const canvas = createCanvas(SIDE.w, SIDE.h);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, SIDE.w, SIDE.h);
  const half = SIDE.h / 2;
  const vy = (y: number): number => (y - SIDE.y0) / (SIDE.y1 - SIDE.y0);
  const scale = SIDE.w / (SIDE.z1 - SIDE.z0); // px per m (both axes are close to it)
  // Starboard (top half): the stern on the left, the bow on the right; port (bottom half): mirrored.
  paintSide(ctx, (z, y) => [((SIDE.z1 - z) / (SIDE.z1 - SIDE.z0)) * SIDE.w, (1 - vy(y)) * half], scale);
  paintSide(
    ctx,
    (z, y) => [((z - SIDE.z0) / (SIDE.z1 - SIDE.z0)) * SIDE.w, half + (1 - vy(y)) * half],
    scale,
  );
  return canvasTexture(canvas, { anisotropy: 8 });
}

function topTexture(): Texture {
  const canvas = createCanvas(TOP.w, TOP.h);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, TOP.w, TOP.h);
  const scale = TOP.w / (TOP.x1 - TOP.x0);
  paintTop(
    ctx,
    (x, z) => [((x - TOP.x0) / (TOP.x1 - TOP.x0)) * TOP.w, ((z - TOP.z0) / (TOP.z1 - TOP.z0)) * TOP.h],
    scale,
  );
  return canvasTexture(canvas, { anisotropy: 8 });
}

// Clear-coated race paint: the base colour with the side and top art projected onto it by the
// surface's facing (the side art on the faces that look outboard, the top art on those that look up).
function liveryMaterial(o: {
  color: ColorRepresentation;
  side: Texture;
  top: Texture;
  ao: AoVolume | null;
  detail?: ResolvedDetail | null;
  name?: string;
  sideArt?: boolean; // default true (the wing has none: the fins' number would show on its plates)
}): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial();
  m.name = o.name ?? 'hull';
  m.clearcoat = 1;
  m.clearcoatRoughness = 0.04;
  const p: N = bodyPosition();
  const n: N = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const vy = clamp(p.y.sub(SIDE.y0).div(SIDE.y1 - SIDE.y0), 0.004, 0.996);
  const starboard = n.x.greaterThan(0);
  const u = select(
    starboard,
    float(SIDE.z1)
      .sub(p.z)
      .div(SIDE.z1 - SIDE.z0),
    p.z.sub(SIDE.z0).div(SIDE.z1 - SIDE.z0),
  );
  const v = select(starboard, vy.mul(0.5).add(0.5), vy.mul(0.5));
  const side = texture(o.side, vec2(u, v));
  const topZ = p.z.add(select(p.y.greaterThan(WING_ART.y), float(WING_ART.shift), float(0)));
  const top = texture(
    o.top,
    vec2(p.x.sub(TOP.x0).div(TOP.x1 - TOP.x0), float(1).sub(topZ.sub(TOP.z0).div(TOP.z1 - TOP.z0))),
  );
  const ws = smoothstep(float(0.35), float(0.75), abs(n.x)).mul(o.sideArt === false ? 0 : 1);
  const wt = smoothstep(float(0.35), float(0.75), n.y);
  const c = new Color(o.color);
  let col: N = vec3(c.r, c.g, c.b);
  col = mix(col, side.rgb, side.a.mul(ws));
  col = mix(col, top.rgb, top.a.mul(wt));
  const s = applyDetail(o.detail, p, n, {
    color: col,
    roughness: float(0.24),
    ao,
    metalness: float(0),
    delta: null,
  });
  m.colorNode = s.color.mul(mix(float(0.8), float(1), ao));
  m.roughness = 0.24;
  if (o.detail) m.roughnessNode = s.roughness;
  m.aoNode = s.ao;
  const normal = detailNormal(null, s.delta);
  if (normal) m.normalNode = m.clearcoatNormalNode = normal;
  return m;
}

// ------------------------------------------------------------------------ draft

const detail = (part: string) => boatDetail('hydro', part);

// The sea kept out of the cockpit tub and from under the canopy: the capsule's inside, down into the
// hull (the physics hull's volume) and up to just under the glass.
function capsuleMask(): ReturnType<typeof wellVolume> {
  return wellVolume(
    CAPSULE.front,
    CAPSULE.aft,
    (z) => {
      const s = capsuleSection(z);
      return Array.from({ length: 24 }, (_, k) => {
        const [x, y] = superPoint(s, (2 * Math.PI * k) / 24, 0.93);
        return [x, y] as [number, number];
      });
    },
    12,
  );
}

export function hydroDraft(): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const builders = [0, 1, 2].map((lod) => structure(lines, lod));
  const deck = lines.deckY(0);
  const lights: LightMountSpec[] = [
    { kind: 'sidePort', position: [-NAV.x, deck + 0.044, NAV.z], direction: [-0.83, 0, -0.56] },
    { kind: 'sideStarboard', position: [NAV.x, deck + 0.044, NAV.z], direction: [0.83, 0, -0.56] },
    { kind: 'allRoundWhite', position: [0, WING.y + 0.135, WING.z] },
  ];
  const drives: TelemetryDrive[] = [
    { name: WING_PIVOT, axis: 'x', key: 'wingAngle', rate: 6 },
    { name: 'rudder', axis: 'y', key: 'rudderAngle' },
    { name: 'helm', axis: 'z', key: 'steering', scale: -8 },
    // Capped so the blades don't strobe (the real one turns ~160 times a second).
    {
      name: 'prop',
      axis: 'z',
      spin: true,
      value: (t) => -Math.min(7, (t.rpm ?? 0) / 60) * Math.PI * 2,
      rate: 4,
    },
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  const mask = merge([triMeshGeometry(physics.mesh), capsuleMask()]);
  return {
    kind: 'hydro',
    name: BOAT_CARDS.hydro.name,
    length: spec.dimensions.loa,
    palette: {
      hull: { topside: 0xb0101a, topsideRoughness: 0.24, clearcoat: 1, bands: [], stain: 0, grime: 0 },
      deck: 0xb0101a,
      house: 0xb0101a,
      trim: 0x121316,
      machinery: 0x2a2c2f,
      grime: 0.02,
      rust: 0,
    },
    extraMaterials: (ao) => {
      const side = sideTexture();
      const top = topTexture();
      return {
        [SLOTS.hull]: liveryMaterial({ color: PAINT.base, side, top, ao, detail: detail(SLOTS.hull) }),
        // The wing white (its name in red on top), so it stands out against the red cowling astern.
        wing: liveryMaterial({
          color: PAINT.white,
          side,
          top,
          ao,
          detail: detail(SLOTS.hull),
          name: 'wing',
          sideArt: false,
        }),
        bottom: hullPaintMaterial({
          topside: 0xe4e6e8,
          topsideRoughness: 0.28,
          clearcoat: 0.6,
          bands: [],
          stain: 0.15,
          grime: 0.03,
          ao,
          detail: detail('bottom'),
        }),
        // Clear Lexan: the driver shows through it.
        [SLOTS.glass]: glassMaterial({ tint: 0x1b2329, outside: 0.32, inside: 0.06 }),
        [SLOTS.black]: simpleMaterial({ color: 0x18191b, roughness: 0.5, ao, name: 'black' }),
        [SLOTS.chrome]: simpleMaterial({
          color: 0xdcdfe2,
          roughness: 0.14,
          metalness: 1,
          ao,
          name: 'stainless',
        }),
        carbon: simpleMaterial({ color: 0x24272b, roughness: 0.3, metalness: 0.1, ao, name: 'carbon' }),
        cockpit: simpleMaterial({ color: 0x2b2e32, roughness: 0.65, ao, name: 'cockpit' }),
        gearcase: simpleMaterial({ color: 0x9ea2a6, roughness: 0.3, metalness: 0.9, ao, name: 'gearcase' }),
        exhaust: simpleMaterial({ color: 0x5a4a3c, roughness: 0.45, metalness: 0.85, ao, name: 'exhaust' }),
        propMetal: simpleMaterial({ color: 0xd9c690, roughness: 0.18, metalness: 1, name: 'propeller' }),
      };
    },
    lods: [0, 1, 2].map((lod) => ({
      builder: builders[lod]!,
      shadows: lod < 2,
      extras: (materials) => [
        wingGroup(lod, materials),
        ...(lod < 2 ? [propGroup(lod, materials), rudderGroup(lod, materials)] : []),
        ...(lod === 0 ? [wheel(materials)] : []),
      ],
    })),
    aoVoxel: 0.04,
    aoLod: 1,
    aoDistance: 0.5,
    // The wing (an extra, not in the bake) shades the after deck under it.
    aoBoxes: [
      {
        min: [-WING.span / 2, WING.y - 0.04, WING.z - WING.le],
        max: [WING.span / 2, WING.y + 0.04, WING.z + 0.5],
      },
    ],
    lights,
    floods: [],
    animated: [],
    drives,
    eye: new Vector3(EYE.x, EYE.y, EYE.z),
    waterMask: mask,
    lodThresholds: { pixels: [220, 70] },
  };
}
