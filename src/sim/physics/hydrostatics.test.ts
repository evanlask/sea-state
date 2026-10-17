import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { GRAVITY } from '../core/units';
import { angleOfVanishingStability, Hydrostatics, rollPeriod } from './hydrostatics';
import { boxMesh } from './mesh';

// 4 m wide (x), 3 m deep (y from −1 to 2), 10 m long (z) box: draft 1 m at y = 0.
const L = 10;
const B = 4;
const T = 1;
const box = boxMesh(0, 0.5, 0, B, 3, L);
const hs = new Hydrostatics(box);
const V = L * B * T;
const BM = (B * B) / (12 * T);
const cg = vec3(0, 0.3, 0); // KG = 1.3
const GM = T / 2 + BM - 1.3;

describe('hydrostatics: box vs analytic', () => {
  it('volume, centre of buoyancy, waterplane and BM = I/V', () => {
    const r = hs.upright(0);
    expect(r.volume).toBeCloseTo(V, 10);
    expect(r.centre.x).toBeCloseTo(0, 10);
    expect(r.centre.y).toBeCloseTo(-T / 2, 10);
    expect(r.centre.z).toBeCloseTo(0, 10);
    expect(r.waterplaneArea).toBeCloseTo(L * B, 10);
    expect(r.waterplaneIxx).toBeCloseTo((L * B ** 3) / 12, 8);
    expect(r.waterplaneIzz).toBeCloseTo((B * L ** 3) / 12, 8);
    expect(r.waterplaneIxx / r.volume).toBeCloseTo(BM, 10);
    expect(r.wettedArea).toBeCloseTo(L * B + 2 * L * T + 2 * B * T, 10);
  });

  it('solves the equilibrium draft for a mass', () => {
    // Half the volume: draft 0.5 → CG (0.3 above the 1 m waterline) sits 0.8 above water.
    const eq = hs.equilibrium(cg, V / 2, 0, false);
    expect(eq.height).toBeCloseTo(0.8, 8);
    expect(eq.hydro.volume).toBeCloseTo(V / 2, 8);
  });

  it('follows the wall-sided GZ formula before deck-edge immersion or bilge emergence', () => {
    for (const deg of [5, 10, 20]) {
      const phi = deg * DEG;
      const gz = hs.equilibrium(cg, V, phi, true).gz;
      expect(gz).toBeCloseTo(Math.sin(phi) * (GM + 0.5 * BM * Math.tan(phi) ** 2), 6);
    }
  });

  it('gives GM from the initial slope of the curve', () => {
    const curve = hs.gzCurve(cg, V);
    expect(curve.gm).toBeCloseTo(GM, 3);
    expect(curve.gz[0]).toBeCloseTo(0, 8);
    expect(Math.abs(curve.gz[curve.gz.length - 1]!)).toBeLessThan(1e-6); // inverted: symmetric again
  });

  it('trims by the head or stern to put B under G (free trim)', () => {
    const aft = vec3(0, 0.3, 0.5);
    const eq = hs.equilibrium(aft, V, 0, true);
    expect(eq.converged).toBe(true);
    expect(eq.hydro.centre.z).toBeCloseTo(0, 6);
    // CG aft sinks the stern: bow up. Small-angle: tan θ = x_G / GM_L.
    const gmL = (B * L ** 3) / 12 / V + T / 2 - 1.3;
    expect(eq.trim).toBeGreaterThan(0);
    expect(Math.tan(eq.trim)).toBeCloseTo(0.5 / gmL, 2);
  });

  it('finds the angle of vanishing stability by interpolation', () => {
    const angles = new Float64Array([0, 1, 2, 3]);
    expect(angleOfVanishingStability(angles, new Float64Array([0, 1, 1, -1]))).toBeCloseTo(2.5, 10);
    expect(angleOfVanishingStability(angles, new Float64Array([0, 1, 1, 1]))).toBe(3);
  });

  it('estimates the roll period from k and GM', () => {
    expect(rollPeriod(10, 1)).toBeCloseTo((2 * Math.PI * 10) / Math.sqrt(GRAVITY), 10);
  });
});
