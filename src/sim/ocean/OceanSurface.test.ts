import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../core/rng';
import { MASTER_STEP, SimWorld } from '../world/SimWorld';
import {
  CASCADE_MASK_ALL,
  CASCADE_MASK_SHIPS,
  type CascadeConfig,
  modeIndex,
  PHYSICS_CASCADES,
} from './cascades';
import { OCEAN_UPDATE_INTERVAL } from './CpuOcean';
import { type CascadeSpectrum, OceanSpectrumBuilder } from './h0';
import { createSurfaceSample, OceanSurface } from './OceanSurface';
import { quantizedDispersion, resolveSpectrum } from './spectrum';

function surfaceFor(windSpeed: number, choppiness = 1, seed = 1): OceanSurface {
  const r = resolveSpectrum({ windSpeed, windFrom: 0.6, fetch: 400_000, choppiness });
  return OceanSurface.create(new OceanSpectrumBuilder(PHYSICS_CASCADES, [], seed).build(r).physics);
}

// Only mode (m, n) of one cascade: η = A cos(k·x0 − ωt + φ).
function singleMode(
  cascadeIndex: number,
  m: number,
  n: number,
  amplitude: number,
  phi: number,
): CascadeSpectrum[] {
  return PHYSICS_CASCADES.map((cascade, i) => {
    const size = cascade.resolution;
    const h0 = new Float32Array(size * size * 4);
    const k = (2 * Math.PI * Math.hypot(m, n)) / cascade.size;
    if (i === cascadeIndex) {
      const p = 4 * (modeIndex(n, size) * size + modeIndex(m, size));
      const q = 4 * (modeIndex(-n, size) * size + modeIndex(-m, size));
      h0[p] = (amplitude / 2) * Math.cos(phi);
      h0[p + 1] = (amplitude / 2) * Math.sin(phi);
      // conj(h0(−(−k))) = conj(h0(k)) at the partner texel; h0(−k) itself is zero.
      h0[q + 2] = (amplitude / 2) * Math.cos(phi);
      h0[q + 3] = -(amplitude / 2) * Math.sin(phi);
    }
    return { cascade, h0, choppiness: 1, kRepresentative: k, m0: 0, slopeVariance: 0 };
  });
}

describe('OceanSurface', () => {
  it('reproduces an analytic Gerstner wave', () => {
    const cascade = PHYSICS_CASCADES[2] as CascadeConfig;
    const [m, n] = [6, 2];
    const A = 1;
    const phi = 0.4;
    const surface = OceanSurface.create(singleMode(2, m, n, A, phi));
    const kx = (2 * Math.PI * m) / cascade.size;
    const kz = (2 * Math.PI * n) / cascade.size;
    const k = Math.hypot(kx, kz);
    const ux = kx / k;
    const uz = kz / k;
    const omega = quantizedDispersion(k);
    const rng = new Rng(4);
    const out = createSurfaceSample();
    let maxHeightErr = 0;
    let maxVelErr = 0;
    let crests = 0;
    let t = 0;
    for (let s = 0; s < 200; s++) {
      // Mid-interval times, where the finite-difference velocity is centred. A few distinct times keep
      // the FFT updates (two per new time) cheap.
      if (s % 20 === 0) t = (rng.int(0, 6000) + 0.5) * OCEAN_UPDATE_INTERVAL;
      const x = rng.range(-300, 300);
      const z = rng.range(-300, 300);
      surface.query(x, z, t, out);
      expect(out.converged).toBe(true);
      // Gerstner along k̂: ξ = ξ0 − A sin(kξ0 − ωt + φ) (+ the k̂⊥ part is unchanged).
      const xi = x * ux + z * uz;
      let xi0 = xi;
      for (let it = 0; it < 30; it++) {
        const th = k * xi0 - omega * t + phi;
        xi0 -= (xi0 - A * Math.sin(th) - xi) / (1 - A * k * Math.cos(th));
      }
      const th = k * xi0 - omega * t + phi;
      maxHeightErr = Math.max(maxHeightErr, Math.abs(out.height - A * Math.cos(th)));
      const vh = A * omega * Math.cos(th);
      const vy = A * omega * Math.sin(th);
      maxVelErr = Math.max(
        maxVelErr,
        Math.abs(out.velocityX - vh * ux),
        Math.abs(out.velocityZ - vh * uz),
        Math.abs(out.velocityY - vy),
      );
      if (Math.cos(th) > 0.9) crests++;
      // The Jacobian of a Gerstner wave is 1 − kA cos θ.
      expect(out.jacobian).toBeCloseTo(1 - A * k * Math.cos(th), 1);
    }
    // λ = 20 m sampled at 1 m: bilinear interpolation costs ~1% of the amplitude.
    expect(maxHeightErr).toBeLessThan(0.02 * A);
    expect(maxVelErr).toBeLessThan(0.03 * A * omega);
    expect(crests).toBeGreaterThan(5);
  });

  it('sharpens crests: particles bunch toward the crest (Gerstner sign)', () => {
    const surface = OceanSurface.create(singleMode(2, 6, 0, 1, 0));
    const d = { x: 0, y: 0, z: 0 };
    const L = (PHYSICS_CASCADES[2] as CascadeConfig).size;
    const wavelength = L / 6;
    // Crest at x0 = 0 when t = 0. A particle just behind the crest is pushed forward (+x), toward it.
    surface.displacementAt(-wavelength / 8, 0, 0, d);
    expect(d.x).toBeGreaterThan(0);
    surface.displacementAt(wavelength / 8, 0, 0, d);
    expect(d.x).toBeLessThan(0);
  });

  it('inverts the horizontal displacement on a choppy storm sea', () => {
    const surface = surfaceFor(24, 3);
    const rng = new Rng(8);
    const out = createSurfaceSample();
    const check = { x: 0, y: 0, z: 0 };
    let converged = 0;
    let folds = 0;
    const count = 2000;
    let iterations = 0;
    let minJacobian = Infinity;
    for (let i = 0; i < count; i++) {
      const x = rng.range(-2000, 2000);
      const z = rng.range(-2000, 2000);
      const t = 37 * Math.floor(i / 200) + 0.01;
      surface.query(x, z, t, out);
      iterations += out.iterations;
      minJacobian = Math.min(minJacobian, out.jacobian);
      if (out.jacobian <= 0) folds++;
      if (!out.converged) continue;
      converged++;
      surface.displacementAt(out.lagrangianX, out.lagrangianZ, t, check);
      expect(Math.hypot(out.lagrangianX + check.x - x, out.lagrangianZ + check.z - z)).toBeLessThan(1e-3);
      expect(out.height).toBeCloseTo(check.y, 6);
    }
    console.log(
      `storm sea: λ = ${surface.ocean.choppinessAt(0, 0).toFixed(2)}, converged ${converged}/${count}, ` +
        `min J ${minJacobian.toFixed(2)}, folds ${folds}, mean iterations ${(iterations / count).toFixed(2)}`,
    );
    expect(converged / count).toBeGreaterThan(0.995);
    expect(folds / count).toBeLessThan(0.002);
    expect(iterations / count).toBeLessThan(5);
  });

  it('converges in one or two steps from a warm start', () => {
    const surface = surfaceFor(18, 1.5);
    const out = createSurfaceSample();
    let total = 0;
    let first = true;
    for (let step = 0; step < 120; step++) {
      surface.query(12, -30, step * MASTER_STEP, out, 0, CASCADE_MASK_ALL, !first);
      if (!first) total += out.iterations;
      first = false;
    }
    expect(total / 119).toBeLessThanOrEqual(2);
  });

  it('returns unit normals that tilt against the slope', () => {
    const surface = OceanSurface.create(singleMode(2, 6, 0, 0.5, 0));
    const out = createSurfaceSample();
    const L = (PHYSICS_CASCADES[2] as CascadeConfig).size;
    // On the rear face of a wave travelling +x the surface rises toward +x, so the normal leans −x.
    surface.query(-L / 6 / 4, 0, 0, out);
    expect(Math.hypot(out.normalX, out.normalY, out.normalZ)).toBeCloseTo(1, 9);
    expect(out.normalX).toBeLessThan(0);
    expect(Math.abs(out.normalZ)).toBeLessThan(1e-6);
  });

  it('attenuates velocity and pressure with depth and honours the cascade mask', () => {
    const surface = surfaceFor(12);
    const top = createSurfaceSample();
    const deep = createSurfaceSample();
    let topSpeed = 0;
    let deepSpeed = 0;
    for (let i = 0; i < 50; i++) {
      const t = 20 + Math.floor(i / 10) * 3.1;
      surface.query(i * 13.7, i * -7.1, t, top, 0);
      surface.query(i * 13.7, i * -7.1, t, deep, 10);
      topSpeed += Math.hypot(top.velocityX, top.velocityY, top.velocityZ);
      deepSpeed += Math.hypot(deep.velocityX, deep.velocityY, deep.velocityZ);
      expect(deep.height).toBeCloseTo(top.height, 9);
    }
    expect(deepSpeed).toBeLessThan(0.8 * topSpeed);
    expect(deepSpeed).toBeGreaterThan(0.05 * topSpeed);

    const short = OceanSurface.create(singleMode(3, 0, 20, 0.1, 0));
    const out = createSurfaceSample();
    short.query(0, 0, 0, out, 0, CASCADE_MASK_SHIPS);
    expect(out.height).toBe(0);
    short.query(0, 0, 0, out, 0, CASCADE_MASK_ALL);
    expect(out.height).toBeCloseTo(0.1, 3);
  });

  it('gives the same sea for the same world point under a floating origin', () => {
    const a = surfaceFor(14);
    const b = surfaceFor(14);
    b.setOrigin(123_456.75, -98_765.5);
    const sa = createSurfaceSample();
    const sb = createSurfaceSample();
    for (const [x, z] of [
      [3, 4],
      [-250, 900],
    ] as const) {
      a.query(x + 123_456.75, z - 98_765.5, 42, sa);
      b.query(x, z, 42, sb);
      expect(sb.height).toBeCloseTo(sa.height, 4);
      expect(sb.velocityY).toBeCloseTo(sa.velocityY, 3);
    }
  });

  it('answers queries quickly', () => {
    const surface = surfaceFor(15, 1.5);
    const out = createSurfaceSample();
    const rng = new Rng(2);
    surface.prepare(10);
    for (let i = 0; i < 2000; i++) surface.query(rng.range(-500, 500), rng.range(-500, 500), 10, out);
    const count = 20_000;
    let started = performance.now();
    for (let i = 0; i < count; i++) surface.query(rng.range(-500, 500), rng.range(-500, 500), 10, out);
    const cold = ((performance.now() - started) * 1000) / count;
    started = performance.now();
    for (let i = 0; i < count; i++) surface.query(3, 4, 10, out, 0, CASCADE_MASK_ALL, true);
    const warm = ((performance.now() - started) * 1000) / count;
    console.log(`surface query: ${cold.toFixed(2)} µs cold, ${warm.toFixed(2)} µs warm-started`);
    expect(cold).toBeLessThan(50);
  });

  it('drops into SimWorld as its OceanField', () => {
    const surface = surfaceFor(10);
    const world = new SimWorld(
      {
        seed: 1,
        physicsMode: 'arcade',
        boats: [{ id: 'a', kind: 'pwc', x: 5, z: 5, heading: 0 }],
        wind: { speed: 10, from: 0.6, gustFactor: 1 },
        seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
        oceanQuality: 'low',
      },
      surface,
    );
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 0.5,
      controls: {},
      commands: [],
      probes: new Float64Array([5, 5]),
    });
    // The boat floats on this surface (its origin is on the design waterline).
    expect(Math.abs((snapshot.boats[0]?.position.y ?? NaN) - (snapshot.probes[0] ?? NaN))).toBeLessThan(0.4);
    expect(Math.abs(snapshot.probes[0] ?? 0)).toBeGreaterThan(0);
  });
});
