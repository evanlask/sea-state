// The contrail sky term compiles to WGSL in Node (the node builder runs on the CPU, as in
// particles/shaders.test.ts), keeps its derivatives out of branches, and the per-frame update fills
// the slots from the schedule.

import {
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { getWeatherPreset } from '../../sim/weather/presets';
import { AtmosphereLuts, AtmosphereUniforms, LUT_QUALITY } from '../sky/AtmosphereLuts';
import type { SkySystem } from '../sky/SkySystem';
import { tsl } from '../tsl';
import { ContrailSystem } from './ContrailSystem';

function renderer(): WebGPURenderer {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
  const r = new WebGPURenderer() as WebGPURenderer & Record<string, unknown>;
  r.hasFeature = () => false;
  // oxlint-disable-next-line typescript/no-explicit-any
  (r.backend as any).renderer = r;
  return r;
}

function fragmentShader(mesh: Mesh): string {
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
  return builder.fragmentShader as string;
}

// The parts of SkySystem the contrails read, with the real LUTs and uniforms.
function skyStub(sunY: number): SkySystem {
  const uniforms = new AtmosphereUniforms();
  const luts = new AtmosphereLuts(uniforms, LUT_QUALITY.low);
  const sun = { x: 0, y: sunY, z: -Math.sqrt(1 - sunY * sunY) };
  return {
    atmosphere: { luts, uniforms },
    preExposure: tsl.uniform(1),
    sunDirection: sun,
    sunIlluminanceAloft: (_altitude: number, cosZenith: number, out: [number, number, number]) => {
      const lux = cosZenith > -0.05 ? 100_000 : 0;
      out[0] = out[1] = out[2] = lux;
      return out;
    },
  } as unknown as SkySystem;
}

const fair = getWeatherPreset('fair');
const weather = {
  clouds: fair.clouds,
  precipitation: 0,
  visibility: 30_000,
  windVelocity: { x: 4, z: 1 },
};

describe('ContrailSystem', () => {
  it('compiles the sky term, derivatives before any branch', () => {
    const contrails = new ContrailSystem(skyStub(0.5), 1);
    const material = new MeshBasicNodeMaterial();
    material.colorNode = contrails.composite(
      tsl.normalize(tsl.positionLocal),
      tsl.vec3(0.2, 0.3, 0.5),
    ) as typeof material.colorNode;
    const wgsl = fragmentShader(new Mesh(new PlaneGeometry(), material));
    expect(wgsl).toContain('fwidth');
    const main = wgsl.slice(wgsl.indexOf('fn main'));
    expect(main.lastIndexOf('fwidth')).toBeLessThan(main.indexOf('if '));
  });

  it('fills a slot with the trail and the aircraft lights when a jet is forced', () => {
    const contrails = new ContrailSystem(skyStub(-0.3), 1); // night
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    contrails.update(10, camera, weather);
    expect(contrails.aircraft).toHaveLength(0);
    contrails.requestForce();
    contrails.update(10.5, camera, weather);
    expect(contrails.aircraft).toHaveLength(1);
    const plane = contrails.aircraft[0];
    expect(plane?.position.y).toBeGreaterThan(9000);
    expect(Math.hypot(plane?.velocity.x ?? 0, plane?.velocity.z ?? 0)).toBeGreaterThan(200);
  });
});
