// Cinematic auto-director: picks a shot (low waterline pass, chase, orbit, fly-by, fixed), holds
// it for 6–12 s and cuts to the next, never the same kind twice in a row. Big seas favour the low
// shots, where crests roll between the camera and the boat. Shot poses are pure functions of the
// boat's pose so they can be tested without a renderer; the rig keeps them out of the water and
// out of every hull.

import { type BoatCameraInfo, chaseDistance, type Vec3Like } from './boatCameraInfo';

export type ShotKind = 'waterline' | 'chase' | 'orbit' | 'flyby' | 'fixed';

export const SHOT_KINDS: readonly ShotKind[] = ['waterline', 'chase', 'orbit', 'flyby', 'fixed'];

export const SHOT_MIN_SECONDS = 6;
export const SHOT_MAX_SECONDS = 12;

export interface Shot {
  kind: ShotKind;
  duration: number; // s
  side: 1 | -1; // starboard / port of the boat, or the orbit's direction
  variant: number; // 0..1: distance and height variety within the kind
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// How dramatic the sea is: 0 up to 1 m significant wave height, 1 from 4 m.
export function seaDrama(hs: number): number {
  return clamp((hs - 1) / 3, 0, 1);
}

// Relative odds of each shot kind for a sea state.
export function shotWeights(hs: number): Record<ShotKind, number> {
  const d = seaDrama(hs);
  return {
    waterline: 1 + 3 * d,
    fixed: 1 + 1.5 * d,
    flyby: 1.2 + 0.5 * d,
    chase: 1.4,
    orbit: 1.2 - 0.7 * d,
  };
}

export function pickShotKind(
  weights: Record<ShotKind, number>,
  previous: ShotKind | null,
  random: () => number,
): ShotKind {
  const kinds = SHOT_KINDS.filter((kind) => kind !== previous);
  const total = kinds.reduce((sum, kind) => sum + weights[kind], 0);
  let r = random() * total;
  for (const kind of kinds) {
    r -= weights[kind];
    if (r < 0) return kind;
  }
  return kinds.at(-1) ?? 'chase';
}

export class Director {
  shot: Shot | null = null;
  elapsed = 0;
  private random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  // Starts a new shot; the camera cuts to it.
  next(hs: number): Shot {
    const r = this.random;
    const kind = pickShotKind(shotWeights(hs), this.shot?.kind ?? null, r);
    this.shot = {
      kind,
      duration: SHOT_MIN_SECONDS + r() * (SHOT_MAX_SECONDS - SHOT_MIN_SECONDS),
      side: r() < 0.5 ? -1 : 1,
      variant: r(),
    };
    this.elapsed = 0;
    return this.shot;
  }

  // Advances the shot clock; true when a new shot started this frame (cut to it).
  update(dt: number, hs: number): boolean {
    if (!this.shot) {
      this.next(hs);
      return true;
    }
    this.elapsed += dt;
    if (this.elapsed < this.shot.duration) return false;
    this.next(hs);
    return true;
  }

  reset(): void {
    this.shot = null;
    this.elapsed = 0;
  }
}

// ---------------------------------------------------------------------------
// Shot poses

export interface ShotContext {
  info: BoatCameraInfo;
  focus: Vec3Like; // smoothed boat position
  yaw: number; // smoothed boat heading as a yaw angle (forward = (−sin, 0, −cos))
  hs: number;
  elapsed: number; // s into the shot
  anchor: Vec3Like; // world point fixed at the shot's start (waterline and fixed shots)
}

export interface ShotPose {
  position: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  clearance: number; // metres above the local water
}

// The look-at point: a little above the boat's waterline reference.
function shotLookAt(info: BoatCameraInfo, focus: Vec3Like): { x: number; y: number; z: number } {
  return { x: focus.x, y: focus.y + Math.min(info.height * 0.3, 12), z: focus.z };
}

// Where world-fixed shots stand, chosen when the shot starts: ahead of the boat and off to one side
// so it sails past mid-shot. `speed` is the boat's speed along its heading (m/s).
export function shotAnchor(
  shot: Shot,
  info: BoatCameraInfo,
  position: Vec3Like,
  yaw: number,
  speed: number,
  hs: number,
): { x: number; y: number; z: number } {
  const { length: L, beam: B, height: H } = info;
  const d = seaDrama(hs);
  const ahead = Math.max(L * 0.4, Math.max(0, speed) * shot.duration * 0.5);
  let side: number;
  let height: number;
  if (shot.kind === 'waterline') {
    // Low, and further off in big seas so crests come between the camera and the boat.
    side = B / 2 + 6 + L * 0.2 + d * (L * 0.3 + 20);
    height = 0.4;
  } else {
    side = B / 2 + L * 0.5 + 15 + d * L * 0.2;
    height = 2 + H * 0.3 * (0.5 + shot.variant) * (1 - 0.6 * d);
  }
  side *= shot.side;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  return {
    x: position.x + fx * ahead + rx * side,
    y: position.y + height,
    z: position.z + fz * ahead + rz * side,
  };
}

export function shotPose(shot: Shot, ctx: ShotContext): ShotPose {
  const { info, focus, yaw, anchor } = ctx;
  const { length: L, beam: B, height: H } = info;
  const d = seaDrama(ctx.hs);
  const lookAt = shotLookAt(info, focus);
  const v = shot.variant;
  const orbitAround = (angle: number, distance: number, pitch: number): ShotPose['position'] => ({
    x: lookAt.x + Math.sin(angle) * Math.cos(pitch) * distance,
    y: lookAt.y + Math.sin(pitch) * distance,
    z: lookAt.z + Math.cos(angle) * Math.cos(pitch) * distance,
  });
  switch (shot.kind) {
    case 'chase': {
      const pitch = 0.03 + (0.08 + 0.2 * v) * (1 - 0.6 * d);
      const angle = yaw + shot.side * 0.35 * v;
      return {
        position: orbitAround(angle, chaseDistance(info) * (0.8 + 0.4 * v), pitch),
        lookAt,
        clearance: 1.2,
      };
    }
    case 'orbit': {
      const pitch = 0.1 + 0.25 * v * (1 - 0.6 * d);
      const angle = v * Math.PI * 2 + shot.side * 0.07 * ctx.elapsed;
      return {
        position: orbitAround(angle, chaseDistance(info) * (0.9 + 0.3 * v), pitch),
        lookAt,
        clearance: 1.2,
      };
    }
    case 'flyby': {
      // Passes the boat bow to stern at a steady pace in its heading frame.
      const u = clamp(ctx.elapsed / shot.duration, 0, 1);
      const along = (L * 0.9 + 15) * (1 - 2 * u);
      const side = shot.side * (B / 2 + L * 0.3 + 8);
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      return {
        position: {
          x: focus.x + fx * along + rx * side,
          y: focus.y + (H * 0.5 + 3 + v * H * 0.3) * (1 - 0.5 * d),
          z: focus.z + fz * along + rz * side,
        },
        lookAt,
        clearance: 1.2,
      };
    }
    case 'waterline':
      return { position: { x: anchor.x, y: anchor.y, z: anchor.z }, lookAt, clearance: 0.6 };
    case 'fixed':
      return { position: { x: anchor.x, y: anchor.y, z: anchor.z }, lookAt, clearance: 1.2 };
  }
}
