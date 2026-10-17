// 33 ft center console "Tidewater 33" (LOA 10.1 m, B 3.2 m, deep-V 22°) on
// the physics planing hull: navy clear-coated topsides with side graphics over
// a white bottom with lifting strakes and chine flats, black rub rail with a
// stainless insert, a raised casting deck and bow seating, the console with a
// wrap-around windshield, lit multifunction displays, tilt wheel and twin
// throttles, a T-top hardtop (radar dome, antennas, outriggers, rocket-launcher
// rod holders, all-round light), leaning post, transom bench, flush rod holders,
// bow rail and twin 300 hp V8 outboards on the transom that steer and trim.
//
// Animated (drives): 'outboard:i:steer' (steering), 'outboard:i:trim'
// (eng{i}Trim, 0..1 → −6..14°), 'outboard:i:prop' (eng{i}Rpm, eng{i}Throttle),
// 'helm' wheel (steering) and 'throttle:i' levers (eng{i}Throttle).

import {
  CanvasTexture,
  Group,
  type Material,
  Mesh,
  type Object3D,
  SRGBColorSpace,
  Vector3,
} from 'three/webgpu';

import { powerboatSpec } from '../../../sim/boats/specs/powerboat';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { boatDetail } from '../detail/detail';
import type { TelemetryDrive } from '../kit/animate';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { LightMountSpec } from '../kit/BoatVisual';
import {
  at,
  atlasPlane,
  bevelBox,
  cylinder,
  extrude,
  normalizeGeometry,
  PartBuilder,
  rod,
  shapeFrom,
} from '../kit/geometry';
import { decalMaterial, hullDecal } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import { textDecalTexture } from '../kit/liveries';
import { deckRegion, hullShell, stationParameters, transomCap } from '../kit/loft';
import {
  type AoVolume,
  fabricMaterial,
  hullPaintMaterial,
  lampMaterial,
  nonSkidMaterial,
  simpleMaterial,
} from '../kit/materials';
import { planBlock } from '../kit/plan';
import { domeAntenna, merge, navLightHousing, SLOTS, whipAntenna } from '../kit/props';
import { bottomStrakes, foilLoft, loftRings, sculpt, type SuperSection, type V3 } from '../kit/sculpt';
import { capsule, hornCleat, rail, rodHolder, slab, steeringWheelGeometry } from '../kit/smallcraft';
import { context2d, createCanvas, drawFittedText, trackTexture } from '../kit/textures';

const spec = powerboatSpec;
const DEG = Math.PI / 180;

export const GUNWALE = 0.17; // covering board width
export const SOLE_Y = 0.3;
export const BOW_SOLE_Y = 0.55;
export const CASTING_AFT = -3.3; // raised casting deck from the bow to here
export const STEP_Z = -1.55; // bow well → main cockpit
export const TRANSOM_IN = 4.55; // inner face of the transom bulkhead
const CAMBER = 0.03; // casting deck crown
const CAMBER_HALF = 0.3; // the crown fades out toward the stem where the deck is narrower than this
const CONSOLE = { front: -1.2, aft: -0.3, half: 0.65 };
const TTOP = { front: -1.6, aft: 0.75, half: 1.0, y: 2.38 };
const POST = { front: 0.55, aft: 1.25, half: 0.55 };
const ENGINE_X = 0.45;
const TILT = { y: 0.72, z: 5.13 }; // tilt pin (trim axis)
const STEER_DZ = 0.1; // steering axis aft of the tilt pin
const TRIM_MIN = -6 * DEG; // driveConfig outboards
const TRIM_MAX = 14 * DEG;

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
    rx = 0,
    ry = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(x, y, z, rx, ry));
  };
  const deckY = (z: number): number => lines.deckY(z);
  const half = (z: number): number => lines.deckHalf(z);
  const xin = (z: number): number => Math.max(0.12, half(z) - GUNWALE);
  const res = [
    { stations: 110, below: 12, above: 8 },
    { stations: 44, below: 5, above: 4 },
    { stations: 20, below: 3, above: 2 },
  ][lod]!;
  b.addData('bottom', hullShell(lines, { ...res, girth: 'bottom' }));
  b.addData(SLOTS.hull, hullShell(lines, { ...res, girth: 'topsides' }));
  b.addData(SLOTS.hull, transomCap(lines, res.below, res.above));
  if (lod < 2) {
    b.addData(
      'bottom',
      bottomStrakes(lines, [0.36, 0.7], {
        stations: lod === 0 ? 60 : 20,
        sFrom: 0.1,
        sTo: 0.995,
        width: 0.055,
      }),
    );
    b.addData(
      'bottom',
      bottomStrakes(lines, [1], {
        stations: lod === 0 ? 70 : 24,
        sFrom: 0.06,
        sTo: 0.995,
        width: 0.07,
        taper: 0.1,
      }),
    );
  }
  // Rub rail: black rubber with a stainless insert, just under the sheer.
  const rubPts = (offset: number, side: number, n: number): Vector3[] => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const z = lines.zBow + 0.03 + ((lines.zStern - lines.zBow - 0.04) * i) / n;
      pts.push(new Vector3(side * (half(z) + offset), deckY(z) - 0.03, z));
    }
    return pts;
  };
  for (const side of [-1, 1]) {
    const n = [60, 24, 10][lod]!;
    rail(b, rubPts(0.012, side, n), 0.035, { slot: SLOTS.black, radial: lod === 0 ? 8 : 5, caps: true });
    if (lod === 0) rail(b, rubPts(0.044, side, n), 0.009, { radial: 5, caps: true });
  }

  // Decks: casting deck forward, covering boards along the cockpit, aft deck over the transom.
  const sCast = lines.sAt(CASTING_AFT);
  const sIn = lines.sAt(TRANSOM_IN);
  // Deck stations on the hull shell's (plus each region's ends), so the deck edges lie on its top edge.
  const shellSs = stationParameters(res.stations);
  const between = (s0: number, s1: number): number[] => [
    s0,
    ...shellSs.filter((s) => s > s0 + 1e-6 && s < s1 - 1e-6),
    s1,
  ];
  const boardSs = between(sCast, sIn);
  b.addData(
    SLOTS.deck,
    deckRegion(lines, {
      stations: between(0, sCast),
      across: 5,
      sFrom: 0,
      sTo: sCast,
      x0: (z) => -half(z),
      x1: (z) => half(z),
      camber: CAMBER,
      camberHalf: CAMBER_HALF,
    }),
  );
  b.addData(
    'gelcoat',
    deckRegion(lines, {
      stations: between(sIn, 1),
      across: 5,
      sFrom: sIn,
      sTo: 1,
      x0: (z) => -half(z),
      x1: (z) => half(z),
    }),
  );
  for (const side of [-1, 1]) {
    b.addData(
      'gelcoat',
      deckRegion(lines, {
        stations: boardSs,
        across: 2,
        sFrom: sCast,
        sTo: sIn,
        x0: (z) => (side > 0 ? xin(z) : -half(z)),
        x1: (z) => (side > 0 ? half(z) : -xin(z)),
      }),
    );
  }
  // Cockpit liner (inboard faces of the gunwales) and soles, bow well and main cockpit. The liner
  // rises to the covering boards' inner edge, through their stations (a polyline), so the two meet
  // without a slot into the hull.
  const boardZs = boardSs.map((s) => lines.zAt(s));
  const coaming = (z: number): [number, number] => {
    let k = 0;
    while (k + 2 < boardZs.length && boardZs[k + 1]! < z) k++;
    const za = boardZs[k]!;
    const zb = boardZs[k + 1]!;
    const t = Math.min(1, Math.max(0, (z - za) / (zb - za)));
    return [xin(za) + (xin(zb) - xin(za)) * t, deckY(za) + (deckY(zb) - deckY(za)) * t];
  };
  const wells = [
    { z0: CASTING_AFT, z1: STEP_Z, sole: BOW_SOLE_Y },
    { z0: STEP_Z, z1: TRANSOM_IN, sole: SOLE_Y },
  ];
  for (const w of wells) {
    const zs = [w.z0, ...boardZs.filter((z) => z > w.z0 + 1e-6 && z < w.z1 - 1e-6), w.z1];
    const edge = zs.map((z) => coaming(z));
    for (const side of [-1, 1]) {
      b.addData(
        'gelcoat',
        loftRings(
          zs.map((z, i): V3[] => [
            [side * edge[i]![0], w.sole, z],
            [side * edge[i]![0], edge[i]![1], z],
          ]),
          { closed: false, inside: [side * 6, 0.6, 0] },
        ),
      );
    }
    b.addData(
      SLOTS.deck,
      loftRings(
        zs.map((z, i): V3[] => [
          [-edge[i]![0], w.sole, z],
          [edge[i]![0], w.sole, z],
        ]),
        { closed: false, inside: [0, -6, 0] },
      ),
    );
  }
  // Bulkhead faces (casting deck front, bow-well step, transom bulkhead): square-edged, so they close
  // up against the soles and decks they meet, and a little wider than the well, so their ends tuck
  // behind the liner where the hull widens (or narrows) across their thickness.
  const face = (z: number, y0: number, top: [number, number][], facing: 1 | -1): void => {
    const hw = xin(z) + 0.03;
    // `top`: the starboard half of the top edge, outboard → in (mirrored to port; a centre point once).
    const port = top.filter(([x]) => x > 0).map(([x, y]): [number, number] => [-x, y]);
    const section = shapeFrom([[-hw, y0], [hw, y0], ...top, ...port.reverse()]);
    b.add('gelcoat', extrude(section, 0.04, 'z'), at(0, 0, z + facing * 0.02));
  };
  // The casting deck's front rises to its crown (the deck's straight segments across the beam at that
  // station; see deckRegion), and out over the covering boards to the sheer, where the crowned deck
  // edge stands above them.
  const zc = CASTING_AFT;
  const crown = (x: number): number => {
    const u = Math.abs(x) / half(zc);
    const camber = CAMBER * Math.min(1, half(zc) / CAMBER_HALF);
    return deckY(zc) + camber * (u <= 0.5 ? 1 - 0.5 * u : 1.5 * (1 - u));
  };
  const hwc = xin(zc) + 0.03;
  face(
    zc,
    BOW_SOLE_Y,
    [
      [hwc, deckY(zc)],
      [half(zc), deckY(zc)],
      [half(zc) / 2, crown(half(zc) / 2)],
      [0, crown(0)],
    ],
    1,
  );
  face(STEP_Z, SOLE_Y, [[xin(STEP_Z) + 0.03, BOW_SOLE_Y]], 1);
  face(TRANSOM_IN, SOLE_Y, [[xin(TRANSOM_IN) + 0.03, deckY(TRANSOM_IN)]], -1);
  // Coaming bolsters (padded) under the covering boards.
  if (lod < 2) {
    for (const side of [-1, 1]) {
      const pts: Vector3[] = [];
      for (let z = STEP_Z + 0.2; z <= TRANSOM_IN - 0.15; z += 0.5)
        pts.push(new Vector3(side * (xin(z) - 0.035), deckY(z) - 0.13, z));
      rail(b, pts, 0.05, { slot: 'cushion', radial: lod === 0 ? 10 : 6, caps: true });
    }
  }

  // Bow seating (side seats and a forward seat against the casting deck) with cushions.
  const seatTop = BOW_SOLE_Y + 0.36;
  for (const side of [-1, 1]) {
    const z0 = CASTING_AFT + 0.05;
    const z1 = STEP_Z - 0.15;
    const n = lod === 0 ? 8 : 3;
    const zs = Array.from({ length: n + 1 }, (_, i) => z0 + ((z1 - z0) * i) / n);
    const seatW = 0.36;
    b.addData(
      'gelcoat',
      loftRings(
        zs.map((z): V3[] => [
          [side * (xin(z) - seatW), BOW_SOLE_Y, z],
          [side * (xin(z) - seatW), seatTop - 0.06, z],
        ]),
        { closed: false, inside: [side * 6, 0.6, 0] },
      ),
    );
    b.addData(
      'cushion',
      loftRings(
        zs.map((z): V3[] => {
          const xi = xin(z);
          return [
            [side * (xi - seatW - 0.01), seatTop - 0.07, z],
            [side * (xi - seatW - 0.01), seatTop - 0.01, z],
            [side * (xi - seatW + 0.03), seatTop, z],
            [side * (xi - 0.01), seatTop, z],
          ];
        }),
        { closed: false, inside: [side * 0.5, -6, 0] },
      ),
    );
  }
  // Close the side seats' aft ends (their fronts tuck into the forward seat): the riser-to-liner
  // panel under the cushion, and the cushion's end.
  for (const side of [-1, 1]) {
    const z = STEP_Z - 0.15;
    const xi = xin(z);
    const xr = xi - 0.36;
    const end = (pts: [number, number][], slot: string): void => {
      const shape = shapeFrom(side > 0 ? pts : pts.map(([x, y]): [number, number] => [-x, y]).reverse());
      b.add(slot, extrude(shape, 0.004, 'z'), at(0, 0, z - 0.002));
    };
    end(
      [
        [xr, BOW_SOLE_Y],
        [xi, BOW_SOLE_Y],
        [xi, seatTop - 0.07],
        [xr, seatTop - 0.07],
      ],
      'gelcoat',
    );
    end(
      [
        [xr - 0.01, seatTop - 0.07],
        [xi, seatTop - 0.07],
        [xi, seatTop],
        [xr + 0.03, seatTop],
        [xr - 0.01, seatTop - 0.01],
      ],
      'cushion',
    );
  }
  b.add(
    'cushion',
    slab(xin(CASTING_AFT) * 2 - 0.05, 0.34, 0.08, 0.05, 0.03),
    at(0, seatTop - 0.07, CASTING_AFT + 0.2),
  );
  b.add(
    'gelcoat',
    bevelBox(xin(CASTING_AFT) * 2 - 0.05, seatTop - 0.07 - BOW_SOLE_Y, 0.34, 0.02),
    at(0, (seatTop - 0.07 + BOW_SOLE_Y) / 2, CASTING_AFT + 0.2),
  );

  // Console: side-profile prism with a raked top, dash and helm ledge.
  const C = CONSOLE;
  const profile = shapeFrom([
    [C.front, SOLE_Y],
    [C.front, 1.3],
    [C.front + 0.08, 1.4],
    [-0.74, 1.4],
    [-0.52, 1.08],
    [C.aft, 1.08],
    [C.aft, SOLE_Y],
  ]);
  b.add('gelcoat', extrude(profile, C.half * 2, 'x', { bevel: 0.04, bevelSegments: 2 }));
  // Console front seat (cooler) and backrest.
  b.add('gelcoat', bevelBox(1.1, 0.38, 0.32, 0.03), at(0, SOLE_Y + 0.19, C.front - 0.17));
  b.add('cushion', slab(1.1, 0.34, 0.09, 0.06, 0.035), at(0, SOLE_Y + 0.38, C.front - 0.17));
  b.add('cushion', bevelBox(1.0, 0.36, 0.08, 0.035), at(0, 1.03, C.front - 0.04));
  // Dash: two lit multifunction displays in black bezels, switch panel, compass.
  const dashTilt = -Math.atan2(0.22, 0.32);
  const dashC = { y: (1.4 + 1.08) / 2, z: (-0.74 + -0.52) / 2 };
  for (const [i, x] of [-0.22, 0.22].entries()) {
    b.add(SLOTS.black, bevelBox(0.44, 0.29, 0.03, 0.01), at(x, dashC.y, dashC.z + 0.012, dashTilt));
    b.add(
      'mfd',
      atlasPlane(0.4, 0.25, i === 0 ? [0, 0] : [0.5, 0], i === 0 ? [0.5, 1] : [1, 1]),
      at(x, dashC.y, dashC.z + 0.029, dashTilt),
    );
  }
  b.add(SLOTS.black, bevelBox(0.5, 0.012, 0.18, 0.004), at(-0.25, 1.086, -0.41));
  b.add(SLOTS.black, cylinder(0.08, 0.05, 14), at(0, 1.425, -0.92));
  b.add('acrylic', cylinder(0.065, 0.06, 14, 0.035), at(0, 1.47, -0.92));
  // Tilt helm wheel pivot (animated mesh added as an extra), throttle box.
  b.add(SLOTS.black, rod(new Vector3(0, 0.88, C.aft), new Vector3(0, 0.98, C.aft + 0.12), 0.035, 10, true));
  b.add(SLOTS.black, bevelBox(0.18, 0.1, 0.2, 0.02), at(0.42, 1.13, -0.42));
  // Windshield: tinted acrylic wrapped round the console top, stainless top rail.
  const wsBottom: V3[] = [
    [-0.63, 1.4, -0.66],
    [-0.64, 1.4, -0.96],
    [-0.55, 1.4, -1.11],
    [-0.3, 1.4, -1.15],
    [0, 1.4, -1.16],
  ];
  const wsTop: V3[] = [
    [-0.6, 1.86, -0.66],
    [-0.6, 1.86, -0.86],
    [-0.5, 1.86, -0.95],
    [-0.27, 1.86, -0.98],
    [0, 1.86, -0.99],
  ];
  const mirror = (pts: V3[]): V3[] => [
    ...pts,
    ...[...pts]
      .reverse()
      .slice(1)
      .map(([x, y, z]): V3 => [-x, y, z]),
  ];
  const ws0 = mirror(wsBottom);
  const ws1 = mirror(wsTop);
  const wsRows = lod === 0 ? 4 : 1;
  b.addData(
    SLOTS.glass,
    loftRings(
      Array.from({ length: wsRows + 1 }, (_, r) =>
        ws0.map((p, k): V3 => {
          const t = r / wsRows;
          const q = ws1[k]!;
          // Slight outward bow in the middle of the panel height.
          const bow = Math.sin(t * Math.PI) * 0.02;
          return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t - bow];
        }),
      ),
      { closed: false, inside: [0, 1.5, -0.5] },
    ),
  );
  rail(
    b,
    ws1.map(([x, y, z]) => new Vector3(x * 1.01, y + 0.012, z - 0.004)),
    0.014,
    { radial: lod === 0 ? 8 : 5, caps: true },
  );
  for (const side of [-1, 1]) {
    // Side grab rails and the console door.
    rail(
      b,
      [
        new Vector3(side * (C.half + 0.06), 1.15, C.front + 0.12),
        new Vector3(side * (C.half + 0.06), 1.17, -0.48),
      ],
      0.014,
      { radial: lod === 0 ? 8 : 5, caps: true },
    );
    for (const z of [C.front + 0.12, -0.48]) {
      b.add(
        SLOTS.chrome,
        rod(
          new Vector3(side * C.half, 1.15, z),
          new Vector3(side * (C.half + 0.06), 1.16, z),
          0.012,
          6,
          true,
        ),
      );
    }
    if (side < 0 && lod === 0) {
      box('gelcoat', 0.02, 0.62, 0.44, -C.half - 0.006, SOLE_Y + 0.45, -0.72, 0.01);
      box(SLOTS.chrome, 0.02, 0.03, 0.1, -C.half - 0.02, SOLE_Y + 0.55, -0.58, 0.005);
    }
  }

  // Leaning post: tackle centre with drawers, flip-up bolsters, backrest and rod holders.
  const P = POST;
  const postMid = (P.front + P.aft) / 2;
  box('gelcoat', P.half * 2, 0.62, P.aft - P.front, 0, SOLE_Y + 0.31, postMid, 0.03);
  if (lod === 0) {
    for (let k = 0; k < 3; k++)
      box(SLOTS.black, P.half * 1.6, 0.008, 0.01, 0, SOLE_Y + 0.25 + k * 0.12, P.front - 0.002, 0.002);
  }
  for (const x of [-0.27, 0.27]) {
    b.add('cushion', bevelBox(0.5, 0.11, 0.3, 0.04), at(x, SOLE_Y + 0.88, P.front + 0.12, -0.2));
    b.add('cushion', bevelBox(0.5, 0.3, 0.08, 0.035), at(x, SOLE_Y + 1.1, P.front + 0.34, 0.1));
  }
  box('gelcoat', P.half * 2, 0.06, P.aft - P.front - 0.1, 0, SOLE_Y + 0.65, postMid + 0.05, 0.02);
  rail(
    b,
    [
      new Vector3(-P.half, SOLE_Y + 0.66, P.front + 0.3),
      new Vector3(-P.half, SOLE_Y + 1.3, P.front + 0.42),
      new Vector3(P.half, SOLE_Y + 1.3, P.front + 0.42),
      new Vector3(P.half, SOLE_Y + 0.66, P.front + 0.3),
    ],
    0.014,
    { radial: lod === 0 ? 8 : 5, sharp: true, caps: true },
  );
  if (lod === 0) {
    for (let k = 0; k < 4; k++) {
      const x = -0.39 + k * 0.26;
      b.add(SLOTS.chrome, cylinder(0.03, 0.32, 8), at(x, SOLE_Y + 0.85, P.aft + 0.03, 0.12));
    }
  }

  // T-top: hardtop on four legs, rod holders, electronics box, lights and antennas.
  const T = TTOP;
  const ttMid = (T.front + T.aft) / 2;
  b.add('gelcoat', slab(T.half * 2, T.aft - T.front, 0.09, 0.25, 0.04), at(0, T.y, ttMid));
  const legR = 0.025;
  const legs: [Vector3, Vector3][] = [];
  for (const side of [-1, 1]) {
    legs.push([
      new Vector3(side * 0.6, SOLE_Y, C.front + 0.15),
      new Vector3(side * 0.86, T.y, T.front + 0.42),
    ]);
    legs.push([new Vector3(side * 0.6, SOLE_Y, P.front - 0.06), new Vector3(side * 0.86, T.y, T.aft - 0.35)]);
  }
  for (const [a, c] of legs) {
    const mid = a.clone().lerp(c, 0.55);
    mid.x += Math.sign(a.x) * 0.05;
    rail(b, [a, mid, c], legR, { slot: 'frame', radial: lod === 0 ? 10 : 6 });
  }
  for (const side of [-1, 1]) {
    rail(
      b,
      [
        new Vector3(side * 0.86, T.y - 0.02, T.front + 0.42),
        new Vector3(side * 0.86, T.y - 0.02, T.aft - 0.35),
      ],
      legR,
      {
        slot: 'frame',
        radial: lod === 0 ? 10 : 6,
        caps: true,
      },
    );
  }
  if (lod < 2) {
    box('canvas', 0.85, 0.2, 0.26, 0, T.y - 0.11, T.front + 0.36, 0.04);
    for (let k = 0; k < 5; k++) {
      const x = -0.6 + k * 0.3;
      b.add('frame', cylinder(0.032, 0.36, 8), at(x, T.y + 0.12, T.aft - 0.08, 0.6));
    }
    domeAntenna(b, at(0, T.y + 0.09, T.front + 0.7), 0.26);
    b.add('frame', cylinder(0.022, 0.62, 8), at(0, T.y + 0.4, T.aft - 0.25));
    navLightHousing(b, at(0, T.y + 0.71, T.aft - 0.25), SLOTS.lampWhite, 0.1);
    if (lod === 0) {
      for (const x of [-0.75, 0.75]) whipAntenna(b, at(x, T.y + 0.09, T.aft - 0.3, -0.25), 2.4);
      for (const z of [T.front + 0.6, ttMid, T.aft - 0.6]) {
        // LED downlights (deck lights: lights/mounts.ts 'ttop-spreader').
        for (const x of [-0.4, 0.4]) b.add(SLOTS.flood, cylinder(0.04, 0.01, 10), at(x, T.y - 0.005, z));
      }
      // Outriggers stowed up and aft.
      for (const side of [-1, 1]) {
        b.add('frame', cylinder(0.04, 0.18, 8), at(side * 0.94, T.y + 0.1, T.front + 0.5));
        b.add(
          'rigger',
          rod(
            new Vector3(side * 0.94, T.y + 0.15, T.front + 0.5),
            new Vector3(side * 1.25, T.y + 2.6, 4.2),
            0.018,
            6,
            true,
          ),
        );
      }
    }
  }

  // Transom bench, aft deck hatches, cleats, rod holders, bow rail and casting-deck hardware.
  b.add('cushion', slab(1.7, 0.36, 0.09, 0.06, 0.035), at(0, SOLE_Y + 0.42, TRANSOM_IN - 0.2));
  box('gelcoat', 1.7, 0.42, 0.36, 0, SOLE_Y + 0.21, TRANSOM_IN - 0.2, 0.02);
  b.add('cushion', bevelBox(1.6, 0.26, 0.07, 0.03), at(0, SOLE_Y + 0.7, TRANSOM_IN - 0.04));
  if (lod === 0) {
    for (const x of [-0.95, 0.95])
      b.add('gelcoat', slab(0.6, 0.36, 0.025, 0.05, 0.01), at(x, deckY(4.8) + 0.002, 4.8));
    b.add('gelcoat', slab(0.55, 0.6, 0.025, 0.08, 0.01), at(0, deckY(-4.2) + 0.03, -4.2));
    for (const side of [-1, 1]) {
      for (const z of [1.6, 2.4, 3.2, 4.0]) rodHolder(b, at(side * (half(z) - GUNWALE / 2), deckY(z), z));
      hornCleat(b, at(side * (half(4.85) - 0.12), deckY(4.85), 4.85, 0, Math.PI / 2), 0.25);
      hornCleat(b, at(side * (half(-1.0) - 0.08), deckY(-1.0), -1.0, 0, Math.PI / 2), 0.25);
      hornCleat(b, at(side * 0.18, deckY(-4.45) + 0.03, -4.45, 0, 0.3 * side), 0.22);
    }
    // Anchor roller at the stem.
    box(SLOTS.chrome, 0.1, 0.06, 0.5, 0, deckY(lines.zBow + 0.2) + 0.03, lines.zBow + 0.2, 0.015);
  }
  if (lod < 2) {
    const railH = 0.45;
    const pts: Vector3[] = [];
    for (const z of [-1.8, -2.6, -3.4, -4.2, -4.7])
      pts.push(new Vector3(-(half(z) - 0.06), deckY(z) + railH, z));
    pts.push(new Vector3(0, deckY(-4.95) + railH, -4.95));
    const both = [
      ...pts,
      ...[...pts]
        .reverse()
        .slice(1)
        .map((p) => new Vector3(-p.x, p.y, p.z)),
    ];
    rail(b, both, 0.014, { radial: lod === 0 ? 8 : 5, caps: true });
    for (const p of both) {
      if (Math.abs(p.x) < 0.01) continue;
      b.add(SLOTS.chrome, rod(new Vector3(p.x, deckY(p.z), p.z), p, 0.012, 6, true));
    }
  }
  // Bow combination sidelight on the stem.
  const zl = lines.zBow + 0.28;
  b.add(SLOTS.black, bevelBox(0.12, 0.05, 0.08, 0.015), at(0, deckY(zl) + 0.035, zl));
  b.add(SLOTS.lampRed, bevelBox(0.055, 0.035, 0.06, 0.01), at(-0.029, deckY(zl) + 0.07, zl));
  b.add(SLOTS.lampGreen, bevelBox(0.055, 0.035, 0.06, 0.01), at(0.029, deckY(zl) + 0.07, zl));

  // Engine clamp brackets on the transom.
  for (const side of [-1, 1]) {
    box('engineDark', 0.3, 0.5, 0.1, side * ENGINE_X, 0.6, lines.zStern + 0.05, 0.02);
  }
  return b;
}

// One outboard: clamp bracket (static) → trim group about the tilt pin → steer group → cowl,
// midsection, gearcase, prop. Prop centre lands on driveConfig's position (y −0.78, z 5.6).
function outboard(i: number, lod: number, materials: Record<string, Material>): Object3D {
  const side = i === 0 ? -1 : 1;
  const b = new PartBuilder();
  const around = lod === 0 ? 28 : lod === 1 ? 14 : 8;
  // Cowling: rounded box tapering to the back, top sloping down aft.
  const cowl: SuperSection[] = [];
  const nc = lod === 0 ? 14 : 6;
  for (let k = 0; k <= nc; k++) {
    const t = k / nc;
    const nose = Math.min(1, t / 0.16) ** 0.5;
    const tail = Math.min(1, (1 - t) / 0.3) ** 0.55;
    const s = nose * tail;
    cowl.push({
      z: -0.08 + 0.94 * t,
      y: 0.47 - 0.04 * t,
      hw: 0.02 + 0.25 * s * (1 - 0.18 * t),
      top: 0.02 + (0.47 - 0.2 * t * t) * s,
      bottom: 0.03 + 0.42 * s,
      n: 3.8,
      nBottom: 5,
    });
  }
  const capped = { capStart: true, capEnd: true };
  b.addData('cowl', sculpt(cowl, around, capped));
  // Lower cowl (chaps) band.
  const chaps: SuperSection[] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const s = Math.min(1, t / 0.15, (1 - t) / 0.3) ** 0.5;
    chaps.push({ z: -0.05 + 0.8 * t, y: 0.05, hw: 0.04 + 0.25 * s, top: 0.06, bottom: 0.08, n: 4 });
  }
  b.addData('engineDark', sculpt(chaps, around, capped));
  // Midsection strut, anti-ventilation plate, gearcase torpedo, skeg.
  const plateY = -1.32;
  const gearY = -1.5;
  b.addData(
    'engineDark',
    foilLoft(
      [
        { y: 0.0, chord: 0.52, le: 0.04, thickness: 0.32 },
        { y: -0.5, chord: 0.44, le: 0.1, thickness: 0.27 },
        { y: plateY + 0.02, chord: 0.38, le: 0.14, thickness: 0.24 },
        { y: gearY, chord: 0.34, le: 0.12, thickness: 0.26 },
      ],
      lod === 0 ? 18 : 8,
      { capEnd: false },
    ),
  );
  b.add('engineDark', slab(0.4, 0.55, 0.014, 0.12, 0.005), at(0, plateY, 0.48));
  const torp: SuperSection[] = [];
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const r = 0.068 * Math.min(1, (t / 0.25) ** 0.5) * (1 - 0.35 * t);
    torp.push({ z: 0.06 + 0.56 * t, y: gearY, hw: r, top: r, bottom: r, n: 2 });
  }
  b.addData('engineDark', sculpt(torp, lod === 0 ? 14 : 8, capped));
  b.addData(
    'engineDark',
    foilLoft(
      [
        { y: gearY, chord: 0.24, le: 0.32, thickness: 0.1 },
        { y: gearY - 0.17, chord: 0.16, le: 0.42, thickness: 0.08 },
      ],
      10,
    ),
  );
  if (lod === 0) {
    // Intake grilles, trim tab and the tilt tube / swivel bracket.
    for (const s of [-1, 1]) b.add(SLOTS.black, bevelBox(0.01, 0.07, 0.16, 0.003), at(s * 0.155, -0.7, 0.3));
    b.add('engineDark', bevelBox(0.03, 0.05, 0.12, 0.01), at(0, plateY - 0.03, 0.64));
  }
  b.add('engineDark', bevelBox(0.16, 0.42, 0.14, 0.03), at(0, -0.12, -0.04));
  const prop = new Group();
  prop.name = `outboard:${i}:prop`;
  prop.position.set(0, gearY, 0.69);
  const pb = new PartBuilder();
  pb.add(SLOTS.chrome, cylinder(0.05, 0.16, 12, 0.035).rotateX(Math.PI / 2));
  const blades = 3;
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2;
    // Elliptical blade in the disc plane, root to tip along x, pitched about its radial axis.
    const blade = normalizeGeometry(cylinder(1, 1, lod === 0 ? 14 : 8))
      .rotateX(Math.PI / 2)
      .scale(0.078, 0.066, 0.006);
    blade.translate(0.115, 0, 0);
    blade.rotateX(0.5 * side);
    blade.rotateZ(a);
    pb.add(SLOTS.chrome, blade);
  }
  prop.add(pb.build(materials).group);
  const steer = new Group();
  steer.name = `outboard:${i}:steer`;
  steer.position.set(0, 0, STEER_DZ);
  steer.add(b.build(materials, { shadows: lod < 2 }).group, prop);
  if (lod === 0) steer.add(...cowlDecals(materials));
  const trim = new Group();
  trim.name = `outboard:${i}:trim`;
  trim.position.set(0, TILT.y, TILT.z);
  trim.add(steer);
  const root = new Group();
  root.name = `outboard:${i}`;
  root.position.x = side * ENGINE_X;
  root.add(trim);
  return root;
}

// Fictional maker's lettering on both cowl sides.
function cowlDecals(materials: Record<string, Material>): Mesh[] {
  return [-1, 1].map((s) => {
    const m = new Mesh(normalizeGeometry(atlasPlane(0.42, 0.13, [0, 0], [1, 1])), materials.cowlDecal);
    m.position.set(s * 0.309, 0.47, 0.38);
    m.rotation.y = (s * Math.PI) / 2;
    m.name = 'decal';
    return m;
  });
}

function wheel(materials: Record<string, Material>): Object3D {
  const tilt = new Group();
  tilt.position.set(0, 1.0, CONSOLE.aft + 0.13);
  tilt.rotation.x = -0.55;
  const w = new Mesh(
    steeringWheelGeometry(0.2, { spokes: 3, rim: 0.012, dish: 0.03, segments: 32 }),
    materials[SLOTS.chrome],
  );
  w.name = 'helm';
  w.castShadow = true;
  tilt.add(w);
  return tilt;
}

function throttles(materials: Record<string, Material>): Object3D[] {
  return [0, 1].map((i) => {
    const g = new Group();
    g.name = `throttle:${i}`;
    g.position.set(0.39 + i * 0.06, 1.18, -0.42);
    const lever = new Mesh(
      normalizeGeometry(capsule(new Vector3(0, 0, 0), new Vector3(0, 0.14, 0.02), 0.012, 6)),
      materials[SLOTS.chrome],
    );
    const knob = new Mesh(
      normalizeGeometry(bevelBox(0.05, 0.03, 0.03, 0.01)).translate(0, 0.15, 0.02),
      materials[SLOTS.black],
    );
    g.add(lever, knob);
    return g;
  });
}

// Hull-side graphics: a tapered swoosh and the model name, painted per side so the swoosh points forward.
function sideGraphic(side: 1 | -1): CanvasTexture {
  const W = 2048;
  const H = 256;
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, W, H);
  // u = 0 at the left as seen from outside: the stern on starboard, the bow on port.
  const fwd = (u: number): number => (side > 0 ? u * W : (1 - u) * W);
  const band = (y0: number, y1: number, taper: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(fwd(0.02), y0 * H);
    ctx.bezierCurveTo(fwd(0.4), y0 * H, fwd(0.7), (y0 - 0.15) * H, fwd(0.98), (y0 - 0.32) * H);
    ctx.lineTo(fwd(0.98), (y0 - 0.32 + taper) * H);
    ctx.bezierCurveTo(fwd(0.7), (y1 - 0.12) * H, fwd(0.4), y1 * H, fwd(0.02), y1 * H);
    ctx.closePath();
    ctx.fill();
  };
  band(0.78, 0.86, 0.02, 'rgba(214,220,226,0.95)');
  band(0.9, 0.93, 0.01, 'rgba(56,170,190,0.95)');
  ctx.fillStyle = '#eef1f3';
  drawFittedText(ctx, 'TIDEWATER', fwd(0.78), H * 0.36, W * 0.22, H * 0.34, {
    weight: 'italic 800',
    spacing: 0.06,
  });
  const tex = trackTexture(new CanvasTexture(canvas));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function decals(lines: HullLines, ao: AoVolume | null): Mesh[] {
  const out: Mesh[] = [];
  for (const side of [-1, 1] as const) {
    out.push(
      hullDecal(
        lines,
        sideGraphic(side),
        {
          zFrom: -3.9,
          zTo: 4.9,
          yFrom: 0.25,
          yTo: 0,
          yToAt: (z) => lines.deckY(z) - 0.07,
          side,
          offset: 0.003,
          nz: 48,
          ny: 3,
        },
        ao,
      ),
    );
  }
  return out;
}

// Daylight multifunction displays: a chart plotter (left half) and a sonar / fish-finder (right half).
function mfdTexture(): CanvasTexture {
  const W = 1024;
  const H = 320;
  const canvas = createCanvas(W, H);
  const ctx = context2d(canvas);
  const half = W / 2;
  ctx.fillStyle = '#9fd2ee';
  ctx.fillRect(0, 0, half, H);
  ctx.fillStyle = '#c8e6f6';
  ctx.beginPath();
  ctx.ellipse(half * 0.35, H * 0.55, half * 0.32, H * 0.3, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8d9a8';
  ctx.beginPath();
  ctx.moveTo(0, H * 0.15);
  ctx.bezierCurveTo(half * 0.3, H * 0.25, half * 0.45, 0, half * 0.7, H * 0.08);
  ctx.lineTo(half * 0.7, 0);
  ctx.lineTo(0, 0);
  ctx.fill();
  ctx.strokeStyle = '#d43a8a';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(half * 0.5, H * 0.95);
  ctx.lineTo(half * 0.62, H * 0.5);
  ctx.lineTo(half * 0.85, H * 0.2);
  ctx.stroke();
  ctx.fillStyle = '#20262c';
  ctx.fillRect(0, H - 34, half, 34);
  ctx.fillStyle = '#ffffff';
  ctx.font = '600 22px Arial, sans-serif';
  ctx.fillText('SOG 28.4 kn   COG 112°   DEPTH 41 ft', 12, H - 10);
  // Sonar: deep blue water column, a bright bottom return and a few fish arches.
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#0a2a6e');
  g.addColorStop(1, '#06184a');
  ctx.fillStyle = g;
  ctx.fillRect(half, 0, half, H);
  ctx.beginPath();
  ctx.moveTo(half, H * 0.7);
  for (let x = 0; x <= half; x += 16) ctx.lineTo(half + x, H * (0.68 + 0.06 * Math.sin(x / 40)));
  ctx.lineTo(W, H);
  ctx.lineTo(half, H);
  ctx.closePath();
  ctx.fillStyle = '#e8402a';
  ctx.fill();
  ctx.fillStyle = '#f2d23a';
  ctx.fillRect(half, H * 0.66, half, 6);
  for (const [x, y] of [
    [0.3, 0.35],
    [0.55, 0.42],
    [0.72, 0.3],
  ] as const) {
    ctx.strokeStyle = '#f2d23a';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(half + x * half, y * H + 10, 14, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText('41.2 ft   68.4°F', half + 12, 30);
  const tex = trackTexture(new CanvasTexture(canvas));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const detail = (part: string) => boatDetail('powerboat', part);

export function powerboatDraft(): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const builders = [0, 1, 2].map((lod) => structure(lines, lod));
  const zl = lines.zBow + 0.28;
  const lights: LightMountSpec[] = [
    { kind: 'sidePort', position: [-0.03, lines.deckY(zl) + 0.07, zl], direction: [-0.83, 0, -0.56] },
    { kind: 'sideStarboard', position: [0.03, lines.deckY(zl) + 0.07, zl], direction: [0.83, 0, -0.56] },
    { kind: 'allRoundWhite', position: [0, TTOP.y + 0.78, TTOP.aft - 0.25] },
  ];
  const trimDrive = (i: number): TelemetryDrive => ({
    name: `outboard:${i}:trim`,
    axis: 'x',
    // Trimmed out swings the lower unit aft: a negative rotation about x.
    value: (t) =>
      -(TRIM_MIN + (t[`eng${i}Trim`] ?? -TRIM_MIN / (TRIM_MAX - TRIM_MIN)) * (TRIM_MAX - TRIM_MIN)),
    rate: 6,
  });
  const propDrive = (i: number): TelemetryDrive => ({
    name: `outboard:${i}:prop`,
    axis: 'z',
    spin: true,
    // Counter-rotating pair; capped so the blades don't strobe.
    value: (t) => {
      const rev = Math.sign(t[`eng${i}Throttle`] ?? 0) || 0;
      const rps = Math.min(7, (t[`eng${i}Rpm`] ?? 0) / 1.85 / 60);
      return rev * rps * Math.PI * 2 * (i === 0 ? -1 : 1);
    },
    rate: 4,
  });
  const drives: TelemetryDrive[] = [
    ...[0, 1].flatMap((i): TelemetryDrive[] => [
      { name: `outboard:${i}:steer`, axis: 'y', key: 'steering' },
      trimDrive(i),
      propDrive(i),
      { name: `throttle:${i}`, axis: 'x', key: `eng${i}Throttle`, scale: -0.7 },
    ]),
    { name: 'helm', axis: 'z', key: 'steering', scale: -6 },
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  const well = planBlock(lines, {
    zFront: CASTING_AFT,
    zAft: TRANSOM_IN,
    inset: GUNWALE,
    y0: -0.2,
    y1: 0.88,
    bevel: 0,
  });
  const mask = merge([triMeshGeometry(physics.mesh), well]);
  return {
    kind: 'powerboat',
    name: BOAT_CARDS.powerboat.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        topside: 0x1b3a60,
        topsideRoughness: 0.16,
        clearcoat: 1,
        bands: [],
        stain: 0.05,
        grime: 0.04,
      },
      deck: 0xe9e9e5,
      house: 0xf0f0ec,
      trim: 0x1b3a60,
      machinery: 0x2a2c2f,
      grime: 0.05,
      rust: 0,
      glassTint: 0x31424a,
    },
    extraMaterials: (ao) => ({
      bottom: hullPaintMaterial({
        topside: 0xf1f1ed,
        topsideRoughness: 0.24,
        clearcoat: 0.6,
        bands: [],
        stain: 0.35,
        grime: 0.05,
        ao,
        detail: detail('bottom'),
      }),
      [SLOTS.deck]: nonSkidMaterial({ color: 0xe6e6e1, ao, cell: 0.014 }),
      gelcoat: simpleMaterial({
        color: 0xf0f0ec,
        roughness: 0.25,
        ao,
        clearcoat: 0.7,
        name: 'gelcoat',
        detail: detail('gelcoat'),
      }),
      cushion: fabricMaterial({ color: 0xecebe4, ao, kind: 'vinyl', name: 'cushion' }),
      canvas: fabricMaterial({ color: 0x1f2f45, ao, kind: 'canvas' }),
      frame: simpleMaterial({
        color: 0xcfd2d5,
        roughness: 0.3,
        metalness: 0.85,
        ao,
        brushed: true,
        name: 'frame',
      }),
      rigger: simpleMaterial({ color: 0xc0c4c8, roughness: 0.3, metalness: 0.9, name: 'rigger' }),
      [SLOTS.chrome]: simpleMaterial({
        color: 0xdcdfe2,
        roughness: 0.14,
        metalness: 1,
        ao,
        name: 'stainless',
      }),
      acrylic: simpleMaterial({ color: 0x0a0e11, roughness: 0.04, name: 'acrylic' }),
      mfd: lampMaterial({
        color: 0xffffff,
        nits: 700,
        channel: 'screen',
        map: mfdTexture(),
        base: 0x585858,
        name: 'mfd',
      }),
      cowl: simpleMaterial({
        color: 0xf2f2ef,
        roughness: 0.22,
        ao,
        clearcoat: 1,
        name: 'cowl',
        detail: detail('cowl'),
      }),
      engineDark: simpleMaterial({
        color: 0x2b2d30,
        roughness: 0.35,
        ao,
        clearcoat: 0.5,
        name: 'engineDark',
      }),
      cowlDecal: decalMaterial(
        textDecalTexture({
          lines: ['ARGENT', 'V8 300'],
          width: 512,
          height: 160,
          color: '#1d2024',
          lineHeights: [0.5, 0.3],
          weight: 'italic 800',
        }),
        { ao, roughness: 0.25 },
      ),
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: builders[lod]!,
      shadows: lod < 2,
      extras: (materials, ao) => [
        outboard(0, lod, materials),
        outboard(1, lod, materials),
        ...(lod < 2 ? [wheel(materials), ...throttles(materials), ...decals(lines, ao)] : []),
      ],
    })),
    aoVoxel: 0.05,
    aoLod: 1,
    aoDistance: 0.8,
    aoExclude: ['rigger'],
    aoBoxes: [-1, 1].map((s) => ({
      min: [s * ENGINE_X - 0.3, 0.75, 5.15],
      max: [s * ENGINE_X + 0.3, 1.6, 6.0],
    })),
    lights,
    floods: [],
    animated: [],
    drives,
    // Standing at the helm between the wheel and the leaning post (see BOAT_CAMERA_INFO.powerboat).
    eye: new Vector3(0, 1.95, 0.3),
    waterMask: mask,
    lodThresholds: { pixels: [240, 70] },
  };
}
