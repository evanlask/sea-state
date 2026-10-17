// Hull volumes for the particles: a simple solid outline of every boat that spray, mist, white water
// and rain splashes may not be inside, so none show through hulls, decks or cabins (from outside,
// from the helm or from a bridge). Particles spawned inside are never allocated; particles that fly
// into a hull die there, as spray landing on a deck does.
//
// The hull comes from the hull lines the models are lofted from, sampled at HULL_STATIONS stations
// from the stem to the transom: per station the half-breadth at the bottom of the topsides (the
// waterline, or the underside of an overhang above it), the half-breadth at the deck edge, the keel
// (bottom) height and the deck-edge height. The half-breadth is linear in height between the two.
// Open cockpits and wells count as solid up to the deck edge. Superstructure boxes (symmetric about
// the centreline) stand on the deck edge, clipped to the deck half-breadth. Everything is in the body
// frame: x starboard, y up from the design waterline, z aft.
//
// The same test runs on the CPU (emitters, tests) and in the particle kernels (HullVolumes.inside).
import { Vector4 } from 'three/webgpu';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import { RHO_SEAWATER } from '../../sim/core/units';
import type { BoatKind, BoatSnapshot } from '../../sim/world/protocol';
import { createHullLines } from '../boats/kit/hullLines';
import { type N, tsl } from '../tsl';
import type { Vec3Like } from './emissionQueue';

const {
  Fn,
  If,
  Loop,
  abs,
  clamp,
  cross,
  dot,
  float,
  floor,
  int,
  max,
  min,
  mix,
  saturate,
  uniform,
  uniformArray,
} = tsl;

const HULL_STATIONS = 16;
export const HULL_BOXES = 6;
const MAX_HULLS = 8; // MAX_FLEET + 1
const KIND_VEC4S = 1 + HULL_STATIONS + 2 * HULL_BOXES;
const KINDS: readonly BoatKind[] = ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc', 'hydro'];

interface HullBox {
  half: number; // m, half-width (clipped to the deck half-breadth)
  y: readonly [number, number]; // body y range, m (never below the deck edge)
  z: readonly [number, number]; // body z range, m
}

export interface HullVolume {
  zBow: number;
  zStern: number;
  // HULL_STATIONS × (bottom half-breadth, deck half-breadth, keel y, deck y), stem to transom.
  stations: Float32Array;
  boxes: readonly HullBox[];
  radius: number; // m, bounding sphere about the body origin
}

const ALL = 1e3; // a box half-width that the deck half-breadth always clips

// Superstructure from the models' layouts (render/boats/models/*.ts). Masts, rigging, sails, the
// T-top and the riders are left out: thin, and spray through them reads as passing beside them.
const SUPERSTRUCTURE: Record<BoatKind, readonly HullBox[]> = {
  cargo: [
    { half: ALL, y: [0, 12.4], z: [-125, -103.5] }, // forecastle
    { half: 15, y: [0, 26.4], z: [-101.5, 62] }, // deck stacks (laden; in ballast the boxes stand empty)
    { half: 12.5, y: [0, 14.2], z: [63.5, 91.5] }, // engine casing
    { half: 12.5, y: [0, 36.9], z: [65.5, 81.5] }, // accommodation and bridge
    { half: 15, y: [0, 24], z: [93.5, 107.5] }, // aft bay
  ],
  cruise: [
    { half: ALL, y: [0, 14.6], z: [-160, 160] }, // upper hull to deck 4
    { half: 16.7, y: [0, 38.4], z: [-133.5, 147] }, // superstructure to the balcony decks
    { half: 15, y: [0, 41.3], z: [-125.5, 119] }, // to the pool deck
  ],
  crab: [
    { half: ALL, y: [0, 4.3], z: [-21, -11.6] }, // whaleback
    { half: 3.3, y: [0, 5.8], z: [-11.6, -3.6] }, // deckhouse
    { half: 3.0, y: [0, 8.4], z: [-11.5, -6.4] }, // wheelhouse
  ],
  sail: [{ half: 1.05, y: [0, 1.42], z: [-2.85, 1.75] }], // cabin trunk
  powerboat: [{ half: 0.65, y: [0, 1.5], z: [-1.2, -0.3] }], // console
  pwc: [{ half: 0.45, y: [0, 0.8], z: [-1.3, 1.2] }], // hood, deck and seat
  hydro: [
    { half: 0.5, y: [0, 1.17], z: [-3.6, -1.7] }, // cockpit capsule and canopy
    { half: 0.66, y: [0, 1.15], z: [-1.7, 4.1] }, // engine cowling
    { half: 0.3, y: [0, 1.34], z: [-1.05, 0.9] }, // the turbine's air-intake scoop
  ],
};

const cache = new Map<BoatKind, HullVolume>();

// The kind's hull volume (built from its hull lines once, then cached).
export function hullVolume(kind: BoatKind): HullVolume {
  let volume = cache.get(kind);
  if (!volume) cache.set(kind, (volume = buildVolume(kind)));
  return volume;
}

function buildVolume(kind: BoatKind): HullVolume {
  const spec = BOAT_SPECS[kind];
  const lines = createHullLines(spec.hull, spec.mass / RHO_SEAWATER);
  const stations = new Float32Array(HULL_STATIONS * 4);
  let radius = 0;
  for (let i = 0; i < HULL_STATIONS; i++) {
    const z = lines.zBow + ((lines.zStern - lines.zBow) * i) / (HULL_STATIONS - 1);
    const keel = lines.keelY(z);
    const deck = lines.deckY(z);
    const bottom = Math.max(keel, 0);
    // A little above the bottom of the topsides: the girth samples' edge reads 0 exactly there.
    const low = lines.halfBreadthAt(z, bottom + 0.05 * Math.max(deck - bottom, 0));
    const half = lines.deckHalf(z);
    stations.set([Math.min(low, half), half, keel, deck], i * 4);
    radius = Math.max(radius, Math.hypot(half, Math.max(-keel, deck), z));
  }
  const boxes = SUPERSTRUCTURE[kind];
  for (const box of boxes) {
    const half = Math.min(box.half, spec.dimensions.beam / 2);
    for (const z of box.z) radius = Math.max(radius, Math.hypot(half, box.y[1], z));
  }
  return { zBow: lines.zBow, zStern: lines.zStern, stations, boxes, radius };
}

export interface HullStation {
  bottomHalf: number;
  deckHalf: number;
  keelY: number;
  deckY: number;
}

// The hull section at body z, linear between stations; null forward of the stem or aft of the transom.
export function hullStation(
  volume: HullVolume,
  z: number,
  out: HullStation = scratchStation,
): HullStation | null {
  const s = ((z - volume.zBow) / (volume.zStern - volume.zBow)) * (HULL_STATIONS - 1);
  if (!(s >= 0 && s <= HULL_STATIONS - 1)) return null;
  const i = Math.min(Math.floor(s), HULL_STATIONS - 2);
  const f = s - i;
  const a = volume.stations;
  const lerp = (k: number): number => (a[i * 4 + k] ?? 0) * (1 - f) + (a[i * 4 + 4 + k] ?? 0) * f;
  out.bottomHalf = lerp(0);
  out.deckHalf = lerp(1);
  out.keelY = lerp(2);
  out.deckY = lerp(3);
  return out;
}

// Hull half-breadth at body (z, y): 0 outside the hull's height range at that station.
export function hullHalfBreadth(volume: HullVolume, z: number, y: number): number {
  const st = hullStation(volume, z);
  if (!st || y < st.keelY || y > st.deckY) return 0;
  const bottom = Math.max(st.keelY, 0);
  const t = Math.min(Math.max((y - bottom) / Math.max(st.deckY - bottom, 1e-3), 0), 1);
  return st.bottomHalf + (st.deckHalf - st.bottomHalf) * t;
}

// Whether a body-frame point is inside the hull or its superstructure.
export function insideHull(volume: HullVolume, p: Vec3Like): boolean {
  const st = hullStation(volume, p.z);
  if (!st) return false;
  const x = Math.abs(p.x);
  if (p.y >= st.keelY && p.y <= st.deckY && x <= hullHalfBreadth(volume, p.z, p.y)) return true;
  for (const box of volume.boxes) {
    if (p.z < box.z[0] || p.z > box.z[1] || p.y < Math.max(box.y[0], st.deckY) || p.y > box.y[1]) continue;
    if (x <= Math.min(box.half, st.deckHalf)) return true;
  }
  return false;
}

const scratchStation: HullStation = { bottomHalf: 0, deckHalf: 0, keelY: 0, deckY: 0 };

// ---------------------------------------------------------------------------
// GPU side: every boat's pose plus the kinds' tables, as uniform arrays.

export class HullVolumes {
  private kinds: Vector4[] = [];
  private poses: Vector4[] = [];
  private kindArray: N;
  private poseArray: N;
  private count = uniform(0, 'int');
  private insideFn: N;

  constructor() {
    for (const kind of KINDS) {
      const volume = hullVolume(kind);
      this.kinds.push(new Vector4(volume.zBow, volume.zStern, volume.radius, 0));
      for (let i = 0; i < HULL_STATIONS; i++) {
        const s = volume.stations;
        this.kinds.push(new Vector4(s[i * 4], s[i * 4 + 1], s[i * 4 + 2], s[i * 4 + 3]));
      }
      for (let b = 0; b < HULL_BOXES; b++) {
        const box = volume.boxes[b];
        // An empty box has an empty height range.
        this.kinds.push(box ? new Vector4(box.half, box.y[0], box.y[1], 0) : new Vector4(0, 1, 0, 0));
        this.kinds.push(box ? new Vector4(box.z[0], box.z[1], 0, 0) : new Vector4(0, 0, 0, 0));
      }
    }
    for (let i = 0; i < MAX_HULLS * 2; i++) this.poses.push(new Vector4(0, 0, 0, 1));
    this.kindArray = uniformArray(this.kinds, 'vec4');
    this.poseArray = uniformArray(this.poses, 'vec4');
    this.insideFn = this.buildInside();
  }

  // The boats this frame (the interpolated states the boat models are drawn at).
  update(boats: readonly BoatSnapshot[]): void {
    const n = Math.min(boats.length, MAX_HULLS);
    for (let i = 0; i < n; i++) {
      const boat = boats[i]!;
      const p = boat.position;
      const o = boat.orientation;
      this.poses[i * 2]!.set(p.x, p.y, p.z, KINDS.indexOf(boat.kind));
      this.poses[i * 2 + 1]!.set(o.x, o.y, o.z, o.w);
    }
    this.count.value = n;
  }

  // Bool node: the world position is inside a boat. Shader only.
  inside(position: N): N {
    return this.insideFn(position);
  }

  private buildInside(): N {
    const kinds = this.kindArray;
    const poses = this.poseArray;
    return Fn(([position]: [N]) => {
      const inside = int(0).toVar();
      Loop({ start: int(0), end: this.count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const pose = poses.element(i.mul(2));
        const base = int(pose.w).mul(KIND_VEC4S).toVar();
        const header = kinds.element(base);
        const d = position.sub(pose.xyz).toVar();
        If(dot(d, d).lessThan(header.z.mul(header.z)), () => {
          // Into the body frame: rotate by the conjugate orientation.
          const q = poses.element(i.mul(2).add(1));
          const u = q.xyz.negate();
          const p = d.add(cross(u, cross(u, d).add(d.mul(q.w))).mul(2)).toVar();
          const s = p.z
            .sub(header.x)
            .div(header.y.sub(header.x))
            .mul(HULL_STATIONS - 1)
            .toVar();
          If(s.greaterThanEqual(0).and(s.lessThanEqual(HULL_STATIONS - 1)), () => {
            const k = int(clamp(floor(s), 0, HULL_STATIONS - 2)).toVar();
            const st = mix(
              kinds.element(base.add(1).add(k)),
              kinds.element(base.add(2).add(k)),
              s.sub(float(k)),
            ).toVar();
            const x = abs(p.x);
            const bottom = max(st.z, 0);
            const half = mix(st.x, st.y, saturate(p.y.sub(bottom).div(max(st.w.sub(bottom), 1e-3))));
            If(p.y.greaterThanEqual(st.z).and(p.y.lessThanEqual(st.w)).and(x.lessThanEqual(half)), () => {
              inside.assign(1);
            });
            for (let b = 0; b < HULL_BOXES; b++) {
              const b0 = kinds.element(base.add(1 + HULL_STATIONS + 2 * b));
              const b1 = kinds.element(base.add(2 + HULL_STATIONS + 2 * b));
              If(
                p.z
                  .greaterThanEqual(b1.x)
                  .and(p.z.lessThanEqual(b1.y))
                  .and(p.y.greaterThanEqual(max(b0.y, st.w)))
                  .and(p.y.lessThanEqual(b0.z))
                  .and(x.lessThanEqual(min(b0.x, st.y))),
                () => {
                  inside.assign(1);
                },
              );
            }
          });
        });
      });
      return inside.equal(1);
    });
  }
}
