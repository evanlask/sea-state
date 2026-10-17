// The wake kernels compile to WGSL in Node (the node builder runs on the CPU, as in
// particles/shaders.test.ts): the near foam trail is folded into the finest wake level, so the
// ocean still samples just three wake textures.

import { type ComputeNode, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { TRAIL_LEVELS, WakeLayer } from './WakeLayer';

function computeShader(node: ComputeNode): string {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const r = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  r.hasFeature = () => false;
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = r.backend as any;
  backend.renderer = r;
  const builder = backend.createNodeBuilder(null, r);
  builder.compute = node;
  builder.build();
  return builder.computeShader as string;
}

describe('wake layer', () => {
  const layer = new WakeLayer();
  // oxlint-disable-next-line typescript/no-explicit-any
  const passes = (layer as any).passes as ComputeNode[];

  it('runs the trails before the splats, which read the near trail', () => {
    expect(passes.map((p) => p.name)).toEqual([
      'ocean-wake-trail-0',
      'ocean-wake-trail-1',
      'ocean-wake-splat-0',
      'ocean-wake-splat-1',
    ]);
  });

  it('compiles every kernel', () => {
    for (const pass of passes) {
      const wgsl = computeShader(pass);
      expect(wgsl, pass.name).toContain('fn main');
    }
  });

  it('keeps one trail texture for the ocean to sample', () => {
    expect(TRAIL_LEVELS).toHaveLength(2);
    expect(layer.trailLevels[0]?.texture).toBeNull();
    expect(layer.trailLevels[1]?.texture).not.toBeNull();
  });
});
