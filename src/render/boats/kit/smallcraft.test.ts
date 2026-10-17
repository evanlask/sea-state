// Pure helpers behind the small-craft models: lofts and foils, strakes, girth-split hull shells,
// deck regions, normal smoothing and the telemetry drives / limb IK.

import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../../sim/boats/specs/index';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { approach, driveTarget, twoBoneJoint } from './animate';
import { createHullLines } from './hullLines';
import { deckRegion, hullShell, smoothNormalsAlong, triangleCountOf } from './loft';
import { bottomStrakes, foilLoft, loftRings, nacaHalfThickness, sculpt, superRing } from './sculpt';

const pb = BOAT_SPECS.powerboat;
const planing = createHullLines(pb.hull, pb.mass / RHO_SEAWATER);
const sail = BOAT_SPECS.sail;
const sailing = createHullLines(sail.hull, sail.mass / RHO_SEAWATER);

// Signed volume of a closed mesh (positive when the faces point outward).
function volume(data: { positions: Float32Array; indices: Uint32Array }): number {
  const p = data.positions;
  let v = 0;
  for (let t = 0; t < data.indices.length; t += 3) {
    const [a, b, c] = [data.indices[t]! * 3, data.indices[t + 1]! * 3, data.indices[t + 2]! * 3];
    v +=
      (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
        p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
        p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
      6;
  }
  return v;
}

describe('sculpt', () => {
  it('rings a superellipse through its extremes', () => {
    const ring = superRing({ z: 2, y: 1, hw: 0.5, top: 0.3, bottom: 0.2, n: 4 }, 16);
    expect(ring).toHaveLength(16);
    expect(ring[0]).toEqual([0.5, 1, 2]);
    expect(ring[4]![1]).toBeCloseTo(1.3, 6);
    expect(ring[12]![1]).toBeCloseTo(0.8, 6);
  });

  it('lofts closed solids with outward faces whatever the ring order', () => {
    // Off the origin, so both caps count toward the signed volume (an inward cap would subtract).
    const sections = [1, 2, 3].map((z) => ({ z, y: 0, hw: 0.5, top: 0.5, bottom: 0.5, n: 2 }));
    const a = loftRings(
      sections.map((s) => superRing(s, 24)),
      { capStart: true, capEnd: true },
    );
    const b = loftRings(
      sections.map((s) => superRing(s, 24).reverse()),
      { capStart: true, capEnd: true },
    );
    // A cylinder of radius 0.5 and length 2 (the polygon is slightly smaller).
    expect(volume(a)).toBeGreaterThan(1.5);
    expect(volume(a)).toBeLessThan(Math.PI * 0.25 * 2);
    expect(volume(b)).toBeCloseTo(volume(a), 6);
  });

  it('faces open strips away from a given inside point', () => {
    const strip = loftRings(
      [
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        [
          [0, 0, 1],
          [1, 0, 1],
        ],
      ],
      { closed: false, inside: [0.5, -1, 0.5] },
    );
    for (let i = 1; i < strip.normals.length; i += 3) expect(strip.normals[i]!).toBeGreaterThan(0.99);
  });

  it('follows the NACA thickness distribution', () => {
    expect(nacaHalfThickness(0, 0.12)).toBeCloseTo(0, 6);
    // Maximum ≈ t/2 at 30% chord.
    expect(nacaHalfThickness(0.3, 0.12)).toBeCloseTo(0.06, 3);
    expect(nacaHalfThickness(1, 0.12)).toBeLessThan(0.002);
  });

  it('builds foils spanning their sections', () => {
    const fin = foilLoft(
      [
        { y: 0, chord: 1, le: -0.5 },
        { y: -1, chord: 0.6, le: -0.2 },
      ],
      16,
    );
    let minY = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < fin.positions.length; i += 3) {
      minY = Math.min(minY, fin.positions[i + 1]!);
      maxZ = Math.max(maxZ, fin.positions[i + 2]!);
    }
    expect(minY).toBeCloseTo(-1, 6);
    expect(maxZ).toBeCloseTo(0.5, 6);
  });

  it('pointed ends close a sculpted body', () => {
    const body = sculpt(
      [0, 0.5, 1].map((t) => ({ z: t, y: 0, hw: Math.sin(Math.PI * t) * 0.3 + 1e-3, top: 0.2, bottom: 0.2 })),
      12,
    );
    expect(triangleCountOf(body)).toBe(2 * 12 * 2);
  });
});

describe('small-craft hull pieces', () => {
  it('splits the shell at the chine into bottom and topsides', () => {
    const o = { stations: 20, below: 6, above: 4 };
    const all = hullShell(planing, o);
    const bottom = hullShell(planing, { ...o, girth: 'bottom' });
    const topsides = hullShell(planing, { ...o, girth: 'topsides' });
    expect(triangleCountOf(bottom) + triangleCountOf(topsides)).toBe(triangleCountOf(all));
    // The bottom stays below the topsides at every station.
    const top = (d: typeof bottom): number =>
      Math.max(...Array.from(d.positions).filter((_, i) => i % 3 === 1));
    expect(top(bottom)).toBeLessThanOrEqual(top(topsides));
  });

  it('runs strakes along the bottom, below the chine', () => {
    const strakes = bottomStrakes(planing, [0.5], { stations: 12, sFrom: 0.3, sTo: 0.9, width: 0.05 });
    // Two faces per station interval, plus an end cap at each end, on both sides.
    expect(triangleCountOf(strakes)).toBe(2 * (11 * 2 * 2 + 2));
    for (let i = 1; i < strakes.positions.length; i += 3) expect(strakes.positions[i]!).toBeLessThan(0.5);
  });

  it('pieces decks between athwartships edges on the cambered surface', () => {
    const side = deckRegion(sailing, {
      stations: 6,
      across: 3,
      sFrom: 0.6,
      sTo: 0.9,
      x0: () => 1,
      x1: (z) => sailing.deckHalf(z),
      camber: 0.05,
    });
    for (let i = 0; i < side.positions.length; i += 3) {
      const z = side.positions[i + 2]!;
      expect(side.positions[i]!).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(side.positions[i + 1]!).toBeGreaterThanOrEqual(sailing.deckY(z) - 1e-6);
    }
    for (let i = 1; i < side.normals.length; i += 3) expect(side.normals[i]!).toBeGreaterThan(0.9);
  });

  it('smooths normals along the length without losing unit length', () => {
    const n = new Float32Array([1, 0, 0, 0, 1, 0, 1, 0, 0]); // 3 rows × 1 column
    smoothNormalsAlong(n, 3, 1, 1);
    expect(Math.hypot(n[3]!, n[4]!, n[5]!)).toBeCloseTo(1, 6);
    expect(n[3]!).toBeGreaterThan(0.6);
    expect(n[0]).toBe(1); // end rows are kept
  });
});

describe('telemetry drives', () => {
  it('scales, offsets, clamps and falls back', () => {
    const d = { name: 'x', axis: 'y' as const, key: 'k', scale: 2, offset: 1, max: 5, fallback: -1 };
    expect(driveTarget(d, { k: 1 })).toBe(4);
    expect(driveTarget(d, { k: 3 })).toBe(5);
    expect(driveTarget(d, {})).toBe(0);
    expect(driveTarget({ name: 'x', axis: 'x', value: (t) => (t.a ?? 0) * 3 }, { a: 2 })).toBe(6);
  });

  it('approaches targets independent of the frame rate', () => {
    const one = approach(0, 1, 5, 0.1);
    const two = approach(approach(0, 1, 5, 0.05), 1, 5, 0.05);
    expect(two).toBeCloseTo(one, 9);
    expect(approach(0, 1, 0, 0.1)).toBe(1);
  });

  it('places a limb joint at the bone lengths, bent toward the pole', () => {
    const root = new Vector3(0, 1, 0);
    const end = new Vector3(0, 1, -0.5);
    const joint = twoBoneJoint(root, end, 0.3, 0.3, new Vector3(0, 0, -0.25), new Vector3());
    expect(joint.distanceTo(root)).toBeCloseTo(0.3, 6);
    expect(joint.distanceTo(end)).toBeCloseTo(0.3, 6);
    expect(joint.y).toBeLessThan(1);
    // Out of reach: the limb straightens toward the target.
    const far = twoBoneJoint(root, new Vector3(0, 1, -2), 0.3, 0.3, new Vector3(0, 0, 0), new Vector3());
    expect(far.distanceTo(root)).toBeCloseTo(0.3, 3);
  });

  it('keeps a limb joint finite when the end sits on the root', () => {
    const root = new Vector3(0, 1, 0);
    const joint = twoBoneJoint(root, root.clone(), 0.3, 0.3, new Vector3(0, 0, -0.25), new Vector3());
    expect([joint.x, joint.y, joint.z].every(Number.isFinite)).toBe(true);
  });
});
