// The probe's crossfade pass compiles to WGSL (no GPU needed: the node builder runs on the CPU) and
// reads both PMREM textures texel for texel.

import { Mesh, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { tsl } from '../tsl';
import { probeBlendMaterial } from './EnvironmentProbe';

function fragmentShader(mesh: Mesh): string {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  renderer.hasFeature = () => false;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  scene.add(mesh);
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = renderer.backend as any;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = mesh.material;
  builder.camera = camera;
  builder.context.material = mesh.material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  builder.build();
  return builder.fragmentShader as string;
}

describe('environment probe crossfade', () => {
  it('compiles to a texel-for-texel blend', () => {
    const display = new RenderTarget(384, 512);
    const fresh = new RenderTarget(384, 512);
    const material = probeBlendMaterial(display.texture, fresh.texture, tsl.uniform(1), tsl.uniform(0.5));
    const fragment = fragmentShader(new Mesh(new PlaneGeometry(), material));
    expect(fragment).toContain('textureLoad');
    expect(fragment).toMatch(/mix\(/);
  });
});
