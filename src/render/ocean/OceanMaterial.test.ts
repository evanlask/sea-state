// The ocean material compiles to WGSL in Node (the node builder runs on the CPU, as in
// LensDroplets.test.ts) and keeps within WebGPU's default 16 samplers per fragment stage without
// wakes: the foam's detail lookups all share the one foam detail texture. With the sun's cascaded
// shadows on, every cascade is sampled at the displaced surface and shadows every direct term.

import { type Light, type Mesh, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { PHYSICS_CASCADES, visualCascades } from '../../sim/ocean/cascades';
import { T_REPEAT } from '../../sim/ocean/spectrum';
import { SunMoonLight } from '../lighting/SunMoonLight';
import { FoamDetail } from './FoamDetail';
import { type GpuCascade, GpuOceanSimulation } from './GpuOcean';
import { OceanMesh } from './OceanMesh';
import { OCEAN_SHADING_QUALITY } from './oceanOptics';

interface Shaders {
  vertex: string;
  fragment: string;
}

// shadows: the scene's sun/moon light with its CSM cascades, as the app has it (reversed-Z,
// comparison samplers).
function compile(mesh: Mesh, shadows = false): Shaders {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const renderer = new WebGPURenderer({ reversedDepthBuffer: shadows }) as WebGPURenderer &
    Record<string, unknown>;
  renderer.hasFeature = () => false;
  renderer.hasCompatibility = () => true;
  renderer.shadowMap.enabled = shadows;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  scene.add(mesh);
  const lights: Light[] = [];
  if (shadows) {
    const sun = new SunMoonLight(scene);
    sun.light.intensity = 1;
    lights.push(sun.light);
  }
  // oxlint-disable-next-line typescript/no-explicit-any
  const backend = renderer.backend as any;
  // The opaque depth copy (refraction, SSR) asks the uninitialised backend for its sample count.
  backend.renderer ??= renderer;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.material = mesh.material;
  builder.camera = camera;
  builder.context.material = mesh.material;
  // oxlint-disable-next-line typescript/no-explicit-any
  builder.lightsNode = (renderer as any).lighting.getNode(scene, camera);
  builder.lightsNode.setLights(lights);
  builder.build();
  return { vertex: builder.vertexShader as string, fragment: builder.fragmentShader as string };
}

const fragmentShader = (mesh: Mesh): string => compile(mesh).fragment;

const cascades = (): GpuCascade[] =>
  [...PHYSICS_CASCADES, ...visualCascades('high')].map((c) => ({
    size: c.resolution,
    patchLength: c.size,
    h0: new Float32Array(c.resolution * c.resolution * 4),
    omega: new Float32Array(c.resolution * c.resolution),
    choppiness: 1,
  }));

const samplers = (wgsl: string): number => (wgsl.match(/: sampler(_comparison)?;/g) ?? []).length;
const count = (wgsl: string, pattern: RegExp): number => (wgsl.match(pattern) ?? []).length;

const oceanMesh = (): OceanMesh => {
  const simulation = new GpuOceanSimulation(cascades(), T_REPEAT);
  const quality = { ...OCEAN_SHADING_QUALITY.high, refraction: false };
  const ocean = new OceanMesh({ groups: simulation.groups, foamDetail: new FoamDetail().texture, quality });
  ocean.mesh.receiveShadow = true; // as OceanSurface sets it
  return ocean;
};

describe('ocean material', () => {
  // Refraction reads the opaque copies, which need a live render target; the foam doesn't care.
  it.each([1, 2] as const)(
    'compiles with %i lace octave(s), procedural streaks and no extra sampler',
    (octaves) => {
      const simulation = new GpuOceanSimulation(cascades(), T_REPEAT);
      const quality = { ...OCEAN_SHADING_QUALITY.high, refraction: false, foamOctaves: octaves };
      const ocean = new OceanMesh({
        groups: simulation.groups,
        foamDetail: new FoamDetail().texture,
        quality,
      });
      const fragment = fragmentShader(ocean.mesh);
      expect(fragment).toContain('oceanStreaks');
      expect(fragment).toContain('oceanFoamDrift');
      // Derivatives + foam per cascade group (2) and the foam detail texture; the sky probe, the
      // opaque copies and the shadow maps join them in the app.
      expect(samplers(fragment)).toBe(5);
    },
  );

  it('samples every shadow cascade at the displaced surface and shadows all the direct light', () => {
    const { vertex, fragment } = compile(oceanMesh().mesh, true);
    const cascades = 3; // DEFAULT_SHADOW_QUALITY
    // Each cascade's depth map with its comparison sampler, 5 PCF taps each (none dropped by the
    // getShadow context or the sampler budget).
    expect(count(fragment, /: texture_depth_2d;/g)).toBe(cascades);
    expect(count(fragment, /: sampler_comparison;/g)).toBe(cascades);
    expect(count(fragment, /textureSampleCompare\(/g)).toBe(cascades * 5);
    // Looked up at the world position of the displaced vertex (FFT displacement, wakes and Earth
    // curvature applied in the vertex stage), not the flat grid.
    expect(fragment).toMatch(/shadowPositionWorld = v_positionWorld;/);
    expect(vertex).toMatch(/positionLocal = \( \( vec3<f32>\( \w+\.x, 0\.0, \w+\.y \) \+/);
    expect(vertex).toMatch(/v_positionWorld = \( object\.\w+ \* vec4<f32>\( positionLocal, 1\.0 \) \)/);
    // The normal bias needs no screen derivatives inside the cascade branches.
    expect(fragment).not.toContain('normalFlat');
    // ...and its normal is assigned once at the top of the shader, not inside the nearest cascade's
    // branch (the other cascades then read an unassigned zero normal: NaN coordinates, never shadowed).
    const assignments = [...fragment.matchAll(/^(\s*)normal(View|World) = /gm)];
    expect(assignments.length).toBeGreaterThanOrEqual(2);
    for (const [, indent] of assignments) expect(indent).toBe('\t');
    const firstCascade = fragment.indexOf('cascades.value[ 0u ]');
    expect((assignments[0] as RegExpMatchArray).index).toBeLessThan(firstCascade);
    expect(fragment).not.toMatch(/^\t\t+normalView = /m);
    // The light's colour is read once, already multiplied by the shadow: glint, body, crest glow
    // and foam all go dark in a boat's shadow.
    const light = /vec4<f32>\( (render\.\w+), 1\.0 \) \* shadowValue/.exec(fragment);
    expect(light).not.toBeNull();
    const uniform = (light as RegExpExecArray)[1] as string;
    expect(count(fragment, new RegExp(`${uniform.replace('.', '\\.')}\\b`, 'g'))).toBe(1);
  });

  // SSR is a post pass (post/OceanReflections.ts) that finds the sea in the depth buffer: the
  // material only makes sure the opaque copies it traces exist, even without refraction.
  it('only reads the opaque copies for SSR, marching nothing itself', () => {
    const ocean = oceanMesh();
    const without = fragmentShader(ocean.mesh);
    ocean.material.setReflections(true);
    const fragment = fragmentShader(ocean.mesh);
    expect(ocean.material.opaqueCopies).not.toBeNull();
    expect(count(fragment, /: texture_depth_2d;/g)).toBe(count(without, /: texture_depth_2d;/g) + 1);
    expect(fragment).not.toMatch(/for \( var/);
    expect(fragment).not.toContain('break;');
    expect(count(compile(ocean.mesh, true).fragment, /var<uniform>/g)).toBeLessThanOrEqual(8);
  });
});
