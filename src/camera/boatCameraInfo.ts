// Per-boat camera geometry: overall size (for distances and the hull's bounding capsule), the helm
// eye point, and the optional bridge-wing and masthead eye points. Body frame: bow −Z, up +Y,
// starboard +X, origin on the centreline at the design waterline, amidships.

import { CC115_RIG } from '../sim/sail/rig';
import type { BoatKind } from '../sim/world/protocol';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface BoatCameraInfo {
  length: number;
  beam: number;
  height: number; // highest point above the waterline
  eye: Vec3Like; // helm eye point
  chase?: number; // chase and orbit distance, m (default chaseDistance's)
  chaseRise?: number; // rad, the chase camera's resting elevation over the others' (default 0)
  // Bridge-wing eye points (ships), looking along the ship's side: forward when the bridge is
  // aft (cargo), aft when it is forward (cruise), so the long side of the ship is in view.
  wings?: { port: Vec3Like; starboard: Vec3Like; lookAft: boolean };
  // Masthead camera (sailboat): just above the masthead, looking down at the deck and sails.
  mast?: { eye: Vec3Like; target: Vec3Like };
}

// How far behind the boat the chase (and orbit) camera sits at zoom 1.
export const chaseDistance = (info: BoatCameraInfo): number => info.chase ?? info.length * 1.25 + 8;

// Helm eye point from its distance aft of the bow and height above the waterline, in body coordinates.
const eyeFromBow = (length: number, aftOfBow: number, height: number, x = 0): Vec3Like => ({
  x,
  y: height,
  z: -length / 2 + aftOfBow,
});

// Bridge wings: the same points as the procedural models' `wingEyes` (render/boats/models).
const wings = (x: number, y: number, z: number, lookAft: boolean): BoatCameraInfo['wings'] => ({
  port: { x: -x, y, z },
  starboard: { x, y, z },
  lookAft,
});

export const BOAT_CAMERA_INFO: Record<BoatKind, BoatCameraInfo> = {
  cargo: {
    length: 243,
    beam: 32.2,
    height: 52,
    eye: eyeFromBow(243, 190, 35),
    // 2 m in from the wing tip: the sidelight screen box at the tip would otherwise fill the view.
    wings: wings(16.6 - 2, 33.3 + 1.75, 65.5 + 1.2, false),
  },
  cruise: {
    length: 317,
    beam: 36.8,
    height: 60,
    // Standing at the console, just aft of the desk and in front of the chairs.
    eye: eyeFromBow(317, 26.6, 33),
    // At the aft end of the enclosed wing, so its aft corner post sits at the edge of the view.
    wings: wings(36.8 / 2 + 1.6 - 1, 31.3 + 1.75, -133.5 + 4.4, true),
  },
  crab: { length: 38.1, beam: 8.8, height: 14, eye: eyeFromBow(38.1, 9.6, 7.5) },
  sail: {
    length: 11.5,
    beam: 3.65,
    height: 17,
    eye: eyeFromBow(11.5, 10.75, 2.15, 0.45),
    mast: {
      eye: { x: 0, y: CC115_RIG.mastheadY + 0.3, z: CC115_RIG.mastZ + 0.3 },
      target: { x: 0, y: CC115_RIG.deckY, z: 1.2 },
    },
  },
  powerboat: { length: 10.1, beam: 3.2, height: 3.4, eye: eyeFromBow(10.1, 5.35, 1.95) },
  // The rider's eyes: RIDER_EYE in render/boats/rider/pose.ts (rider/pose.test.ts keeps them equal).
  pwc: { length: 3.3, beam: 1.25, height: 1.4, eye: eyeFromBow(3.3, 1.65 - 0.199, 1.324) },
  // The driver's eyes in the safety capsule, under the canopy's crown (render/boats/models/hydro.ts
  // reads this eye); the wing's end plates are the highest point. The chase camera hangs back further
  // than the formula's and higher (~8 m up), so it looks down past the wing onto the rooster tail
  // behind the transom instead of into it.
  hydro: {
    length: 9.4,
    beam: 4.3,
    height: 1.7,
    eye: eyeFromBow(9.4, 2.4, 1.0),
    chase: 24,
    chaseRise: 0.14,
  },
};
