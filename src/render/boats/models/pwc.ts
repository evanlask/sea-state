// Three-seat performance jet ski "Sea Dart RX" (Sea-Doo RXP-X class, 3.3 ×
// 1.25 m) on the physics planing hull: dark lower hull with strakes, sponsons,
// intake grate and ride plate under a sculpted red upper deck (domed hood with
// racing stripes and side graphics, footwells with raised lips, stepped
// three-seat saddle, rear boarding platform with mats, step and tow eye),
// steering pod with a lit display, handlebars, mirrors and a small visor, the
// jet nozzle and reverse bucket at the transom, and a rider in a life vest
// holding the bars: the skinned character (rider/) on the near LODs once it has
// loaded, else (and on the far LOD) a procedural figure.
//
// Animated (drives): 'handlebar' (nozzle), 'nozzle' (nozzle), 'bucket'
// (bucket: 0 ahead, 1 neutral, 2 brake, 3 reverse), 'rider:torso' (riderLean);
// the rider's arms follow the bars (two-bone IK in the animator: the skinned
// rider's skeleton, or the procedural LOD0 rider's limbs).

import {
  type BufferGeometry,
  Color,
  type ColorRepresentation,
  DoubleSide,
  type Material,
  Matrix4,
  Mesh,
  MeshPhysicalNodeMaterial,
  type Object3D,
  Group,
  SphereGeometry,
  type Texture,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';

import { pwcSpec } from '../../../sim/boats/specs/pwc';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { type N, tsl } from '../../tsl';
import { boatDetail, type ResolvedDetail } from '../detail/detail';
import { applyDetail, detailNormal } from '../detail/nodes';
import { type Animator, linkMesh, stretch, type TelemetryDrive, twoBoneJoint } from '../kit/animate';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { LightMountSpec } from '../kit/BoatVisual';
import {
  at,
  atlasPlane,
  bevelBox,
  cylinder,
  lathe,
  normalizeGeometry,
  PartBuilder,
  rod,
  toGeometry,
} from '../kit/geometry';
import { hullDecal } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import { textDecalTexture } from '../kit/liveries';
import { computeNormals, hullShell, type MeshData, stationParameters, transomCap } from '../kit/loft';
import {
  type AoVolume,
  aoNode,
  bodyNormal,
  bodyPosition,
  fabricMaterial,
  nonSkidMaterial,
  simpleMaterial,
} from '../kit/materials';
import { wellVolume } from '../kit/plan';
import { merge, navLightHousing, SLOTS } from '../kit/props';
import { bottomStrakes, loftRings, orientOutward, sculpt, type SuperSection, type V3 } from '../kit/sculpt';
import { capsule, rail, slab } from '../kit/smallcraft';
import { canvasTexture, context2d, createCanvas } from '../kit/textures';
import { riderAsset } from '../rider/asset';
import { RiderOverboard } from '../rider/overboardRider';
import { RIDER_EYE } from '../rider/pose';
import { riderMaterials, skinnedRider, skinnedRiderAnimator } from '../rider/skinnedRider';
import {
  BAR,
  FOOT_AFT,
  FOOT_FRONT,
  FOOT_Y,
  GRIP,
  gripAt,
  SEAT_BASE,
  SEAT_HW,
  SEAT_Z0,
  SEAT_Z1,
  seatSection,
} from './pwcLayout';

const { abs, float, mix, smoothstep, texture, vec2, vec3 } = tsl;

const spec = pwcSpec;
const HOOD_AFT = -0.5;
const PLATFORM_Y = 0.335;
const HIP = new Vector3(0, 0.7, 0.16);
const SPINE_PITCH = -0.38; // torso leaning forward
const SHOULDER: V3 = [0.21, 0.47, 0.02]; // spine frame
const NOZZLE = { y: -0.14, z: 1.62 };
const BUCKET = { y: -0.02, z: 1.66 };
const ZA = -1.65;
const ZB = 1.65;
const YA = 0.24;
const YB = 0.82;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Upper-deck cross-section (starboard half, outer edge → centreline), blending the domed hood, the
// footwells with their raised lips beside the seat pedestal, and the flat rear platform.
function deckRing(lines: HullLines, z: number): [number, number][] {
  const w = lines.deckHalf(z); // 0 at the stem: the moulding closes there in a knife edge
  const yd = lines.deckY(z);
  const hood = 0.47 + 0.27 * smooth(-1.65, -0.62, z) - 0.06 * smooth(-0.62, -0.3, z);
  const fracs = [1, 0.97, 0.88, 0.8, 0.56, 0.44, 0.22, 0];
  const n = 2.4;
  const dome = fracs.map((f): [number, number] => {
    const x = w * f;
    const h = (1 - f ** n) ** (1 / n);
    return [x, yd + (hood - yd) * h];
  });
  const lip = yd + 0.085;
  const foot: [number, number][] = [
    [w, yd],
    [w - 0.015, lip],
    [w - 0.06, lip],
    [w - 0.095, FOOT_Y],
    [SEAT_HW + 0.03, FOOT_Y],
    [SEAT_HW, SEAT_BASE],
    [SEAT_HW * 0.5, SEAT_BASE + 0.01],
    [0, SEAT_BASE + 0.012],
  ];
  const rear: [number, number][] = [
    [w, yd],
    [w - 0.015, PLATFORM_Y - 0.005],
    [w - 0.06, PLATFORM_Y],
    [w * 0.8, PLATFORM_Y],
    [w * 0.56, PLATFORM_Y],
    [w * 0.44, PLATFORM_Y],
    [w * 0.22, PLATFORM_Y],
    [0, PLATFORM_Y],
  ];
  const fw = smooth(HOOD_AFT - 0.12, FOOT_FRONT, z);
  const rw = smooth(FOOT_AFT - 0.02, FOOT_AFT + 0.14, z);
  return dome.map(([x0, y0], k) => {
    const [x1, y1] = foot[k]!;
    const [x2, y2] = rear[k]!;
    const x = x0 + (x1 - x0) * fw;
    const y = y0 + (y1 - y0) * fw;
    return [x + (x2 - x) * rw, y + (y2 - y) * rw];
  });
}

// Vertical face closing the deck moulding's aft end down to the straight line between its two
// deck-edge points: the boarding platform stands above the deck edge, where the transom stops.
function sternCap(ring: readonly V3[]): MeshData {
  const [x0, yd, z] = ring[0]!;
  const n = ring.length;
  const positions: number[] = [];
  for (const p of ring) positions.push(...p);
  // Below each inner ring point, on the deck-edge line (the ends are on it already).
  for (let k = 1; k < n - 1; k++) positions.push(ring[k]![0], yd, z);
  const below = (k: number): number => (k === 0 ? 0 : k === n - 1 ? n - 1 : n + k - 1);
  const indices: number[] = [];
  for (let k = 0; k + 1 < n; k++) {
    if (k > 0) indices.push(k, k + 1, below(k));
    if (k + 1 < n - 1) indices.push(k + 1, below(k + 1), below(k));
  }
  orientOutward(positions, indices, [0, yd, z - 1]);
  const uvs: number[] = [];
  for (let i = 0; i < positions.length; i += 3) uvs.push(positions[i]! - x0, positions[i + 1]! - yd);
  return {
    positions: new Float32Array(positions),
    normals: computeNormals(positions, indices),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

function structure(lines: HullLines, lod: number): PartBuilder {
  const b = new PartBuilder();
  const box = (
    slot: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    bevel = 0.01,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(x, y, z, rx, ry, rz));
  };
  const res = [
    { stations: 64, below: 10, above: 5 },
    { stations: 28, below: 5, above: 3 },
    { stations: 14, below: 3, above: 2 },
  ][lod]!;
  b.addData(SLOTS.hull, hullShell(lines, res));
  b.addData(SLOTS.hull, transomCap(lines, res.below, res.above));
  if (lod < 2) {
    b.addData(
      SLOTS.hull,
      bottomStrakes(lines, [0.4, 0.75], {
        stations: lod === 0 ? 40 : 14,
        sFrom: 0.12,
        sTo: 0.99,
        width: 0.025,
      }),
    );
    b.addData(
      SLOTS.hull,
      bottomStrakes(lines, [1], { stations: lod === 0 ? 40 : 14, sFrom: 0.1, sTo: 0.995, width: 0.03 }),
    );
  }
  // Upper deck moulding.
  // On the hull shell's stations, so the deck's edge lies on the shell's top edge (and its last ring
  // in the transom's plane, where its cap meets the transom's top edge).
  const zs = stationParameters(res.stations).map((s) => lines.zAt(s));
  const rings = zs.map((z) => {
    const half = deckRing(lines, z);
    const full = [
      ...half,
      ...[...half]
        .reverse()
        .slice(1)
        .map(([x, y]): [number, number] => [-x, y]),
    ];
    return full.map(([x, y]): V3 => [x, y, z]);
  });
  b.addData('deckPaint', loftRings(rings, { closed: false, inside: [0, -3, 0] }));
  b.addData('deckPaint', sternCap(rings[rings.length - 1]!));
  // Rubber bumper on the hull/deck joint.
  for (const side of [-1, 1]) {
    const pts: Vector3[] = [];
    const n = [40, 16, 8][lod]!;
    for (let i = 0; i <= n; i++) {
      const z = ZA + 0.06 + ((ZB - ZA - 0.08) * i) / n;
      pts.push(new Vector3(side * (lines.deckHalf(z) + 0.008), lines.deckY(z) - 0.005, z));
    }
    rail(b, pts, 0.022, { slot: SLOTS.black, radial: lod === 0 ? 8 : 5, caps: true });
  }
  // Sponsons, intake grate and ride plate.
  for (const side of [-1, 1]) {
    box(
      SLOTS.black,
      0.07,
      0.012,
      0.5,
      side * (lines.halfBreadthAt(1.15, -0.06) + 0.025),
      -0.06,
      1.15,
      0.004,
      0,
      0,
      side * 0.25,
    );
    box(
      SLOTS.black,
      0.12,
      0.01,
      0.42,
      side * 0.06,
      -0.323 + 0.06 * Math.tan(0.384) - 0.004,
      0.85,
      0.003,
      0,
      0,
      side * 0.384,
    );
  }
  box(SLOTS.black, 0.34, 0.012, 0.4, 0, -0.33, 1.45, 0.004);
  // Pump tunnel exit panel on the transom and the venturi housing round the nozzle.
  box(SLOTS.black, 0.36, 0.3, 0.012, 0, -0.13, lines.zStern + 0.004, 0.004);
  // Venturi housing round the nozzle, under the platform.
  b.add(
    SLOTS.black,
    cylinder(0.09, 0.14, lod === 0 ? 16 : 8).rotateX(Math.PI / 2),
    at(0, NOZZLE.y, NOZZLE.z - 0.06),
  );

  // Steering pod with the display; the bars are a separate (animated) group.
  const pod: SuperSection[] = [];
  const np = lod === 0 ? 8 : 4;
  for (let k = 0; k <= np; k++) {
    const t = k / np;
    const s = Math.min(1, t / 0.25, (1 - t) / 0.3) ** 0.5;
    pod.push({
      z: -0.68 + 0.36 * t,
      y: 0.7,
      hw: 0.04 + 0.13 * s,
      top: 0.02 + 0.13 * s,
      bottom: 0.03 + 0.1 * s,
      n: 3,
    });
  }
  b.addData('deckPaint', sculpt(pod, lod === 0 ? 20 : 10, { capStart: true, capEnd: true }));
  if (lod < 2) {
    b.add(SLOTS.black, bevelBox(0.24, 0.14, 0.03, 0.012), at(0, 0.8, -0.38, -0.9));
    b.add(SLOTS.screen, atlasPlane(0.2, 0.1, [0.68, 0.45], [0.99, 0.95]), at(0, 0.8, -0.364, -0.9));
    // Visor.
    const v0: V3[] = [];
    const v1: V3[] = [];
    for (let k = 0; k <= 6; k++) {
      const x = -0.2 + (0.4 * k) / 6;
      const c = 1 - (x / 0.2) ** 2;
      v0.push([x, 0.8 + 0.02 * c, -0.6 - 0.03 * c]);
      v1.push([x * 0.85, 0.92 + 0.02 * c, -0.52 - 0.02 * c]);
    }
    b.addData(SLOTS.glass, loftRings([v0, v1], { closed: false, inside: [0, 0.7, -0.2] }));
    // Mirrors on stalks.
    for (const side of [-1, 1]) {
      b.add(
        SLOTS.black,
        rod(new Vector3(side * 0.3, 0.66, -0.66), new Vector3(side * 0.43, 0.8, -0.62), 0.012, 6, true),
      );
      box(SLOTS.black, 0.14, 0.075, 0.045, side * 0.47, 0.82, -0.62, 0.015, 0, side * 0.15);
      box(SLOTS.chrome, 0.12, 0.06, 0.004, side * 0.47, 0.82, -0.596, 0.002, 0, side * 0.15);
    }
  }
  // Stepped three-seat saddle.
  const seat: SuperSection[] = [];
  const ns = lod === 0 ? 30 : 10;
  for (let k = 0; k <= ns; k++) {
    const z = SEAT_Z0 + (SEAT_Z1 - SEAT_Z0) * (k / ns);
    seat.push({ z, y: SEAT_BASE + 0.02, ...seatSection(z), bottom: 0.03, n: 3.6, nBottom: 6 });
  }
  b.addData('seat', sculpt(seat, lod === 0 ? 24 : 10, { capStart: true, capEnd: true }));
  if (lod < 2) {
    // Rear grab handle, platform mats, boarding step, tow eye, accessory light post.
    rail(
      b,
      [
        new Vector3(-0.2, PLATFORM_Y + 0.12, FOOT_AFT + 0.02),
        new Vector3(-0.18, PLATFORM_Y + 0.2, FOOT_AFT + 0.1),
        new Vector3(0.18, PLATFORM_Y + 0.2, FOOT_AFT + 0.1),
        new Vector3(0.2, PLATFORM_Y + 0.12, FOOT_AFT + 0.02),
      ],
      0.016,
      { slot: SLOTS.black, radial: 8 },
    );
    for (const side of [-1, 1])
      b.add('mat', slab(0.4, 0.5, 0.008, 0.04, 0.003), at(side * 0.27, PLATFORM_Y, 1.35));
    for (const side of [-1, 1]) {
      // Footwell mats.
      b.add('mat', slab(0.22, 1.2, 0.006, 0.04, 0.002), at(side * 0.4, FOOT_Y, 0.3));
    }
    box(SLOTS.black, 0.26, 0.13, 0.03, 0, 0.17, lines.zStern + 0.018, 0.008);
    b.add(SLOTS.chrome, new TorusGeometry(0.025, 0.007, 6, 12), at(0, PLATFORM_Y + 0.03, 1.55));
    b.add(SLOTS.black, cylinder(0.022, 0.05, 10), at(0, PLATFORM_Y + 0.025, 1.45));
  }
  if (lod === 0) {
    navLightHousing(b, at(0, PLATFORM_Y + 0.05, 1.45), SLOTS.lampWhite, 0.07);
  }
  return b;
}

// Procedural rider: static legs, the torso (leaning on riderLean) and arms, as extras (so they can hide
// while he's overboard).
function legsGroup(lod: number, materials: Record<string, Material>): Group {
  const b = new PartBuilder();
  const seg = lod === 0 ? 10 : 6;
  b.add(
    'wetsuit',
    normalizeGeometry(
      capsule(new Vector3(-0.11, HIP.y - 0.01, HIP.z), new Vector3(0.11, HIP.y - 0.01, HIP.z), 0.1, seg),
    ),
  );
  for (const side of [-1, 1]) {
    const hip = new Vector3(side * 0.1, HIP.y - 0.02, HIP.z - 0.02);
    const knee = new Vector3(side * 0.24, 0.66, -0.26);
    const ankle = new Vector3(side * 0.37, 0.33, -0.12);
    b.add('wetsuit', normalizeGeometry(capsule(hip, knee, 0.075, seg)));
    b.add('wetsuit', normalizeGeometry(capsule(knee, ankle, 0.055, seg)));
    b.add('shoe', bevelBox(0.1, 0.07, 0.25, 0.03), at(side * 0.385, FOOT_Y + 0.035, -0.17, 0, side * -0.15));
  }
  const legs = b.build(materials, { shadows: lod < 2 }).group;
  legs.name = 'rider:legs';
  return legs;
}

function torsoGroup(lod: number, materials: Record<string, Material>): Group {
  const b = new PartBuilder();
  const seg = lod === 0 ? 20 : lod === 1 ? 12 : 8;
  // Torso in the spine frame (y up the spine, −z forward), lofted along local z then stood up.
  const stand = new Matrix4().makeRotationX(-Math.PI / 2);
  const vest: SuperSection[] = [];
  const nv = lod === 0 ? 10 : 4;
  for (let k = 0; k <= nv; k++) {
    const t = k / nv;
    const h = 0.04 + 0.5 * t;
    const chest = Math.sin(Math.min(1, t * 1.2) * Math.PI * 0.55);
    const shoulder = t > 0.85 ? Math.sqrt(Math.max(0, 1 - ((t - 0.85) / 0.17) ** 2)) : 1;
    vest.push({
      z: h,
      y: 0.01,
      hw: (0.15 + 0.06 * chest) * (0.45 + 0.55 * shoulder),
      top: (0.1 + 0.035 * chest) * (0.5 + 0.5 * shoulder),
      bottom: (0.1 + 0.02 * chest) * (0.5 + 0.5 * shoulder),
      n: 2.6,
    });
  }
  const capped = { capStart: true, capEnd: true };
  b.add('vest', normalizeGeometry(toGeometry(sculpt(vest, seg, capped))), stand);
  if (lod < 2) {
    for (const h of [0.18, 0.31]) {
      const band: SuperSection[] = [-0.012, 0.012].map((d) => ({
        z: h + d,
        y: 0.01,
        hw: 0.215,
        top: 0.142,
        bottom: 0.125,
        n: 2.6,
      }));
      b.add(SLOTS.black, normalizeGeometry(toGeometry(sculpt(band, seg, capped))), stand);
    }
  }
  b.add('skin', normalizeGeometry(capsule(new Vector3(0, 0.5, 0), new Vector3(0, 0.6, -0.01), 0.048, 10)));
  b.add('skin', new SphereGeometry(0.1, seg, Math.round(seg * 0.7)), at(0, 0.67, -0.02, 0, 0, 0));
  // Hair cap and sunglasses.
  b.add(
    'hair',
    new SphereGeometry(0.104, seg, Math.round(seg * 0.4), 0, Math.PI * 2, 0, Math.PI * 0.45),
    at(0, 0.675, 0.0, -0.35),
  );
  if (lod < 2) {
    b.add(SLOTS.black, bevelBox(0.16, 0.035, 0.03, 0.01), at(0, 0.685, -0.105));
    for (const side of [-1, 1]) {
      // Shoulders (sleeve tops).
      b.add('wetsuit', new SphereGeometry(0.06, 10, 8), at(side * SHOULDER[0], SHOULDER[1], SHOULDER[2]));
    }
  }
  const body = b.build(materials, { shadows: lod < 2 }).group;
  const spine = new Group();
  spine.name = 'rider:spine';
  spine.rotation.x = SPINE_PITCH;
  spine.add(body);
  const torso = new Group();
  torso.name = 'rider:torso';
  torso.position.copy(HIP);
  torso.add(spine);
  return torso;
}

function handlebarGroup(lod: number, materials: Record<string, Material>): Group {
  const b = new PartBuilder();
  const [gx, gy, gz] = GRIP;
  rail(
    b,
    [
      new Vector3(-gx - 0.04, gy, gz + 0.01),
      new Vector3(-0.18, 0.01, 0.0),
      new Vector3(0.18, 0.01, 0.0),
      new Vector3(gx + 0.04, gy, gz + 0.01),
    ],
    0.014,
    { radial: 8 },
  );
  for (const side of [-1, 1]) {
    b.add(
      SLOTS.black,
      normalizeGeometry(
        capsule(
          new Vector3(side * (gx - 0.05), gy, gz),
          new Vector3(side * (gx + 0.06), gy + 0.005, gz + 0.015),
          0.019,
          10,
        ),
      ),
    );
    if (lod === 0)
      b.add(SLOTS.black, bevelBox(0.09, 0.012, 0.02, 0.004), at(side * (gx - 0.02), gy + 0.005, gz - 0.035));
  }
  b.add('deckPaint', bevelBox(0.16, 0.06, 0.08, 0.025), at(0, 0.0, 0.0));
  b.add(SLOTS.black, cylinder(0.03, 0.12, 10), at(0, -0.06, 0));
  const bar = new Group();
  bar.name = 'handlebar';
  bar.add(b.build(materials).group);
  const tilt = new Group();
  tilt.name = 'handlebar:tilt';
  tilt.position.set(0, BAR.y, BAR.z);
  tilt.rotation.x = BAR.tilt;
  tilt.add(bar);
  return tilt;
}

function jetGroups(lod: number, materials: Record<string, Material>): Object3D[] {
  const nb = new PartBuilder();
  nb.add(
    'jetNozzle',
    lathe(
      [
        [0.07, 0],
        [0.068, 0.06],
        [0.056, 0.16],
        [0.05, 0.16],
        [0.06, 0.02],
        [0.064, 0],
      ],
      lod === 0 ? 18 : 10,
    ).rotateX(Math.PI / 2),
  );
  const nozzle = new Group();
  nozzle.name = 'nozzle';
  nozzle.position.set(0, NOZZLE.y, NOZZLE.z);
  nozzle.add(nb.build(materials).group);
  // Reverse bucket: a scoop that drops behind the nozzle exit (pivot above the nozzle at the transom).
  const bb = new PartBuilder();
  bb.add(SLOTS.black, bevelBox(0.2, 0.2, 0.02, 0.008), at(0, -0.12, 0.27, -0.25));
  for (const s of [-1, 1]) bb.add(SLOTS.black, bevelBox(0.015, 0.2, 0.18, 0.005), at(s * 0.1, -0.1, 0.18));
  bb.add(SLOTS.black, bevelBox(0.22, 0.03, 0.06, 0.01), at(0, -0.01, 0.03));
  const bucket = new Group();
  bucket.name = 'bucket';
  bucket.position.set(0, BUCKET.y, BUCKET.z);
  bucket.add(bb.build(materials).group);
  return [nozzle, bucket];
}

const spineMatrix = new Matrix4();
const torsoMatrix = new Matrix4();
function shoulderAt(side: number, lean: number, out: Vector3): Vector3 {
  torsoMatrix.makeRotationZ(lean).setPosition(HIP);
  spineMatrix.makeRotationX(SPINE_PITCH);
  return out
    .set(side * SHOULDER[0], SHOULDER[1], SHOULDER[2])
    .applyMatrix4(spineMatrix)
    .applyMatrix4(torsoMatrix);
}

const UPPER_ARM = 0.29;
const FOREARM = 0.29;

const armPole = new Vector3();

function posedArm(side: number, steer: number, lean: number, s: Vector3, e: Vector3, h: Vector3): void {
  shoulderAt(side, lean, s);
  gripAt(side, steer, h);
  const pole = armPole.set(side * 0.35, -0.25, 0.15).add(s);
  twoBoneJoint(s, h, UPPER_ARM, FOREARM, pole, e);
}

function armMeshes(lod: number, materials: Record<string, Material>): Object3D[] {
  const out: Object3D[] = [];
  const s = new Vector3();
  const e = new Vector3();
  const h = new Vector3();
  for (const [k, side] of [-1, 1].entries()) {
    const upper = linkMesh(0.045, materials.wetsuit!, `rider:arm:${k}:upper`, lod === 0 ? 8 : 5);
    const fore = linkMesh(0.035, materials.skin!, `rider:arm:${k}:fore`, lod === 0 ? 8 : 5);
    const hand = new Mesh(new SphereGeometry(0.035, 8, 6), materials.glove);
    hand.name = `rider:arm:${k}:hand`;
    // A little fatter than the upper arm, so it closes the arm tube's open end.
    const elbow = new Mesh(new SphereGeometry(0.048, 8, 6), materials.wetsuit);
    elbow.name = `rider:arm:${k}:elbow`;
    posedArm(side, 0, 0, s, e, h);
    stretch(upper, s, e);
    stretch(fore, e, h);
    hand.position.copy(h);
    elbow.position.copy(e);
    for (const m of [upper, fore]) m.castShadow = lod < 2;
    hand.castShadow = elbow.castShadow = lod < 2;
    out.push(upper, fore, hand, elbow);
  }
  return out;
}

// Keeps the LOD0 rider's hands on the grips as the bars turn and the torso leans; hides him while
// he's overboard after a capsize.
function riderAnimator(lods: readonly Object3D[]): Animator {
  const overboard = new RiderOverboard(lods, [], () => {});
  const lod0 = lods[0]!;
  const bar = lod0.getObjectByName('handlebar');
  const torso = lod0.getObjectByName('rider:torso');
  const arms = [0, 1].map((k) => ({
    upper: lod0.getObjectByName(`rider:arm:${k}:upper`),
    fore: lod0.getObjectByName(`rider:arm:${k}:fore`),
    hand: lod0.getObjectByName(`rider:arm:${k}:hand`),
    elbow: lod0.getObjectByName(`rider:arm:${k}:elbow`),
  }));
  const s = new Vector3();
  const e = new Vector3();
  const h = new Vector3();
  const animator: Animator = (dt, telemetry, lod) => {
    overboard.update(dt, telemetry);
    if (lod !== 0 || !bar || !torso) return;
    arms.forEach((a, k) => {
      if (!a.upper || !a.fore || !a.hand || !a.elbow) return;
      posedArm(k === 0 ? -1 : 1, bar.rotation.y, torso.rotation.z, s, e, h);
      stretch(a.upper, s, e);
      stretch(a.fore, e, h);
      a.hand.position.copy(h);
      a.elbow.position.copy(e);
    });
  };
  animator.event = (type) => overboard.event(type);
  return animator;
}

// Side graphics in body z (identical on both sides, so the shapes point forward on each), drawn
// with u = 0 at the stern and 1 at the bow, v = 0 at YA up to 1 at YB.
function sideGraphicTexture(): Texture {
  const W = 1024;
  const H = 256;
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, W, H);
  const P = (u: number, v: number): [number, number] => [u * W, (1 - v) * H];
  const poly = (pts: [number, number][], color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    pts.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(...P(u, v)) : ctx.lineTo(...P(u, v))));
    ctx.closePath();
    ctx.fill();
  };
  // Black lower flank rising toward the bow, a white slash and a thin silver line.
  poly(
    [
      [0.0, 0.0],
      [0.0, 0.2],
      [0.35, 0.22],
      [0.62, 0.42],
      [0.86, 0.6],
      [0.98, 0.52],
      [0.98, 0.0],
    ],
    '#16171a',
  );
  poly(
    [
      [0.52, 0.42],
      [0.62, 0.47],
      [0.88, 0.72],
      [0.97, 0.66],
      [0.86, 0.62],
      [0.62, 0.42],
    ],
    '#f2f2ee',
  );
  poly(
    [
      [0.3, 0.27],
      [0.6, 0.48],
      [0.6, 0.5],
      [0.3, 0.29],
    ],
    '#c9ced3',
  );
  return canvasTexture(canvas, { anisotropy: 8 });
}

// Clear-coated deck paint with the projected side graphics and twin hood stripes.
function deckPaintMaterial(o: {
  color: ColorRepresentation;
  graphic: Texture;
  ao: AoVolume | null;
  detail?: ResolvedDetail | null;
}): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial();
  m.name = 'deckPaint';
  m.clearcoat = 1;
  m.clearcoatRoughness = 0.05;
  const p: N = bodyPosition();
  const n: N = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const u = float(ZB)
    .sub(p.z)
    .div(ZB - ZA);
  const v = p.y.sub(YA).div(YB - YA);
  const g = texture(o.graphic, vec2(u, v));
  const sideW = smoothstep(float(0.3), float(0.6), abs(n.x));
  const c = new Color(o.color);
  const base = vec3(c.r, c.g, c.b);
  let col: N = mix(base, g.rgb, g.a.mul(sideW));
  const ax = abs(p.x);
  const stripe = smoothstep(float(0.03), float(0.034), ax)
    .mul(float(1).sub(smoothstep(float(0.058), float(0.062), ax)))
    .mul(float(1).sub(smoothstep(float(-0.62), float(-0.55), p.z)))
    .mul(smoothstep(float(0.35), float(0.6), n.y));
  col = mix(col, vec3(0.94, 0.94, 0.92), stripe);
  const s = applyDetail(o.detail, p, n, {
    color: col,
    roughness: float(0.3),
    ao,
    metalness: float(0),
    delta: null,
  });
  m.colorNode = s.color.mul(mix(float(0.8), float(1), ao));
  m.roughness = 0.3;
  if (o.detail) m.roughnessNode = s.roughness;
  m.aoNode = s.ao;
  const normal = detailNormal(null, s.delta);
  if (normal) m.normalNode = m.clearcoatNormalNode = normal;
  return m;
}

function decals(lines: HullLines, ao: AoVolume | null): Mesh[] {
  const tex = textDecalTexture({
    lines: [BOAT_CARDS.pwc.name.toUpperCase()],
    width: 1024,
    height: 128,
    color: '#f2f2ee',
    weight: 'italic 800',
  });
  return ([-1, 1] as const).map((side) =>
    hullDecal(
      lines,
      tex,
      { zFrom: 0.6, zTo: 1.5, yFrom: 0.17, yTo: 0.265, side, offset: 0.003, nz: 12, ny: 2 },
      ao,
    ),
  );
}

// Water-mask volume of one footwell (and the ramps at its ends): from inside the hull (overlapping
// the physics hull) out to the topsides and up past the raised lip by the ocean's mask margin
// (WaterMask MARGIN), so no sea shows in the well while the water outside is below the lip.
function footwellMask(lines: HullLines, side: number): BufferGeometry {
  const y0 = FOOT_Y - 0.1;
  return wellVolume(FOOT_FRONT - 0.12, FOOT_AFT + 0.08, (z) => {
    const yd = lines.deckY(z);
    const top = yd + 0.085 + 0.05;
    const hull = [0, 0.5, 1].map((t): [number, number] => {
      const y = y0 + (yd - y0) * t;
      return [lines.halfBreadthAt(z, y) - 0.005, y];
    });
    const ring: [number, number][] = [
      [SEAT_HW, y0],
      ...hull,
      [lines.deckHalf(z) - 0.005, top],
      [SEAT_HW, top],
    ];
    return ring.map(([x, y]): [number, number] => [side * x, y]);
  });
}

const detail = (part: string) => boatDetail('pwc', part);

export function pwcDraft(): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  // The skinned rider (when loaded) on LOD0 and LOD1; the procedural one otherwise and far away.
  const rider = riderAsset();
  const skinnedLod = (lod: number): boolean => rider !== null && lod < 2;
  const builders = [0, 1, 2].map((lod) => structure(lines, lod));
  const lights: LightMountSpec[] = [{ kind: 'allRoundWhite', position: [0, PLATFORM_Y + 0.11, 1.45] }];
  const bucketPos = (b: number): number => (b < 0.5 ? 0 : b < 1.5 ? 0.69 : 1);
  const drives: TelemetryDrive[] = [
    // Turning to starboard pulls the right grip back: a negative yaw of the bars.
    { name: 'handlebar', axis: 'y', key: 'nozzle', scale: -1.3, rate: 14 },
    { name: 'nozzle', axis: 'y', key: 'nozzle' },
    { name: 'bucket', axis: 'x', value: (t) => -1.15 * (1 - bucketPos(t.bucket ?? 0)), rate: 3 },
    { name: 'rider:torso', axis: 'z', key: 'riderLean', scale: -0.22, rate: 6 },
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  const mask = merge([triMeshGeometry(physics.mesh), ...[-1, 1].map((side) => footwellMask(lines, side))]);
  return {
    kind: 'pwc',
    name: BOAT_CARDS.pwc.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        // The deck colour wraps down the hull sides to a black accent line over the dark bottom.
        topside: 0xc8231d,
        topsideRoughness: 0.3,
        clearcoat: 1,
        bands: [{ below: 0.115, color: 0x26292d, roughness: 0.35 }],
        stripes: [{ y0: 0.115, y1: 0.15, color: 0x111214 }],
        stain: 0.25,
        grime: 0.05,
      },
      deck: 0x1c1d1f,
      house: 0xd12a24,
      trim: 0x16171a,
      machinery: 0x2a2c2f,
      grime: 0.05,
      rust: 0,
      glassTint: 0x2a3238,
    },
    extraMaterials: (ao) => ({
      deckPaint: deckPaintMaterial({
        color: 0xc8231d,
        graphic: sideGraphicTexture(),
        ao,
        detail: detail('deckPaint'),
      }),
      [SLOTS.black]: simpleMaterial({
        color: 0x18191b,
        roughness: 0.45,
        ao,
        name: 'black',
        detail: detail('black'),
      }),
      seat: fabricMaterial({ color: 0x2b2c30, ao, kind: 'vinyl', name: 'seat' }),
      mat: nonSkidMaterial({ color: 0x1d1e20, ao, cell: 0.008, name: 'mat', detail: detail('mat') }),
      [SLOTS.chrome]: simpleMaterial({
        color: 0xdcdfe2,
        roughness: 0.12,
        metalness: 1,
        ao,
        name: 'stainless',
      }),
      jetNozzle: simpleMaterial({ color: 0x45484c, roughness: 0.35, metalness: 0.6, ao, name: 'nozzle' }),
      wetsuit: fabricMaterial({ color: 0x1b2232, ao, kind: 'vinyl', name: 'wetsuit' }),
      vest: fabricMaterial({ color: 0xf0c018, ao, kind: 'canvas', name: 'vest' }),
      skin: simpleMaterial({ color: 0xc69274, roughness: 0.55, ao, name: 'skin' }),
      // Double-sided: the cap's inside shows past the head under its rim.
      hair: simpleMaterial({ color: 0x2b1d14, roughness: 0.8, ao, name: 'hair', side: DoubleSide }),
      glove: simpleMaterial({ color: 0x141416, roughness: 0.6, ao, name: 'glove' }),
      shoe: simpleMaterial({ color: 0x2c2f35, roughness: 0.7, ao, name: 'shoe' }),
      ...(rider ? riderMaterials(rider) : {}),
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: builders[lod]!,
      shadows: lod < 2,
      extras: (materials, ao) => [
        handlebarGroup(lod, materials),
        ...jetGroups(lod, materials),
        ...(rider && skinnedLod(lod)
          ? skinnedRider(rider, materials)
          : [
              legsGroup(lod, materials),
              torsoGroup(lod, materials),
              ...(lod < 2 ? armMeshes(lod, materials) : []),
            ]),
        ...(lod < 2 ? decals(lines, ao) : []),
      ],
    })),
    aoVoxel: 0.025,
    aoLod: 1,
    aoDistance: 0.35,
    aoBoxes: [
      { min: [-0.18, 0.72, -0.12], max: [0.18, 1.1, 0.25] },
      // The rider's hips and thighs (the AO bake voxelises LOD1's builder; the rider is an extra).
      { min: [-0.3, 0.64, -0.28], max: [0.3, 0.8, 0.22] },
    ],
    lights,
    floods: [],
    animated: [],
    drives,
    animator: rider ? skinnedRiderAnimator(rider) : riderAnimator,
    // The rider's eyes (BOAT_CAMERA_INFO.pwc).
    eye: RIDER_EYE.clone(),
    waterMask: mask,
    lodThresholds: { pixels: [220, 60] },
  };
}
