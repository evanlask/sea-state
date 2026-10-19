// Wheelhouse / bridge builder shared by the ships and workboats: walls with
// raked front windows (mullions, glass panes, sun visor), side windows, and an
// interior good enough for the first-person helm camera (console, chairs,
// steering stand, chart table, ceiling lights). Returns the wiper pivots so the
// model can add animated wipers.
//
// Frame: body coordinates; the house is centred on x = cx, front at zFront (bow side).

import { Shape, TorusGeometry } from 'three/webgpu';

import { at, atlasPlane, bevelBox, cylinder, extrude, type PartBuilder } from './geometry';
import { SLOTS } from './props';

export const BRIDGE_SLOTS = {
  frame: 'frame', // window mullions / frames
  floor: 'floor',
  console: 'console',
  ceiling: 'ceiling',
  ceilingLight: 'ceilingLight',
} as const;

const FLOOR_PROUD = 0.02; // m, the floor's top above floorY

export interface WheelhouseOptions {
  cx?: number;
  halfWidth: number;
  zFront: number;
  zAft: number;
  floorY: number;
  height: number; // floor to roof
  sill: number; // window sill above the floor
  head: number; // window head above the floor
  rake: number; // front windows lean outward at the top, rad
  panes: number; // front panes across
  sidePanes: number; // per side
  aftPanes?: number;
  visor?: number; // roof overhang forward, m
  wall?: string; // slot for the walls
  roof?: string;
  interior?: boolean;
  wipers?: number; // centre panes with wipers
  consoleWidth?: number; // fraction of the width
  chairs?: number;
  wallThickness?: number;
  mullion?: number; // window post width, m
}

export interface WiperPivot {
  position: [number, number, number];
  tilt: number; // rotation about x to lie in the window plane
  length: number;
}

export function wheelhouse(b: PartBuilder, o: WheelhouseOptions): { wipers: WiperPivot[]; eyeZ: number } {
  const cx = o.cx ?? 0;
  const W = o.halfWidth * 2;
  const L = o.zAft - o.zFront;
  const t = o.wallThickness ?? 0.2;
  const wall = o.wall ?? SLOTS.house;
  const roofSlot = o.roof ?? wall;
  const y0 = o.floorY;
  const yS = y0 + o.sill;
  const yH = y0 + o.head;
  const yR = y0 + o.height;
  const lean = (o.head - o.sill) * Math.tan(o.rake);
  const zTop = o.zFront - lean; // window head is further forward
  const box = (
    slot: string,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    bevel = 0.03,
    rx = 0,
  ): void => {
    b.add(slot, bevelBox(w, h, d, bevel), at(cx + x, y, z, rx));
  };
  // Floor slab and roof with a forward visor. The floor stands a little proud of floorY, where the
  // house it sits on usually has its roof: coplanar, the two would z-fight through the windows.
  box(BRIDGE_SLOTS.floor, W - 0.05, 0.25, L - 0.05, 0, y0 - 0.125 + FLOOR_PROUD, o.zFront + L / 2, 0.02);
  const visor = o.visor ?? 0.8;
  box(roofSlot, W + 0.3, 0.3, L + lean + visor, 0, yR + 0.15, o.zFront + L / 2 - (lean + visor) / 2, 0.1);
  // Front: sill wall, header (slanted to the visor), mullions and glass.
  box(wall, W, o.sill, t, 0, y0 + o.sill / 2, o.zFront + t / 2, 0.05);
  box(wall, W, yR - yH, t, 0, (yH + yR) / 2, zTop + t / 2, 0.05);
  const midY = (yS + yH) / 2;
  const midZ = (o.zFront + zTop) / 2;
  const paneH = (o.head - o.sill) / Math.cos(o.rake);
  const paneW = W / o.panes;
  for (let i = 0; i <= o.panes; i++) {
    const x = -W / 2 + i * paneW;
    box(
      BRIDGE_SLOTS.frame,
      o.mullion ?? 0.08,
      paneH,
      0.14,
      Math.min(W / 2 - 0.06, Math.max(-W / 2 + 0.06, x)),
      midY,
      midZ + 0.05,
      0.02,
      -o.rake,
    );
  }
  b.add(SLOTS.glass, atlasPlane(W, paneH, [0, 0], [1, 1]), at(cx, midY, midZ + 0.05, -o.rake + Math.PI));
  // Side walls with windows.
  const sidePaneL = L / o.sidePanes;
  for (const side of [-1, 1]) {
    const x = side * (o.halfWidth - t / 2);
    box(wall, t, o.sill, L, x, y0 + o.sill / 2, o.zFront + L / 2, 0.05);
    box(wall, t, yR - yH, L, x, (yH + yR) / 2, o.zFront + L / 2, 0.05);
    for (let i = 0; i <= o.sidePanes; i++) {
      const z = o.zFront + Math.min(L - 0.1, Math.max(0.1, i * sidePaneL));
      box(BRIDGE_SLOTS.frame, (o.mullion ?? 0.08) * 1.6, o.head - o.sill, 0.14, x, midY, z, 0.02);
    }
    b.add(
      SLOTS.glass,
      atlasPlane(L, o.head - o.sill, [0, 0], [1, 1]),
      at(cx + x, midY, o.zFront + L / 2, 0, (side * Math.PI) / 2),
    );
  }
  // Aft wall (optionally with windows).
  const aft = o.aftPanes ?? 0;
  if (aft > 0) {
    box(wall, W, o.sill, t, 0, y0 + o.sill / 2, o.zAft - t / 2, 0.05);
    box(wall, W, yR - yH, t, 0, (yH + yR) / 2, o.zAft - t / 2, 0.05);
    for (let i = 0; i <= aft; i++) {
      box(
        BRIDGE_SLOTS.frame,
        0.14,
        o.head - o.sill,
        0.16,
        Math.min(W / 2 - 0.07, Math.max(-W / 2 + 0.07, -W / 2 + (i * W) / aft)),
        midY,
        o.zAft - t / 2,
        0.02,
      );
    }
    b.add(SLOTS.glass, atlasPlane(W, o.head - o.sill, [0, 0], [1, 1]), at(cx, midY, o.zAft - t / 2));
  } else {
    box(wall, W, o.height, t, 0, y0 + o.height / 2, o.zAft - t / 2, 0.05);
  }
  // Wipers on the centre panes.
  const wipers: WiperPivot[] = [];
  const nW = Math.min(o.wipers ?? 0, o.panes);
  for (let k = 0; k < nW; k++) {
    const i = Math.floor((o.panes - nW) / 2) + k;
    const x = -W / 2 + (i + 0.5) * paneW;
    wipers.push({
      position: [cx + x, yS + 0.08, o.zFront - 0.06],
      tilt: -o.rake,
      length: Math.min(paneH * 0.75, paneW * 0.6),
    });
  }
  const eyeZ = o.zFront + 1.9;
  if (o.interior ?? true) interior(b, o, cx, W, L);
  return { wipers, eyeZ };
}

function interior(b: PartBuilder, o: WheelhouseOptions, cx: number, W: number, L: number): void {
  const y0 = o.floorY;
  // Ceiling and light panels.
  b.add(
    BRIDGE_SLOTS.ceiling,
    bevelBox(W - 0.4, 0.05, L - 0.4, 0.01),
    at(cx, y0 + o.height - 0.05, o.zFront + L / 2),
  );
  const lights = Math.max(2, Math.round(W / 3));
  for (let i = 0; i < lights; i++) {
    const x = -W / 2 + ((i + 0.5) * W) / lights;
    b.add(
      BRIDGE_SLOTS.ceilingLight,
      bevelBox(0.6, 0.03, 0.6, 0.005),
      at(cx + x, y0 + o.height - 0.09, o.zFront + L * 0.55),
    );
  }
  // Console: sloped desk along the front windows.
  const cw = W * (o.consoleWidth ?? 0.7);
  const deskH = Math.min(1.1, o.sill + 0.05);
  const depth = 0.95;
  const profile = new Shape();
  profile.moveTo(0, 0);
  profile.lineTo(0, deskH);
  profile.lineTo(depth * 0.35, deskH + 0.08);
  profile.lineTo(depth, deskH - 0.12);
  profile.lineTo(depth, 0);
  profile.closePath();
  const zc = o.zFront + 0.35;
  b.add(BRIDGE_SLOTS.console, extrude(profile, cw, 'x', { bevel: 0.03 }), at(cx, y0, zc));
  // Steering stand with a small wheel at the centre, aft of the console.
  b.add(BRIDGE_SLOTS.console, bevelBox(0.5, 1.0, 0.45, 0.04), at(cx - 1.4, y0 + 0.5, zc + depth + 0.3));
  b.add(SLOTS.chrome, new TorusGeometry(0.15, 0.012, 6, 20), at(cx - 1.4, y0 + 1.1, zc + depth + 0.25, -0.5));
  // Chairs.
  const chairs = o.chairs ?? 2;
  for (let i = 0; i < chairs; i++) {
    const x = (i - (chairs - 1) / 2) * Math.min(1.6, cw / Math.max(1, chairs));
    const z = zc + depth + 1.05;
    b.add(SLOTS.black, cylinder(0.05, 0.55, 8), at(cx + x, y0 + 0.28, z));
    b.add(SLOTS.black, bevelBox(0.55, 0.12, 0.55, 0.05), at(cx + x, y0 + 0.62, z));
    b.add(SLOTS.black, bevelBox(0.52, 0.65, 0.1, 0.05), at(cx + x, y0 + 1.0, z + 0.27, 0.1));
    b.add(SLOTS.black, bevelBox(0.06, 0.06, 0.4, 0.02), at(cx + x - 0.3, y0 + 0.8, z));
    b.add(SLOTS.black, bevelBox(0.06, 0.06, 0.4, 0.02), at(cx + x + 0.3, y0 + 0.8, z));
  }
  // Chart table and a back-wall cabinet.
  if (L > 3) {
    b.add(
      BRIDGE_SLOTS.console,
      bevelBox(Math.min(2.4, W * 0.3), 0.95, 1.1, 0.03),
      at(cx + W * 0.25, y0 + 0.475, o.zAft - 0.85),
    );
    b.add(
      BRIDGE_SLOTS.console,
      bevelBox(Math.min(3, W * 0.35), 1.8, 0.5, 0.03),
      at(cx - W * 0.22, y0 + 0.9, o.zAft - 0.45),
    );
  }
}
