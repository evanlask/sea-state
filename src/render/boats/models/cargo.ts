// Container ship (KCS-like 3,600 TEU Panamax, Lpp 230 m, B 32.2 m) built from
// the physics hull lines: bulbous bow, raised forecastle with mooring gear and
// a breakwater, eleven 40 ft bays forward of an aft accommodation block (plus
// one aft), hatch covers, lashing bridges, instanced 20/40 ft boxes, the house
// with bridge wings, funnel, radar mast, foremast, a free-fall lifeboat over
// the stern, and red antifouling / black boot-top / navy topsides.

import { type Material, Matrix4, Mesh, type Object3D, Vector3 } from 'three/webgpu';

import { cargoSpec } from '../../../sim/boats/specs/cargo';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
// The display names the menus and HUD use, so the hull lettering matches.
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { boatDetail } from '../detail/detail';
import type { AoBox } from '../kit/ao';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { AnimatedSpec, FloodSpec, LightMountSpec } from '../kit/BoatVisual';
import { wheelhouse, type WiperPivot } from '../kit/bridge';
import { emblemTexture } from '../kit/emblem';
import { at, bevelBox, cylinder, extrude, metricPlane, PartBuilder, roundedRect } from '../kit/geometry';
import { addHull, flatDecal, hullDecal, raisedDeck } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import {
  CONTAINER_HEIGHT,
  containerGeometry,
  FEU_LENGTH,
  HIGH_CUBE_HEIGHT,
  instanced,
  layoutContainers,
  placement,
  TEU_LENGTH,
  type ContainerBay,
  type ContainerSlot,
} from '../kit/instancing';
import {
  CONTAINER_LINES,
  containerLogoAtlas,
  draftMarksTexture,
  hullMaskTexture,
  imoNumber,
  plimsollTexture,
  textDecalTexture,
} from '../kit/liveries';
import { bulwarks } from '../kit/loft';
import { type AoVolume, containerMaterial, paintMaterial } from '../kit/materials';
import { lampMaterial } from '../kit/materials';
import {
  bollard,
  closedChock,
  davit,
  domeAntenna,
  enclosedLifeboat,
  floodlight,
  horn,
  ladder,
  lifebuoy,
  liferaft,
  navLightHousing,
  poleMast,
  radarScanner,
  railing,
  searchlight,
  searchlightLens,
  SLOTS,
  vent,
  whipAntenna,
  winch,
} from '../kit/props';
import { wiperMeshes } from './shared';

const spec = cargoSpec;
const T = spec.dimensions.draft;

// Layout (body z, aft positive).
const HOUSE_FRONT = 65.5;
const HOUSE_AFT = 81.5;
const CASING_FRONT = 63.5;
const CASING_AFT = 91.5;
const CASING_TOP = 14.2;
const BRIDGE_FLOOR = 33.3;
const BRIDGE_AFT = 74;
const HOUSE_HALF = 12.5;
const WING_HALF = 16.6;
const FUNNEL_Z = 87;
const FOREMAST_Z = -110.3;
const FORECASTLE_AFT = -103.5;
const FORECASTLE_H = 2.5;
// The windlasses stand where the forecastle is wide enough to carry them inside the bulwarks, aft
// of the hawse pipes' deck ends (just inside the bulwark): the chain leads aft and a little
// outboard to the gypsy.
const WINDLASS_Z = -108;
const WINDLASS_X = 2.76;
const WINDLASS_R = 0.65;
const WINDLASS_W = 1.0;
const CHAIN_PIPE_Z = -110.8;
const CHAIN_PIPE_X = 2.86;
const MAST_Z = 72;
// Bridge-wing searchlights near the wheelhouse end of each wing, looking over the front bulwark: clear
// of the wing camera (wingEyes, 2 m in from the tip) and the sidelight screens at the tips.
const SEARCH_X = HOUSE_HALF + 0.8;
const SEARCH_Z = HOUSE_FRONT + 0.75;
const SEARCH_R = 0.26;
const SEARCH_FOOT = BRIDGE_FLOOR + 1.0; // on a post, so the beam clears the bulwark
const BAY_PITCH = 13.8;
const COAMING = 1.6;
const HATCH = 0.7;

function bays(lines: HullLines): (ContainerBay & { end: number })[] {
  const out: (ContainerBay & { end: number })[] = [];
  const add = (z: number, tiers: number): void => {
    const zEnd = z < 0 ? z - FEU_LENGTH / 2 : z + FEU_LENGTH / 2;
    const half = Math.min(lines.deckHalf(zEnd), lines.deckHalf(z));
    const rows = Math.min(13, Math.floor((2 * (half - 1.5)) / 2.468));
    out.push({ z, rows, tiers, baseY: lines.deckY(z) + COAMING + HATCH, twenty: false, end: zEnd });
  };
  for (let i = 0; i < 11; i++) {
    const z = CASING_FRONT - 1.4 - FEU_LENGTH / 2 - i * BAY_PITCH;
    add(z, i === 10 ? 4 : i === 9 ? 5 : 6);
  }
  add(CASING_AFT + 2 + FEU_LENGTH / 2, 5);
  // A few bays carry pairs of 20 ft boxes.
  for (const i of [2, 5, 8]) out[i]!.twenty = true;
  return out;
}

interface CargoParts {
  builder: PartBuilder;
  wipers: WiperPivot[];
  radars: { position: [number, number, number]; length: number; name: string }[];
}

function structure(lines: HullLines, lod: number, bayList: ReturnType<typeof bays>): CargoParts {
  const b = new PartBuilder();
  const box = (
    slot: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    bevel = 0.06,
    ry = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(x, y, z, 0, ry));
  };
  const deckY = (z: number): number => lines.deckY(z);
  addHull(b, lines, {
    lod,
    bulb: {
      tipZ: -spec.dimensions.lwl / 2 - 4.2,
      length: 16,
      halfWidth: 2.9,
      halfHeight: 3.4,
      centreY: -T + 4.6,
    },
    sheerRail: { radius: 0.18, drop: 0.05 },
  });

  // Forecastle.
  const sF = lines.sAt(FORECASTLE_AFT);
  const fc = raisedDeck(lines, {
    sFrom: 0,
    sTo: sF,
    height: () => FORECASTLE_H,
    stations: lod === 0 ? 26 : 10,
  });
  b.addData(SLOTS.hull, fc.sides).addData(SLOTS.deck, fc.top).addData(SLOTS.house, fc.bulkhead);
  if (lod < 2) {
    b.addData(
      SLOTS.hull,
      bulwarks(lines, {
        sFrom: 0.0005,
        sTo: sF,
        stations: lod === 0 ? 24 : 8,
        height: 1.4,
        lift: () => FORECASTLE_H,
        thickness: 0.15,
      }),
    );
  }
  const fy = (z: number): number => deckY(z) + FORECASTLE_H;

  // Breakwater: V-shaped screen forward of the first bay.
  const bwZ = bayList[10]!.end - 3.2;
  const bwHalf = lines.deckHalf(bwZ) - 1.8;
  const legLen = Math.hypot(bwHalf, 4);
  const legAngle = Math.atan2(bwHalf, 4);
  for (const side of [-1, 1]) {
    box(
      SLOTS.house,
      legLen,
      6,
      0.3,
      (side * bwHalf) / 2,
      deckY(bwZ) + 3,
      bwZ - 2,
      0.08,
      side * (Math.PI / 2 - legAngle),
    );
    if (lod === 0) {
      for (let k = 1; k < 5; k++) {
        const x = (side * bwHalf * k) / 5;
        const z = bwZ - 4 + (4 * k) / 5;
        b.add(SLOTS.house, bevelBox(0.15, 4.5, 1.6, 0.03), at(x, deckY(bwZ) + 2.25, z + 0.9));
      }
    }
  }

  // Hatch coamings, hatch covers, lashing bridges.
  for (const [i, bay] of bayList.entries()) {
    const w = bay.rows * 2.468 + 0.8;
    const y = deckY(bay.z);
    box('hatch', w, COAMING, FEU_LENGTH + 0.6, 0, y + COAMING / 2, bay.z, 0.1);
    const panels = bay.rows > 9 ? 3 : 2;
    for (let p = 0; p < panels; p++) {
      const pw = w / panels - 0.08;
      box(
        'hatch',
        pw,
        HATCH,
        FEU_LENGTH + 0.4,
        -w / 2 + (p + 0.5) * (w / panels),
        y + COAMING + HATCH / 2,
        bay.z,
        0.18,
      );
      if (lod === 0) {
        for (const dz of [-3.2, 0, 3.2])
          box(
            'hatch',
            pw - 0.4,
            0.06,
            0.18,
            -w / 2 + (p + 0.5) * (w / panels),
            y + COAMING + HATCH + 0.03,
            bay.z + dz,
            0.02,
          );
      }
    }
    // Lashing bridge on the aft side of each forward bay (between it and the next bay aft).
    if (lod < 2 && i < 11 && i > 0) {
      const zl = bay.z + FEU_LENGTH / 2 + 0.75;
      const yl = y + COAMING + HATCH;
      const lw = w - 0.4;
      const posts = Math.ceil(bay.rows / 2) + 1;
      for (let p = 0; p < posts; p++) {
        const x = -lw / 2 + (p * lw) / (posts - 1);
        for (const dz of [-0.4, 0.4]) box('lashing', 0.22, 5.4, 0.22, x, yl + 2.7, zl + dz, 0.03);
      }
      for (const yy of [2.6, 5.3]) {
        box('lashing', lw, 0.1, 1.05, 0, yl + yy, zl, 0.02);
        if (lod === 0) {
          railing(b, [new Vector3(-lw / 2, yl + yy, zl - 0.5), new Vector3(lw / 2, yl + yy, zl - 0.5)], {
            height: 1.0,
            spacing: 2.4,
            rails: 2,
            slot: 'lashing',
            radius: 0.025,
          });
          railing(b, [new Vector3(-lw / 2, yl + yy, zl + 0.5), new Vector3(lw / 2, yl + yy, zl + 0.5)], {
            height: 1.0,
            spacing: 2.4,
            rails: 2,
            slot: 'lashing',
            radius: 0.025,
          });
        }
      }
    }
  }

  // Accommodation: casing, house, deck edges, window facades.
  const casingY0 = deckY(77) - 0.3;
  box(
    SLOTS.house,
    29,
    CASING_TOP - casingY0,
    CASING_AFT - CASING_FRONT,
    0,
    (CASING_TOP + casingY0) / 2,
    (CASING_FRONT + CASING_AFT) / 2,
    0.15,
  );
  const houseH = BRIDGE_FLOOR - CASING_TOP;
  box(
    SLOTS.house,
    HOUSE_HALF * 2,
    houseH,
    HOUSE_AFT - HOUSE_FRONT,
    0,
    CASING_TOP + houseH / 2,
    (HOUSE_FRONT + HOUSE_AFT) / 2,
    0.2,
  );
  const deckH = houseH / 7;
  if (lod < 2) {
    for (let k = 1; k <= 7; k++) {
      box(
        SLOTS.house,
        HOUSE_HALF * 2 + 0.3,
        0.14,
        HOUSE_AFT - HOUSE_FRONT + 0.3,
        0,
        CASING_TOP + k * deckH - 0.05,
        (HOUSE_FRONT + HOUSE_AFT) / 2,
        0.04,
      );
    }
    const fw = HOUSE_HALF * 2 - 1.2;
    const fh = houseH - 0.4;
    b.add('windows', metricPlane(fw, fh), at(0, CASING_TOP, HOUSE_FRONT - 0.03, 0, Math.PI));
    b.add('windows', metricPlane(fw, fh, 7.3), at(0, CASING_TOP, HOUSE_AFT + 0.03));
    for (const side of [-1, 1]) {
      b.add(
        'windows',
        metricPlane(HOUSE_AFT - HOUSE_FRONT - 1.2, fh, 3.1),
        at(side * (HOUSE_HALF + 0.03), CASING_TOP, (HOUSE_FRONT + HOUSE_AFT) / 2, 0, (side * Math.PI) / 2),
      );
    }
  }

  // Bridge, wings and monkey island.
  const bridge = wheelhouse(b, {
    halfWidth: HOUSE_HALF,
    zFront: HOUSE_FRONT,
    zAft: BRIDGE_AFT,
    floorY: BRIDGE_FLOOR,
    height: 3.3,
    sill: 1.15,
    head: 3.0,
    rake: 0.2,
    panes: 13,
    sidePanes: 3,
    visor: 0.9,
    interior: lod === 0,
    wipers: lod === 0 ? 3 : 0,
    consoleWidth: 0.55,
    chairs: 2,
  });
  const roofY = BRIDGE_FLOOR + 3.6;
  for (const side of [-1, 1]) {
    const xm = (side * (HOUSE_HALF + WING_HALF)) / 2;
    const ww = WING_HALF - HOUSE_HALF;
    box(SLOTS.house, ww, 0.35, 4.2, xm, BRIDGE_FLOOR - 0.15, HOUSE_FRONT + 2.1, 0.06);
    box(SLOTS.house, ww, 1.25, 0.18, xm, BRIDGE_FLOOR + 0.62, HOUSE_FRONT + 0.09, 0.04);
    box(
      SLOTS.house,
      0.18,
      1.25,
      4.2,
      side * (WING_HALF - 0.09),
      BRIDGE_FLOOR + 0.62,
      HOUSE_FRONT + 2.1,
      0.04,
    );
    // Underside brackets.
    for (const dz of [0.6, 3.6])
      box(SLOTS.house, ww - 0.3, 0.3, 0.25, xm, BRIDGE_FLOOR - 0.9, HOUSE_FRONT + dz, 0.03);
    box(SLOTS.house, 0.4, 1.6, 0.4, side * (WING_HALF - 0.5), BRIDGE_FLOOR - 1.1, HOUSE_FRONT + 2.1, 0.05);
    if (lod === 0) {
      railing(
        b,
        [
          new Vector3(side * HOUSE_HALF, BRIDGE_FLOOR, HOUSE_FRONT + 4.2),
          new Vector3(side * (WING_HALF - 0.1), BRIDGE_FLOOR, HOUSE_FRONT + 4.2),
        ],
        { height: 1.1, spacing: 1.2 },
      );
      box(SLOTS.black, 0.8, 1.1, 0.6, side * (WING_HALF - 0.8), BRIDGE_FLOOR + 0.55, HOUSE_FRONT + 0.6, 0.05);
      // Sidelight with its inboard screen.
      navLightHousing(
        b,
        at(side * (WING_HALF - 0.25), BRIDGE_FLOOR + 1.25, HOUSE_FRONT + 0.6),
        side > 0 ? SLOTS.lampGreen : SLOTS.lampRed,
        0.45,
      );
      box(
        SLOTS.black,
        0.06,
        0.9,
        1.0,
        side * (WING_HALF - 0.55),
        BRIDGE_FLOOR + 1.7,
        HOUSE_FRONT + 0.8,
        0.01,
      );
      lifebuoy(b, at(side * (WING_HALF - 0.05), BRIDGE_FLOOR + 0.7, HOUSE_FRONT + 3.2, 0, Math.PI / 2));
      box(
        SLOTS.steel,
        0.3,
        SEARCH_FOOT - BRIDGE_FLOOR,
        0.3,
        side * SEARCH_X,
        (SEARCH_FOOT + BRIDGE_FLOOR) / 2,
        SEARCH_Z,
        0.03,
      );
      searchlight(b, at(side * SEARCH_X, SEARCH_FOOT, SEARCH_Z), SEARCH_R);
    }
  }
  if (lod === 0) {
    railing(
      b,
      [
        new Vector3(-HOUSE_HALF + 0.2, roofY, HOUSE_FRONT - 0.6),
        new Vector3(HOUSE_HALF - 0.2, roofY, HOUSE_FRONT - 0.6),
        new Vector3(HOUSE_HALF - 0.2, roofY, BRIDGE_AFT - 0.2),
        new Vector3(-HOUSE_HALF + 0.2, roofY, BRIDGE_AFT - 0.2),
      ],
      { height: 1.0, closed: true, spacing: 1.6 },
    );
    railing(
      b,
      [
        new Vector3(-HOUSE_HALF + 0.1, BRIDGE_FLOOR, BRIDGE_AFT),
        new Vector3(-HOUSE_HALF + 0.1, BRIDGE_FLOOR, HOUSE_AFT - 0.1),
        new Vector3(HOUSE_HALF - 0.1, BRIDGE_FLOOR, HOUSE_AFT - 0.1),
        new Vector3(HOUSE_HALF - 0.1, BRIDGE_FLOOR, BRIDGE_AFT),
      ],
      { height: 1.0, spacing: 1.6 },
    );
    // Outside ladders between decks on the house sides.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 7; k++)
        ladder(
          b,
          at(
            side * (HOUSE_HALF + 0.35),
            CASING_TOP + k * deckH,
            HOUSE_AFT - 1.2 - (k % 2) * 3,
            0,
            (side * Math.PI) / 2,
          ),
          deckH,
          0.5,
        );
    }
  }

  // Radar mast on the monkey island.
  poleMast(b, at(0, roofY, MAST_Z), {
    height: 13.6,
    radius: 0.38,
    top: 0.2,
    yard: { y: 4.4, span: 7.5 },
    slot: SLOTS.trim,
  });
  box(SLOTS.trim, 3.0, 0.2, 2.2, 0, roofY + 4.2, MAST_Z - 1.2, 0.04);
  box(SLOTS.trim, 3.6, 0.16, 0.25, 0, roofY + 9.2, MAST_Z, 0.04);
  b.add(SLOTS.trim, cylinder(0.25, 1.5, 10), at(0, roofY + 0.75, 76.2));
  const radars: CargoParts['radars'] = [
    { position: [0, roofY + 4.3, MAST_Z - 1.4], length: 2.6, name: 'radar:x' },
    { position: [0, roofY + 1.5, 76.2], length: 3.9, name: 'radar:s' },
  ];
  if (lod === 0) {
    railing(b, [new Vector3(-1.5, roofY + 4.3, MAST_Z - 2.3), new Vector3(1.5, roofY + 4.3, MAST_Z - 2.3)], {
      height: 0.9,
      spacing: 1,
      rails: 2,
    });
    navLightHousing(b, at(0, roofY + 13.3, MAST_Z - 0.4), SLOTS.lampWhite, 0.45);
    for (const y of [roofY + 10.4, roofY + 8.4])
      navLightHousing(b, at(0, y, MAST_Z - 0.7), SLOTS.lampRed, 0.35);
    whipAntenna(b, at(1.7, roofY + 9.3, MAST_Z), 5);
    whipAntenna(b, at(-1.7, roofY + 9.3, MAST_Z), 5);
    domeAntenna(b, at(7, roofY, 70.5), 0.65);
    domeAntenna(b, at(-6, roofY, 72), 0.18);
    domeAntenna(b, at(-7, roofY, 70), 0.15);
    horn(b, at(0, roofY + 6.4, MAST_Z - 0.5), 1.1);
    ladder(b, at(0, roofY, MAST_Z + 0.45, 0, Math.PI), 13, 0.4);
    floodlight(b, at(-3, BRIDGE_FLOOR - 0.6, HOUSE_FRONT - 0.3), 0.5, 0.6);
    floodlight(b, at(3, BRIDGE_FLOOR - 0.6, HOUSE_FRONT - 0.3), 0.5, 0.6);
  }

  // Funnel with band, emblem (decal) and exhausts. The body stops just under the wider black top
  // band, so their top faces aren't coplanar (z-fighting).
  const funnelH = 43.9 - CASING_TOP;
  b.add(
    'funnel',
    extrude(roundedRect(8.4, 9.4, 3.2), funnelH, 'y', { bevel: 0.25 }),
    at(0, CASING_TOP, FUNNEL_Z),
  );
  b.add(
    'funnelBand',
    extrude(roundedRect(8.55, 9.55, 3.25), 4.5, 'y', { bevel: 0.08 }),
    at(0, 36.5, FUNNEL_Z),
  );
  b.add(
    SLOTS.black,
    extrude(roundedRect(8.5, 9.5, 3.25), 1.6, 'y', { bevel: 0.08 }),
    at(0, 44 - 1.6, FUNNEL_Z),
  );
  for (const [x, z, r] of [
    [-1.5, FUNNEL_Z + 0.5, 0.7],
    [1.4, FUNNEL_Z + 1.2, 0.5],
    [0.9, FUNNEL_Z - 2, 0.35],
  ] as const) {
    b.add(SLOTS.steel, cylinder(r, 2.2, 14), at(x, 44.6, z));
    b.add(SLOTS.black, cylinder(r * 0.8, 0.05, 14), at(x, 45.74, z)); // soot, clear of the pipe's top
  }

  // Foremast on the forecastle.
  const fmY = fy(FOREMAST_Z);
  poleMast(b, at(0, fmY, FOREMAST_Z), {
    height: 25,
    radius: 0.5,
    top: 0.18,
    yard: { y: 14, span: 3 },
    slot: SLOTS.trim,
  });
  if (lod === 0) {
    navLightHousing(b, at(0, fmY + 24.8, FOREMAST_Z - 0.35), SLOTS.lampWhite, 0.4);
    navLightHousing(b, at(0, fmY + 13.6, FOREMAST_Z - 0.6), SLOTS.lampWhite, 0.35);
    ladder(b, at(0, fmY, FOREMAST_Z + 0.55, 0, Math.PI), 24, 0.4);
    floodlight(b, at(0.8, fmY + 14.1, FOREMAST_Z + 0.2, 0, Math.PI), 0.5, 0.7);
    floodlight(b, at(-0.8, fmY + 14.1, FOREMAST_Z + 0.2, 0, Math.PI), 0.5, 0.7);
  }

  // Free-fall lifeboat on a ramp over the stern, atop a small poop house.
  const poopZ0 = 106.5;
  const poopZ1 = 113.5;
  const poopTop = 14.6;
  box(
    SLOTS.house,
    12,
    poopTop - deckY(110) + 0.2,
    poopZ1 - poopZ0,
    0,
    (poopTop + deckY(110) - 0.2) / 2,
    (poopZ0 + poopZ1) / 2,
    0.12,
  );
  const rampAngle = 0.6;
  const rampLen = 10;
  for (const x of [-1.3, 1.3]) {
    box(SLOTS.steel, 0.3, 0.45, rampLen, x, poopTop + 1.7, poopZ0 + 4.2, 0.04);
    b.add(SLOTS.steel, bevelBox(0.3, 0.45, rampLen, 0.04), at(x, poopTop + 1.6, poopZ0 + 4.8, -rampAngle));
    box(SLOTS.steel, 0.3, 2.8, 0.3, x, poopTop + 1.4, poopZ0 + 1, 0.04);
  }
  b.add(
    SLOTS.orange,
    enclosedLifeboat(8.6, 3.1, 3.3, lod === 0 ? 20 : 10, lod === 0 ? 18 : 10),
    at(0, poopTop + 2.0, poopZ0 + 4.8, -rampAngle, Math.PI),
  );
  if (lod === 0) {
    railing(
      b,
      [
        new Vector3(-6, poopTop, poopZ0),
        new Vector3(-6, poopTop, poopZ1),
        new Vector3(6, poopTop, poopZ1),
        new Vector3(6, poopTop, poopZ0),
      ],
      { height: 1.0, spacing: 1.5 },
    );
    // Rescue boat in a davit on the starboard casing deck.
    b.add(SLOTS.orange, enclosedLifeboat(6, 2.4, 1.3, 12, 12), at(13.6, CASING_TOP + 1.6, 77));
    davit(b, at(12.6, CASING_TOP, 77), 3.6, 1.2);
    for (const z of [68, 71, 84]) liferaft(b, at(13.8, CASING_TOP, z), 1.3, 0.33);
    for (const z of [68, 71]) liferaft(b, at(-13.8, CASING_TOP, z), 1.3, 0.33);
    railing(
      b,
      [new Vector3(14.4, CASING_TOP, CASING_FRONT + 0.2), new Vector3(14.4, CASING_TOP, CASING_AFT - 0.2)],
      { height: 1.0 },
    );
    railing(
      b,
      [new Vector3(-14.4, CASING_TOP, CASING_FRONT + 0.2), new Vector3(-14.4, CASING_TOP, CASING_AFT - 0.2)],
      { height: 1.0 },
    );
    for (const x of [-9, -4, 4, 9])
      vent(b, at(x, CASING_TOP, CASING_AFT - 1.5), { kind: 'gooseneck', r: 0.35, h: 1.4 });
  }

  // Deck gear, rails, mooring fittings.
  if (lod === 0) {
    for (const side of [-1, 1]) {
      // The winches' gearboxes and motors (local +x) stand inboard, the gypsies and drums outboard.
      const inboard = side > 0 ? Math.PI : 0;
      winch(b, at(side * WINDLASS_X, fy(WINDLASS_Z), WINDLASS_Z, 0, inboard), {
        drum: WINDLASS_R,
        width: WINDLASS_W,
        windlass: true,
      });
      winch(b, at(side * 2.62, fy(-105), -105, 0, inboard), { drum: 0.6, width: 1.4 });
      for (const [z, inset] of [
        [-116, 1.6],
        [-112.3, 1.6],
        [-105.2, 0.7],
      ] as const)
        bollard(b, at(side * (lines.deckHalf(z) - inset), fy(z), z, 0, Math.PI / 2), 0.28);
      for (const z of [-114, -107.5])
        closedChock(
          b,
          // Facing outboard through the bulwark, square to it.
          at(
            side * (lines.deckHalf(z) - 0.08),
            fy(z) + 0.2,
            z,
            0,
            side * Math.atan(lines.deckHalf(z + 0.5) - lines.deckHalf(z - 0.5)),
          ),
          0.55,
          0.35,
        );
      // Hawse pipe deck end (the pipe runs down inside the bow to the shell opening), and the
      // chain from it over a stopper to the top of the windlass gypsy.
      const pipeY = fy(CHAIN_PIPE_Z) + 0.6;
      b.add(SLOTS.black, cylinder(0.45, 0.6, 12), at(side * CHAIN_PIPE_X, pipeY - 0.3, CHAIN_PIPE_Z));
      const gx = WINDLASS_X + WINDLASS_W / 2 + WINDLASS_R * 0.6;
      const gy = fy(WINDLASS_Z) + WINDLASS_R * 2.15;
      const gz = WINDLASS_Z - WINDLASS_R * 0.6;
      const dx = gx - CHAIN_PIPE_X;
      const dy = gy - pipeY;
      const dz = gz - CHAIN_PIPE_Z;
      const run = Math.hypot(dx, dz);
      const lead = side * Math.atan2(dx, dz);
      b.add(
        SLOTS.black,
        bevelBox(0.24, 0.14, Math.hypot(run, dy), 0.04),
        at(side * (CHAIN_PIPE_X + dx / 2), pipeY + dy / 2, CHAIN_PIPE_Z + dz / 2, -Math.atan2(dy, run), lead),
      );
      const sz = CHAIN_PIPE_Z + dz * 0.4;
      b.add(
        SLOTS.machinery,
        bevelBox(0.6, 0.3, 1.0, 0.05),
        at(side * (CHAIN_PIPE_X + dx * 0.4), fy(sz) + 0.15, sz, 0, lead),
      );
      // Side walkway rails along the cargo deck.
      const pts: Vector3[] = [];
      for (let z = FORECASTLE_AFT + 0.4; z <= CASING_FRONT; z += 6)
        pts.push(new Vector3(side * (lines.deckHalf(z) - 0.12), deckY(z), z));
      railing(b, pts, { height: 1.0, spacing: 1.8 });
      const aft: Vector3[] = [];
      for (let z = CASING_AFT; z <= lines.zStern - 0.4; z += 4)
        aft.push(new Vector3(side * (lines.deckHalf(z) - 0.12), deckY(z), z));
      railing(b, aft, { height: 1.0, spacing: 1.8 });
      // Stern mooring station.
      winch(b, at(side * 6.5, deckY(117), 117.5), { drum: 0.6, width: 1.3 });
      for (const z of [115, 120])
        bollard(b, at(side * (lines.deckHalf(z) - 1.5), deckY(z), z, 0, Math.PI / 2), 0.26);
      for (const z of [99, 109])
        bollard(b, at(side * (lines.deckHalf(z) - 1.3), deckY(z), z, 0, Math.PI / 2), 0.25);
      for (const z of [-60, -10, 40])
        bollard(b, at(side * (lines.deckHalf(z) - 0.8), deckY(z), z, 0, 0), 0.22);
      // Accommodation ladder stowed on the hull side below the house.
      box(SLOTS.steel, 0.35, 0.9, 16, side * (lines.deckHalf(72) + 0.2), deckY(72) - 1.4, 72, 0.04);
      // Hawse pipe openings and anchors, laid against the flared bow plating: n is the shell's
      // outward normal at the opening, u runs down the shell under it, t fore and aft along it.
      const zh = -113.6;
      const yh = 6.6;
      const hb = (z: number, y: number): number => lines.halfBreadthAt(z, y);
      const ph = new Vector3(side * hb(zh, yh), yh, zh);
      const n = new Vector3(
        side,
        hb(zh, yh - 0.5) - hb(zh, yh + 0.5),
        hb(zh - 0.5, yh) - hb(zh + 0.5, yh),
      ).normalize();
      const u = new Vector3(side * hb(zh, yh - 3.2), yh - 3.2, zh).sub(ph);
      u.addScaledVector(n, -u.dot(n)).normalize();
      const t = new Vector3().crossVectors(n, u);
      const shell = (along: number, out: number): Matrix4 =>
        new Matrix4()
          .makeBasis(n, u, t)
          .setPosition(ph.clone().addScaledVector(u, along).addScaledVector(n, out));
      // (The cylinder's axis is its local y: the basis (u, n, t) turns it along the normal.)
      const ring = new Matrix4()
        .makeBasis(u, n, t.clone().negate())
        .setPosition(ph.clone().addScaledVector(u, -0.4));
      b.add(SLOTS.black, cylinder(1.25, 0.25, 16), ring);
      b.add(SLOTS.black, bevelBox(0.45, 3.2, 0.45, 0.08), shell(1.6, 0.23));
      b.add(SLOTS.black, bevelBox(0.7, 0.9, 2.6, 0.18), shell(3.3, 0.36));
    }
    railing(
      b,
      [
        new Vector3(-lines.deckHalf(lines.zStern - 0.4) + 0.2, deckY(lines.zStern), lines.zStern - 0.3),
        new Vector3(lines.deckHalf(lines.zStern - 0.4) - 0.2, deckY(lines.zStern), lines.zStern - 0.3),
      ],
      { height: 1.0, spacing: 1.8 },
    );
    navLightHousing(b, at(0, deckY(lines.zStern) + 1.0, lines.zStern - 0.35), SLOTS.lampWhite, 0.35);
    // Rudder and propeller (visual; the physics models them as foils and thrust).
    b.add('rudder', extrude(roundedRect(6.0, 9.9, 1.2), 0.9, 'x', { bevel: 0.35 }), at(0, -5.6, 117.2));
    b.add('bronze', cylinder(0.9, 1.6, 16, 0.7), at(0, -6.4, 112.4, Math.PI / 2));
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      b.add(
        'bronze',
        bevelBox(0.12, 3.4, 1.7, 0.05),
        at(Math.sin(a) * 2.1, -6.4 + Math.cos(a) * 2.1, 112.4, 0.45, 0, -a),
      );
    }
    b.add(SLOTS.hull, cylinder(1.0, 4, 14), at(0, -6.4, 109.8, Math.PI / 2));
  }
  return { builder: b, wipers: bridge.wipers, radars };
}

function containerMeshes(slots: readonly ContainerSlot[], material: Material): Object3D[] {
  const groups = new Map<string, ContainerSlot[]>();
  for (const s of slots) {
    const key = `${s.length > 8 ? 40 : 20}:${s.height > 2.7 ? 'hc' : 'std'}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  const out: Object3D[] = [];
  for (const [key, list] of groups) {
    const [len, kind] = key.split(':');
    const geometry = containerGeometry(
      len === '40' ? FEU_LENGTH : TEU_LENGTH,
      kind === 'hc' ? HIGH_CUBE_HEIGHT : CONTAINER_HEIGHT,
    );
    const variant = new Float32Array(list.length * 2);
    const color = new Float32Array(list.length * 3);
    list.forEach((s, i) => {
      const line = CONTAINER_LINES[s.livery % CONTAINER_LINES.length]!;
      const c = new Vector3(
        Number.parseInt(line.color.slice(1, 3), 16),
        Number.parseInt(line.color.slice(3, 5), 16),
        Number.parseInt(line.color.slice(5, 7), 16),
      ).divideScalar(255);
      // sRGB → linear, then fade toward grey with age.
      const lin = c.toArray().map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      const fade = 0.15 + s.tint * 0.3;
      const bright = 0.85 + s.tint * 0.25;
      for (let k = 0; k < 3; k++) color[i * 3 + k] = (lin[k]! * (1 - fade) + 0.18 * fade) * bright;
      variant[i * 2] = s.livery % CONTAINER_LINES.length;
      variant[i * 2 + 1] = s.tint * 37;
    });
    out.push(
      instanced(
        geometry,
        material,
        {
          matrices: list.map((s) => placement(s.x, s.y, s.z, s.tint > 0.5 ? Math.PI : 0)),
          attributes: { aVariant: { itemSize: 2, data: variant }, aColor: { itemSize: 3, data: color } },
        },
        { name: `containers:${key}` },
      ),
    );
  }
  return out;
}

function decals(lines: HullLines, ao: AoVolume | null, lod: number): Mesh[] {
  const name = BOAT_CARDS.cargo.name.replace(/^MV\s+/, '').toUpperCase();
  const out: Mesh[] = [];
  const bowName = textDecalTexture({ lines: [name], width: 2048, height: 192, color: '#f1eee6' });
  const lineName = textDecalTexture({
    lines: ['MERIDIAN  LINES'],
    width: 2048,
    height: 256,
    color: '#eeeae0',
    weight: '800',
  });
  for (const side of [-1, 1] as const) {
    out.push(
      hullDecal(lines, bowName, { zFrom: -116.5, zTo: -90, yFrom: 7.0, yTo: 9.4, side, nz: 30, ny: 3 }, ao),
    );
    out.push(
      hullDecal(lines, lineName, { zFrom: -62, zTo: 18, yFrom: 1.8, yTo: 7.6, side, nz: 12, ny: 2 }, ao),
    );
  }
  if (lod > 0) return out;
  const stern = textDecalTexture({
    lines: [name, 'MAJURO', imoNumber(4207)],
    width: 2048,
    height: 640,
    lineHeights: [0.42, 0.3, 0.16],
  });
  const transom = flatDecal(stern, 14, 4.4, ao);
  transom.position.set(0, 5.4, lines.zStern + 0.03);
  out.push(transom);
  const bowMarks = draftMarksTexture(T, 12.6, -10.6, 1.6);
  const midMarks = bowMarks;
  const sternMarks = draftMarksTexture(T, 12.6, -4.4, 1.6);
  const plimsoll = plimsollTexture();
  for (const side of [-1, 1] as const) {
    out.push(
      hullDecal(
        lines,
        bowMarks,
        { zFrom: -111.9, zTo: -111.3, yFrom: -10.6, yTo: 1.6, side, nz: 2, ny: 24 },
        ao,
      ),
    );
    out.push(
      hullDecal(lines, midMarks, { zFrom: 3, zTo: 3.6, yFrom: -10.6, yTo: 1.6, side, nz: 1, ny: 4 }, ao),
    );
    out.push(
      hullDecal(
        lines,
        sternMarks,
        { zFrom: 106, zTo: 106.6, yFrom: -4.4, yTo: 1.6, side, nz: 2, ny: 12 },
        ao,
      ),
    );
    out.push(
      hullDecal(lines, plimsoll, { zFrom: -1.5, zTo: 1.5, yFrom: -1.2, yTo: 1.2, side, nz: 1, ny: 1 }, ao),
    );
  }
  return out;
}

const detail = (part: string) => boatDetail('cargo', part);

// In ballast she carries empties two high on deck instead of full stacks.
const BALLAST_TIERS = 2;

export function cargoDraft(ballast = false): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const bayList = bays(lines);
  const stacked = ballast
    ? bayList.map((bay) => ({ ...bay, tiers: Math.min(bay.tiers, BALLAST_TIERS) }))
    : bayList;
  const containers = layoutContainers(stacked, { seed: 11, liveries: CONTAINER_LINES.length, fill: 0.9 });
  const parts = [0, 1, 2].map((lod) => structure(lines, lod, bayList));
  const logos = containerLogoAtlas();
  const emblem = emblemTexture({ disc: '#b8322a', mark: '#f3efe6', ring: '#f3efe6', kind: 'star' });
  const aoBoxes: AoBox[] = containers.map((c) => ({
    min: [c.x - 1.22, c.y, c.z - c.length / 2],
    max: [c.x + 1.22, c.y + c.height, c.z + c.length / 2],
  }));
  const radarMeshes = (lod: number, materials: Record<string, Material>): Object3D[] =>
    parts[lod]!.radars.map((r) => {
      const pedestal = new PartBuilder();
      const array = new Mesh(radarScanner(pedestal, at(0, 0, 0), r.length), materials[SLOTS.white]);
      const ped = pedestal.build(materials).group;
      ped.position.set(...r.position);
      array.position.set(...r.position);
      array.name = r.name;
      array.castShadow = true;
      return lod === 0 ? [ped, array] : [ped];
    }).flat();
  const funnelDecals = (ao: AoVolume | null): Mesh[] =>
    [-1, 1].map((side) => {
      const d = flatDecal(emblem, 3.6, 3.6, ao);
      d.position.set(side * 4.3, 38.75, FUNNEL_Z);
      d.rotation.y = (side * Math.PI) / 2;
      return d;
    });
  const animated: AnimatedSpec[] = [
    { type: 'radar', name: 'radar:x', rpm: 24 },
    { type: 'radar', name: 'radar:s', rpm: 22 },
    ...parts[0]!.wipers.map((_, i): AnimatedSpec => ({
      type: 'wiper',
      name: `wiper:${i}`,
      amplitude: 0.9,
      period: 1.6,
      phase: i * 0.4,
    })),
  ];
  const lights: LightMountSpec[] = [
    {
      kind: 'mastheadForward',
      position: [0, lines.deckY(FOREMAST_Z) + FORECASTLE_H + 25.05, FOREMAST_Z - 0.35],
      direction: [0, 0, -1],
    },
    { kind: 'mastheadAft', position: [0, BRIDGE_FLOOR + 3.6 + 13.55, MAST_Z - 0.4], direction: [0, 0, -1] },
    {
      kind: 'sidePort',
      position: [-(WING_HALF - 0.25), BRIDGE_FLOOR + 1.5, HOUSE_FRONT + 0.6],
      direction: [-0.83, 0, -0.56],
    },
    {
      kind: 'sideStarboard',
      position: [WING_HALF - 0.25, BRIDGE_FLOOR + 1.5, HOUSE_FRONT + 0.6],
      direction: [0.83, 0, -0.56],
    },
    {
      kind: 'stern',
      position: [0, lines.deckY(lines.zStern) + 1.2, lines.zStern - 0.35],
      direction: [0, 0, 1],
    },
    { kind: 'nucUpper', position: [0, BRIDGE_FLOOR + 3.6 + 10.6, MAST_Z - 0.7] },
    { kind: 'nucLower', position: [0, BRIDGE_FLOOR + 3.6 + 8.6, MAST_Z - 0.7] },
    { kind: 'anchorForward', position: [0, lines.deckY(FOREMAST_Z) + FORECASTLE_H + 13.8, FOREMAST_Z - 0.6] },
    { kind: 'anchorAft', position: [0, lines.deckY(lines.zStern) + 3.2, lines.zStern - 1] },
    ...[-1, 1].map((side): LightMountSpec => ({
      kind: 'searchlight',
      position: [
        side * SEARCH_X,
        SEARCH_FOOT + searchlightLens(SEARCH_R).y,
        SEARCH_Z + searchlightLens(SEARCH_R).z,
      ],
    })),
    { kind: 'deckFlood', position: [-3, BRIDGE_FLOOR - 0.3, HOUSE_FRONT - 0.5], direction: [0, -0.5, -1] },
    { kind: 'deckFlood', position: [3, BRIDGE_FLOOR - 0.3, HOUSE_FRONT - 0.5], direction: [0, -0.5, -1] },
    {
      kind: 'deckFlood',
      position: [0, lines.deckY(FOREMAST_Z) + FORECASTLE_H + 14.4, FOREMAST_Z + 0.6],
      direction: [0, -0.6, 1],
    },
  ];
  const floods: FloodSpec[] = [
    {
      position: [-3, BRIDGE_FLOOR - 0.3, HOUSE_FRONT - 0.6],
      target: [-4, 14, 20],
      intensity: 60000,
      angle: 0.55,
      distance: 160,
    },
    {
      position: [3, BRIDGE_FLOOR - 0.3, HOUSE_FRONT - 0.6],
      target: [4, 14, 20],
      intensity: 60000,
      angle: 0.55,
      distance: 160,
    },
    { position: [0, 27, FOREMAST_Z + 0.6], target: [0, 12, -60], intensity: 40000, angle: 0.6, distance: 90 },
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  return {
    kind: 'cargo',
    name: BOAT_CARDS.cargo.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        topside: 0x1d2f4d,
        topsideRoughness: 0.42,
        bands: [
          { below: 0.7, color: 0x18191a, roughness: 0.5 },
          { below: -1.4, color: 0x7a2a22, roughness: 0.8 },
        ],
        stain: 0.6,
        grime: 0.5,
        rust: 0.9,
        plates: { horizontal: 11.5, vertical: 2.6, frames: 0.8 },
        mask: {
          texture: hullMaskTexture(lines, {
            yMin: -T,
            yMax: 13,
            scuppers: Array.from({ length: 16 }, (_, i) => -98 + i * 13.2),
            hawse: [{ z: -113.6, y: 6.6 }],
            extraStreaks: 60,
          }),
          zBow: lines.zBow,
          length: lines.zStern - lines.zBow,
          yMin: -T,
          yMax: 13,
        },
      },
      deck: 0x4a5a4b,
      house: 0xece9e1,
      trim: 0xc9a34a,
      machinery: 0x4b6a73,
      grime: 0.4,
      rust: 0.25,
      windows: {
        deckHeight: (BRIDGE_FLOOR - CASING_TOP) / 7,
        sill: 0.95,
        height: 0.95,
        width: 1.15,
        pitch: 2.5,
        occupancy: 0.45,
        nits: 14,
      },
    },
    extraMaterials: (ao) => ({
      hatch: paintMaterial({
        color: 0x55605f,
        ao,
        grime: 0.45,
        rust: 0.3,
        plates: { horizontal: 3.2, vertical: 3.2 },
        name: 'hatch',
        detail: detail('hatch'),
      }),
      lashing: paintMaterial({
        color: 0xb9b5a6,
        ao,
        grime: 0.4,
        rust: 0.35,
        name: 'lashing',
        detail: detail('lashing'),
      }),
      funnel: paintMaterial({
        color: 0xe9e2d0,
        ao,
        grime: 0.45,
        streaks: 0.6,
        name: 'funnel',
        detail: detail('funnel'),
      }),
      funnelBand: paintMaterial({
        color: 0x1d2f4d,
        ao,
        grime: 0.3,
        name: 'funnelBand',
        detail: detail('funnelBand'),
      }),
      rudder: paintMaterial({ color: 0x7a2a22, ao, grime: 0.3, roughness: 0.8, name: 'rudder' }),
      containers: containerMaterial({ logos: logos.texture, rows: logos.rows, ao }),
      wiper: lampMaterial({ color: 0x000000, nits: 0, base: 0x111111, name: 'wiper' }),
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: parts[lod]!.builder,
      shadows: lod < 2,
      extras: (materials, ao) => [
        ...containerMeshes(containers, materials.containers!),
        ...radarMeshes(lod, materials),
        ...(lod < 2 ? decals(lines, ao, lod) : []),
        ...(lod < 2 ? funnelDecals(ao) : []),
        ...(lod === 0 ? wiperMeshes(parts[0]!.wipers, materials.wiper!) : []),
      ],
    })),
    aoVoxel: 0.8,
    aoLod: 1,
    aoBoxes,
    aoDistance: 9,
    lights,
    floods,
    animated,
    eye: new Vector3(0, 35, -121.5 + 190),
    wingEyes: {
      port: new Vector3(-(WING_HALF - 2), BRIDGE_FLOOR + 1.75, HOUSE_FRONT + 1.2),
      starboard: new Vector3(WING_HALF - 2, BRIDGE_FLOOR + 1.75, HOUSE_FRONT + 1.2),
    },
    waterMask: triMeshGeometry(physics.mesh),
  };
}
