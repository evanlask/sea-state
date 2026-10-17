import { PerspectiveCamera, type Vector2, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { Lightning } from './Lightning';

const renderer = { getDrawingBufferSize: (v: Vector2) => v.set(1920, 1080) } as unknown as WebGPURenderer;

describe('Lightning warm-up', () => {
  it('draws the (empty) bolt during warm-up so its pipeline is built before the first strike', () => {
    const lightning = new Lightning();
    lightning.rate = 0;
    const camera = new PerspectiveCamera();
    lightning.update(renderer, camera, 1 / 60, 0);
    expect(lightning.mesh.visible).toBe(false);
    lightning.setWarmup(true);
    lightning.update(renderer, camera, 1 / 60, 0);
    expect(lightning.mesh.visible).toBe(true);
    expect(lightning.flash.intensity).toBe(0);
    lightning.setWarmup(false);
    lightning.update(renderer, camera, 1 / 60, 0);
    expect(lightning.mesh.visible).toBe(false);
  });
});
