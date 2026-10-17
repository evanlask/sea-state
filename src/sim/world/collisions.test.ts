// Boat–boat contact between the compound hull shapes: boats touch where their hulls do (bow to bow
// at about the sum of their half-lengths, side by side at the sum of their half-beams), a jet ski
// clear of a ship's bow taper — or under its flare — doesn't touch it, and the contact point gives
// the impulse a sensible lever arm (a glancing blow on the bow spins the boat, head-on doesn't).

import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../boats/specs/index';
import { headingToVector } from '../core/conventions';
import { type CollisionHull, contactBetween, resolveCollisions } from './collisions';
import { chainHalfBreadth, collisionShapeFor } from './collisionShapes';
import type { BoatKind, SimConfig } from './protocol';
import { flatOcean, SimWorld } from './SimWorld';

const KINDS: BoatKind[] = ['pwc', 'powerboat', 'sail', 'crab', 'cargo', 'cruise'];

// One of each boat (two jet skis and two center consoles), placed by hand.
const world = new SimWorld(
  {
    seed: 1,
    physicsMode: 'arcade',
    boats: ([...KINDS, 'pwc', 'powerboat'] as BoatKind[]).map((kind, i) => ({
      id: `${kind}-${i}`,
      kind,
      x: i * 1000,
      z: 0,
      heading: 0,
    })),
    wind: { speed: 0, from: 0, gustFactor: 1 },
    seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
    oceanQuality: 'low',
  } satisfies SimConfig,
  flatOcean,
);
const hulls = [...KINDS, 'pwc', 'powerboat'].map((kind, i) => world.boat(`${kind}-${i}`)!.collision);
const hullOf = (kind: BoatKind, second = false): CollisionHull =>
  second ? hulls[kind === 'pwc' ? 6 : 7]! : hulls[KINDS.indexOf(kind)]!;

// Origin on the design waterline at (x, z), level, at rest.
function place(h: CollisionHull, x: number, z: number, heading: number): void {
  world.boat(h.id)!.dyn.placeAtRest(x, z, heading);
}

// Distance at which B, moved along the line from A (heading `bearing` from A), first touches A.
function touchDistance(A: CollisionHull, B: CollisionHull, bearing: number, headingB: number): number {
  const dir = headingToVector(bearing);
  let lo = 0;
  let hi = 1000;
  for (let i = 0; i < 60; i++) {
    const d = 0.5 * (lo + hi);
    place(B, dir.x * d, dir.z * d, headingB);
    if (contactBetween(A, B)) lo = d;
    else hi = d;
  }
  return 0.5 * (lo + hi);
}

// Places A to starboard of B (at rest at the origin) at body z, just touching (2 cm in).
function alongside(A: CollisionHull, B: CollisionHull, z: number, heading: number): void {
  let lo = 0;
  let hi = 50;
  for (let i = 0; i < 50; i++) {
    const x = 0.5 * (lo + hi);
    place(A, x, z, heading);
    if (contactBetween(A, B)) lo = x;
    else hi = x;
  }
  place(A, lo - 0.02, z, heading);
}

const halfLength = (kind: BoatKind): number => BOAT_SPECS[kind].dimensions.loa / 2;
const halfBeam = (kind: BoatKind): number => BOAT_SPECS[kind].dimensions.beam / 2;

describe('collision shapes', () => {
  it('are a handful of convex prisms per boat', () => {
    for (const kind of KINDS) {
      const shape = collisionShapeFor(kind);
      expect(shape.pieces.length).toBeGreaterThanOrEqual(2);
      expect(shape.pieces.length).toBeLessThanOrEqual(5);
      for (const p of shape.pieces) {
        const n = p.xs.length;
        expect(n).toBeGreaterThanOrEqual(3);
        expect(n).toBeLessThanOrEqual(12);
        // Convex: every vertex on the inner side of every edge.
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const d = p.nxs[i]! * (p.xs[j]! - p.xs[i]!) + p.nzs[i]! * (p.zs[j]! - p.zs[i]!);
            expect(d).toBeLessThan(1e-6);
          }
        }
        expect(p.y1).toBeGreaterThan(p.y0);
      }
      // As long and as wide as the boat (within a few per cent).
      expect((shape.zStern - shape.zBow) / BOAT_SPECS[kind].dimensions.loa).toBeGreaterThan(0.98);
      expect((shape.zStern - shape.zBow) / BOAT_SPECS[kind].dimensions.loa).toBeLessThan(1.035); // (the sailboat's swim step)
      expect(shape.halfBeam / halfBeam(kind)).toBeGreaterThan(0.98);
      expect(shape.halfBeam / halfBeam(kind)).toBeLessThan(1.04);
    }
  });

  it('touch bow to bow at about the sum of the half-lengths', () => {
    const pairs: [BoatKind, BoatKind][] = [
      ['pwc', 'pwc'],
      ['powerboat', 'powerboat'],
      ['powerboat', 'sail'],
      ['crab', 'cargo'],
      ['cargo', 'cruise'],
    ];
    for (const [a, b] of pairs) {
      const A = hullOf(a);
      const B = hullOf(b, a === b);
      place(A, 0, 0, 0);
      const d = touchDistance(A, B, 0, Math.PI);
      const expected = halfLength(a) + halfLength(b);
      expect(Math.abs(d - expected) / expected, `${a}–${b}: ${d.toFixed(2)} m`).toBeLessThan(0.025);
    }
  });

  it('touch side by side at the sum of the half-beams', () => {
    const pairs: [BoatKind, BoatKind][] = [
      ['pwc', 'pwc'],
      ['pwc', 'powerboat'],
      ['powerboat', 'sail'],
      ['sail', 'crab'],
      ['crab', 'cargo'],
      ['cargo', 'cruise'],
    ];
    for (const [a, b] of pairs) {
      const A = hullOf(a);
      const B = hullOf(b, a === b);
      place(A, 0, 0, 0);
      const d = touchDistance(A, B, Math.PI / 2, 0);
      const expected = halfBeam(a) + halfBeam(b);
      expect(Math.abs(d - expected) / expected, `${a}–${b}: ${d.toFixed(2)} m`).toBeLessThan(0.03);
    }
  });

  it("lets a jet ski lie close beside a ship's bow taper, and under its flare", () => {
    for (const ship of ['cargo', 'cruise'] as const) {
      const S = hullOf(ship);
      const J = hullOf('pwc');
      place(S, 0, 0, 0);
      const shape = collisionShapeFor(ship);
      const low = shape.pieces.find((p) => p.name === 'bow-low')!;
      const high = shape.pieces.find((p) => p.name === 'bow-high')!;
      // 15 m aft of the waterline stem, the jet ski lying alongside, heading the same way.
      const stem = Math.min(...low.zs);
      const z = stem + 15;
      const side = (p: typeof low): number => {
        const pts = Array.from(p.xs, (x, i) => ({ x, z: p.zs[i]! }))
          .filter((q) => q.x >= 0)
          .sort((u, v) => u.z - v.z);
        return chainHalfBreadth(pts, z);
      };
      const hullHalf = side(low);
      const flareHalf = side(high);
      expect(flareHalf - hullHalf).toBeGreaterThan(1); // the flare stands well out over the water
      const jetHalf = collisionShapeFor('pwc').halfBeam;
      // Half a metre clear of the hull at the waterline: under the flare, but not touching.
      place(J, hullHalf + jetHalf + 0.5, z, 0);
      expect(contactBetween(S, J)).toBeNull();
      // Also clear of a bounding capsule of radius half the beam.
      expect(hullHalf + jetHalf + 0.5).toBeLessThan(halfBeam(ship));
      // Nudged against the hull, it touches.
      place(J, hullHalf + jetHalf - 0.2, z, 0);
      expect(contactBetween(S, J)).not.toBeNull();
    }
  });

  it('spins a boat struck a glancing blow on the bow, but not one struck head-on', () => {
    const A = hullOf('pwc');
    const B = hullOf('powerboat');
    const shapeB = collisionShapeFor('powerboat');
    // Glancing: the jet ski, moving to port, catches the console's starboard bow.
    place(B, 0, 0, 0);
    const zHit = shapeB.zBow + 1.5;
    alongside(A, B, zHit, Math.PI / 2); // the jet ski's stern against the console's side
    A.body.velocity.x = -4;
    resolveCollisions([A, B]);
    const glancing = B.body.angularVelocity.y;
    // The bow is pushed to port: positive yaw rate (counter-clockwise from above).
    expect(glancing).toBeGreaterThan(0.05);
    // Head-on: the jet ski runs straight into the stem along the centreline.
    place(B, 0, 0, 0);
    place(A, 0, shapeB.zBow - 1.63, Math.PI);
    A.body.velocity.z = 4;
    resolveCollisions([A, B]);
    expect(Math.abs(B.body.angularVelocity.y)).toBeLessThan(0.05 * glancing);
    expect(B.body.velocity.z).toBeGreaterThan(0.1); // pushed aft along its length
    // Side by side: a push amidships moves the boat sideways without spinning it much.
    place(B, 0, 0, 0);
    alongside(A, B, (shapeB.zBow + shapeB.zStern) / 2, 0);
    A.body.velocity.x = -4;
    resolveCollisions([A, B]);
    expect(B.body.velocity.x).toBeLessThan(-0.1);
    expect(Math.abs(B.body.angularVelocity.y)).toBeLessThan(0.35 * glancing);
  });

  it('is deterministic', () => {
    const run = (): number[] => {
      const A = hullOf('pwc');
      const B = hullOf('crab');
      place(B, 0, 0, 0.3);
      place(A, 4, -15, 1.2);
      A.body.velocity.x = -3;
      A.body.velocity.z = 1;
      resolveCollisions([A, B]);
      return [A.body.position.x, A.body.position.z, B.body.angularVelocity.y, A.body.velocity.x];
    };
    expect(run()).toEqual(run());
  });

  it('stays cheap: eight boats, broad phase first', () => {
    // A fleet spread out (the usual case) and one piled together (every pair in contact).
    for (const spacing of [150, 12]) {
      hulls.forEach((h, i) => place(h, (i % 4) * spacing, Math.floor(i / 4) * spacing, 0.4 * i));
      const saved = hulls.map((h) => ({ ...h.body.position }));
      const n = 2000;
      const t = performance.now();
      for (let k = 0; k < n; k++) {
        resolveCollisions(hulls);
        hulls.forEach((h, i) => Object.assign(h.body.position, saved[i]));
      }
      const us = ((performance.now() - t) / n) * 1000;
      // Generous bounds (a shared CI machine); measured ~1 µs spread out and ~10 µs piled up,
      // against ~2 ms for the whole 120 Hz world step with eight boats.
      expect(us).toBeLessThan(spacing > 100 ? 25 : 250);
    }
  });
});
