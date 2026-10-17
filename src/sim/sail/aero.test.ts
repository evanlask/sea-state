import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../core/conventions';
import { vec3 } from '../core/math';
import { liftSlope } from '../physics/foils';
import {
  apparentWind,
  GENOA_POLAR,
  MAIN_POLAR,
  sailCoefficients,
  sailCoefficientsResult,
  sailForce,
  sailForceResult,
  windAngleOffBow,
} from './aero';

const c = sailCoefficientsResult();
const cl = (alphaDeg: number, ar = 5.3): number => sailCoefficients(MAIN_POLAR, ar, alphaDeg * DEG, c).cl;

describe('apparent wind', () => {
  it('is the true wind minus the boat velocity', () => {
    // Wind from the east (blowing west, −x) and the boat sailing north (−z) at 3 m/s.
    const aw = apparentWind(vec3(), vec3(-5, 0, 0), vec3(0, 0, -3));
    expect(aw).toEqual({ x: -5, y: 0, z: 3 });
    // In the body frame of a north-heading boat: from starboard and forward of the beam.
    expect(windAngleOffBow(aw.x, aw.z)).toBeCloseTo(Math.atan2(5, 3), 9);
    expect(Math.hypot(aw.x, aw.z)).toBeCloseTo(Math.sqrt(34), 9);
  });

  it('a head wind is 0°, from starboard +90°, from astern 180°', () => {
    expect(windAngleOffBow(0, 4)).toBeCloseTo(0, 9);
    expect(windAngleOffBow(-4, 0) / DEG).toBeCloseTo(90, 9);
    expect(Math.abs(windAngleOffBow(0, -4)) / DEG).toBeCloseTo(180, 9);
  });
});

describe('sail polars', () => {
  it('attached lift grows with the finite-span slope', () => {
    const slope = (cl(10) - cl(8)) / (2 * DEG);
    expect(slope / liftSlope(5.3)).toBeGreaterThan(0.9);
    expect(slope / liftSlope(5.3)).toBeLessThan(1.05);
  });

  it('peaks just under CLmax near the stall angle, then falls off', () => {
    let best = 0;
    let bestAt = 0;
    for (let a = 0; a <= 90; a += 0.5) {
      const v = cl(a);
      if (v > best) {
        best = v;
        bestAt = a;
      }
    }
    expect(best).toBeLessThanOrEqual(MAIN_POLAR.clMax + 1e-9);
    expect(best).toBeGreaterThan(0.95 * MAIN_POLAR.clMax);
    expect(bestAt).toBeGreaterThan(14);
    expect(bestAt).toBeLessThan(26);
    expect(cl(50)).toBeLessThan(0.9 * best);
    expect(cl(65)).toBeLessThan(cl(50));
  });

  it('luffs at zero angle of attack and is a flat plate square to the wind', () => {
    sailCoefficients(MAIN_POLAR, 5.3, 0, c);
    expect(c.fill).toBe(0);
    expect(c.cl).toBe(0);
    expect(c.cd).toBeCloseTo(MAIN_POLAR.flogDrag, 9);
    sailCoefficients(GENOA_POLAR, 7, 90 * DEG, c);
    expect(Math.abs(c.cl)).toBeLessThan(1e-9);
    expect(c.cd).toBeCloseTo(GENOA_POLAR.plateNormal, 6);
  });

  it('is odd in lift and even in drag (a soft sail turns inside out)', () => {
    const a = sailCoefficients(MAIN_POLAR, 5.3, 17 * DEG, sailCoefficientsResult());
    const b = sailCoefficients(MAIN_POLAR, 5.3, -17 * DEG, sailCoefficientsResult());
    expect(b.cl).toBeCloseTo(-a.cl, 12);
    expect(b.cd).toBeCloseTo(a.cd, 12);
  });

  it('induced drag falls with aspect ratio', () => {
    const lo = sailCoefficients(MAIN_POLAR, 3, 15 * DEG, sailCoefficientsResult()).cd;
    const hi = sailCoefficients(MAIN_POLAR, 8, 15 * DEG, sailCoefficientsResult()).cd;
    expect(hi).toBeLessThan(lo);
  });

  it('close-hauled on starboard tack the main drives forward and pushes to port', () => {
    // Apparent wind 28° off the starboard bow; boom 12° to port.
    const awa = 28 * DEG;
    const f = sailForce(
      MAIN_POLAR,
      46,
      5.3,
      -12 * DEG,
      -Math.sin(awa) * 8,
      Math.cos(awa) * 8,
      1.225,
      sailForceResult(),
    );
    expect(f.alpha / DEG).toBeCloseTo(16, 6);
    expect(f.fz).toBeLessThan(0);
    expect(f.fx).toBeLessThan(0);
    expect(Math.abs(f.fx)).toBeGreaterThan(Math.abs(f.fz));
  });
});
