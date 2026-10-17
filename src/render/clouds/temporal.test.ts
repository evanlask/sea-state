import { Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vite-plus/test';

import {
  frameJitter,
  historyWeightFor,
  interleavedGradientNoise,
  pixelJitter,
  reprojectToPreviousUv,
  upscaleCycle,
  upscaleOffset,
} from './temporal';

const STILL = { x: 0, y: 0, z: 0 };

// Camera-relative view-projection, as CloudSystem builds it.
function viewProjection(camera: PerspectiveCamera): Matrix4 {
  camera.updateMatrixWorld();
  return camera.matrixWorldInverse.clone().setPosition(0, 0, 0).premultiply(camera.projectionMatrix);
}

// Direction through buffer uv (origin top-left), as the march kernel builds its rays.
function rayThrough(camera: PerspectiveCamera, u: number, v: number): Vector3 {
  const tanY = Math.tan((camera.fov * Math.PI) / 360);
  const e = camera.matrixWorld.elements;
  const right = new Vector3(e[0], e[1], e[2]);
  const up = new Vector3(e[4], e[5], e[6]);
  const forward = new Vector3(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1));
  return forward
    .addScaledVector(right, (u * 2 - 1) * tanY * camera.aspect)
    .addScaledVector(up, (1 - v * 2) * tanY)
    .normalize();
}

describe('jitter sequences', () => {
  it('stays in [0, 1) and spreads evenly over frames', () => {
    const bins = Array.from({ length: 8 }, () => 0);
    for (let f = 0; f < 64; f++) {
      const j = frameJitter(f);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(1);
      const bin = Math.floor(j * 8);
      bins[bin] = (bins[bin] ?? 0) + 1;
    }
    for (const count of bins) expect(count).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < 50; i++) {
      const v = pixelJitter(i * 7, i * 3, i);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(interleavedGradientNoise(0, 0)).toBe(0);
  });

  it('visits every pixel of a 2×2 block once per cycle', () => {
    const seen = new Set<string>();
    for (let f = 0; f < upscaleCycle(2); f++) seen.add(upscaleOffset(f, 2).join(','));
    expect(seen.size).toBe(4);
    expect(upscaleOffset(5, 2)).toEqual(upscaleOffset(1, 2));
    expect(upscaleOffset(3, 1)).toEqual([0, 0]);
    expect(upscaleOffset(-1, 2)).toEqual(upscaleOffset(3, 2));
  });
});

describe('reprojection', () => {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.position.set(3, 5, -2);
  camera.lookAt(10, 400, -1000);
  camera.updateMatrixWorld();

  it('maps a pixel to itself when the camera is still', () => {
    const vp = viewProjection(camera);
    for (const [u, v] of [
      [0.5, 0.5],
      [0.1, 0.2],
      [0.9, 0.7],
    ] as const) {
      const prev = reprojectToPreviousUv(rayThrough(camera, u, v), 3000, STILL, vp.elements);
      expect(prev?.u).toBeCloseTo(u, 5);
      expect(prev?.v).toBeCloseTo(v, 5);
    }
  });

  it('follows a camera rotation and rejects points behind the old view', () => {
    const before = camera.clone();
    const vp = viewProjection(before);
    const after = camera.clone();
    after.rotateY(0.05); // turning left: the old centre now lies right of the view centre
    after.updateMatrixWorld();
    const prev = reprojectToPreviousUv(rayThrough(after, 0.5, 0.5), 3000, STILL, vp.elements);
    expect(prev).not.toBeNull();
    expect(prev?.u ?? 1).toBeLessThan(0.5);
    const behind = rayThrough(before, 0.5, 0.5).negate();
    expect(reprojectToPreviousUv(behind, 3000, STILL, vp.elements)).toBeNull();
  });

  it('barely moves distant clouds when the camera translates', () => {
    const vp = viewProjection(camera);
    const ray = rayThrough(camera, 0.5, 0.5);
    const moved = { x: 5, y: 0, z: 0 };
    const near = reprojectToPreviousUv(ray, 100, moved, vp.elements);
    const far = reprojectToPreviousUv(ray, 20_000, moved, vp.elements);
    expect(Math.abs((far?.u ?? 0) - 0.5)).toBeLessThan(Math.abs((near?.u ?? 0) - 0.5));
    expect(Math.abs((far?.u ?? 0) - 0.5)).toBeLessThan(1e-3);
  });

  it('weights history by whether the pixel was marched', () => {
    expect(historyWeightFor(true, true, 0.8)).toBe(0.8);
    expect(historyWeightFor(false, true, 0.8)).toBe(1);
    expect(historyWeightFor(true, false, 0.8)).toBe(0);
  });
});
