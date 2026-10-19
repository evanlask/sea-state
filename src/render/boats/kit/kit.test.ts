import { MeshStandardNodeMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../../sim/boats/specs/index';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { bakeAoVolume, fibonacciDirections, sampleAo } from './ao';
import { createHullLines } from './hullLines';
import {
  bakeInstances,
  CONTAINER_WIDTH,
  containerGeometry,
  instanced,
  layoutContainers,
  placement,
  layoutPots,
  POT_SIZE,
  potCapacity,
  rng,
  spacedAlong,
} from './instancing';
import { draftMarks, imoNumber, nameLetterHeight } from './liveries';
import { projectedPixels, selectLod } from './lod';
import {
  bulwarks,
  deckSurface,
  hullPatch,
  hullShell,
  mergeMeshData,
  transomCap,
  triangleCountOf,
} from './loft';

const cargo = BOAT_SPECS.cargo;
const lines = createHullLines(cargo.hull, cargo.mass / RHO_SEAWATER);

const normalAt = (data: ReturnType<typeof hullShell>, i: number): [number, number, number] => [
  data.normals[i * 3]!,
  data.normals[i * 3 + 1]!,
  data.normals[i * 3 + 2]!,
];

describe('hull loft', () => {
  const shell = hullShell(lines, { stations: 40, below: 10, above: 5 });

  it('has the grid triangle count', () => {
    const cols = 2 * 15 + 1;
    expect(triangleCountOf(shell)).toBe(39 * (cols - 1) * 2);
  });

  it('winds outward: starboard normals point +x, the keel points down', () => {
    const cols = 31;
    const mid = 20 * cols; // a station amidships
    expect(normalAt(shell, mid + 15 + 10)[0]).toBeGreaterThan(0.9); // starboard knuckle
    expect(normalAt(shell, mid + 15 - 10)[0]).toBeLessThan(-0.9); // port knuckle
    expect(normalAt(shell, mid + 15)[1]).toBeLessThan(-0.9); // keel
  });

  it('spans the hull from the stem to the transom with metric UVs', () => {
    let maxU = 0;
    for (let i = 0; i < shell.uvs.length; i += 2) maxU = Math.max(maxU, shell.uvs[i]!);
    expect(maxU).toBeCloseTo(lines.zStern - lines.zBow, 3);
  });

  it('splits normals at the chine of a planing hull', () => {
    const pb = BOAT_SPECS.powerboat;
    const pl = createHullLines(pb.hull, pb.mass / RHO_SEAWATER);
    const smooth = hullShell(pl, { stations: 10, below: 3, above: 3, creases: false });
    const creased = hullShell(pl, { stations: 10, below: 3, above: 3 });
    expect(creased.positions.length).toBeGreaterThan(smooth.positions.length);
  });

  it('builds a deck facing up, a transom facing aft and bulwarks with port openings', () => {
    const deck = deckSurface(lines, { stations: 20, across: 5 });
    for (let i = 1; i < deck.normals.length; i += 3) expect(deck.normals[i]!).toBeGreaterThan(0.5);
    const cap = transomCap(lines, 6, 3);
    expect(cap.normals[2]).toBe(1);
    const plain = bulwarks(lines, { sFrom: 0.1, sTo: 0.9, stations: 20, height: 1 });
    const ported = bulwarks(lines, {
      sFrom: 0.1,
      sTo: 0.9,
      stations: 20,
      height: 1,
      ports: [{ z0: -10, z1: -8 }],
    });
    // The port adds two stations and its jambs, drops the foot quads across its span and closes it
    // over with a lintel.
    expect(triangleCountOf(ported)).toBeLessThan(triangleCountOf(plain) + 2 * (2 * 5 + 2) * 2);
    const facing = (m: typeof ported, axis: number, sign: number): number => {
      let n = 0;
      for (let i = axis; i < m.normals.length; i += 3) if (m.normals[i]! * sign > 0.99) n++;
      return n;
    };
    // Lintels face down, the jambs along the hull (4 vertices each, both sides); the plain bulwark has neither.
    expect(facing(ported, 1, -1)).toBeGreaterThan(0);
    expect(facing(ported, 2, 1)).toBe(8);
    expect(facing(ported, 2, -1)).toBe(8);
    expect(facing(plain, 1, -1) + facing(plain, 2, 1) + facing(plain, 2, -1)).toBe(0);
  });

  it('places hull patches just outside the shell', () => {
    const patch = hullPatch(lines, { zFrom: -10, zTo: 10, yFrom: 1, yTo: 3, side: 1, offset: 0.05 });
    const x = patch.positions[0]!;
    expect(x).toBeCloseTo(lines.halfBreadthAt(-10, 1) + 0.05, 3);
    expect(patch.normals[0]!).toBeGreaterThan(0.9);
  });

  it('merges mesh data with offset indices', () => {
    const a = transomCap(lines, 4, 2);
    const merged = mergeMeshData([a, a]);
    expect(merged.indices.length).toBe(a.indices.length * 2);
    expect(Math.max(...merged.indices)).toBe(a.positions.length / 3 + Math.max(...a.indices));
  });
});

describe('instancing layouts', () => {
  it('is deterministic per seed', () => {
    const a = rng(5);
    const b = rng(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('stacks containers within the bay limits', () => {
    const bays = [
      { z: 0, rows: 13, tiers: 6, baseY: 10 },
      { z: 14, rows: 11, tiers: 5, baseY: 10, twenty: true },
    ];
    const slots = layoutContainers(bays, { seed: 1, liveries: 8, fill: 1 });
    const first = slots.filter((s) => s.z === 0);
    expect(first.length).toBeLessThanOrEqual(13 * 6);
    expect(first.length).toBeGreaterThan(13 * 4);
    expect(Math.max(...slots.map((s) => Math.abs(s.x)))).toBeLessThanOrEqual(
      6 * (CONTAINER_WIDTH + 0.03) + 1e-9,
    );
    // 20 ft bays hold pairs.
    const twenty = slots.filter((s) => Math.abs(s.z - 14) < 4);
    expect(twenty.length % 2).toBe(0);
    expect(slots.every((s) => s.livery >= 0 && s.livery < 8)).toBe(true);
    // Tiers sit on each other: no two boxes in a stack overlap in height.
    const stack = first.filter((s) => s.x === first[0]!.x).sort((p, q) => p.y - q.y);
    for (let i = 1; i < stack.length; i++)
      expect(stack[i]!.y).toBeCloseTo(stack[i - 1]!.y + stack[i - 1]!.height, 6);
  });

  it('lays out pots up to the count and capacity', () => {
    const options = { z0: -2, z1: 16, halfWidth: 4, deckY: 1, maxTiers: 3 };
    const capacity = potCapacity(options);
    expect(capacity).toBe(3 * 8 * 3);
    expect(layoutPots({ ...options, count: 50, seed: 2 })).toHaveLength(50);
    expect(layoutPots({ ...options, count: 500, seed: 2 })).toHaveLength(capacity);
    const pots = layoutPots({ ...options, count: capacity, seed: 2 });
    expect(Math.max(...pots.map((p) => Math.abs(p.x) + POT_SIZE / 2))).toBeLessThanOrEqual(4.1);
  });

  it('spaces repeats along a polyline', () => {
    const pts = spacedAlong(
      [
        [0, 0],
        [0, 10],
        [10, 10],
      ],
      2,
    );
    expect(pts).toHaveLength(10);
    expect(pts[0]![2]).toBeCloseTo(0, 6);
    expect(pts[9]![2]).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('liveries', () => {
  it('lays out metric draft marks every 20 cm with whole metres labelled', () => {
    const marks = draftMarks(10.8, 12);
    expect(marks).toHaveLength(60);
    expect(marks[4]!.label).toBe('1M');
    expect(marks[0]!.label).toBe('2');
    expect(marks[4]!.y).toBeCloseTo(1 - 10.8, 6);
  });

  it('fits names to the available length', () => {
    expect(nameLetterHeight('MERIDIAN TRADER', 30, 3)).toBeLessThanOrEqual(3);
    expect(nameLetterHeight('A', 30, 3)).toBe(3);
    const h = nameLetterHeight('NORTHERN REACH', 7, 1);
    expect(h * 14 * 0.62 * 1.08).toBeCloseTo(7, 6);
  });

  it('makes IMO numbers with a valid check digit', () => {
    for (const seed of [1, 2, 3, 42]) {
      const digits = imoNumber(seed).replace('IMO ', '').split('').map(Number);
      expect(digits).toHaveLength(7);
      const sum = digits.slice(0, 6).reduce((acc, d, i) => acc + d * (7 - i), 0);
      expect(sum % 10).toBe(digits[6]);
    }
  });
});

describe('LOD selection', () => {
  it('projects size to pixels', () => {
    expect(projectedPixels(100, 100, Math.PI / 2, 1000)).toBeCloseTo(500, 6);
  });

  it('picks levels by projected size with hysteresis', () => {
    const t = { pixels: [200, 50] as const, hysteresis: 0.1 };
    expect(selectLod(400, 2, t)).toBe(0);
    expect(selectLod(100, 0, t)).toBe(1);
    expect(selectLod(10, 0, t)).toBe(2);
    expect(selectLod(195, 0, t)).toBe(0); // inside the hysteresis band: stay
    expect(selectLod(205, 1, t)).toBe(1); // not yet past 200 × 1.1
    expect(selectLod(230, 1, t)).toBe(0);
    expect(selectLod(52, 2, t)).toBe(2);
    expect(selectLod(60, 2, t)).toBe(1);
  });
});

describe('AO volume', () => {
  it('spreads directions over the sphere', () => {
    const d = fibonacciDirections(64);
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < 64; i++) {
      sx += d[i * 3]!;
      sy += d[i * 3 + 1]!;
      expect(Math.hypot(d[i * 3]!, d[i * 3 + 1]!, d[i * 3 + 2]!)).toBeCloseTo(1, 5);
    }
    expect(Math.abs(sx) / 64).toBeLessThan(0.05);
    expect(Math.abs(sy) / 64).toBeLessThan(0.05);
  });

  it('darkens an inside corner more than an open face', () => {
    // A floor and a wall meeting along x = 0.
    const volume = bakeAoVolume({
      min: [-4, -1, -4],
      max: [4, 4, 4],
      voxel: 0.25,
      triangles: [],
      boxes: [
        { min: [-4, -1, -4], max: [4, 0, 4] },
        { min: [-4, 0, -4], max: [-3, 4, 4] },
      ],
      distance: 2,
    });
    const open = sampleAo(volume, 2, 0.3, 0);
    const corner = sampleAo(volume, -2.7, 0.3, 0);
    expect(open).toBeGreaterThan(0.85);
    expect(corner).toBeLessThan(open - 0.15);
  });
});

describe('instanced repeats', () => {
  const box = containerGeometry(6, 2.6);
  const matrices = [placement(0, 0, 0), placement(10, 2, -5, Math.PI / 2)];
  const spec = {
    matrices,
    attributes: { aColor: { itemSize: 3, data: new Float32Array([1, 0, 0, 0, 0, 1]) } },
  };

  it('bakes every instance into one static geometry', () => {
    const g = bakeInstances(box, spec);
    const n = box.getAttribute('position').count;
    expect(g.getAttribute('position').count).toBe(2 * n);
    expect(g.getIndex()!.count).toBe(2 * box.getIndex()!.count);
    expect(g.getAttribute('aFace').count).toBe(2 * n);
    // Second instance: moved and turned a quarter (a +x normal now points −z).
    const p = g.getAttribute('position');
    expect(p.getX(n)).toBeCloseTo(10 + box.getAttribute('position').getZ(0), 5);
    expect(p.getY(n)).toBeCloseTo(2, 5);
    expect(g.getAttribute('normal').getZ(n)).toBeCloseTo(-1, 5);
    // Instance attributes repeat per vertex.
    const c = g.getAttribute('aColor');
    expect([c.getX(0), c.getZ(0), c.getX(n), c.getZ(n)]).toEqual([1, 0, 0, 1]);
    expect(g.getIndex()!.getX(box.getIndex()!.count)).toBe(box.getIndex()!.getX(0) + n);
  });

  it('builds a plain mesh, so boat clones share one pipeline', () => {
    const mesh = instanced(box, new MeshStandardNodeMaterial(), spec, { name: 'boxes' });
    expect((mesh as { isInstancedMesh?: boolean }).isInstancedMesh).toBeUndefined();
    expect(mesh.name).toBe('boxes');
    expect(mesh.visible).toBe(true);
    expect(instanced(box, new MeshStandardNodeMaterial(), { matrices: [] }).visible).toBe(false);
  });
});
