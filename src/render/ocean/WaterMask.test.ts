// WaterMask keeps one proxy mesh per boat; a boat that leaves, and the mask itself, must release the
// proxy's render objects (bind groups, uniform buffers) rather than leave them to the garbage collector.

import { BoxGeometry, Matrix4, PerspectiveCamera, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { BoatVisual } from '../boats/kit/BoatVisual';
import { WaterMask } from './WaterMask';

function standInRenderer(): WebGPURenderer {
  return {
    getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) => target.set(64, 32),
    getRenderTarget: () => null,
    getClearAlpha: () => 1,
    getClearColor: () => undefined,
    setClearColor: () => undefined,
    setRenderTarget: () => undefined,
    render: () => undefined,
  } as unknown as WebGPURenderer;
}

function standInVisual(): BoatVisual {
  return {
    waterMask: { geometry: new BoxGeometry(1, 1, 1), matrixWorld: new Matrix4() },
    root: { visible: true, parent: {}, frustumCulled: true },
  } as unknown as BoatVisual;
}

// How many proxies fire their 'dispose' event (what the renderer frees their render objects on).
function watch(mask: WaterMask): { disposed: () => number } {
  let count = 0;
  const proxies = (
    mask as unknown as { proxies: Map<unknown, { addEventListener(t: 'dispose', f: () => void): void }> }
  ).proxies;
  for (const proxy of proxies.values()) proxy.addEventListener('dispose', () => count++);
  return { disposed: () => count };
}

describe('WaterMask', () => {
  const renderer = standInRenderer();
  const camera = new PerspectiveCamera();

  it('releases the proxy of a boat that left', () => {
    const mask = new WaterMask();
    const [a, b] = [standInVisual(), standInVisual()];
    mask.render(renderer, camera, [a, b]);
    const events = watch(mask);
    mask.render(renderer, camera, [a]);
    expect(events.disposed()).toBe(1);
    expect((mask as unknown as { proxies: Map<unknown, unknown> }).proxies.size).toBe(1);
    mask.dispose();
  });

  it('releases every proxy with itself', () => {
    const mask = new WaterMask();
    mask.render(renderer, camera, [standInVisual(), standInVisual()]);
    const events = watch(mask);
    mask.dispose();
    expect(events.disposed()).toBe(2);
  });
});
