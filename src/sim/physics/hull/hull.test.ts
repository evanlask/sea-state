import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../boats/specs/index';
import { checkManifold, frustumMesh, meshVolume, mergeMeshes, triangleCount } from '../mesh';
import { generateHull, superellipseArea, superellipseExponent } from './generateHull';
import { buildSuperstructure } from './superstructure';

describe('hull generator', () => {
  for (const spec of Object.values(BOAT_SPECS)) {
    describe(spec.kind, () => {
      const hull = generateHull({ ...spec.hull, targetVolume: spec.mass / 1025 });

      it('is a closed, consistently wound, genus-0 surface', () => {
        const report = checkManifold(hull.mesh);
        expect(report.boundaryEdges).toBe(0);
        expect(report.nonManifoldEdges).toBe(0);
        expect(report.inconsistentEdges).toBe(0);
        expect(report.degenerateTriangles).toBe(0);
        expect(report.eulerCharacteristic).toBe(2);
      });

      it('has outward normals (positive divergence-theorem volume)', () => {
        const volume = meshVolume(hull.mesh);
        expect(volume).toBeGreaterThan(spec.mass / 1025); // reserve buoyancy above the waterline
      });

      it('stays within the 200–800 triangle budget', () => {
        const n = triangleCount(hull.mesh);
        expect(n).toBeGreaterThanOrEqual(200);
        expect(n).toBeLessThanOrEqual(800);
      });

      it('builds closed superstructure volumes on the deck', () => {
        const parts = spec.superstructures.map((s) => buildSuperstructure(hull, s));
        for (const part of parts) {
          expect(checkManifold(part).closed).toBe(true);
          expect(meshVolume(part)).toBeGreaterThan(0);
        }
        const merged = checkManifold(mergeMeshes([hull.mesh, ...parts]));
        expect(merged.closed).toBe(true);
        expect(merged.eulerCharacteristic).toBe(2 * (1 + parts.length));
      });
    });
  }

  it('is mirror-symmetric about the centreline', () => {
    const hull = generateHull(BOAT_SPECS.sail.hull);
    const key = (x: number, y: number, z: number): string =>
      [x, y, z].map((v) => Math.round(v * 1e5) + 0).join(',');
    const p = hull.mesh.positions;
    const keys = new Set<string>();
    for (let i = 0; i < p.length; i += 3) keys.add(key(p[i]!, p[i + 1]!, p[i + 2]!));
    for (let i = 0; i < p.length; i += 3) expect(keys.has(key(-p[i]!, p[i + 1]!, p[i + 2]!))).toBe(true);
  });

  it('maps a section-area coefficient to a superellipse exponent', () => {
    expect(superellipseArea(2)).toBeCloseTo(Math.PI / 4, 10);
    expect(superellipseArea(superellipseExponent(0.985))).toBeCloseTo(0.985, 6);
  });

  it('builds frustums with outward winding', () => {
    const box = frustumMesh({
      cx: 0,
      cz: 0,
      y0: 0,
      length: 4,
      width: 2,
      height: 1,
      topLength: 2,
      topWidth: 1,
    });
    expect(checkManifold(box).closed).toBe(true);
    // Frustum volume h/3·(A1 + A2 + √(A1·A2)).
    expect(meshVolume(box)).toBeCloseTo((1 / 3) * (8 + 2 + 4), 10);
  });
});
