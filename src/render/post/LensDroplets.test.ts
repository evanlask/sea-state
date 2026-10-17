// The droplet layer and the post node compile to WGSL (no GPU needed: the node builder runs on the
// CPU), and the post node adds a single sampler for the drop layer.

import {
  type BufferGeometry,
  DataTexture,
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
import { LensDropLayer, LensDropletUniforms, lensDroplets } from './LensDroplets';

function shaders(
  material: Material,
  geometry: BufferGeometry = new PlaneGeometry(),
): { vertex: string; fragment: string } {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  renderer.hasFeature = () => false;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const mesh = new Mesh(geometry, material);
  scene.add(mesh);
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = renderer.backend as any;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = material;
  builder.camera = camera;
  builder.context.material = material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  builder.build();
  return { vertex: builder.vertexShader as string, fragment: builder.fragmentShader as string };
}

const samplers = (wgsl: string): number => (wgsl.match(/: sampler(_comparison)?;/g) ?? []).length;
const texture = (): DataTexture => new DataTexture(new Uint8Array(16), 2, 2, RGBAFormat);

describe('lens droplet shaders', () => {
  it('draws the drop layer from per-instance attributes', () => {
    const material = LensDropLayer.createMaterial(new LensDropletUniforms().aspect);
    const { vertex, fragment } = shaders(material, LensDropLayer.createGeometry());
    expect(vertex).toContain('dropShape');
    expect(vertex).toContain('dropLook');
    expect(samplers(fragment)).toBe(0);
  });

  it('samples the scene and the drop layer only', () => {
    const material = new MeshBasicNodeMaterial();
    const scene = tsl.texture(texture());
    material.outputNode = lensDroplets(scene, texture(), tsl.float(-10), new LensDropletUniforms());
    const { fragment } = shaders(material);
    expect(samplers(fragment)).toBeLessThanOrEqual(2);
  });

  it('is a plain copy while the glass is dry', () => {
    const u = new LensDropletUniforms();
    u.set(0, { mode: 'window', windowDistance: 4 }, 1920, 1080);
    expect(u.isActive).toBe(false);
    u.set(3, { mode: 'window', windowDistance: 4 }, 1920, 1080);
    expect(u.isActive).toBe(true);
    // Everything but the one read of the scene sits behind the dry-glass branch.
    const material = new MeshBasicNodeMaterial();
    material.outputNode = lensDroplets(tsl.texture(texture()), texture(), tsl.float(-10), u);
    const main = shaders(material).fragment.split('fn main')[1]!;
    const beforeBranch = main.split('if (')[0]!;
    expect(beforeBranch.match(/texture(Load|Sample\w*)\(/g)?.length).toBe(1);
    expect(main).toContain(`if ( ( object.nodeUniform`);
  });
});
