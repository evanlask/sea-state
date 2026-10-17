// The masked AO pass compiles to WGSL (the node builder runs on the CPU) and keeps the whole
// horizon search behind the mask: a pixel the composite doesn't use reads its mask and stops.

import {
  DataTexture,
  DepthTexture,
  FloatType,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { tsl } from '../tsl';
import { MaskedGtaoNode } from './maskedGtao';

function fragmentOf(material: Material): string {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  renderer.hasFeature = () => false;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const mesh = new Mesh(new PlaneGeometry(), material);
  scene.add(mesh);
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = renderer.backend as any;
  backend.renderer ??= renderer;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = material;
  builder.camera = camera;
  builder.context.material = material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  builder.build();
  return builder.fragmentShader as string;
}

describe('masked GTAO', () => {
  it('runs the horizon search only where the mask needs it', () => {
    const depthTexture = new DepthTexture(4, 4);
    depthTexture.type = FloatType;
    const depth = tsl.texture(depthTexture);
    const velocity = tsl.texture(new DataTexture(new Uint8Array(64), 4, 4, RGBAFormat));
    const needed = depth.r.greaterThan(0).and(velocity.z.lessThan(0.999));
    const camera = new PerspectiveCamera();
    const node = new MaskedGtaoNode(depth, camera, needed);
    node.samples.value = 16;
    // The composite reading the AO builds the node, which sets up the AO pass's own material.
    const composite = new MeshBasicNodeMaterial();
    composite.colorNode = node.getTextureNode();
    fragmentOf(composite);
    const material = (node as unknown as { _material: Material })._material;
    const main = fragmentOf(material).split('fn main')[1]!;
    const branch = main.indexOf('if (');
    expect(branch).toBeGreaterThan(0);
    // Before the branch: the mask's two reads and the sampler-binding gather. Every loop of the search is inside it.
    const before = main.slice(0, branch);
    expect(before.match(/texture(Load|Sample\w*|Gather\w*)\(/g)?.length ?? 0).toBeLessThanOrEqual(3);
    expect(before).not.toContain('for (');
    expect(main.slice(branch)).toContain('for (');
    expect(main).toContain('gtaoMasked');
    // Every sampler the shader names is declared (see MaskedGtaoNode.setup).
    const full = fragmentOf(material);
    for (const sampler of new Set(full.match(/\w+_sampler/g))) {
      expect(full).toMatch(new RegExp(`var ${sampler}\\b`));
    }
  });
});
