// Cruise ship (Solstice-class-like, LOA 317 m, B 36.8 m) on the physics hull:
// fine raked bow, white upper hull with ocean-view window rows, recessed
// lifeboat deck with boats in davits, six balcony decks (instanced balconies,
// procedural cabin doors with night occupancy) terracing at the stern, bridge
// forward with wings beyond the hull, pool deck with solarium vault, pools,
// loungers, twin raked funnels and a lawn deck aft.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  BoxGeometry,
  CylinderGeometry,
  type Material,
  Mesh,
  type Object3D,
  TorusGeometry,
  Vector3,
} from 'three/webgpu';

import { cruiseSpec } from '../../../sim/boats/specs/cruise';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
// The display names the menus and HUD use, so the hull lettering matches.
import { BOAT_CARDS } from '../../../ui/menu/boats';
import { boatDetail } from '../detail/detail';
import { type ModelDraft, triMeshGeometry } from '../kit/assemble';
import type { AnimatedSpec, FloodSpec, LightMountSpec } from '../kit/BoatVisual';
import { wheelhouse, type WiperPivot } from '../kit/bridge';
import { emblemTexture } from '../kit/emblem';
import {
  at,
  atlasPlane,
  bevelBox,
  cylinder,
  extrude,
  normalizeGeometry,
  PartBuilder,
  roundedRect,
} from '../kit/geometry';
import { addHull, flatDecal, hullDecal, raisedDeck } from '../kit/hull';
import { createHullLines, type HullLines } from '../kit/hullLines';
import { instanced, placement } from '../kit/instancing';
import { draftMarksTexture, imoNumber, textDecalTexture } from '../kit/liveries';
import { hullPatch } from '../kit/loft';
import {
  type AoVolume,
  glassMaterial,
  paintMaterial,
  simpleMaterial,
  windowFacadeMaterial,
} from '../kit/materials';
import { alongPlan, planBlock, planFacade } from '../kit/plan';
import {
  bollard,
  davit,
  domeAntenna,
  enclosedLifeboat,
  horn,
  merge,
  navLightHousing,
  poleMast,
  radarScanner,
  railing,
  searchlight,
  searchlightLens,
  SLOTS,
  whipAntenna,
  winch,
} from '../kit/props';
import { wiperMeshes } from './shared';

const spec = cruiseSpec;
const T = spec.dimensions.draft;
const B2 = spec.dimensions.beam / 2;

const UPPER_HULL_TOP = 14.6; // deck 4
const BOAT_DECK_TOP = 20.4; // deck 5/6 (lifeboats hang below)
const DECK_H = 3.0;
const BALCONY_DECKS = 6; // decks 6–11
const BALCONY_TOP = BOAT_DECK_TOP + BALCONY_DECKS * DECK_H; // 38.4
const POOL_DECK = BALCONY_TOP + 2.9; // 41.3
const FRONT = -133.5; // superstructure / bridge front
const AFT = 141;
const BRIDGE_FLOOR = 31.3;
const BRIDGE_AFT = -126;
const WING_HALF = B2 + 1.6;
// Searchlights on the bridge-wing roofs, inboard of the sidelights.
const WING_ROOF = BRIDGE_FLOOR + 3.475;
const SEARCH_X = WING_HALF - 1.4;
const SEARCH_Z = FRONT + 1.4;
const SEARCH_R = 0.26;
const FUNNEL_Z = 46;
const LIFEBOAT_Z0 = -92;
const LIFEBOAT_Z1 = 92;
const BALCONY_PITCH = 3.6;

interface CruiseParts {
  builder: PartBuilder;
  wipers: WiperPivot[];
  radars: { position: [number, number, number]; length: number; name: string }[];
}

function structure(lines: HullLines, lod: number): CruiseParts {
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
  addHull(b, lines, {
    lod,
    bulb: {
      tipZ: -spec.dimensions.lwl / 2 - 3.2,
      length: 14,
      halfWidth: 2.4,
      halfHeight: 2.9,
      centreY: -T + 3.8,
    },
    deck: false,
  });
  // Upper hull carried vertically to deck 4, closed at the stern.
  const up = raisedDeck(lines, {
    sFrom: 0,
    sTo: 1,
    height: (z) => UPPER_HULL_TOP - lines.deckY(z) + (z < -120 ? ((-120 - z) / 38) ** 2 * 1.2 : 0),
    stations: lod === 0 ? 80 : lod === 1 ? 30 : 14,
    flare: 0,
    rake: 0.5,
    rows: lod === 0 ? 8 : 3,
    across: lod === 0 ? 9 : 5,
  });
  b.addData(SLOTS.hull, up.sides).addData(SLOTS.deck, up.top).addData(SLOTS.hull, up.bulkhead);

  // Lifeboat deck: recessed walls between the boat stations, flush beyond.
  const y4 = UPPER_HULL_TOP;
  b.add(
    SLOTS.house,
    planBlock(lines, { zFront: FRONT, zAft: AFT + 6, inset: 3.6, y0: y4, y1: BOAT_DECK_TOP }),
  );
  b.add(
    SLOTS.house,
    planBlock(lines, { zFront: FRONT, zAft: LIFEBOAT_Z0 - 2, inset: 0.4, y0: y4, y1: BOAT_DECK_TOP }),
  );
  b.add(
    SLOTS.house,
    planBlock(lines, { zFront: LIFEBOAT_Z1 + 2, zAft: AFT + 6, inset: 0.4, y0: y4, y1: BOAT_DECK_TOP }),
  );

  // Balcony decks: facade set back 1.7 m; slabs out to the hull line; terraces stepping aft.
  for (let k = 0; k < BALCONY_DECKS; k++) {
    const y0 = BOAT_DECK_TOP + k * DECK_H;
    const aft = AFT - Math.max(0, k - 1) * 4;
    b.add(
      SLOTS.house,
      planBlock(lines, { zFront: FRONT, zAft: aft - 1.7, inset: 1.7, y0, y1: y0 + DECK_H, bevel: 0.08 }),
    );
    b.add(
      SLOTS.house,
      planBlock(lines, { zFront: FRONT, zAft: aft, inset: 0.05, y0: y0 - 0.12, y1: y0 + 0.16, bevel: 0.05 }),
    );
    if (lod < 2) {
      for (const side of [-1, 1] as const) {
        b.add(
          'cabins',
          planFacade(lines, {
            zFront: FRONT + 6,
            zAft: aft - 4,
            inset: 1.7,
            y0,
            y1: y0 + DECK_H,
            side,
            n: 30,
          }),
        );
      }
      // Aft terrace: glass balustrade along the step edge.
      if (lod === 0) {
        const half = lines.deckHalf(aft) - 0.3;
        b.add('balconyGlass', atlasPlane(half * 2, 1.05, [0, 0], [1, 1]), at(0, y0 + 0.7, aft - 0.05));
        b.add('cabins', planFacadeAft(half * 2 - 3, y0, aft - 1.7));
      }
    }
  }
  // Roof slab of the balcony block and deck 12.
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: FRONT,
      zAft: AFT - 16,
      inset: 0.05,
      y0: BALCONY_TOP - 0.1,
      y1: BALCONY_TOP + 0.2,
      bevel: 0.05,
    }),
  );
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: FRONT + 8,
      zAft: AFT - 22,
      inset: 2.4,
      y0: BALCONY_TOP,
      y1: POOL_DECK,
      bevel: 0.1,
    }),
  );
  b.add(
    'teak',
    planBlock(lines, {
      zFront: FRONT + 8.2,
      zAft: AFT - 22.2,
      inset: 2.6,
      y0: POOL_DECK - 0.05,
      y1: POOL_DECK + 0.02,
      bevel: 0.01,
    }),
  );
  if (lod < 2) {
    for (const side of [-1, 1] as const) {
      b.add(
        'windows',
        planFacade(lines, {
          zFront: FRONT + 12,
          zAft: AFT - 26,
          inset: 2.4,
          y0: BALCONY_TOP,
          y1: POOL_DECK,
          side,
          n: 20,
        }),
      );
      // Ocean-view windows in the upper hull (decks 3–4) and portholes lower down.
      b.add(
        'windows',
        planFacade(lines, {
          zFront: -128,
          zAft: 146,
          inset: 0,
          y0: 7.4,
          y1: y4 - 0.4,
          side,
          n: 40,
          offset: 0.03,
        }),
      );
      b.addData(
        'portholes',
        hullPatch(lines, {
          zFrom: -118,
          zTo: 128,
          yFrom: 3.0,
          yTo: 4.8,
          side,
          nz: 60,
          ny: 1,
          offset: 0.03,
          uv: 'metric',
        }),
      );
    }
  }

  // Bridge (deck 10/11) with wings beyond the hull sides.
  const bridgeHalf = lines.deckHalf(FRONT + 2) - 2.2;
  const bridge = wheelhouse(b, {
    halfWidth: bridgeHalf,
    zFront: FRONT - 0.2,
    zAft: BRIDGE_AFT,
    floorY: BRIDGE_FLOOR,
    height: 3.2,
    sill: 1.1,
    head: 2.9,
    rake: 0.18,
    panes: 14,
    sidePanes: 3,
    visor: 1.0,
    interior: lod === 0,
    wipers: lod === 0 ? 4 : 0,
    consoleWidth: 0.45,
    chairs: 3,
    wall: SLOTS.house,
  });
  for (const side of [-1, 1]) {
    const x0 = bridgeHalf;
    const ww = WING_HALF - x0;
    const xm = side * (x0 + ww / 2);
    // Enclosed wings: floor, roof, front glass, and a glazed outer end over a waist-high bulwark (the
    // officer looks aft along the side through it).
    box(SLOTS.house, ww, 0.4, 5.5, xm, BRIDGE_FLOOR - 0.2, FRONT + 2.4, 0.08);
    box(SLOTS.house, ww + 0.2, 0.35, 5.9, xm, BRIDGE_FLOOR + 3.3, FRONT + 2.4, 0.1);
    box(SLOTS.house, ww, 1.1, 0.2, xm, BRIDGE_FLOOR + 0.55, FRONT - 0.2, 0.04);
    box(SLOTS.house, 0.25, 1.0, 5.5, side * (WING_HALF - 0.12), BRIDGE_FLOOR + 0.5, FRONT + 2.4, 0.04);
    for (const dz of [-0.35, 5.15])
      box(SLOTS.house, 0.25, 2.3, 0.2, side * (WING_HALF - 0.12), BRIDGE_FLOOR + 2.15, FRONT + dz, 0.03);
    b.add(
      SLOTS.glass,
      atlasPlane(ww, 2.0, [0, 0], [1, 1]),
      at(xm, BRIDGE_FLOOR + 2.1, FRONT - 0.2, 0, Math.PI),
    );
    b.add(
      SLOTS.glass,
      atlasPlane(5.0, 2.0, [0, 0], [1, 1]),
      at(side * WING_HALF + side * 0.01, BRIDGE_FLOOR + 2.0, FRONT + 2.4, 0, (side * Math.PI) / 2),
    );
    // Underside bracket.
    b.add(SLOTS.house, bevelBox(ww, 1.6, 5, 0.2), at(xm - side * 0.3, BRIDGE_FLOOR - 1.2, FRONT + 2.6));
    if (lod === 0) {
      navLightHousing(
        b,
        at(side * (WING_HALF - 0.1), BRIDGE_FLOOR + 3.5, FRONT + 0.8),
        side > 0 ? SLOTS.lampGreen : SLOTS.lampRed,
        0.45,
      );
      searchlight(b, at(side * SEARCH_X, WING_ROOF, SEARCH_Z), SEARCH_R);
    }
  }
  // Forward face windows of the balcony block (suites facing forward).
  if (lod < 2) {
    const fw = (lines.deckHalf(FRONT) - 1.7) * 2 - 1;
    for (let k = 0; k < BALCONY_DECKS; k++) {
      const y0 = BOAT_DECK_TOP + k * DECK_H;
      if (y0 + DECK_H > BRIDGE_FLOOR - 0.5 && y0 < BRIDGE_FLOOR + 3.5) continue;
      b.add('windows', facadePlane(fw, DECK_H, y0, FRONT - 0.04, Math.PI));
    }
  }

  // Pool deck: forward lounge, solarium vault, pools, loungers' bases, funnels, lawn deck aft.
  const lounge0 = FRONT + 10;
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: lounge0,
      zAft: lounge0 + 22,
      inset: 5.5,
      y0: POOL_DECK,
      y1: POOL_DECK + 5.4,
      bevel: 0.2,
    }),
  );
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: lounge0 + 1,
      zAft: lounge0 + 21,
      inset: 7,
      y0: POOL_DECK + 5.4,
      y1: POOL_DECK + 8.0,
      bevel: 0.2,
    }),
  );
  if (lod < 2) {
    for (const side of [-1, 1] as const) {
      b.add(
        'windows',
        planFacade(lines, {
          zFront: lounge0 + 2,
          zAft: lounge0 + 20,
          inset: 5.5,
          y0: POOL_DECK,
          y1: POOL_DECK + 5.4,
          side,
          n: 8,
        }),
      );
    }
    const lw = (lines.deckHalf(lounge0) - 5.5) * 2 - 1;
    b.add('panorama', facadePlane(lw, 5.0, POOL_DECK + 0.2, lounge0 - 0.04, Math.PI));
  }
  // Solarium: a glass barrel vault with ribs.
  const sol0 = lounge0 + 26;
  const solLen = 34;
  const solR = 11;
  const vault = normalizeGeometry(
    new CylinderGeometry(solR, solR, solLen, lod === 0 ? 24 : 10, 1, true, -Math.PI / 2, Math.PI),
  );
  vault.rotateX(-Math.PI / 2);
  vault.scale(1, 0.55, 1);
  b.add('vaultGlass', vault, at(0, POOL_DECK + 1.5, sol0 + solLen / 2));
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: sol0,
      zAft: sol0 + solLen,
      inset: 7.2,
      y0: POOL_DECK,
      y1: POOL_DECK + 1.5,
      bevel: 0.1,
      maxHalf: solR,
    }),
  );
  if (lod === 0) {
    for (let k = 0; k <= 8; k++) {
      const rib = normalizeGeometry(new TorusGeometry(solR, 0.14, 4, 20, Math.PI)).scale(1, 0.55, 1);
      b.add(SLOTS.house, rib, at(0, POOL_DECK + 1.5, sol0 + (k / 8) * solLen));
    }
  }
  // Main pool area.
  const poolZ = sol0 + solLen + 14;
  box('poolTile', 15, 0.6, 22, 0, POOL_DECK + 0.3, poolZ, 0.12);
  box('water', 13.6, 0.1, 20.6, 0, POOL_DECK + 0.58, poolZ, 0.02);
  for (const [x, z] of [
    [-9, poolZ - 13],
    [9, poolZ - 13],
    [-9, poolZ + 13],
    [9, poolZ + 13],
  ] as const) {
    b.add('poolTile', cylinder(2.0, 0.8, lod === 0 ? 20 : 10), at(x, POOL_DECK + 0.4, z));
    b.add('water', cylinder(1.8, 0.05, lod === 0 ? 20 : 10), at(x, POOL_DECK + 0.78, z));
  }
  // Twin raked funnels. Each body stops just under its wider black top, so their top faces
  // aren't coplanar (z-fighting).
  for (const side of [-1, 1]) {
    const g = extrude(roundedRect(3.8, 12, 1.8), 16.9, 'y', { bevel: 0.2 });
    // Rake aft: shear z by height.
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) + pos.getY(i) * 0.28);
    g.computeVertexNormals();
    b.add('funnel', g, at(side * 3.3, POOL_DECK, FUNNEL_Z));
    const top = extrude(roundedRect(3.95, 12.15, 1.85), 1.6, 'y', { bevel: 0.08 });
    const tp = top.getAttribute('position');
    for (let i = 0; i < tp.count; i++) tp.setZ(i, tp.getZ(i) + (tp.getY(i) + 15.4) * 0.28);
    b.add(SLOTS.black, top, at(side * 3.3, POOL_DECK + 15.4, FUNNEL_Z));
  }
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: FUNNEL_Z - 9,
      zAft: FUNNEL_Z + 14,
      inset: 9,
      y0: POOL_DECK,
      y1: POOL_DECK + 3.2,
      bevel: 0.2,
    }),
  );
  // Lawn deck aft (deck 15) on a glazed block.
  const lawn0 = AFT - 52;
  b.add(
    SLOTS.house,
    planBlock(lines, {
      zFront: lawn0,
      zAft: AFT - 22,
      inset: 3.4,
      y0: POOL_DECK,
      y1: POOL_DECK + 5.6,
      bevel: 0.15,
    }),
  );
  b.add(
    'grass',
    planBlock(lines, {
      zFront: lawn0 + 0.5,
      zAft: AFT - 22.6,
      inset: 4,
      y0: POOL_DECK + 5.6,
      y1: POOL_DECK + 5.7,
      bevel: 0.01,
    }),
  );
  if (lod < 2) {
    for (const side of [-1, 1] as const) {
      b.add(
        'panorama',
        planFacade(lines, {
          zFront: lawn0 + 1,
          zAft: AFT - 23,
          inset: 3.4,
          y0: POOL_DECK + 0.3,
          y1: POOL_DECK + 5.2,
          side,
          n: 10,
        }),
      );
    }
  }

  // Radar mast above the bridge, aft mast on the funnel casing.
  const mastY = POOL_DECK + 8.0;
  const mastZ = lounge0 + 12;
  poleMast(b, at(0, mastY, mastZ), {
    height: 9,
    radius: 0.35,
    top: 0.2,
    yard: { y: 3.5, span: 9 },
    slot: SLOTS.house,
  });
  box(SLOTS.house, 4, 0.2, 2.6, 0, mastY + 3.3, mastZ - 1.4, 0.05);
  const radars: CruiseParts['radars'] = [
    { position: [-2.6, mastY + 3.45, mastZ - 1.4], length: 3.0, name: 'radar:x' },
    { position: [2.6, mastY + 3.45, mastZ - 1.4], length: 3.9, name: 'radar:s' },
  ];
  poleMast(b, at(0, POOL_DECK + 3.2, FUNNEL_Z + 2), {
    height: 17,
    radius: 0.3,
    top: 0.15,
    slot: SLOTS.house,
  });
  if (lod === 0) {
    navLightHousing(b, at(0, mastY + 8.8, mastZ - 0.35), SLOTS.lampWhite, 0.45);
    navLightHousing(b, at(0, POOL_DECK + 3.2 + 16.8, FUNNEL_Z + 1.65), SLOTS.lampWhite, 0.45);
    for (const dy of [6.4, 4.6]) navLightHousing(b, at(0, mastY + dy, mastZ - 0.6), SLOTS.lampRed, 0.35);
    whipAntenna(b, at(4.2, mastY + 3.6, mastZ), 4);
    whipAntenna(b, at(-4.2, mastY + 3.6, mastZ), 4);
    domeAntenna(b, at(6, POOL_DECK + 8.0, mastZ + 6), 1.2);
    domeAntenna(b, at(-6, POOL_DECK + 8.0, mastZ + 6), 1.2);
    horn(b, at(0, POOL_DECK + 3.2 + 9, FUNNEL_Z + 1.6), 1.4);
    // Railings round the open decks.
    for (const side of [-1, 1]) {
      railing(
        b,
        [
          new Vector3(side * (lines.deckHalf(-150) - 0.3), y4, -150),
          new Vector3(side * (lines.deckHalf(FRONT) - 0.3), y4, FRONT - 1),
        ],
        { height: 1.1, spacing: 1.5 },
      );
      b.add(
        'balconyGlass',
        planFacade(lines, {
          zFront: FRONT + 9,
          zAft: AFT - 23,
          inset: 2.6,
          y0: POOL_DECK,
          y1: POOL_DECK + 1.2,
          side: side as 1 | -1,
          n: 20,
          offset: 0,
        }),
      );
      // Foredeck mooring gear.
      winch(b, at(side * 4.5, y4, -141), { drum: 0.6, width: 1.3, windlass: true });
      winch(b, at(side * 5.5, y4, -136.5), { drum: 0.5, width: 1.2 });
      bollard(b, at(side * (lines.deckHalf(-146) - 1.3), y4, -146, 0, Math.PI / 2), 0.25);
    }
  }

  return { builder: b, wipers: bridge.wipers, radars };
}

// Facade plane (metric uv) across a flat end, bottom at y0, facing −z when ry = π.
function facadePlane(
  w: number,
  h: number,
  y0: number,
  z: number,
  ry: number,
): ReturnType<typeof normalizeGeometry> {
  const g = atlasPlane(w, h, [0, 0], [w, h]);
  g.translate(0, h / 2 + y0, 0);
  if (ry !== 0) g.rotateY(ry);
  g.translate(0, 0, z);
  return g;
}

function planFacadeAft(w: number, y0: number, z: number): ReturnType<typeof normalizeGeometry> {
  return facadePlane(w, DECK_H, y0, z + 0.04, 0);
}

function balconyGeometry(lod: number): { frame: ReturnType<typeof merge>; glass: ReturnType<typeof merge> } {
  const p = BALCONY_PITCH;
  // LOD1 uses plain boxes (12 triangles) instead of bevelled ones (44).
  const part = (w: number, h: number, d: number): ReturnType<typeof merge> =>
    normalizeGeometry(lod === 0 ? bevelBox(w, h, d, 0.025) : new BoxGeometry(w, h, d));
  const divider = part(1.6, 2.6, 0.1).translate(0.85, 1.3, 0);
  const rail = part(0.07, 0.07, p).translate(1.62, 1.1, p / 2);
  const glass = normalizeGeometry(atlasPlane(p - 0.1, 1.0, [0, 0], [1, 1]))
    .rotateY(Math.PI / 2)
    .translate(1.6, 0.6, p / 2);
  return { frame: mergeGeometries([divider, rail], false)!, glass };
}

function balconies(lines: HullLines, materials: Record<string, Material>, lod: number): Object3D[] {
  const matrices = [];
  for (let k = 0; k < BALCONY_DECKS; k++) {
    const y0 = BOAT_DECK_TOP + k * DECK_H;
    const aft = AFT - Math.max(0, k - 1) * 4;
    for (const side of [-1, 1] as const) {
      for (const [x, z, yaw] of alongPlan(lines, FRONT + 6, aft - 4, 1.7, BALCONY_PITCH, side)) {
        const yWithinBridge =
          y0 + DECK_H > BRIDGE_FLOOR - 0.5 && y0 < BRIDGE_FLOOR + 3.5 && z < BRIDGE_AFT + 4;
        if (yWithinBridge) continue;
        matrices.push(placement(x, y0 + 0.16, z, yaw));
      }
    }
  }
  const g = balconyGeometry(lod);
  return [
    instanced(g.frame, materials[SLOTS.house]!, { matrices }, { name: 'balconies' }),
    instanced(g.glass, materials.balconyGlass!, { matrices }, { castShadow: false, name: 'balcony-glass' }),
  ];
}

function lifeboats(lines: HullLines, materials: Record<string, Material>, lod: number): Object3D[] {
  const out: Object3D[] = [];
  const hull = enclosedLifeboat(10.8, 4.4, 3.4, lod === 0 ? 18 : 8, lod === 0 ? 16 : 8);
  const matrices = [];
  const davits = new PartBuilder();
  const n = 8;
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const z = LIFEBOAT_Z0 + 6 + ((LIFEBOAT_Z1 - LIFEBOAT_Z0 - 12) * i) / (n - 1);
      const x = side * (lines.deckHalf(z) - 1.9);
      matrices.push(placement(x, UPPER_HULL_TOP + 1.1, z, 0));
      if (lod < 2) {
        for (const dz of [-3.6, 3.6])
          davit(
            davits,
            at(side * (lines.deckHalf(z) - 3.7), UPPER_HULL_TOP, z + dz, 0, side > 0 ? 0 : Math.PI),
            4.6,
            1.9,
            SLOTS.steel,
          );
      }
    }
  }
  out.push(instanced(hull, materials[SLOTS.orange]!, { matrices }, { name: 'lifeboats' }));
  if (lod < 2) out.push(davits.build(materials).group);
  return out;
}

function loungers(materials: Record<string, Material>): Object3D[] {
  const g = merge([
    normalizeGeometry(bevelBox(0.7, 0.12, 1.9, 0.03)).translate(0, 0.35, 0),
    normalizeGeometry(bevelBox(0.68, 0.08, 0.7, 0.03))
      .rotateX(-0.9)
      .translate(0, 0.55, 0.85),
  ]);
  const matrices = [];
  const z0 = FRONT + 8 + 26 + 34 + 14;
  for (const side of [-1, 1]) {
    for (let r = 0; r < 3; r++) {
      for (let i = 0; i < 12; i++)
        matrices.push(placement(side * (9.5 + r * 2.4), POOL_DECK, z0 - 16 + i * 2.6 + r * 0.3, 0));
    }
  }
  return [instanced(g, materials.lounger!, { matrices }, { name: 'loungers' })];
}

function decals(lines: HullLines, ao: AoVolume | null): Mesh[] {
  const name = BOAT_CARDS.cruise.name.replace(/^MS\s+/, '').toUpperCase();
  const out: Mesh[] = [];
  const bow = textDecalTexture({ lines: [name], width: 2048, height: 192, color: '#1b2a4a', weight: '600' });
  const marks = draftMarksTexture(T, 10, -8.3, 2.0, '#f2efe6');
  for (const side of [-1, 1] as const) {
    out.push(
      hullDecal(lines, bow, { zFrom: -150, zTo: -128, yFrom: 4.4, yTo: 6.4, side, nz: 24, ny: 2 }, ao),
    );
    out.push(
      hullDecal(lines, marks, { zFrom: -140, zTo: -139.4, yFrom: -8.3, yTo: 2.0, side, nz: 2, ny: 16 }, ao),
    );
  }
  const stern = textDecalTexture({
    lines: [name, 'NASSAU', imoNumber(9133)],
    width: 2048,
    height: 640,
    color: '#1b2a4a',
    lineHeights: [0.42, 0.3, 0.16],
  });
  const s = flatDecal(stern, 16, 4.6, ao);
  s.position.set(0, 10.5, lines.zStern + 0.04);
  out.push(s);
  return out;
}

const detail = (part: string) => boatDetail('cruise', part);

export function cruiseDraft(): ModelDraft {
  const volume = spec.mass / RHO_SEAWATER;
  const lines = createHullLines(spec.hull, volume);
  const parts = [0, 1, 2].map((lod) => structure(lines, lod));
  const emblem = emblemTexture({ disc: '#1b2a4a', mark: '#e9c46a', ring: '#e9c46a', kind: 'wave' });
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
  const funnelDecals = (ao: AoVolume | null): Mesh[] =>
    [-1, 1].map((side) => {
      const d = flatDecal(emblem, 4.5, 4.5, ao);
      d.position.set(side * 5.25 + side * 0.03, POOL_DECK + 11, FUNNEL_Z + 3.1);
      d.rotation.y = (side * Math.PI) / 2;
      return d;
    });
  const mastY = POOL_DECK + 8.0;
  const mastZ = FRONT + 22;
  const lights: LightMountSpec[] = [
    { kind: 'mastheadForward', position: [0, mastY + 9.1, mastZ - 0.35], direction: [0, 0, -1] },
    { kind: 'mastheadAft', position: [0, POOL_DECK + 3.2 + 17.1, FUNNEL_Z + 1.65], direction: [0, 0, -1] },
    {
      kind: 'sidePort',
      position: [-(WING_HALF - 0.1), BRIDGE_FLOOR + 3.75, FRONT + 0.8],
      direction: [-0.83, 0, -0.56],
    },
    {
      kind: 'sideStarboard',
      position: [WING_HALF - 0.1, BRIDGE_FLOOR + 3.75, FRONT + 0.8],
      direction: [0.83, 0, -0.56],
    },
    { kind: 'stern', position: [0, UPPER_HULL_TOP + 0.6, lines.zStern + 0.1], direction: [0, 0, 1] },
    { kind: 'nucUpper', position: [0, mastY + 6.6, mastZ - 0.6] },
    { kind: 'nucLower', position: [0, mastY + 4.8, mastZ - 0.6] },
    { kind: 'anchorForward', position: [0, UPPER_HULL_TOP + 6, lines.zBow + 4] },
    { kind: 'anchorAft', position: [0, UPPER_HULL_TOP + 1.2, lines.zStern - 0.5] },
    ...[-1, 1].map((side): LightMountSpec => ({
      kind: 'searchlight',
      position: [
        side * SEARCH_X,
        WING_ROOF + searchlightLens(SEARCH_R).y,
        SEARCH_Z + searchlightLens(SEARCH_R).z,
      ],
    })),
    { kind: 'deckFlood', position: [0, POOL_DECK + 7, FUNNEL_Z - 10], direction: [0, -1, 0.3] },
  ];
  const floods: FloodSpec[] = [
    {
      position: [0, POOL_DECK + 9, FUNNEL_Z - 12],
      target: [0, POOL_DECK, FUNNEL_Z - 30],
      intensity: 9000,
      angle: 0.8,
      distance: 80,
    },
    {
      position: [0, POOL_DECK + 8, AFT - 60],
      target: [0, POOL_DECK, AFT - 30],
      intensity: 7000,
      angle: 0.8,
      distance: 60,
    },
  ];
  const animated: AnimatedSpec[] = [
    { type: 'radar', name: 'radar:x', rpm: 26 },
    { type: 'radar', name: 'radar:s', rpm: 22 },
    ...parts[0]!.wipers.map((_, i): AnimatedSpec => ({
      type: 'wiper',
      name: `wiper:${i}`,
      amplitude: 0.9,
      period: 1.7,
      phase: i * 0.3,
    })),
  ];
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  return {
    kind: 'cruise',
    name: BOAT_CARDS.cruise.name,
    length: spec.dimensions.loa,
    palette: {
      hull: {
        topside: 0xf1f0eb,
        topsideRoughness: 0.35,
        bands: [
          { below: 2.4, color: 0x1b2a4a, roughness: 0.4 },
          { below: -1.4, color: 0x7a2a22, roughness: 0.8 },
        ],
        stripes: [{ y0: 2.6, y1: 2.85, color: 0xc9a14a }],
        stain: 0.35,
        grime: 0.25,
        rust: 0.25,
        plates: { horizontal: 12, vertical: 2.7, frames: 0.75 },
      },
      deck: 0x6d7378,
      house: 0xf2f1ec,
      trim: 0x1b2a4a,
      machinery: 0x5f6b70,
      grime: 0.22,
      rust: 0.05,
      housePlates: { horizontal: 3.2, vertical: DECK_H },
      windows: {
        pitch: 3.0,
        width: 1.9,
        height: 1.25,
        sill: 0.95,
        deckHeight: DECK_H,
        occupancy: 0.55,
        nits: 16,
        corner: 0.15,
        glass: 0x18262e,
      },
    },
    extraMaterials: (ao) => ({
      cabins: windowFacadeMaterial({
        pitch: BALCONY_PITCH,
        width: 2.9,
        height: 2.25,
        sill: 0.25,
        deckHeight: DECK_H,
        shape: 'door',
        occupancy: 0.6,
        nits: 14,
        frame: 0xe9e8e2,
        glass: 0x1a2a33,
        ao,
        seed: 3,
        corner: 0.04,
      }),
      portholes: windowFacadeMaterial({
        pitch: 2.2,
        width: 0.5,
        height: 0.5,
        sill: 0.6,
        deckHeight: 10,
        shape: 'round',
        occupancy: 0.4,
        nits: 10,
        frame: 0xf1f0eb,
        ao,
        seed: 5,
      }),
      panorama: windowFacadeMaterial({
        pitch: 2.2,
        width: 2.05,
        height: 4.4,
        sill: 0.3,
        deckHeight: 10,
        occupancy: 0.95,
        nits: 18,
        frame: 0x2a3036,
        glass: 0x1b2c36,
        ao,
        seed: 7,
        corner: 0.02,
      }),
      balconyGlass: glassMaterial({ tint: 0x6f8f98, outside: 0.35, inside: 0.25 }),
      vaultGlass: glassMaterial({ tint: 0x3a5a66, outside: 0.6, inside: 0.3 }),
      teak: simpleMaterial({ color: 0x8a6440, roughness: 0.7, ao, name: 'teak', detail: detail('teak') }),
      poolTile: simpleMaterial({ color: 0xdfe6e8, roughness: 0.4, ao, name: 'poolTile' }),
      water: simpleMaterial({ color: 0x1f8fb0, roughness: 0.05, name: 'pool' }),
      grass: simpleMaterial({ color: 0x4f7a35, roughness: 0.95, ao, name: 'grass' }),
      lounger: simpleMaterial({ color: 0xe8e4da, roughness: 0.6, ao, name: 'lounger' }),
      funnel: paintMaterial({
        color: 0xf2f1ec,
        ao,
        grime: 0.3,
        streaks: 0.5,
        name: 'funnel',
        detail: detail('funnel'),
      }),
      wiper: simpleMaterial({ color: 0x111111, roughness: 0.6, name: 'wiper' }),
    }),
    lods: [0, 1, 2].map((lod) => ({
      builder: parts[lod]!.builder,
      shadows: lod < 2,
      extras: (materials, ao) => [
        ...(lod < 2 ? balconies(lines, materials, lod) : []),
        ...lifeboats(lines, materials, lod),
        ...(lod === 0 ? loungers(materials) : []),
        ...radarMeshes(lod, materials),
        ...(lod < 2 ? decals(lines, ao) : []),
        ...(lod < 2 ? funnelDecals(ao) : []),
        ...(lod === 0 ? wiperMeshes(parts[0]!.wipers, materials.wiper!) : []),
      ],
    })),
    aoVoxel: 0.9,
    aoLod: 1,
    aoDistance: 9,
    lights,
    floods,
    animated,
    eye: new Vector3(0, 33, -158.6 + 26.7),
    wingEyes: {
      port: new Vector3(-(WING_HALF - 1), BRIDGE_FLOOR + 1.75, FRONT + 4.4),
      starboard: new Vector3(WING_HALF - 1, BRIDGE_FLOOR + 1.75, FRONT + 4.4),
    },
    waterMask: triMeshGeometry(physics.mesh),
  };
}
