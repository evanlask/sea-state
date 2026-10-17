import { type Color, PerspectiveCamera, Scene, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { SkySystem } from '../sky/SkySystem';
import { SunMoonLight } from './SunMoonLight';

const DEG = Math.PI / 180;

function fakeSky(sunElevation: number, sunLux: number, moonLux: number): SkySystem {
  return {
    sunElevation,
    sunDirection: new Vector3(0, Math.sin(sunElevation), -Math.cos(sunElevation)),
    moonDirection: new Vector3(0, 0.5, 0.8).normalize(),
    sunIlluminance: (c: Color) => c.setRGB(sunLux, sunLux, sunLux),
    moonIlluminance: (c: Color) => c.setRGB(moonLux, moonLux, moonLux),
  } as unknown as SkySystem;
}

describe('SunMoonLight', () => {
  it('never changes the light set: visible and castShadow hold through sunset and moonset', () => {
    const light = new SunMoonLight(new Scene());
    const target = new Vector3();
    const states: string[] = [];
    for (const [elevation, sun, moon] of [
      [30 * DEG, 50_000, 0],
      [-3 * DEG, 0, 0.1], // moonlight
      [-20 * DEG, 0, 0], // moonset: no light at all
      [10 * DEG, 20_000, 0],
    ] as const) {
      light.update(fakeSky(elevation, sun, moon), 1, target);
      states.push(`${light.light.visible}:${light.light.castShadow}`);
    }
    expect(new Set(states)).toEqual(new Set(['true:true']));
  });

  it('stops re-rendering shadow maps while dark, except during warm-up', () => {
    const light = new SunMoonLight(new Scene());
    light.update(fakeSky(-20 * DEG, 0, 0), 1, new Vector3());
    expect(light.light.intensity).toBe(0);
    expect(light.light.shadow.autoUpdate).toBe(false);
    light.setWarmup(true);
    light.update(fakeSky(-20 * DEG, 0, 0), 1, new Vector3());
    expect(light.light.shadow.autoUpdate).toBe(true);
    light.setWarmup(false);
    light.update(fakeSky(20 * DEG, 30_000, 0), 1, new Vector3());
    expect(light.light.shadow.autoUpdate).toBe(true);
  });

  it('scales only the directional intensity by the overcast share, and rests the shadows at 0', () => {
    const light = new SunMoonLight(new Scene());
    light.update(fakeSky(40 * DEG, 50_000, 0), 1, new Vector3());
    const clear = light.light.intensity;
    light.update(fakeSky(40 * DEG, 50_000, 0), 1, new Vector3(), 0.25);
    expect(light.light.intensity).toBeCloseTo(clear * 0.25, 6);
    expect(light.illuminanceLux).toBeCloseTo(50_000, 6); // the clear-sky value, for bounce light
    expect(light.sourceWeight).toBe(1);
    light.update(fakeSky(40 * DEG, 50_000, 0), 1, new Vector3(), 0);
    expect(light.light.intensity).toBe(0);
    expect(light.light.shadow.autoUpdate).toBe(false);
  });

  it('stretches the cascades over a big ship’s shadow and refits them when the camera changes', () => {
    const light = new SunMoonLight(new Scene(), { enabled: true, mapSize: 2048, cascades: 3, maxFar: 600 });
    const camera = new PerspectiveCamera(55, 16 / 9, 0.1, 80_000);
    camera.position.set(0, 66, 312);
    camera.lookAt(0, 12, 0);
    camera.updateMatrixWorld();
    const csm = light.shadowNode as unknown as {
      _init(b: { camera: PerspectiveCamera; renderer: object }): void;
      _cascades: { y: number }[];
      maxFar: number;
      lightMargin: number;
      lights: { shadow: { camera: { far: number; right: number } } }[];
    };
    csm._init({ camera, renderer: { coordinateSystem: WebGPUCoordinateSystem, reversedDepthBuffer: false } });
    const sky = fakeSky(10 * DEG, 50_000, 0); // sun ahead (−Z): the shadow runs toward the camera
    const cargo = { x: 0, y: 0, z: 0, radius: 122, height: 52, helm: true };
    light.update(sky, 1, new Vector3(), 1, { camera, casters: [{ ...cargo, height: 1.4, radius: 1.7 }] });
    expect(light.shadowFar).toBe(600);
    expect(csm.lightMargin).toBe(300);
    light.update(sky, 1, new Vector3(), 1, { camera, casters: [cargo] });
    expect(light.shadowFar).toBeGreaterThan(600);
    expect(csm.maxFar).toBe(light.shadowFar);
    expect(csm.lightMargin).toBeGreaterThanOrEqual(60 / Math.sin(10 * DEG));
    for (const cascade of csm.lights)
      expect(cascade.shadow.camera.far).toBeGreaterThan(csm.lightMargin + csm.maxFar * 2);
    // A narrower view (resize, FOV setting) refits the cascades to the new frustum: CSMShadowNode
    // alone would keep the frustum it first saw.
    const width = (i: number) => csm.lights[i]!.shadow.camera.right;
    const before = [0, 1, 2].map(width);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    light.update(sky, 1, new Vector3(), 1, { camera, casters: [cargo] });
    expect(light.shadowFar).toBe(csm.maxFar);
    for (const i of [0, 1, 2]) expect(width(i)).toBeLessThan(before[i]!);
  });
});
