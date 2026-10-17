import { Box3, Group, Matrix4, Mesh, BoxGeometry, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import {
  createOccluderSlots,
  marchRange,
  occluderBounds,
  packScreenRects,
  type ScreenRect,
  screenRectOfBox,
  updateOccluderSlots,
} from './ssrOccluders';

const rect = (): ScreenRect => ({ minX: 0, minY: 0, maxX: 0, maxY: 0, near: 0 });

function cameraAt(position: Vector3, target: Vector3): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 10000);
  camera.position.copy(position);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

const clipOf = (camera: PerspectiveCamera): Matrix4 =>
  new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);

// uv (y down) of a world point, as the SSR trace computes it.
function uvOf(camera: PerspectiveCamera, p: Vector3): [number, number] {
  const ndc = p.clone().project(camera);
  return [ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5];
}

describe('SSR occluder rectangles', () => {
  it('bounds every corner of a box in front of the camera, with its nearest distance', () => {
    const camera = cameraAt(new Vector3(0, 5, 30), new Vector3(0, 0, 0));
    const box = new Box3(new Vector3(-2, 0, -6), new Vector3(2, 4, 6));
    const r = screenRectOfBox(box, clipOf(camera), camera.near, rect());
    expect(r).not.toBeNull();
    for (let i = 0; i < 8; i++) {
      const corner = new Vector3(i & 1 ? 2 : -2, i & 2 ? 4 : 0, i & 4 ? 6 : -6);
      const [u, v] = uvOf(camera, corner);
      expect(u).toBeGreaterThanOrEqual(r!.minX - 1e-6);
      expect(u).toBeLessThanOrEqual(r!.maxX + 1e-6);
      expect(v).toBeGreaterThanOrEqual(r!.minY - 1e-6);
      expect(v).toBeLessThanOrEqual(r!.maxY + 1e-6);
    }
    // Nearest corner: (±2, 4, 6) seen from (0, 5, 30), along the view axis.
    expect(r!.near).toBeGreaterThan(20);
    expect(r!.near).toBeLessThan(25);
  });

  it('drops boxes behind the camera or off screen', () => {
    const camera = cameraAt(new Vector3(0, 5, 0), new Vector3(0, 5, -10));
    const behind = new Box3(new Vector3(-2, 0, 10), new Vector3(2, 4, 20));
    expect(screenRectOfBox(behind, clipOf(camera), camera.near, rect())).toBeNull();
    const aside = new Box3(new Vector3(200, 0, -20), new Vector3(204, 4, -10));
    expect(screenRectOfBox(aside, clipOf(camera), camera.near, rect())).toBeNull();
  });

  it('clips a box around the camera to the near plane: it covers the screen', () => {
    // The helm boat from the bridge: the camera inside its box.
    const camera = cameraAt(new Vector3(0, 3, 0), new Vector3(0, 0, -20));
    const box = new Box3(new Vector3(-4, -1, -15), new Vector3(4, 6, 15));
    const r = screenRectOfBox(box, clipOf(camera), camera.near, rect());
    expect(r).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1, near: camera.near });
  });

  it('packs rectangles with padding and merges the overflow into the last slot', () => {
    const slots = createOccluderSlots({ value: 0 });
    const many = Array.from({ length: 20 }, (_, i) => ({
      minX: i * 0.04,
      minY: 0.4,
      maxX: i * 0.04 + 0.02,
      maxY: 0.5,
      near: 100 - i,
    }));
    const used = packScreenRects(many, slots.data, 0.01, 0.01);
    expect(used).toBe(16);
    expect(slots.data[0]!.toArray()).toEqual([0, 0.39, 0.03, 0.51]);
    expect(slots.data[1]!.x).toBe(100);
    // Slot 15 holds rectangles 15..19.
    const last = slots.data[30]!;
    expect(last.x).toBeCloseTo(0.59);
    expect(last.z).toBeCloseTo(0.79);
    expect(slots.data[31]!.x).toBe(81);
  });

  it('starts as one full-screen rectangle and falls back to it for debug geometry', () => {
    const slots = createOccluderSlots({ value: 0 });
    expect(slots.count.value).toBe(1);
    expect(slots.data[0]!.toArray()).toEqual([0, 0, 1, 1]);
    const camera = cameraAt(new Vector3(0, 5, 30), new Vector3(0, 0, 0));
    const root = new Group();
    root.updateMatrixWorld();
    const bounds = new Box3(new Vector3(-1, 0, -1), new Vector3(1, 1, 1));
    updateOccluderSlots(slots, camera, [{ root, bounds }], { x: 1920, y: 1080 });
    expect(slots.count.value).toBe(1);
    expect(slots.data[0]!.z).toBeLessThan(1);
    updateOccluderSlots(slots, camera, [], { x: 1920, y: 1080 });
    expect(slots.count.value).toBe(0);
    updateOccluderSlots(slots, camera, [], { x: 1920, y: 1080 }, true);
    expect(slots.count.value).toBe(1);
    expect(slots.data[0]!.toArray()).toEqual([0, 0, 1, 1]);
  });
});

describe('occluder bounds', () => {
  it('measures every drawn child in the root frame, padded', () => {
    const root = new Group();
    root.position.set(100, 0, 50);
    root.rotation.y = 1;
    const mast = new Mesh(new BoxGeometry(0.2, 10, 0.2));
    mast.position.set(0, 5, -1);
    const hull = new Mesh(new BoxGeometry(3, 2, 10));
    const lod = new Group();
    lod.visible = false; // hidden LODs count too
    lod.add(hull);
    root.add(mast, lod);
    root.updateMatrixWorld(true);
    const box = occluderBounds(root);
    const pad = 0.5 + 0.05 * 11;
    expect(box.min.x).toBeCloseTo(-1.5 - pad);
    expect(box.max.x).toBeCloseTo(1.5 + pad);
    expect(box.min.y).toBeCloseTo(-1 - pad);
    expect(box.max.y).toBeCloseTo(10 + pad);
    expect(box.min.z).toBeCloseTo(-5 - pad);
    expect(box.max.z).toBeCloseTo(5 + pad);
  });
});

describe('march range', () => {
  // The restricted march must visit exactly the samples whose t lies in [enter, exit].
  it('covers exactly the sample indices inside the interval', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let trial = 0; trial < 2000; trial++) {
      const steps = trial % 2 ? 40 : 20;
      const span = 0.05 + random() * 0.95;
      const jitter = random();
      const a = random() * span;
      const b = a + random() * (span - a);
      const [first, last] = marchRange(a, b, span, steps, jitter);
      for (let i = 0; i < steps; i++) {
        const f = (i + jitter) / steps;
        const t = f * f * span;
        const inside = t >= a + 1e-9 && t <= b - 1e-9;
        const outside = t < a - 1e-9 || t > b + 1e-9;
        if (inside) expect(i >= first && i <= last).toBe(true);
        if (outside) expect(i >= first && i <= last).toBe(false);
      }
    }
  });

  it('is empty when the interval holds no sample', () => {
    const [first, last] = marchRange(0.5, 0.5001, 1, 20, 0.5);
    expect(last).toBeLessThan(first);
  });
});
