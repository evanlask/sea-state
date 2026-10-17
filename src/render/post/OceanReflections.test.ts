// The sea's SSR pass compiles to WGSL (the node builder runs on the CPU) against the real ocean
// material's surface sampling: it finds the sea from the depth buffers alone, samples the cascades
// with explicit LODs only (it branches before them), marches between the sample indices the boats'
// rectangles bound, and the composite upsamples by depth at half resolution.

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

import { PHYSICS_CASCADES, visualCascades } from '../../sim/ocean/cascades';
import { T_REPEAT } from '../../sim/ocean/spectrum';
import { FoamDetail } from '../ocean/FoamDetail';
import { GpuOceanSimulation } from '../ocean/GpuOcean';
import { OceanMesh } from '../ocean/OceanMesh';
import { OCEAN_SHADING_QUALITY } from '../ocean/oceanOptics';
import { tsl } from '../tsl';
import { composeReflections, OceanReflectionNode, type OceanReflectionSource } from './OceanReflections';

function fragmentOf(material: Material): string {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer({ reversedDepthBuffer: true }) as WebGPURenderer &
    Record<string, unknown>;
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

const count = (wgsl: string, pattern: RegExp): number => (wgsl.match(pattern) ?? []).length;
const mainOf = (wgsl: string): string => wgsl.split('fn main')[1] ?? '';

function oceanSource(): OceanReflectionSource {
  const cascades = [...PHYSICS_CASCADES, ...visualCascades('high')].map((c) => ({
    size: c.resolution,
    patchLength: c.size,
    h0: new Float32Array(c.resolution * c.resolution * 4),
    omega: new Float32Array(c.resolution * c.resolution),
    choppiness: 1,
  }));
  const simulation = new GpuOceanSimulation(cascades, T_REPEAT);
  const quality = { ...OCEAN_SHADING_QUALITY.high };
  const ocean = new OceanMesh({ groups: simulation.groups, foamDetail: new FoamDetail().texture, quality });
  ocean.material.setReflections(true);
  const copies = ocean.material.opaqueCopies!;
  const u = ocean.uniforms;
  return {
    color: copies.color,
    depth: copies.depth,
    occluders: u.ssrOccluderData,
    occluderCount: u.ssrOccluders.count,
    frame: u.frame,
    surface: (xz, footprint, lod) => ocean.material.surfaceAt(xz, footprint, lod),
    displacement: (xz, distance) => ocean.displacementAt(xz, distance),
  };
}

function setup(resolutionScale: number) {
  const source = oceanSource();
  const sceneDepthTexture = new DepthTexture(4, 4);
  sceneDepthTexture.type = FloatType;
  const depth = tsl.texture(sceneDepthTexture);
  const camera = new PerspectiveCamera();
  const scene = new Scene();
  // A probe as EnvironmentProbe makes one (CubeUV): the trace swaps out its reflection.
  const probe = new DataTexture(new Uint8Array(4 * 64 * 64), 64, 64, RGBAFormat);
  probe.mapping = 306; // CubeUVReflectionMapping
  scene.environment = probe;
  const node = new OceanReflectionNode(
    { steps: 40, refine: 6, maxDistance: 600, resolutionScale },
    source,
    depth,
    camera,
    scene,
    tsl.uniform(0),
  );
  const color = tsl.texture(new DataTexture(new Uint8Array(64), 4, 4, RGBAFormat));
  const composite = new MeshBasicNodeMaterial();
  composite.colorNode = composeReflections(color, node, source, depth, camera);
  const compositeShader = mainOf(fragmentOf(composite));
  const traceShader = fragmentOf((node as unknown as { material: Material }).material);
  return { compositeShader, traceShader };
}

describe('ocean reflection pass', () => {
  it('finds the sea from depth, rebuilds its normal with explicit LODs and marches bounded', () => {
    const { traceShader } = setup(0.5);
    const main = mainOf(traceShader);
    // Before the sea test: the two depth reads.
    const branch = main.indexOf('if (');
    expect(count(main.slice(0, branch), /textureLoad\(/g)).toBe(2);
    // Inside: the cascades (array textures) at explicit levels, never with screen derivatives.
    expect(count(main, /textureSampleLevel\(/g)).toBeGreaterThan(6);
    expect(main).not.toMatch(/textureSample\(/);
    expect(main).toMatch(/for \( var \w+ : i32 = 0; \w+ < i32\( object\.\w+ \); \w+ \+\+ \)/);
    expect(main).toMatch(/for \( var \w+ : i32 = \w+; \w+ <= \w+; \w+ \+\+ \)/);
    expect(main).not.toMatch(/< 40;/);
    expect(main).toContain('break;');
  });

  it('upsamples a half-resolution trace from four texels, a full one from one', () => {
    const half = setup(0.5).compositeShader;
    const full = setup(1).compositeShader;
    // Both: the two depth reads for the sea mask (and the colour). Half: 4 trace texels; full: 1.
    expect(count(full, /textureLoad\(/g) + 3).toBe(count(half, /textureLoad\(/g));
    expect(count(full, /textureLoad\(/g)).toBeLessThanOrEqual(4);
  });
});
