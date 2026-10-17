// 38 ft cruiser-racer "Kittiwake" (C&C 115 class, LOA 11.5 m, B 3.65 m) on
// the physics canoe body: white clear-coated gelcoat with navy sheer and boot
// stripes, plumb transom with a teak swim step, cambered non-skid deck, low
// cabin trunk with long smoked windows, hatches and a companionway, a teak
// cockpit with seats, traveller, primary winches and a 1.2 m wheel, stanchions
// and wire lifelines between the pulpit and pushpits, a keel-stepped aluminium
// mast with two sets of swept spreaders, standing rigging (forestay with
// furler, split backstay, caps, intermediates and lowers), the boom on its
// gooseneck with a rigid vang, mainsheet and genoa sheet, a fin keel with a
// lead bulb and a spade rudder.
//
// Attach points follow CC115_RIG (sim/sail/rig.ts) so SailView's cloth sails
// sit on the spars: luff on the mast's aft face at rig.mastZ, foot on the boom
// top at rig.boomY, genoa tack on the stem fitting at rig.tack.
//
// Animated (drives, every LOD): 'rudder' and 'wheel' from rudderAngle, 'boom'
// from sail.boomAngle; LOD0 sheets follow the boom and sail.jibClew*.

import {
  BoxGeometry,
  Group,
  type Material,
  Mesh,
  type Object3D,
  Path,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { sailSpec } from '../../../sim/boats/specs/sail';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
import { CC115_RIG } from '../../../sim/sail/rig';
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { boatDetail } from '../detail/detail';
import { type Animator, linkMesh, stretch, type Telemetry, type TelemetryDrive } from '../kit/animate';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { FloodSpec, LightMountSpec } from '../kit/BoatVisual';
import {
  at,
  bevelBox,
  cylinder,
  extrude,
  lathe,
  PartBuilder,
  rod,
  roundedRect,
  shapeFrom,
} from '../kit/geometry';
import { addHull, flatDecal } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import { textDecalTexture } from '../kit/liveries';
import { deckRegion, hullPatch } from '../kit/loft';
import { type AoVolume, lampMaterial, nonSkidMaterial, simpleMaterial, teakMaterial } from '../kit/materials';
import { merge, navLightHousing, SLOTS } from '../kit/props';
import { foilLoft, loftRings, sculpt, type V3 } from '../kit/sculpt';
import {
  deckHatch,
  hornCleat,
  lifelines,
  rail,
  sailWinch,
  slab,
  steeringWheelGeometry,
} from '../kit/smallcraft';

// Warm cabin light seen through the trunk (on the cabin switch, like the ships' windows).
function cabinGlow(base: number, nits: number, roughness: number, name: string): Material {
  const m = lampMaterial({ color: 0xffc98a, nits, channel: 'interior', base, name });
  m.roughness = roughness;
  return m;
}

const spec = sailSpec;
const rig = CC115_RIG;
const DEG = Math.PI / 180;

const CAMBER = 0.05;
const WELL_FRONT = 1.75; // cockpit well (and trunk aft face)
const WELL_AFT = 5.2;
const WELL_HALF = 1.08;
const SOLE_Y = 0.5;
const SEAT_Y = 0.9;
const SEAT_AFT = 3.95;
const TRUNK_FRONT = -2.85;
const TRUNK_RAMP = 0.8;
const TRUNK_Y = 1.42;
const TRUNK_CROWN = 0.045;
const SHOULDER = 0.05;
const MAST_HD = 0.1; // half depth (fore-aft) of the mast section
const MAST_HW = 0.065;
const MAST_CZ = rig.mastZ - MAST_HD + 0.01; // luff groove on the aft face at rig.mastZ
const HOUNDS_Y = rig.deckY + rig.I;
const SPREADERS = [
  { y: 6.2, length: 1.05 },
  { y: 11.0, length: 0.72 },
];
const SWEEP = 18 * DEG;
const CHAIN_Z = rig.mastZ + 0.55;
const TRAVELLER_Z = 3.75;
const TRAVELLER_Y = SOLE_Y + 0.2;
const PEDESTAL_Z = 4.42;
const WHEEL_Z = 4.53;
const WHEEL_Y = 1.3;
const WHEEL_R = 0.6;
const RUDDER_Z = 3.98; // stock axis
const WINCH = { x: 1.14, z: 2.75 };
const BOOM_BLOCK: V3 = [0, -0.24, 4.6]; // mainsheet block under the boom, boom frame

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

interface TrunkSection {
  wb: number;
  wt: number;
  yb: number;
  yt: number;
  f: number;
}

function deckTop(lines: HullLines, x: number, z: number): number {
  const half = Math.max(1e-3, lines.deckHalf(z));
  const u = Math.min(1, Math.abs(x) / half);
  return lines.deckY(z) + CAMBER * (1 - u * u);
}

function trunkAt(lines: HullLines, z: number): TrunkSection {
  const t = clamp((z - TRUNK_FRONT) / TRUNK_RAMP, 0, 1);
  const f = Math.sin((t * Math.PI) / 2) ** 0.8;
  const wb = Math.min(0.98, lines.deckHalf(z) - 0.36);
  const yb = deckTop(lines, wb, z) - 0.01;
  return { wb, wt: wb - 0.09 * f, yb, yt: yb + (TRUNK_Y - yb) * f, f };
}

const crownAt = (s: TrunkSection, x: number): number =>
  TRUNK_CROWN * s.f * (1 - (x / Math.max(0.05, s.wt)) ** 2);

// Starboard side of the trunk: base → top edge → rounded shoulder (x, y).
function trunkSide(s: TrunkSection): [number, number][] {
  const r = SHOULDER * s.f + 1e-3;
  const pts: [number, number][] = [
    [s.wb, s.yb],
    [(s.wb + s.wt) / 2, (s.yb + s.yt - r) / 2],
    [s.wt, s.yt - r],
  ];
  for (const a of [35, 65, 90]) {
    const x = s.wt - r + r * Math.cos(a * DEG);
    pts.push([x, s.yt - r + r * Math.sin(a * DEG) + crownAt(s, x)]);
  }
  return pts;
}

function trunkTop(s: TrunkSection, n = 7): [number, number][] {
  const x0 = s.wt - SHOULDER * s.f - 1e-3;
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const x = x0 - (2 * x0 * k) / (n - 1);
    pts.push([x, s.yt + crownAt(s, x)]);
  }
  return pts;
}

// Point on the trunk's flat side at fraction f from the base to the top edge, pushed out by `off`.
function trunkSidePoint(lines: HullLines, z: number, f: number, side: number, off = 0.004): V3 {
  const s = trunkAt(lines, z);
  const r = SHOULDER * s.f;
  const dx = s.wt - s.wb;
  const dy = s.yt - r - s.yb;
  const l = Math.hypot(dx, dy) || 1;
  return [side * (s.wb + dx * f + (dy / l) * off), s.yb + dy * f - (dx / l) * off, z];
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
    bevel = 0.02,
    ry = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(x, y, z, 0, ry));
  };
  const deckY = (z: number): number => lines.deckY(z);
  const half = (z: number): number => lines.deckHalf(z);
  addHull(b, lines, {
    lod,
    deck: false,
    resolution: [
      { stations: 120, below: 18, above: 8 },
      { stations: 48, below: 8, above: 4 },
      { stations: 22, below: 4, above: 2 },
    ][lod],
    sheerRail: lod < 2 ? { radius: 0.02, slot: 'alu', drop: -0.015 } : undefined,
    smoothAlong: [80, 24, 8][lod],
  });
  // Deck: foredeck to the cockpit, side decks beside the well, aft deck.
  const st = [56, 22, 10][lod]!;
  const across = [9, 5, 3][lod]!;
  const sWell0 = lines.sAt(WELL_FRONT);
  const sWell1 = lines.sAt(WELL_AFT);
  const full = { x0: (z: number) => -half(z), x1: (z: number) => half(z), camber: CAMBER };
  b.addData(SLOTS.deck, deckRegion(lines, { ...full, stations: st, across, sFrom: 0, sTo: sWell0 }));
  b.addData(SLOTS.deck, deckRegion(lines, { ...full, stations: 4, across, sFrom: sWell1, sTo: 1 }));
  for (const side of [-1, 1]) {
    b.addData(
      SLOTS.deck,
      deckRegion(lines, {
        stations: Math.max(4, Math.round(st / 3)),
        across: 3,
        sFrom: sWell0,
        sTo: sWell1,
        camber: CAMBER,
        x0: (z) => (side > 0 ? WELL_HALF : -half(z)),
        x1: (z) => (side > 0 ? half(z) : -WELL_HALF),
      }),
    );
  }
  // Sheer and pin stripes parallel to the deck edge.
  if (lod < 2) {
    for (const side of [-1, 1] as const) {
      for (const [d0, d1] of [
        [0.165, 0.115],
        [0.095, 0.085],
      ] as const) {
        b.addData(
          'stripe',
          hullPatch(lines, {
            zFrom: lines.zBow + 0.3,
            zTo: lines.zStern - 0.005,
            yFrom: 0,
            yTo: 0,
            yFromAt: (z) => deckY(z) - d0,
            yToAt: (z) => deckY(z) - d1,
            side,
            offset: 0.0025,
            nz: lod === 0 ? 90 : 30,
            ny: 1,
          }),
        );
      }
    }
  }

  // Cabin trunk: lofted sides (gelcoat) and a crowned non-skid top, raked smoothly into the foredeck.
  const tz: number[] = [];
  const nT = [26, 12, 6][lod]!;
  for (let i = 0; i <= nT; i++) {
    const t = i / nT;
    tz.push(TRUNK_FRONT + (WELL_FRONT - TRUNK_FRONT) * (t < 0.3 ? (t / 0.3) ** 1.6 * 0.3 : t));
  }
  const inside: V3 = [0, 1.0, -0.5];
  for (const side of [-1, 1]) {
    const rings = tz.map((z) => trunkSide(trunkAt(lines, z)).map(([x, y]): V3 => [side * x, y, z]));
    b.addData(SLOTS.house, loftRings(rings, { closed: false, inside }));
  }
  b.addData(
    SLOTS.deck,
    loftRings(
      tz.map((z) => trunkTop(trunkAt(lines, z), lod === 0 ? 9 : 5).map(([x, y]): V3 => [x, y, z])),
      { closed: false, inside },
    ),
  );
  // Long smoked side windows.
  for (const side of [-1, 1]) {
    const rows: V3[][] = [];
    const n = lod === 0 ? 10 : 3;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      rows.push([
        trunkSidePoint(lines, -1.95 + 2.8 * t, 0.26, side),
        trunkSidePoint(lines, -1.62 + 2.32 * t, 0.82, side),
      ]);
    }
    b.addData('acrylic', loftRings(rows, { closed: false, inside }));
  }
  // Aft face of the trunk down to the cockpit sole, with the companionway.
  const sa = trunkAt(lines, WELL_FRONT);
  const prof = trunkSide(sa);
  const top = trunkTop(sa);
  const outline: [number, number][] = [
    [-WELL_HALF, SOLE_Y],
    [WELL_HALF, SOLE_Y],
    [WELL_HALF, deckTop(lines, WELL_HALF, WELL_FRONT)],
    ...prof,
    ...top.slice(1, -1),
    ...[...prof].reverse().map(([x, y]): [number, number] => [-x, y]),
    [-WELL_HALF, deckTop(lines, WELL_HALF, WELL_FRONT)],
  ];
  const face = shapeFrom(outline);
  const holeY = (TRUNK_Y - 0.08 + 0.84) / 2;
  const hole = new Path(
    roundedRect(0.6, TRUNK_Y - 0.08 - 0.84, 0.05)
      .getPoints(4)
      .map((p) => new Vector2(p.x, p.y + holeY)),
  );
  face.holes.push(hole);
  b.add(SLOTS.house, extrude(face, 0.05, 'z', { curveSegments: 3 }), at(0, 0, WELL_FRONT - 0.025));
  box('void', 0.62, TRUNK_Y - 0.84, 0.7, 0, (TRUNK_Y + 0.84) / 2 - 0.04, WELL_FRONT - 0.4, 0.01);
  box('acrylic', 0.6, 0.3, 0.02, 0, 0.84 + 0.15, WELL_FRONT - 0.03, 0.005);
  // Sliding hatch, sea hood and teak hatch runners.
  const yTop = TRUNK_Y + TRUNK_CROWN;
  box('acrylic', 0.7, 0.03, 0.85, 0, yTop + 0.03, WELL_FRONT - 0.42, 0.012);
  box(SLOTS.house, 0.86, 0.08, 0.42, 0, yTop + 0.03, WELL_FRONT - 1.02, 0.03);
  for (const x of [-0.39, 0.39]) box('teak', 0.04, 0.035, 0.95, x, yTop + 0.015, WELL_FRONT - 0.48, 0.008);

  // Cockpit: well walls, seats with teak tops, teak sole, traveller bridge, coamings.
  const deckAt = deckTop(lines, WELL_HALF, 3);
  const wellLen = WELL_AFT - WELL_FRONT;
  const wellMid = (WELL_FRONT + WELL_AFT) / 2;
  for (const side of [-1, 1]) {
    box(
      'gelcoat',
      0.04,
      deckAt - SOLE_Y + 0.02,
      wellLen,
      side * (WELL_HALF + 0.02),
      (deckAt + SOLE_Y) / 2,
      wellMid,
      0.01,
    );
    // Seat: moulded base with a teak top.
    const sx = side * (WELL_HALF - 0.21);
    box(
      'gelcoat',
      0.42,
      SEAT_Y - SOLE_Y - 0.03,
      SEAT_AFT - WELL_FRONT - 0.05,
      sx,
      (SEAT_Y + SOLE_Y - 0.03) / 2,
      (WELL_FRONT + SEAT_AFT) / 2,
      0.02,
    );
    b.add(
      'teak',
      slab(0.42, SEAT_AFT - WELL_FRONT - 0.07, 0.03, 0.03, 0.01),
      at(sx, SEAT_Y - 0.03, (WELL_FRONT + SEAT_AFT) / 2),
    );
    // Coaming: a raised lip beside the well carrying the primary winches.
    box('gelcoat', 0.13, 0.13, 2.3, side * (WELL_HALF + 0.065), deckAt + 0.04, WELL_FRONT + 1.15, 0.035);
    if (lod === 0)
      box('teak', 0.12, 0.02, 2.2, side * (WELL_HALF + 0.065), deckAt + 0.11, WELL_FRONT + 1.15, 0.006);
  }
  box(
    'gelcoat',
    2 * WELL_HALF + 0.08,
    deckAt - SOLE_Y,
    0.04,
    0,
    (deckAt + SOLE_Y) / 2,
    WELL_AFT + 0.02,
    0.01,
  );
  b.add(
    'teak',
    slab(2 * WELL_HALF - 0.02, wellLen - 0.04, 0.025, 0.02, 0.006),
    at(0, SOLE_Y - 0.025, wellMid),
  );
  box('gelcoat', 2 * WELL_HALF, 0.15, 0.22, 0, SOLE_Y + 0.075, TRAVELLER_Z, 0.04);
  box('alu', 1.95, 0.025, 0.05, 0, SOLE_Y + 0.16, TRAVELLER_Z, 0.008);
  for (const x of [-0.98, 0.98]) box(SLOTS.black, 0.05, 0.04, 0.07, x, SOLE_Y + 0.17, TRAVELLER_Z, 0.01);
  // Wheel pedestal with binnacle compass and guard rail.
  b.add(
    SLOTS.chrome,
    rod(new Vector3(0, SOLE_Y, PEDESTAL_Z), new Vector3(0, 1.2, PEDESTAL_Z + 0.03), 0.055, 12),
  );
  b.add(SLOTS.chrome, cylinder(0.12, 0.02, 14), at(0, SOLE_Y + 0.01, PEDESTAL_Z));
  b.add(
    SLOTS.black,
    lathe(
      [
        [0, 0],
        [0.11, 0],
        [0.12, 0.05],
        [0, 0.05],
      ],
      14,
    ),
    at(0, 1.2, PEDESTAL_Z + 0.03),
  );
  b.add(
    'acrylic',
    lathe(
      [
        [0.1, 0],
        [0.095, 0.04],
        [0.06, 0.08],
        [0, 0.09],
      ],
      14,
    ),
    at(0, 1.25, PEDESTAL_Z + 0.03),
  );
  b.add(
    SLOTS.chrome,
    rod(new Vector3(0, 1.27, PEDESTAL_Z + 0.04), new Vector3(0, WHEEL_Y, WHEEL_Z), 0.02, 8),
  );
  if (lod < 2) {
    rail(
      b,
      [
        new Vector3(-0.2, SOLE_Y, PEDESTAL_Z - 0.2),
        new Vector3(-0.2, 1.18, PEDESTAL_Z - 0.2),
        new Vector3(-0.14, 1.32, PEDESTAL_Z - 0.18),
        new Vector3(0.14, 1.32, PEDESTAL_Z - 0.18),
        new Vector3(0.2, 1.18, PEDESTAL_Z - 0.2),
        new Vector3(0.2, SOLE_Y, PEDESTAL_Z - 0.2),
      ],
      0.013,
      { radial: lod === 0 ? 8 : 5 },
    );
  }

  // Swim step on the transom.
  const zs = lines.zStern;
  b.add('gelcoat', slab(1.3, 0.38, 0.12, 0.08, 0.03), at(0, 0.2, zs + 0.18));
  b.add('teak', slab(1.24, 0.32, 0.015, 0.06, 0.004), at(0, 0.32, zs + 0.19));

  // Keel fin and lead bulb, below the canoe body.
  const kSec = lod === 0 ? 24 : lod === 1 ? 12 : 8;
  b.addData(
    SLOTS.hull,
    foilLoft(
      [
        { y: -0.4, chord: 1.18, le: -0.3 - 0.25 * 1.18, thickness: 0.13 },
        { y: -1.1, chord: 1.0, le: -0.3 - 0.25 * 1.0 + 0.1, thickness: 0.13 },
        { y: -1.75, chord: 0.84, le: -0.3 - 0.25 * 0.84 + 0.2, thickness: 0.13 },
      ],
      kSec,
      { capEnd: false },
    ),
  );
  const bulb = [];
  const nb = lod === 0 ? 18 : 8;
  for (let i = 0; i <= nb; i++) {
    const t = i / nb;
    const r = Math.max(0.004, (Math.sqrt(t) * (1 - t) ** 0.75) / 0.431);
    bulb.push({ z: -1.4 + 2.4 * t, y: -1.81, hw: 0.25 * r, top: 0.17 * r, bottom: 0.19 * r, n: 2.2 });
  }
  b.addData(SLOTS.hull, sculpt(bulb, lod === 0 ? 20 : 10));

  // Mast (keel-stepped through the trunk top), spreaders and fittings.
  const seg = lod === 0 ? 16 : lod === 1 ? 10 : 6;
  const mastBase = 1.3;
  const taper = 12.6;
  const lower = cylinder(1, taper - mastBase, seg).scale(MAST_HW, 1, MAST_HD);
  b.add('spar', lower, at(0, (taper + mastBase) / 2, MAST_CZ));
  const upper = cylinder(1, rig.mastheadY - taper, seg, 0.62).scale(MAST_HW, 1, MAST_HD);
  b.add('spar', upper, at(0, (rig.mastheadY + taper) / 2, MAST_CZ));
  b.add(
    SLOTS.black,
    cylinder(1, 0.08, seg, 1).scale(MAST_HW * 1.6, 1, MAST_HD * 1.4),
    at(0, yTop + 0.03, MAST_CZ),
  );
  box(SLOTS.black, 0.08, 0.07, 0.34, 0, rig.mastheadY + 0.02, MAST_CZ + 0.06, 0.015);
  for (const [i, s] of SPREADERS.entries()) {
    for (const side of [-1, 1]) {
      const c = Math.cos(SWEEP);
      const sn = Math.sin(SWEEP);
      const root = new Vector3(side * MAST_HW, s.y, MAST_CZ);
      const mid = root.clone().add(new Vector3(side * c * s.length * 0.5, 0, sn * s.length * 0.5));
      b.add(
        'spar',
        bevelBox(s.length, 0.028 - i * 0.004, 0.075 - i * 0.01, 0.01),
        at(mid.x, mid.y, mid.z, 0, side > 0 ? -SWEEP : SWEEP),
      );
      if (lod === 0 && i === 0) {
        // Spreader (deck) light under the root.
        b.add(SLOTS.black, bevelBox(0.07, 0.04, 0.1, 0.01), at(side * 0.16, s.y - 0.04, MAST_CZ));
        b.add(SLOTS.flood, bevelBox(0.055, 0.005, 0.08, 0.002), at(side * 0.16, s.y - 0.062, MAST_CZ));
      }
    }
  }
  if (lod === 0) {
    // Masthead: tricolour/anchor light, wind vane and VHF whip.
    navLightHousing(b, at(0, rig.mastheadY + 0.055, MAST_CZ), SLOTS.lampWhite, 0.11);
    b.add(SLOTS.black, cylinder(0.006, 0.9, 5, 0.003), at(0.03, rig.mastheadY + 0.5, MAST_CZ + 0.14));
    b.add(
      SLOTS.black,
      rod(
        new Vector3(0, rig.mastheadY + 0.1, MAST_CZ - 0.02),
        new Vector3(0, rig.mastheadY + 0.45, MAST_CZ - 0.45),
        0.004,
        4,
      ),
    );
    box(SLOTS.red, 0.004, 0.08, 0.16, 0, rig.mastheadY + 0.45, MAST_CZ - 0.5, 0.001);
    // Mast-base turning blocks, halyards led aft to clutches and halyard winches.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const x0 = side * (0.05 + k * 0.025);
        const pts = [
          new Vector3(x0, yTop + 0.02, MAST_CZ + 0.15),
          new Vector3(side * (0.32 + k * 0.03), TRUNK_Y + 0.035, 0.1),
          new Vector3(side * (0.47 + k * 0.03), TRUNK_Y + 0.03, 0.88),
        ];
        b.add('rope', rod(pts[0]!, pts[1]!, 0.005, 4));
        b.add('rope', rod(pts[1]!, pts[2]!, 0.005, 4));
        b.add(SLOTS.black, bevelBox(0.05, 0.05, 0.06, 0.012), at(x0, yTop + 0.02, MAST_CZ + 0.15));
      }
      box(SLOTS.black, 0.17, 0.05, 0.13, side * 0.5, TRUNK_Y + 0.045, 0.93, 0.012);
      sailWinch(b, at(side * 0.56, TRUNK_Y + 0.025, 1.3), 0.06);
    }
  }

  // Standing rigging.
  const wireR = lod === 0 ? 0.0055 : 0.008;
  const wseg = lod === 0 ? 5 : 3;
  const wire = (pts: Vector3[]): void => {
    for (let i = 0; i + 1 < pts.length; i++) b.add('wire', rod(pts[i]!, pts[i + 1]!, wireR, wseg));
  };
  const tack = new Vector3(rig.tack.x, rig.tack.y, rig.tack.z);
  wire([tack.clone().setY(tack.y + 0.1), new Vector3(0, HOUNDS_Y, MAST_CZ - MAST_HD)]);
  const split = new Vector3(0, 3.4, 0);
  const masthead = new Vector3(0, rig.mastheadY - 0.02, MAST_CZ + 0.2);
  const backAnchor = new Vector3(0, deckY(zs), zs - 0.08);
  split.z = masthead.z + ((backAnchor.z - masthead.z) * (masthead.y - split.y)) / (masthead.y - backAnchor.y);
  wire([masthead, split]);
  for (const side of [-1, 1]) wire([split, new Vector3(side * 1.15, deckY(zs) + 0.03, zs - 0.12)]);
  b.add(SLOTS.black, cylinder(0.025, 0.14, 8), at(split.x, split.y + 0.07, split.z, 0.42));
  const chainZ = CHAIN_Z;
  for (const side of [-1, 1]) {
    const chain = new Vector3(side * (half(chainZ) - 0.1), deckY(chainZ) + 0.04, chainZ);
    const tips = SPREADERS.map(
      (s) =>
        new Vector3(side * (MAST_HW + Math.cos(SWEEP) * s.length), s.y, MAST_CZ + Math.sin(SWEEP) * s.length),
    );
    wire([chain, tips[0]!, tips[1]!, new Vector3(side * MAST_HW, HOUNDS_Y - 0.05, MAST_CZ)]);
    if (lod < 2) {
      wire([chain, new Vector3(side * MAST_HW, SPREADERS[0]!.y - 0.12, MAST_CZ)]);
      wire([tips[0]!, new Vector3(side * MAST_HW, SPREADERS[1]!.y - 0.1, MAST_CZ)]);
    }
    box(SLOTS.chrome, 0.03, 0.08, 0.05, chain.x, chain.y - 0.01, chain.z, 0.008);
  }
  // Furler drum at the tack.
  b.add(
    SLOTS.black,
    lathe(
      [
        [0.02, 0],
        [0.075, 0.01],
        [0.075, 0.12],
        [0.02, 0.15],
      ],
      seg,
    ),
    at(tack.x, tack.y - 0.02, tack.z),
  );
  // Stem fitting and bow roller.
  box(SLOTS.chrome, 0.08, 0.06, 0.38, 0, deckY(lines.zBow + 0.2) + 0.02, lines.zBow + 0.22, 0.01);

  if (lod < 2) {
    // Pulpit, pushpits and lifelines.
    const top = (z: number): number => deckY(z) + 0.62;
    const edge = (z: number, inset = 0.07): number => half(z) - inset;
    const pr = lod === 0 ? 8 : 5;
    const pulpit = (y: (z: number) => number): Vector3[] => [
      new Vector3(-edge(-4.55), y(-4.55), -4.55),
      new Vector3(-edge(-5.0) - 0.02, y(-5.0), -5.0),
      new Vector3(-0.3, y(-5.45), -5.45),
      new Vector3(-0.1, y(-5.75), -5.8),
      new Vector3(0.1, y(-5.75), -5.8),
      new Vector3(0.3, y(-5.45), -5.45),
      new Vector3(edge(-5.0) + 0.02, y(-5.0), -5.0),
      new Vector3(edge(-4.55), y(-4.55), -4.55),
    ];
    rail(b, pulpit(top), 0.0125, { radial: pr });
    rail(b, pulpit((z) => deckY(z) + 0.33).slice(0, 3), 0.01, { radial: pr });
    rail(b, pulpit((z) => deckY(z) + 0.33).slice(5), 0.01, { radial: pr });
    for (const side of [-1, 1]) {
      for (const z of [-4.55, -5.0]) {
        const x = side * (edge(z) + (z === -5.0 ? 0.02 : 0));
        b.add(SLOTS.chrome, rod(new Vector3(x, deckY(z), z), new Vector3(x, top(z), z), 0.0125, pr));
      }
      b.add(
        SLOTS.chrome,
        rod(
          new Vector3(side * 0.09, deckY(-5.35), -5.35),
          new Vector3(side * 0.1, top(-5.75), -5.79),
          0.0125,
          pr,
        ),
      );
      const push = [
        new Vector3(side * edge(4.45), top(4.45), 4.45),
        new Vector3(side * edge(5.1), top(5.1), 5.1),
        new Vector3(side * (edge(5.5) - 0.08), top(5.5), 5.5),
        new Vector3(side * 0.55, top(5.55), zs - 0.06),
      ];
      rail(b, push, 0.0125, { radial: pr });
      rail(b, push.map((p) => p.clone().setY(p.y - 0.29)).slice(0, 3), 0.01, { radial: pr });
      for (const p of [push[0]!, push[2]!, push[3]!]) {
        b.add(SLOTS.chrome, rod(new Vector3(p.x, deckY(p.z), p.z), p, 0.0125, pr));
      }
      if (lod === 0) {
        const bases = [-4.55, -3.0, -1.45, 0.15, 1.75, 3.15, 4.45].map(
          (z) => new Vector3(side * edge(z), deckY(z), z),
        );
        lifelines(b, bases, { height: 0.62, wires: [0.33, 0.62] });
      }
    }
    // Sidelights on the pulpit, sternlight on the transom, horseshoe buoy on the pushpit.
    for (const side of [-1, 1]) {
      navLightHousing(
        b,
        at(side * 0.31, deckY(-5.4) + 0.4, -5.4, 0, side * 0.6),
        side > 0 ? SLOTS.lampGreen : SLOTS.lampRed,
        0.1,
      );
    }
    navLightHousing(b, at(0, deckY(zs) + 0.12, zs - 0.06), SLOTS.lampWhite, 0.09);
    b.add(SLOTS.chrome, bevelBox(0.05, 0.12, 0.03, 0.005), at(0, deckY(zs) + 0.06, zs - 0.05));
    if (lod === 0) {
      b.add(
        'buoy',
        new TorusGeometry(0.2, 0.05, 8, 20, Math.PI * 1.6),
        at(1.0, top(5.4) - 0.24, 5.47, 0, 0, Math.PI * 0.7),
      );
    }
  }

  if (lod === 0) {
    // Winches, genoa tracks with lead cars, cleats and hatches.
    for (const side of [-1, 1]) {
      sailWinch(b, at(side * WINCH.x, deckAt + 0.105, WINCH.z), 0.085);
      sailWinch(b, at(side * WINCH.x, deckAt + 0.105, WINCH.z + 0.85), 0.065);
      const tx = side * rig.jibLead.x;
      box('alu', 0.03, 0.016, 1.7, tx, deckTop(lines, rig.jibLead.x, 0.5) + 0.004, 0.5, 0.006);
      box(
        SLOTS.black,
        0.045,
        0.04,
        0.12,
        tx,
        deckTop(lines, rig.jibLead.x, rig.jibLead.z) + 0.03,
        rig.jibLead.z,
        0.01,
      );
      b.add(
        SLOTS.black,
        cylinder(0.035, 0.03, 10).rotateZ(Math.PI / 2),
        at(tx, rig.jibLead.y, rig.jibLead.z),
      );
      hornCleat(b, at(side * 1.25, deckY(5.3) + 0.01, 5.3, 0, Math.PI / 2), 0.22);
      hornCleat(b, at(side * (half(0.4) - 0.17), deckY(0.4) + 0.02, 0.4, 0, Math.PI / 2), 0.2);
    }
    hornCleat(b, at(0, deckY(-4.95) + 0.02, -4.95), 0.2);
    deckHatch(b, at(0, deckY(-4.45) + 0.04, -4.45), 0.42, 0.5, { lens: 'gelcoat' });
    deckHatch(b, at(0, deckY(-3.55) + 0.05, -3.55), 0.55, 0.55);
    deckHatch(b, at(0, yTop - 0.005, -2.05), 0.5, 0.5);
    deckHatch(b, at(0, yTop - 0.005, 0.2), 0.42, 0.42);
    // Grab rails along the trunk top.
    for (const side of [-1, 1]) {
      const x = side * 0.62;
      box('teak', 0.035, 0.03, 2.4, x, TRUNK_Y + 0.075, -0.6, 0.008);
      for (const z of [-1.7, -0.9, -0.1, 0.5]) box('teak', 0.03, 0.05, 0.05, x, TRUNK_Y + 0.045, z, 0.006);
    }
  }
  return b;
}

// Boom on its gooseneck (pivot at the mast, rig.boomY): the main's foot runs along its top (y = 0).
function boomGroup(lod: number, materials: Record<string, Material>): Object3D {
  const b = new PartBuilder();
  const L = rig.boomLength;
  b.add('spar', bevelBox(0.1, 0.17, L - 0.06, lod === 0 ? 0.03 : 0.02), at(0, -0.085, L / 2 + 0.02));
  b.add(SLOTS.black, bevelBox(0.11, 0.18, 0.08, 0.02), at(0, -0.085, L + 0.02));
  b.add(SLOTS.black, bevelBox(0.07, 0.07, 0.12, 0.015), at(0, -0.08, 0.04));
  if (lod < 2) {
    b.add(SLOTS.black, cylinder(0.04, 0.05, 10).rotateZ(Math.PI / 2), at(...BOOM_BLOCK));
    b.add(SLOTS.chrome, bevelBox(0.02, 0.06, 0.03, 0.005), at(0, -0.19, BOOM_BLOCK[2]));
    // Rigid vang from the mast foot.
    const foot = new Vector3(0, 1.52 - rig.boomY, 0.03);
    const head = new Vector3(0, -0.17, 1.05);
    const mid = foot.clone().lerp(head, 0.55);
    b.add('spar', rod(foot, mid, 0.028, 8));
    b.add(SLOTS.chrome, rod(mid, head, 0.016, 8));
  }
  if (lod === 0) {
    // Outhaul car and reef lines along the boom.
    b.add(SLOTS.black, bevelBox(0.06, 0.03, 0.12, 0.01), at(0, 0.01, L - 0.3));
    for (const x of [-0.052, 0.052])
      b.add('rope', rod(new Vector3(x, -0.06, 0.4), new Vector3(x, -0.06, L - 0.3), 0.004, 4));
  }
  const g = new Group();
  g.name = 'boom';
  g.position.set(0, rig.boomY, rig.mastZ);
  g.add(b.build(materials, { shadows: lod < 2 }).group);
  return g;
}

function rudderGroup(lod: number, materials: Record<string, Material>): Object3D {
  const b = new PartBuilder();
  b.addData(
    SLOTS.hull,
    foilLoft(
      [
        { y: -0.1, chord: 0.5, le: -0.13, thickness: 0.12 },
        { y: -0.8, chord: 0.44, le: -0.08, thickness: 0.12 },
        { y: -1.45, chord: 0.3, le: 0.01, thickness: 0.12 },
        { y: -1.55, chord: 0.2, le: 0.06, thickness: 0.1 },
      ],
      lod === 0 ? 20 : 10,
    ),
  );
  const g = new Group();
  g.name = 'rudder';
  g.position.set(0, 0, RUDDER_Z);
  g.add(b.build(materials, { shadows: lod < 2 }).group);
  return g;
}

function wheelGroup(lod: number, materials: Record<string, Material>): Object3D {
  const wheel = new Mesh(
    steeringWheelGeometry(WHEEL_R, { spokes: 6, rim: 0.016, dish: 0.05, segments: lod === 0 ? 48 : 20 }),
    materials[SLOTS.chrome],
  );
  wheel.castShadow = true;
  wheel.receiveShadow = true;
  // Leather-wrapped grip on the rim.
  const grip = new Mesh(new TorusGeometry(WHEEL_R, 0.02, 6, lod === 0 ? 48 : 16), materials.leather);
  grip.position.z = 0.05;
  grip.castShadow = true;
  const g = new Group();
  g.name = 'wheel';
  g.position.set(0, WHEEL_Y, WHEEL_Z);
  g.add(wheel, grip);
  return g;
}

function decals(lines: HullLines, ao: AoVolume | null): Mesh[] {
  const name = BOAT_CARDS.sail.name.toUpperCase();
  const tex = textDecalTexture({
    lines: [name, 'HALIFAX'],
    width: 1024,
    height: 320,
    color: '#14295a',
    lineHeights: [0.55, 0.24],
    font: 'Georgia, "Times New Roman", serif',
    weight: 'italic 700',
  });
  const transom = flatDecal(tex, 1.5, 0.47, ao);
  transom.position.set(0, 0.62, lines.zStern + 0.004);
  return [transom];
}

// Mainsheet (boom block → traveller car) and the working genoa sheet (clew → lead → winch).
function sheetAnimator(lods: readonly Object3D[]): Animator {
  const lod0 = lods[0]!;
  const boom = lod0.getObjectByName('boom');
  const car = lod0.getObjectByName('traveller-car');
  const main = [0, 1].map((i) => lod0.getObjectByName(`sheet:main:${i}`));
  const jib = [0, 1].map((i) => lod0.getObjectByName(`sheet:jib:${i}`));
  const block = new Vector3();
  const a = new Vector3();
  const c = new Vector3();
  const lead = new Vector3();
  const winch = new Vector3();
  return (_dt: number, t: Telemetry, lod: number): void => {
    if (lod !== 0 || !boom || !car) return;
    const beta = boom.rotation.y;
    block.set(
      Math.sin(beta) * BOOM_BLOCK[2],
      rig.boomY + BOOM_BLOCK[1],
      rig.mastZ + Math.cos(beta) * BOOM_BLOCK[2],
    );
    car.position.x = clamp(block.x, -0.9, 0.9);
    main.forEach((m, i) => {
      if (!m) return;
      const dx = (i - 0.5) * 0.035;
      stretch(
        m,
        a.set(block.x + dx, block.y - 0.03, block.z),
        c.set(car.position.x + dx, TRAVELLER_Y + 0.05, TRAVELLER_Z),
      );
    });
    const clewX = t['sail.jibClewX'];
    const visible = clewX !== undefined && (t['sail.jibFurl'] ?? 0) < 0.97;
    for (const j of jib) if (j) j.visible = visible;
    if (!visible || !jib[0] || !jib[1]) return;
    const side = (t['sail.jibAngle'] ?? clewX) >= 0 ? 1 : -1;
    c.set(clewX, t['sail.jibClewY'] ?? rig.tack.y + rig.genoaClewHeight, t['sail.jibClewZ'] ?? rig.mastZ);
    lead.set(side * rig.jibLead.x, rig.jibLead.y, rig.jibLead.z);
    winch.set(side * WINCH.x, 1.12, WINCH.z);
    stretch(jib[0], c, lead);
    stretch(jib[1], lead, winch);
  };
}

const detail = (part: string) => boatDetail('sail', part);

export function sailDraft(): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const builders = [0, 1, 2].map((lod) => structure(lines, lod));
  const zs = lines.zStern;
  const lights: LightMountSpec[] = [
    { kind: 'tricolour', position: [0, rig.mastheadY + 0.09, MAST_CZ] },
    { kind: 'allRoundWhite', position: [0, rig.mastheadY + 0.15, MAST_CZ] }, // anchor light
    { kind: 'sidePort', position: [-0.31, lines.deckY(-5.4) + 0.46, -5.4], direction: [-0.83, 0, -0.56] },
    { kind: 'sideStarboard', position: [0.31, lines.deckY(-5.4) + 0.46, -5.4], direction: [0.83, 0, -0.56] },
    { kind: 'stern', position: [0, lines.deckY(zs) + 0.17, zs - 0.06], direction: [0, 0, 1] },
    { kind: 'spreader', position: [-0.16, SPREADERS[0]!.y - 0.07, MAST_CZ], direction: [0, -1, -0.15] },
    { kind: 'spreader', position: [0.16, SPREADERS[0]!.y - 0.07, MAST_CZ], direction: [0, -1, -0.15] },
  ];
  const floods: FloodSpec[] = [-1, 1].map((side) => ({
    position: [side * 0.16, SPREADERS[0]!.y - 0.08, MAST_CZ],
    target: [side * 0.8, 1, -1.8],
    intensity: 1800,
    angle: 0.85,
    distance: 14,
  }));
  const drives: TelemetryDrive[] = [
    { name: 'rudder', axis: 'y', key: 'rudderAngle' },
    // About 1.4 turns lock to lock; turning the wheel clockwise (seen from aft) gives starboard rudder.
    { name: 'wheel', axis: 'z', key: 'rudderAngle', scale: -4 },
    // Instant: the cloth sails read the same telemetry unsmoothed.
    { name: 'boom', axis: 'y', key: 'sail.boomAngle', rate: 0 },
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  const well = new BoxGeometry(2 * WELL_HALF, 1.0, WELL_AFT - WELL_FRONT);
  well.translate(0, lines.deckY(3) - 0.5, (WELL_FRONT + WELL_AFT) / 2);
  const mask = merge([triMeshGeometry(physics.mesh), well]);
  const travellerCar = (materials: Record<string, Material>): Object3D => {
    const b = new PartBuilder();
    b.add(SLOTS.black, bevelBox(0.13, 0.035, 0.07, 0.01), at(0, 0.017, 0));
    b.add(SLOTS.black, cylinder(0.035, 0.045, 10).rotateZ(Math.PI / 2), at(0, 0.06, 0));
    const g = new Group();
    g.name = 'traveller-car';
    g.position.set(0, SOLE_Y + 0.17, TRAVELLER_Z);
    g.add(b.build(materials).group);
    return g;
  };
  return {
    kind: 'sail',
    name: BOAT_CARDS.sail.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        topside: 0xf3f2ed,
        topsideRoughness: 0.2,
        clearcoat: 1,
        bands: [{ below: 0.04, color: 0x1a2340, roughness: 0.75 }],
        stripes: [{ y0: 0.06, y1: 0.12, color: 0x14295a }],
        stain: 0.12,
        grime: 0.05,
      },
      deck: 0xe6e4dc,
      house: 0xf1f0eb,
      trim: 0x14295a,
      machinery: 0x9aa0a6,
      grime: 0.05,
      rust: 0,
    },
    extraMaterials: (ao) => ({
      [SLOTS.deck]: nonSkidMaterial({ color: 0xe4e2da, ao }),
      [SLOTS.house]: simpleMaterial({
        color: 0xf1f0eb,
        roughness: 0.25,
        ao,
        clearcoat: 0.8,
        name: 'gelcoat',
        detail: detail('house'),
      }),
      gelcoat: simpleMaterial({
        color: 0xf0efea,
        roughness: 0.28,
        ao,
        clearcoat: 0.6,
        name: 'gelcoat',
        detail: detail('gelcoat'),
      }),
      stripe: simpleMaterial({ color: 0x14295a, roughness: 0.22, ao, clearcoat: 1, name: 'stripe' }),
      teak: teakMaterial({ ao, detail: detail('teak') }),
      spar: simpleMaterial({ color: 0xc8cbcf, roughness: 0.3, metalness: 0.9, brushed: true, name: 'spar' }),
      wire: simpleMaterial({ color: 0xd2d5d8, roughness: 0.25, metalness: 1, name: 'wire' }),
      [SLOTS.chrome]: simpleMaterial({
        color: 0xdcdfe2,
        roughness: 0.14,
        metalness: 1,
        ao,
        name: 'stainless',
      }),
      alu: simpleMaterial({
        color: 0xb4b8bc,
        roughness: 0.35,
        metalness: 0.9,
        ao,
        brushed: true,
        name: 'alu',
      }),
      // Smoked acrylic (windows, hatches, compass dome) glowing with the cabin lights behind it.
      acrylic: cabinGlow(0x0a0e11, 10, 0.04, 'acrylic'),
      rope: simpleMaterial({ color: 0xe9e3d2, roughness: 0.8, ao, name: 'rope', detail: detail('rope') }),
      leather: simpleMaterial({ color: 0x1d1b19, roughness: 0.6, ao, name: 'leather' }),
      buoy: simpleMaterial({ color: 0xf2c418, roughness: 0.5, ao, name: 'buoy' }),
      void: cabinGlow(0x030303, 15, 1, 'void'), // the open companionway: the saloon beyond
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: builders[lod]!,
      shadows: lod < 2,
      extras: (materials, ao) => [
        boomGroup(lod, materials),
        rudderGroup(lod, materials),
        ...(lod < 2 ? [wheelGroup(lod, materials), travellerCar(materials)] : []),
        ...(lod < 2 ? decals(lines, ao) : []),
        ...(lod === 0
          ? [
              linkMesh(0.005, materials.rope!, 'sheet:main:0'),
              linkMesh(0.005, materials.rope!, 'sheet:main:1'),
              linkMesh(0.006, materials.rope!, 'sheet:jib:0'),
              linkMesh(0.006, materials.rope!, 'sheet:jib:1'),
            ]
          : []),
      ],
    })),
    aoVoxel: 0.06,
    aoLod: 1,
    aoDistance: 0.9,
    aoExclude: ['spar', 'wire', 'rope'],
    lights,
    floods,
    animated: [],
    drives,
    animator: sheetAnimator,
    // Standing behind the wheel, a little to starboard of the pedestal (see BOAT_CAMERA_INFO.sail).
    eye: new Vector3(0.45, 2.15, 5.0),
    waterMask: mask,
    lodThresholds: { pixels: [240, 70] },
  };
}
