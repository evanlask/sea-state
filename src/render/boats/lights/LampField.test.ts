import type { BufferAttribute } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { setStorageReleaser } from '../../gpuResources';
import { LampField } from './LampField';

describe('lamp field', () => {
  afterEach(() => setStorageReleaser(null));

  it('gives its per-lamp vertex buffers back with it', () => {
    const released: BufferAttribute[] = [];
    setStorageReleaser((attribute) => void released.push(attribute));
    const field = new LampField(
      [
        {
          position: { x: 0, y: 1, z: 0 },
          lensRadius: 0.05,
          colour: [1, 0, 0],
          intensity: 10,
          shape: { mode: 'cone', direction: { x: 0, y: -1, z: 0 }, angle: 0.5, leak: 0.01 },
        },
      ],
      { lens: false },
    );
    field.dispose();
    // Position, emission, shape, two edges and the twinkle phase.
    expect(new Set(released).size).toBe(6);
  });
});
