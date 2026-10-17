import { describe, expect, it } from 'vite-plus/test';

import { BOAT_SPECS } from '../../../sim/boats/specs/index';
import { RHO_SEAWATER } from '../../../sim/core/units';
import { generateHull } from '../../../sim/physics/hull/generateHull';
import type {
  DisplacementHullParams,
  HydroplaneHullParams,
  PlaningHullParams,
} from '../../../sim/physics/hull/types';
import { createHullLines, hydroplaneStep, physicsStationParameter } from './hullLines';

describe('hull lines', () => {
  // The hydroplane's stations aren't the other hulls': it has its own checks below.
  for (const spec of Object.values(BOAT_SPECS).filter((s) => s.hull.family !== 'hydroplane')) {
    describe(spec.kind, () => {
      const volume = spec.mass / RHO_SEAWATER;
      const physics = generateHull({ ...spec.hull, targetVolume: volume });
      const lines = createHullLines(spec.hull, volume);

      it('spans the same stem and transom as the physics hull', () => {
        expect(lines.zBow).toBeCloseTo(physics.zBow, 6);
        expect(lines.zStern).toBeCloseTo(physics.zStern, 6);
      });

      it('puts every physics vertex on a visual section (same lines)', () => {
        const isShip = spec.hull.family !== 'planing';
        const n = spec.hull.stations ?? (isShip ? 20 : 16);
        const h = spec.hull as DisplacementHullParams | PlaningHullParams;
        const nb = (h.family === 'planing' ? h.girthBottom : h.girthBelow) ?? (isShip ? 5 : 3);
        const na = (h.family === 'planing' ? h.girthTopsides : h.girthAbove) ?? 4;
        const points: [number, number, number][] = [];
        for (let i = 0; i < n; i++) {
          const sec = lines.section(physicsStationParameter(i, n), nb, na);
          for (let j = 0; j < sec.xs.length; j++) points.push([sec.xs[j]!, sec.ys[j]!, sec.z]);
        }
        const p = physics.mesh.positions;
        let worst = 0;
        for (let v = 0; v < p.length; v += 3) {
          const x = Math.abs(p[v]!);
          const y = p[v + 1]!;
          const z = p[v + 2]!;
          let best = Infinity;
          for (const q of points) {
            const d = Math.hypot(x - q[0], y - q[1], z - q[2]);
            if (d < best) best = d;
          }
          // Transom-cap centroids are not on a section; skip points inside the stern section.
          if (Math.abs(z - physics.zStern) < 1e-6 && best > 1e-3) continue;
          worst = Math.max(worst, best);
        }
        expect(worst).toBeLessThan(1e-3);
      });

      it('agrees on the deck line at the physics stations', () => {
        const n = spec.hull.stations ?? (spec.hull.family === 'planing' ? 16 : 20);
        for (let i = 1; i < n - 1; i++) {
          const z = lines.zAt(physicsStationParameter(i, n));
          expect(lines.deckY(z)).toBeCloseTo(physics.deckHeightAt(z), 4);
          expect(lines.deckHalf(z)).toBeCloseTo(physics.deckHalfBreadthAt(z), 4);
        }
      });

      it('reports the waterline half-breadth amidships', () => {
        const half = lines.halfBreadthAt(0, 0);
        const h = spec.hull as DisplacementHullParams | PlaningHullParams;
        const beam = h.family === 'planing' ? h.chineBeam : h.beamWaterline;
        expect(half).toBeGreaterThan(0.3 * beam);
        expect(half).toBeLessThanOrEqual(0.5 * spec.dimensions.beam + 1e-6);
      });
    });
  }
});

describe('hydroplane lines', () => {
  const spec = BOAT_SPECS.hydro;
  const volume = spec.mass / RHO_SEAWATER;
  const physics = generateHull({ ...spec.hull, targetVolume: volume });
  const lines = createHullLines(spec.hull, volume);
  const p = lines.params as HydroplaneHullParams;

  // Distance from (x, y) to the section polyline at body z.
  const offSection = (x: number, y: number, z: number): number => {
    const sec = lines.section(lines.sAt(z), 6, 4);
    let best = Infinity;
    for (let j = 1; j < sec.xs.length; j++) {
      const ax = sec.xs[j - 1]!;
      const ay = sec.ys[j - 1]!;
      const dx = sec.xs[j]! - ax;
      const dy = sec.ys[j]! - ay;
      const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return best;
  };

  it('spans the same noses and transom and solves the same draft as the physics hull', () => {
    expect(lines.zBow).toBeCloseTo(physics.zBow, 6);
    expect(lines.zStern).toBeCloseTo(physics.zStern, 6);
    expect(p.draft).toBeCloseTo((physics.params as HydroplaneHullParams).draft, 9);
  });

  it('puts every physics vertex on a visual section (same lines)', () => {
    const pos = physics.mesh.positions;
    let worst = 0;
    for (let v = 0; v < pos.length; v += 3) {
      const z = pos[v + 2]!;
      const d = offSection(Math.abs(pos[v]!), pos[v + 1]!, z);
      // The end caps' centroids are not on a section.
      if ((Math.abs(z - physics.zStern) < 1e-6 || Math.abs(z - physics.zBow) < 1e-6) && d > 1e-3) continue;
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("agrees on the deck line, and steps the bottom up at the sponsons' transoms", () => {
    for (let z = physics.zBow; z <= physics.zStern; z += 0.37) {
      expect(lines.deckY(z)).toBeCloseTo(physics.deckHeightAt(z), 6);
    }
    const step = hydroplaneStep(p);
    expect(lines.keelY(step.fore)).toBeCloseTo(-p.draft, 6); // the pads, on the pad line
    expect(lines.keelY(step.aft)).toBeCloseTo(p.afterPlaneStep - p.draft, 6);
    expect(lines.deckHalf(step.fore)).toBeCloseTo(spec.dimensions.beam / 2, 6);
  });

  it('reports the outer side as the half-breadth, from the chine to the deck', () => {
    const z = (lines.zBow + hydroplaneStep(p).fore) / 2;
    expect(lines.halfBreadthAt(z, 0)).toBeCloseTo(spec.dimensions.beam / 2, 6);
    expect(lines.halfBreadthAt(z, lines.keelY(z) - 0.01)).toBe(0);
    expect(lines.halfBreadthAt(z, lines.deckY(z) + 0.01)).toBe(0);
    const sec = lines.section(lines.sAt(z), 4, 3);
    expect(sec.xs[sec.chine]).toBeCloseTo(spec.dimensions.beam / 2, 6);
    expect(sec.ys[sec.chine]).toBeCloseTo(lines.keelY(z), 6);
  });
});
