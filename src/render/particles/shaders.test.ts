// The particle kernels and material, and the rain, compile to WGSL in Node (the node builder runs on
// the CPU, as in LensDroplets.test.ts): with the hull test, smoke and the power-law sizes in them,
// and the particle material still reading a single texture (the scene depth) in its fragment stage.

import { type ComputeNode, type Mesh, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { PHYSICS_CASCADES, visualCascades } from '../../sim/ocean/cascades';
import { T_REPEAT } from '../../sim/ocean/spectrum';
import { type GpuCascade, GpuOceanSimulation } from '../ocean/GpuOcean';
import { Rain } from '../weather/Rain';
import { RainSplashEmitter, SpumeEmitter } from './emitters';
import { HullVolumes } from './hullVolumes';
import { OceanSampler } from './oceanSampler';
import { ParticleSystem } from './ParticleSystem';
import { FxLighting } from './shading';

function renderer(): WebGPURenderer {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const r = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  r.hasFeature = () => false;
  // The scene-depth copy asks the backend's renderer for its sample count.
  // oxlint-disable-next-line typescript/no-explicit-any
  (r.backend as any).renderer = r;
  return r;
}

function meshShaders(mesh: Mesh): { vertex: string; fragment: string } {
  const r = renderer();
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  scene.add(mesh);
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = r.backend as any;
  const builder = backend.createNodeBuilder(mesh, r);
  builder.scene = scene;
  builder.material = mesh.material;
  builder.camera = camera;
  builder.context.material = mesh.material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (r as any).lighting.getNode(scene, camera);
  builder.build();
  return { vertex: builder.vertexShader as string, fragment: builder.fragmentShader as string };
}

function computeShader(node: ComputeNode): string {
  const r = renderer();
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = r.backend as any;
  const builder = backend.createNodeBuilder(null, r);
  builder.compute = node;
  builder.build();
  return builder.computeShader as string;
}

const cascades = (): GpuCascade[] =>
  [...PHYSICS_CASCADES, ...visualCascades('high')].map((c) => ({
    size: c.resolution,
    patchLength: c.size,
    h0: new Float32Array(c.resolution * c.resolution * 4),
    omega: new Float32Array(c.resolution * c.resolution),
    choppiness: 1,
  }));

const samplers = (wgsl: string): number => (wgsl.match(/: sampler(_comparison)?;/g) ?? []).length;

function system(): ParticleSystem {
  const simulation = new GpuOceanSimulation(cascades(), T_REPEAT);
  return new ParticleSystem({
    capacity: 1024,
    emitPerFrame: 256,
    ocean: new OceanSampler(simulation.groups),
    lighting: new FxLighting(),
    hulls: new HullVolumes(),
  });
}

describe('particle shaders', () => {
  it('draws every kind with one texture read in the fragment stage', () => {
    const { vertex, fragment } = meshShaders(system().mesh);
    expect(vertex.length).toBeGreaterThan(0);
    expect(samplers(fragment)).toBeLessThanOrEqual(1);
  });

  it('draws the rain, kept out of the hulls, without a texture', () => {
    const rain = new Rain({ maxDrops: 64, lighting: new FxLighting(), hulls: new HullVolumes() });
    const { vertex, fragment } = meshShaders(rain.mesh);
    expect(vertex).toContain('for (');
    expect(samplers(fragment)).toBe(0);
  });

  it('compiles the simulation and emission kernels with the hull test', () => {
    const particles = system();
    // oxlint-disable-next-line typescript/no-explicit-any
    const nodes = particles as any;
    for (const node of [nodes.simulateNode, nodes.emitNode] as ComputeNode[]) {
      const wgsl = computeShader(node);
      expect(wgsl).toContain('fn main');
    }
  });

  it('compiles the spume and rain-splash emitters with the hull test', () => {
    const particles = system();
    const spume = new SpumeEmitter({ particles, maxCandidates: 64 });
    const rain = new RainSplashEmitter({ particles, maxCandidates: 64 });
    // oxlint-disable-next-line typescript/no-explicit-any
    for (const emitter of [spume, rain] as any[]) expect(computeShader(emitter.node)).toContain('fn main');
  });
});
