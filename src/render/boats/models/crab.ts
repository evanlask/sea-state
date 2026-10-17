// Bering Sea crab boat (125 ft class, LOA 38.1 m, B 8.8 m) on the physics
// fishing hull: high whaleback forward, two-level house with a wheelhouse
// windowed all round (aft windows overlook the deck), mast with sodium/LED
// floodlight bars, radars and fishing lights, hydraulic crane, pot launcher
// and picking block on the starboard rail, instanced 7×7×3 ft pots with mesh
// webbing, bulwarks with freeing ports, buoys and coiled line.

import {
  BoxGeometry,
  type BufferGeometry,
  type Material,
  Mesh,
  type Object3D,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { crabSpec } from '../../../sim/boats/specs/crab';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
// The display names the menus and HUD use, so the hull lettering matches.
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { boatDetail } from '../detail/detail';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { AnimatedSpec, FloodSpec, LightMountSpec } from '../kit/BoatVisual';
import { wheelhouse, type WiperPivot } from '../kit/bridge';
import {
  at,
  atlasPlane,
  bevelBox,
  cylinder,
  extrude,
  metricPlane,
  normalizeGeometry,
  PartBuilder,
  rod,
} from '../kit/geometry';
import { addHull, flatDecal, hullDecal, raisedDeck } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import { instanced, layoutPots, placement, POT_HEIGHT, POT_SIZE, potCapacity } from '../kit/instancing';
import { hullMaskTexture, textDecalTexture } from '../kit/liveries';
import { bulwarks } from '../kit/loft';
import {
  type AoVolume,
  paintMaterial,
  simpleMaterial,
  webbingMaterial,
  windowFacadeMaterial,
} from '../kit/materials';
import {
  bollard,
  domeAntenna,
  floodlight,
  horn,
  ladder,
  lifebuoy,
  liferaft,
  merge,
  navLightHousing,
  radarScanner,
  railing,
  searchlight,
  searchlightLens,
  SLOTS,
  vent,
  whipAntenna,
} from '../kit/props';
import { DEFAULT_POT_COUNT } from './crabLoad';
import { wiperMeshes } from './shared';

const spec = crabSpec;
const T = spec.dimensions.draft;

const WHALEBACK_AFT = -11.6;
const HOUSE_FRONT = -11.6;
const HOUSE_AFT = -3.6;
const HOUSE_HALF = 3.3;
const LEVEL2_TOP = 5.8; // wheelhouse floor
// The wheelhouse stands back from the house front and a little narrower than it, so its roof and
// visor stay inside the deck edge where the bow narrows.
const WH_FRONT = -10.9;
const WH_AFT = -6.4;
const WH_HALF = 2.7;
const WH_TOP = LEVEL2_TOP + 2.6;
const MAST_Z = -8.4;
const SEARCH_Z = WH_FRONT + 0.6; // twin searchlights on the wheelhouse roof
const SEARCH_R = 0.16;
const STACK_X = 1.1; // exhaust stacks, either side just aft of the wheelhouse
const STACK_Z = WH_AFT + 0.25;
const STACK_R = 0.14;
const STACK_TOP = 10.1;
const BULWARK_H = 1.1;
const POT_DECK_Z0 = -2.6;
// Pots fill the deck tier by tier, as high as the load needs (the sim's PotStackSpec: 24 a tier,
// 200 pots ≈ 9 tiers).
const POT_MAX_TIERS = 10;

interface CrabParts {
  builder: PartBuilder;
  wipers: WiperPivot[];
  radars: { position: [number, number, number]; length: number; name: string }[];
}

// Where a house level of half-width `full` standing `edge` outside the deck edge (inside when
// negative) reaches its full width, going aft from z0.
function taperKnee(lines: HullLines, full: number, edge: number, z0: number): number {
  let z = z0;
  while (lines.deckHalf(z) + edge < full && z < lines.zStern) z += 0.05;
  return z;
}

// A house level in plan: half-width min(full, deck edge + edge) from z0 (front) to z1 (aft), so
// the front corners are angled to follow the narrowing deck; extruded up by `height` from y = 0.
function taperedSlab(
  lines: HullLines,
  full: number,
  edge: number,
  z0: number,
  z1: number,
  height: number,
  bevel: number,
): BufferGeometry {
  const knee = Math.min(z1, taperKnee(lines, full, edge, z0));
  const steps = 5;
  const starboard: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const z = z0 + ((knee - z0) * i) / steps;
    starboard.push([Math.min(full, lines.deckHalf(z) + edge), z]);
  }
  starboard.push([full, z1]);
  const port = starboard.map(([x, z]): [number, number] => [-x, z]).reverse();
  // Plan shape coordinates (x, −z): extruding along 'y' maps shape y to body −z.
  const shape = new Shape([...starboard, ...port].map(([x, z]) => new Vector2(x, -z)));
  return extrude(shape, height, 'y', { bevel });
}

function structure(lines: HullLines, lod: number): CrabParts {
  const b = new PartBuilder();
  const box = (
    slot: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    bevel = 0.04,
    ry = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(x, y, z, 0, ry));
  };
  const deckY = (z: number): number => lines.deckY(z);
  addHull(b, lines, {
    lod,
    sheerRail: { radius: 0.11, slot: 'rubRail', drop: 0.02 },
    rubbing: [{ y: 0.35, radius: 0.09, sFrom: 0.08, sTo: 0.99, slot: 'rubRail' }],
  });
  // Whaleback: the bow carried up and crowned, a long sheltered fo'c'sle.
  const sW = lines.sAt(WHALEBACK_AFT);
  const wb = raisedDeck(lines, {
    sFrom: 0,
    sTo: sW,
    height: (z) => 1.5 + 0.5 * Math.min(1, (WHALEBACK_AFT - z) / 6),
    stations: lod === 0 ? 24 : 10,
    crown: 0.55,
    flare: 0.1,
    rake: 0.45,
    rows: lod === 0 ? 5 : 2,
    across: lod === 0 ? 11 : 5,
  });
  b.addData(SLOTS.hull, wb.sides).addData('whaleTop', wb.top).addData(SLOTS.house, wb.bulkhead);
  // Bulwarks with freeing ports around the working deck.
  const sB = lines.sAt(HOUSE_FRONT + 0.4);
  const ports: { z0: number; z1: number }[] = [];
  for (let z = -2; z < lines.zStern - 1.2; z += 2.6) ports.push({ z0: z, z1: z + 0.9 });
  if (lod < 2) {
    b.addData(
      SLOTS.hull,
      bulwarks(lines, {
        sFrom: sB,
        sTo: 0.998,
        stations: lod === 0 ? 40 : 14,
        height: BULWARK_H,
        thickness: 0.12,
        flare: 0.08,
        ports: lod === 0 ? ports : [],
        portHeight: 0.3,
      }),
    );
  }
  const sternHalf = lines.deckHalf(lines.zStern - 0.1);
  box(
    SLOTS.hull,
    sternHalf * 2 + 0.1,
    BULWARK_H,
    0.14,
    0,
    deckY(lines.zStern) + BULWARK_H / 2,
    lines.zStern - 0.12,
    0.03,
  );
  box(
    'cap',
    sternHalf * 2 + 0.3,
    0.1,
    0.3,
    0,
    deckY(lines.zStern) + BULWARK_H + 0.05,
    lines.zStern - 0.12,
    0.03,
  );
  // Bulwark capping rail (a painted pipe rail on top).
  if (lod < 2) {
    for (const side of [-1, 1]) {
      const pts: Vector3[] = [];
      for (let z = HOUSE_FRONT + 0.4; z <= lines.zStern - 0.1; z += 1.2) {
        pts.push(
          new Vector3(side * (lines.deckHalf(z) + 0.08 * BULWARK_H - 0.06), deckY(z) + BULWARK_H + 0.04, z),
        );
      }
      for (let i = 0; i + 1 < pts.length; i++) b.add('cap', rod(pts[i]!, pts[i + 1]!, 0.07, 6));
    }
  }

  // Deckhouse level 1 (galley, staterooms) and level 2, wheelhouse on top.
  // The deck narrows toward the bow where the house starts, so each level's sides follow the deck
  // edge forward (angled front corners) until the deck is wide enough for the full width.
  const y1 = deckY(-7) + 2.45;
  const L1_EDGE = -0.16; // level 1 stands inside the bulwarks
  const LEDGE_EDGE = 0.05; // its roof ledge reaches just over them
  const L2_EDGE = -0.05;
  const L2_AFT = HOUSE_AFT - 2.2;
  const l1Knee = taperKnee(lines, HOUSE_HALF, L1_EDGE, HOUSE_FRONT);
  const l2Knee = taperKnee(lines, HOUSE_HALF - 0.2, L2_EDGE, HOUSE_FRONT);
  b.add(
    SLOTS.house,
    taperedSlab(lines, HOUSE_HALF, L1_EDGE, HOUSE_FRONT, HOUSE_AFT, y1 - deckY(-7) + 0.3, 0.12),
    at(0, deckY(-7) - 0.3, 0),
  );
  b.add(
    SLOTS.house,
    taperedSlab(lines, HOUSE_HALF + 0.3, LEDGE_EDGE, HOUSE_FRONT - 0.3, HOUSE_AFT + 0.3, 0.18, 0.05),
    at(0, y1, 0),
  );
  b.add(
    SLOTS.house,
    taperedSlab(lines, HOUSE_HALF - 0.2, L2_EDGE, HOUSE_FRONT, L2_AFT, LEVEL2_TOP - y1, 0.1),
    at(0, y1, 0),
  );
  const wh = wheelhouse(b, {
    halfWidth: WH_HALF,
    zFront: WH_FRONT,
    zAft: WH_AFT,
    floorY: LEVEL2_TOP,
    height: 2.6,
    sill: 1.0,
    head: 2.3,
    rake: 0.28,
    panes: 6,
    sidePanes: 3,
    aftPanes: 3,
    visor: 0.35,
    interior: lod === 0,
    wipers: lod === 0 ? 4 : 0,
    consoleWidth: 0.8,
    mullion: 0.055,
    chairs: 2,
    wall: SLOTS.house,
  });
  // Level 2 deck roof aft of the wheelhouse is an open deck with rails.
  if (lod < 2) {
    for (const side of [-1, 1] as const) {
      // Portholes along the full-width sides, aft of the angled front corners.
      const l1z0 = l1Knee + 0.2;
      const l1z1 = HOUSE_AFT - 0.5;
      b.add(
        'portholes',
        metricPlane(l1z1 - l1z0, y1 - deckY(-7) - 0.2),
        at(side * (HOUSE_HALF + 0.02), deckY(-7) + 0.1, (l1z0 + l1z1) / 2, 0, (side * Math.PI) / 2),
      );
      const l2z0 = l2Knee + 0.2;
      const l2z1 = L2_AFT - 0.3;
      b.add(
        'portholes',
        metricPlane(l2z1 - l2z0, LEVEL2_TOP - y1 - 0.2, 1.3),
        at(side * (HOUSE_HALF - 0.18), y1 + 0.1, (l2z0 + l2z1) / 2, 0, (side * Math.PI) / 2),
      );
    }
  }
  if (lod === 0) {
    railing(
      b,
      [
        new Vector3(-HOUSE_HALF, y1 + 0.18, HOUSE_AFT - 2.1),
        new Vector3(-HOUSE_HALF, y1 + 0.18, HOUSE_AFT + 0.2),
        new Vector3(HOUSE_HALF, y1 + 0.18, HOUSE_AFT + 0.2),
        new Vector3(HOUSE_HALF, y1 + 0.18, HOUSE_AFT - 2.1),
      ],
      { height: 1.0, spacing: 1.1, slot: 'cap' },
    );
    railing(
      b,
      [
        new Vector3(-WH_HALF, LEVEL2_TOP, WH_AFT),
        new Vector3(-WH_HALF + 0.1, LEVEL2_TOP, HOUSE_AFT - 2.3),
        new Vector3(WH_HALF - 0.1, LEVEL2_TOP, HOUSE_AFT - 2.3),
        new Vector3(WH_HALF, LEVEL2_TOP, WH_AFT),
      ],
      { height: 1.0, spacing: 1.1, slot: 'cap' },
    );
    railing(
      b,
      [
        new Vector3(-WH_HALF + 0.2, WH_TOP + 0.3, WH_FRONT + 0.2),
        new Vector3(WH_HALF - 0.2, WH_TOP + 0.3, WH_FRONT + 0.2),
        new Vector3(WH_HALF - 0.2, WH_TOP + 0.3, WH_AFT - 0.2),
        new Vector3(-WH_HALF + 0.2, WH_TOP + 0.3, WH_AFT - 0.2),
      ],
      { height: 0.9, spacing: 1.2, closed: true, slot: 'cap' },
    );
    // Doors, ladders, life-saving gear on the house.
    for (const side of [-1, 1]) {
      box(SLOTS.steel, 0.06, 1.9, 0.8, side * (HOUSE_HALF + 0.03), deckY(-5) + 1.0, -4.6, 0.02);
      ladder(b, at(side * (HOUSE_HALF - 0.6), y1 + 0.18, HOUSE_AFT - 2.25), LEVEL2_TOP - y1, 0.45);
      liferaft(b, at(side * 1.9, LEVEL2_TOP, HOUSE_AFT - 1.2, 0, Math.PI / 2), 1.2, 0.3);
      lifebuoy(b, at(side * (WH_HALF + 0.03), LEVEL2_TOP + 0.9, WH_AFT - 0.5, 0, Math.PI / 2), 0.3);
      vent(b, at(side * 2.0, deckY(-12.5) + 1.95, -14.5), { kind: 'gooseneck', r: 0.12, h: 0.6 });
    }
    ladder(b, at(0, WH_TOP, WH_AFT - 0.05, 0, Math.PI), 0.4, 0.45);
  }

  // Mast on the wheelhouse roof with floodlight bar, radars and fishing lights.
  const mastBase = WH_TOP + 0.3;
  b.add(SLOTS.house, cylinder(0.14, 6.2, 12, 0.08), at(0, mastBase + 3.1, MAST_Z));
  for (const x of [-1.2, 1.2])
    b.add(
      SLOTS.house,
      rod(new Vector3(x, mastBase, MAST_Z + 0.9), new Vector3(0, mastBase + 2.4, MAST_Z), 0.06, 6),
    );
  box(SLOTS.house, 4.2, 0.14, 0.18, 0, mastBase + 2.4, MAST_Z, 0.03);
  box(SLOTS.house, 2.0, 0.12, 0.12, 0, mastBase + 4.3, MAST_Z, 0.02);
  box(SLOTS.house, 1.8, 0.1, 1.4, 0, mastBase + 0.9, MAST_Z - 1.2, 0.02);
  // Dry exhaust stacks up the back of the wheelhouse, sooty at the top (render/particles/exhaust.ts
  // smokes from their tops).
  for (const side of [-1, 1]) {
    const x = side * STACK_X;
    const h = STACK_TOP - LEVEL2_TOP;
    b.add(SLOTS.steel, cylinder(STACK_R, h, 12), at(x, LEVEL2_TOP + h / 2, STACK_Z));
    b.add(SLOTS.black, cylinder(STACK_R + 0.012, 0.45, 12), at(x, STACK_TOP - 0.22, STACK_Z));
    box(SLOTS.steel, 0.08, 0.06, 0.3, x, WH_TOP - 0.2, WH_AFT + 0.1, 0.01); // bracket to the house
  }
  const radars: CrabParts['radars'] = [
    { position: [-0.55, mastBase + 1.0, MAST_Z - 1.4], length: 1.8, name: 'radar:a' },
    { position: [0.7, mastBase + 1.0, MAST_Z - 1.0], length: 1.2, name: 'radar:b' },
  ];
  if (lod === 0) {
    for (let i = 0; i < 6; i++)
      floodlight(b, at(-1.75 + i * 0.7, mastBase + 2.47, MAST_Z + 0.1, 0, Math.PI), 0.32, 0.75);
    for (const side of [-1, 1]) {
      floodlight(b, at(side * (HOUSE_HALF - 0.3), y1 + 1.4, HOUSE_AFT + 0.15, 0, Math.PI), 0.3, 0.55);
      searchlight(b, at(side * 1.6, WH_TOP + 0.3, SEARCH_Z), SEARCH_R);
    }
    navLightHousing(b, at(0, mastBase + 6.15, MAST_Z - 0.2), SLOTS.lampWhite, 0.3);
    navLightHousing(b, at(0, mastBase + 4.4, MAST_Z - 0.25), SLOTS.lampRed, 0.28);
    navLightHousing(b, at(0, mastBase + 3.3, MAST_Z - 0.25), SLOTS.lampWhite, 0.28);
    for (const side of [-1, 1]) {
      navLightHousing(
        b,
        at(side * (WH_HALF + 0.25), LEVEL2_TOP + 1.9, WH_FRONT + 0.6),
        side > 0 ? SLOTS.lampGreen : SLOTS.lampRed,
        0.3,
      );
      box(SLOTS.black, 0.05, 0.5, 0.7, side * (WH_HALF + 0.08), LEVEL2_TOP + 2.1, WH_FRONT + 0.75, 0.01);
      whipAntenna(b, at(side * 0.9, mastBase + 4.35, MAST_Z), 3.5);
      whipAntenna(b, at(side * 2.4, WH_TOP + 0.3, WH_AFT - 0.5), 4.5);
    }
    domeAntenna(b, at(-2.2, WH_TOP + 0.3, WH_FRONT + 1.6), 0.35);
    domeAntenna(b, at(2.4, WH_TOP + 0.3, WH_FRONT + 1.4), 0.12);
    horn(b, at(0, mastBase + 1.8, MAST_Z - 0.2), 0.5);
    navLightHousing(
      b,
      at(0, deckY(lines.zStern) + BULWARK_H + 0.9, lines.zStern - 0.3),
      SLOTS.lampWhite,
      0.25,
    );
    b.add('cap', cylinder(0.05, 0.9, 6), at(0, deckY(lines.zStern) + BULWARK_H + 0.45, lines.zStern - 0.3));
  }

  // Hydraulic crane (starboard, aft of the house), pot launcher and picking block.
  const craneX = 2.7;
  const craneZ = HOUSE_AFT + 1.0;
  const cy = deckY(craneZ);
  b.add('crane', cylinder(0.42, 2.6, 14), at(craneX, cy + 1.3, craneZ));
  b.add('crane', bevelBox(1.0, 0.7, 1.2, 0.08), at(craneX, cy + 2.9, craneZ));
  const boomFrom = new Vector3(craneX, cy + 3.1, craneZ);
  const boomTo = new Vector3(craneX - 1.2, cy + 6.6, craneZ + 9.5);
  b.add('crane', normalizeGeometry(rod(boomFrom, boomTo, 0.26, 8)));
  b.add(
    SLOTS.chrome,
    rod(new Vector3(craneX, cy + 1.8, craneZ + 0.3), boomFrom.clone().lerp(boomTo, 0.4), 0.08, 8),
  );
  b.add(
    'crane',
    rod(new Vector3(craneX, cy + 1.7, craneZ + 0.25), boomFrom.clone().lerp(boomTo, 0.25), 0.13, 8),
  );
  b.add(SLOTS.black, rod(boomTo, boomTo.clone().setY(boomTo.y - 3.2), 0.015, 4));
  b.add('crane', bevelBox(0.3, 0.4, 0.2, 0.05), at(boomTo.x, boomTo.y - 3.4, boomTo.z));
  // Pot launcher: tilting rack at the starboard rail amidships.
  const lz = 2.5;
  const lx = lines.deckHalf(lz) - 0.9;
  const ly = deckY(lz);
  b.add('crane', bevelBox(1.4, 0.35, 2.6, 0.05), at(lx, ly + 0.18, lz));
  for (const dz of [-1.0, 1.0]) {
    b.add('crane', bevelBox(0.18, 2.4, 0.18, 0.03), at(lx + 0.35, ly + 1.4, lz + dz, 0, 0, -0.35));
    b.add(
      SLOTS.chrome,
      rod(
        new Vector3(lx - 0.3, ly + 0.3, lz + dz * 0.8),
        new Vector3(lx + 0.1, ly + 1.4, lz + dz * 0.8),
        0.06,
        6,
      ),
    );
  }
  b.add('crane', bevelBox(0.16, 0.16, 2.2, 0.03), at(lx + 0.75, ly + 2.5, lz));
  // Picking block on a davit forward of the launcher.
  const bz = -1.2;
  const bx = lines.deckHalf(bz) - 0.5;
  b.add('crane', rod(new Vector3(bx, deckY(bz), bz), new Vector3(bx + 0.4, deckY(bz) + 3.6, bz), 0.12, 8));
  b.add(
    'crane',
    normalizeGeometry(new TorusGeometry(0.35, 0.09, 8, 16)),
    at(bx + 0.55, deckY(bz) + 3.2, bz, 0, Math.PI / 2),
  );
  if (lod === 0) {
    for (const side of [-1, 1]) {
      bollard(b, at(side * (lines.deckHalf(-13) - 0.5), deckY(-13) + 2.05, -13, 0, Math.PI / 2), 0.1);
      bollard(b, at(side * (lines.deckHalf(16) - 0.45), deckY(16), 16, 0, Math.PI / 2), 0.12);
    }
    // Buoys stacked at the stern and line coils.
    for (let i = 0; i < 10; i++) {
      const r = 0.38;
      const x = -2.6 + (i % 5) * 0.8;
      const y = deckY(lines.zStern - 1.0) + r + Math.floor(i / 5) * 0.72;
      b.add(
        i % 3 === 0 ? 'buoyPink' : SLOTS.orange,
        new SphereGeometry(r, 12, 8),
        at(x, y, lines.zStern - 0.8 - Math.floor(i / 5) * 0.2),
      );
    }
    for (let i = 0; i < 4; i++) {
      b.add(
        'rope',
        new TorusGeometry(0.45, 0.07, 6, 18),
        at(-3.0 + i * 0.95, deckY(14) + 0.08, 14.8 + (i % 2) * 0.4, Math.PI / 2),
      );
      b.add(
        'rope',
        new TorusGeometry(0.42, 0.07, 6, 18),
        at(-3.0 + i * 0.95, deckY(14) + 0.22, 14.8 + (i % 2) * 0.4, Math.PI / 2),
      );
    }
    // Rudder and propeller (visual).
    b.add('rudder', bevelBox(0.35, 2.6, 1.7, 0.12), at(0, -2.7, lines.zStern - 0.5));
    b.add('bronze', cylinder(0.3, 0.6, 10), at(0, -2.6, lines.zStern - 2.2, Math.PI / 2));
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      b.add(
        'bronze',
        bevelBox(0.06, 1.0, 0.55, 0.02),
        at(Math.sin(a) * 0.6, -2.6 + Math.cos(a) * 0.6, lines.zStern - 2.2, 0.4, 0, -a),
      );
    }
  }
  return { builder: b, wipers: wh.wipers, radars };
}

// Pot geometry, origin at the bottom centre: welded tube frame and webbing panels (uv in metres).
function potGeometry(): { frame: BufferGeometry; web: BufferGeometry } {
  const s = POT_SIZE;
  const h = POT_HEIGHT;
  const t = 0.05;
  const bars: BufferGeometry[] = [];
  const bar = (w: number, hh: number, d: number, x: number, y: number, z: number): void => {
    bars.push(normalizeGeometry(new BoxGeometry(w, hh, d)).translate(x, y, z));
  };
  for (const y of [t / 2, h - t / 2]) {
    for (const x of [-s / 2 + t / 2, s / 2 - t / 2]) bar(t, t, s, x, y, 0);
    for (const z of [-s / 2 + t / 2, s / 2 - t / 2]) bar(s, t, t, 0, y, z);
  }
  for (const x of [-s / 2 + t / 2, s / 2 - t / 2])
    for (const z of [-s / 2 + t / 2, s / 2 - t / 2]) bar(t, h, t, x, h / 2, z);
  // Tunnel eye frames on two sides.
  bar(0.04, 0.5, 0.04, -0.3, h / 2, s / 2 - 0.02);
  bar(0.04, 0.5, 0.04, 0.3, h / 2, s / 2 - 0.02);
  const webs: BufferGeometry[] = [];
  const panel = (
    w: number,
    hh: number,
    m: { x: number; y: number; z: number; ry: number; rx: number },
  ): void => {
    const g = normalizeGeometry(atlasPlane(w, hh, [0, 0], [w, hh]));
    g.rotateX(m.rx).rotateY(m.ry).translate(m.x, m.y, m.z);
    webs.push(g);
  };
  panel(s, h, { x: 0, y: h / 2, z: s / 2, ry: 0, rx: 0 });
  panel(s, h, { x: 0, y: h / 2, z: -s / 2, ry: Math.PI, rx: 0 });
  panel(s, h, { x: s / 2, y: h / 2, z: 0, ry: Math.PI / 2, rx: 0 });
  panel(s, h, { x: -s / 2, y: h / 2, z: 0, ry: -Math.PI / 2, rx: 0 });
  panel(s, s, { x: 0, y: h, z: 0, ry: 0, rx: -Math.PI / 2 });
  return { frame: merge(bars), web: merge(webs) };
}

function pots(lines: HullLines, count: number, materials: Record<string, Material>): Object3D[] {
  const z1 = lines.zStern - 1.6;
  const slots = layoutPots({
    count,
    z0: POT_DECK_Z0,
    z1,
    halfWidth: lines.deckHalf(6) - 0.5,
    deckY: lines.deckY(6),
    maxTiers: POT_MAX_TIERS,
    seed: 9,
  });
  // Follow the sheer: each pot sits on the local deck height.
  const matrices = slots.map((p) => placement(p.x, p.y - lines.deckY(6) + lines.deckY(p.z), p.z, p.yaw));
  const g = potGeometry();
  return [
    instanced(g.frame, materials.potFrame!, { matrices }, { name: 'pots' }),
    instanced(g.web, materials.webbing!, { matrices }, { castShadow: false, name: 'pot-webbing' }),
  ];
}

function decals(lines: HullLines, ao: AoVolume | null): Mesh[] {
  const name = BOAT_CARDS.crab.name.replace(/^F\/V\s+/, '').toUpperCase();
  const tex = textDecalTexture({ lines: [name], width: 1024, height: 128, color: '#f2efe6' });
  const out: Mesh[] = [];
  for (const side of [-1, 1] as const) {
    const zf = -18.2;
    out.push(
      hullDecal(
        lines,
        tex,
        {
          zFrom: zf,
          zTo: zf + 7.5,
          yFrom: lines.deckY(zf + 3.5) + 0.2,
          yTo: lines.deckY(zf + 3.5) + 1.05,
          side,
          nz: 16,
          ny: 2,
        },
        ao,
      ),
    );
  }
  const stern = textDecalTexture({
    lines: [name, 'KODIAK, AK'],
    width: 1024,
    height: 320,
    lineHeights: [0.5, 0.32],
  });
  const s = flatDecal(stern, 4.6, 1.4, ao);
  s.position.set(0, lines.deckY(lines.zStern) - 1.0, lines.zStern + 0.03);
  out.push(s);
  return out;
}

const detail = (part: string) => boatDetail('crab', part);

// Pots in one tier of the deck stack (the sim's PotStackSpec.perTier must match).
export function crabPotsPerTier(): number {
  const lines = createHullLines(spec.hull, spec.mass / RHO_SEAWATER);
  return potCapacity({
    z0: POT_DECK_Z0,
    z1: lines.zStern - 1.6,
    halfWidth: lines.deckHalf(6) - 0.5,
    deckY: lines.deckY(6),
    maxTiers: 1,
  });
}

export function crabDraft(potCount = DEFAULT_POT_COUNT): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const parts = [0, 1, 2].map((lod) => structure(lines, lod));
  const mastBase = WH_TOP + 0.3;
  const radarMeshes = (lod: number, materials: Record<string, Material>): Object3D[] =>
    parts[lod]!.radars.flatMap((r) => {
      const pedestal = new PartBuilder();
      const array = new Mesh(radarScanner(pedestal, at(0, 0, 0), r.length), materials[SLOTS.white]);
      const ped = pedestal.build(materials).group;
      ped.position.set(...r.position);
      array.position.set(...r.position);
      array.name = r.name;
      return lod === 0 ? [ped, array] : [ped];
    });
  const lights: LightMountSpec[] = [
    { kind: 'mastheadForward', position: [0, mastBase + 6.4, MAST_Z - 0.2], direction: [0, 0, -1] },
    {
      kind: 'sidePort',
      position: [-(WH_HALF + 0.25), LEVEL2_TOP + 2.1, WH_FRONT + 0.6],
      direction: [-0.83, 0, -0.56],
    },
    {
      kind: 'sideStarboard',
      position: [WH_HALF + 0.25, LEVEL2_TOP + 2.1, WH_FRONT + 0.6],
      direction: [0.83, 0, -0.56],
    },
    {
      kind: 'stern',
      position: [0, lines.deckY(lines.zStern) + BULWARK_H + 1.1, lines.zStern - 0.3],
      direction: [0, 0, 1],
    },
    { kind: 'fishingRed', position: [0, mastBase + 4.6, MAST_Z - 0.25] },
    { kind: 'fishingWhite', position: [0, mastBase + 3.5, MAST_Z - 0.25] },
    { kind: 'anchorForward', position: [0, lines.deckY(-17) + 2.6, -17] },
    ...[-1, 1].map((side): LightMountSpec => ({
      kind: 'searchlight',
      position: [
        side * 1.6,
        WH_TOP + 0.3 + searchlightLens(SEARCH_R).y,
        SEARCH_Z + searchlightLens(SEARCH_R).z,
      ],
    })),
    ...Array.from({ length: 6 }, (_, i): LightMountSpec => ({
      kind: 'deckFlood',
      position: [-1.75 + i * 0.7, mastBase + 2.6, MAST_Z + 0.35],
      direction: [0, -0.7, 1],
    })),
    { kind: 'deckFlood', position: [-(HOUSE_HALF - 0.3), 5.4, HOUSE_AFT + 0.35], direction: [0, -0.6, 1] },
    { kind: 'deckFlood', position: [HOUSE_HALF - 0.3, 5.4, HOUSE_AFT + 0.35], direction: [0, -0.6, 1] },
  ];
  const floods: FloodSpec[] = [
    {
      position: [-1.0, mastBase + 2.6, MAST_Z + 0.4],
      target: [-1.5, 1, 8],
      intensity: 25000,
      angle: 0.75,
      distance: 45,
    },
    {
      position: [1.0, mastBase + 2.6, MAST_Z + 0.4],
      target: [1.5, 1, 8],
      intensity: 25000,
      angle: 0.75,
      distance: 45,
    },
    {
      position: [-(HOUSE_HALF - 0.3), 5.4, HOUSE_AFT + 0.4],
      target: [-2.5, 1, 2],
      intensity: 12000,
      angle: 0.9,
      distance: 25,
    },
    {
      position: [HOUSE_HALF - 0.3, 5.4, HOUSE_AFT + 0.4],
      target: [3.5, 1, 3],
      intensity: 12000,
      angle: 0.9,
      distance: 25,
    },
  ];
  const animated: AnimatedSpec[] = [
    { type: 'radar', name: 'radar:a', rpm: 24 },
    { type: 'radar', name: 'radar:b', rpm: 30 },
    ...parts[0]!.wipers.map((_, i): AnimatedSpec => ({
      type: 'wiper',
      name: `wiper:${i}`,
      amplitude: 0.85,
      period: 1.3,
      phase: i * 0.5,
    })),
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  // Water mask: the canoe body plus the deck well inside the bulwarks.
  const well = new BoxGeometry(lines.deckHalf(6) * 2 - 0.3, BULWARK_H + 1.2, lines.zStern - HOUSE_AFT - 0.4);
  well.translate(0, lines.deckY(6) + (BULWARK_H + 1.2) / 2 - 1.2, (HOUSE_AFT + lines.zStern) / 2);
  const mask = merge([triMeshGeometry(physics.mesh), well]);
  return {
    kind: 'crab',
    name: BOAT_CARDS.crab.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        topside: 0x1f3a5c,
        topsideRoughness: 0.4,
        bands: [
          { below: 0.15, color: 0x161718, roughness: 0.55 },
          { below: -0.6, color: 0x8a2a20, roughness: 0.8 },
        ],
        stripes: [{ y0: 1.9, y1: 2.05, color: 0xe8e4da }],
        stain: 0.8,
        grime: 0.6,
        rust: 1.0,
        plates: { horizontal: 4.5, vertical: 1.5, frames: 0.5 },
        mask: {
          texture: hullMaskTexture(lines, {
            yMin: -T,
            yMax: 5,
            scuppers: Array.from({ length: 9 }, (_, i) => -1.5 + i * 2.6),
            hawse: [{ z: -17.2, y: 2.0 }],
            extraStreaks: 30,
            width: 1024,
            height: 256,
          }),
          zBow: lines.zBow,
          length: lines.zStern - lines.zBow,
          yMin: -T,
          yMax: 5,
        },
      },
      deck: 0x5c605e,
      deckWear: 0.6,
      house: 0xebe8df,
      trim: 0xc63a2a,
      machinery: 0x3f5f78,
      grime: 0.5,
      rust: 0.45,
      housePlates: { horizontal: 2.4, vertical: 2.4 },
    },
    extraMaterials: (ao) => ({
      whaleTop: paintMaterial({
        color: 0x8b8e8a,
        ao,
        grime: 0.55,
        rust: 0.4,
        name: 'whaleTop',
        detail: detail('whaleTop'),
      }),
      cap: paintMaterial({ color: 0xd8b03a, ao, grime: 0.45, rust: 0.4, name: 'cap', detail: detail('cap') }),
      rubRail: paintMaterial({
        color: 0x1b1c1d,
        ao,
        grime: 0.3,
        rust: 0.7,
        name: 'rubRail',
        detail: detail('rubRail'),
      }),
      crane: paintMaterial({
        color: 0xd8a21f,
        ao,
        grime: 0.5,
        rust: 0.5,
        streaks: 0.6,
        name: 'crane',
        detail: detail('crane'),
      }),
      rudder: paintMaterial({ color: 0x8a2a20, ao, roughness: 0.8, name: 'rudder' }),
      potFrame: simpleMaterial({
        color: 0x6f7472,
        roughness: 0.6,
        metalness: 0.6,
        ao,
        name: 'potFrame',
        detail: detail('potFrame'),
      }),
      webbing: webbingMaterial({ color: 0x3d4536 }),
      buoyPink: simpleMaterial({ color: 0xe0507a, roughness: 0.45, ao, name: 'buoyPink' }),
      rope: simpleMaterial({ color: 0xd7c25a, roughness: 0.85, ao, name: 'rope', detail: detail('rope') }),
      portholes: windowFacadeMaterial({
        pitch: 1.7,
        width: 0.75,
        height: 0.5,
        sill: 1.05,
        deckHeight: 10,
        corner: 0.06,
        occupancy: 0.5,
        nits: 12,
        frame: 0xebe8df,
        ao,
        seed: 2,
      }),
      wiper: simpleMaterial({ color: 0x111111, roughness: 0.6, name: 'wiper' }),
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: parts[lod]!.builder,
      shadows: lod < 2,
      extras: (materials, ao) => [
        ...(lod < 2 ? pots(lines, potCount, materials) : []),
        ...radarMeshes(lod, materials),
        ...(lod < 2 ? decals(lines, ao) : []),
        ...(lod === 0 ? wiperMeshes(parts[0]!.wipers, materials.wiper!) : []),
      ],
    })),
    aoVoxel: 0.18,
    aoLod: 1,
    aoDistance: 2.2,
    aoBoxes: layoutPots({
      count: potCount,
      z0: POT_DECK_Z0,
      z1: lines.zStern - 1.6,
      halfWidth: lines.deckHalf(6) - 0.5,
      deckY: lines.deckY(6),
      maxTiers: POT_MAX_TIERS,
      seed: 9,
    }).map((p) => ({
      min: [p.x - POT_SIZE / 2, p.y, p.z - POT_SIZE / 2],
      max: [p.x + POT_SIZE / 2, p.y + POT_HEIGHT * 0.5, p.z + POT_SIZE / 2],
    })),
    lights,
    floods,
    animated,
    eye: new Vector3(0, 7.5, -38.1 / 2 + 9.6),
    waterMask: mask,
  };
}
