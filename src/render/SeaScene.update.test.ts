// SeaScene.update on a stand-in renderer (no GPU, as SeaScene.dispose.test.ts): a frame whose step is
// not a number must not poison the state that integrates it, like the exposure's adapted EV.

import { PerspectiveCamera, Vector3, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { SimClock } from '../sim/astro/clock';
import type { SpectrumMessage } from '../sim/world/protocol';
import { type SceneFrame, SeaScene } from './SeaScene';

function standInRenderer(): WebGPURenderer {
  return {
    backend: { device: undefined },
    shadowMap: { enabled: false },
    coordinateSystem: 2000,
    compute: () => undefined,
    computeAsync: async () => undefined,
    getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) => target.set(1280, 720),
    domElement: { width: 1280, height: 720 },
    initRenderTarget: () => undefined,
  } as unknown as WebGPURenderer;
}

function spectrum(): SpectrumMessage {
  const cascade = (index: number, size: number, resolution: number) => ({
    index,
    kind: 'wind' as const,
    size,
    resolution,
    h0: new Float32Array(resolution * resolution * 4).map((_, i) => Math.sin(i) * 0.01),
    choppiness: 1,
  });
  return {
    type: 'spectrum',
    version: 1,
    activationTime: 0,
    transitionDuration: 0,
    cascades: [cascade(0, 250, 32), cascade(1, 60, 32), cascade(2, 17, 16)],
    significantHeight: 2,
    peakPeriod: 8,
    douglas: 3,
    wind: { speed: 10, from: 0, gustFactor: 1 },
  } as unknown as SpectrumMessage;
}

describe('SeaScene.update', () => {
  it('treats a non-finite frame step as no time passing', () => {
    const g = globalThis as Record<string, unknown>;
    g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
    const scene = new SeaScene(standInRenderer(), {
      spectrum: spectrum(),
      quality: 'low',
      post: { aa: 'off', bloom: false },
      shadows: { enabled: false, mapSize: 256, cascades: 1, maxFar: 200 },
      seed: 1,
      latitudeDeg: 40,
      longitudeDeg: -40,
    });
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 20_000);
    camera.position.set(0, 3, 0);
    const clock = new SimClock({ date: '2026-07-15', timeOfDay: 12, longitude: 0 });
    const frame = (dt: number): SceneFrame => ({
      camera,
      boats: [],
      time: 10,
      dt,
      clock,
      weather: {
        windVelocity: { x: 5, y: 0, z: 0 },
        precipitation: 0,
        lightningPerMinute: 0,
        overcast: 0,
        hazeDensity: 1,
        visibility: 30_000,
        clouds: { type: 'clear', coverage: 0, base: 1500 },
      },
      focus: new Vector3(),
    });
    scene.update(frame(1 / 60));
    for (const dt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scene.update(frame(dt))).not.toThrow();
      expect(Number.isFinite(scene.exposure.preExposure)).toBe(true);
      expect(Number.isFinite(scene.exposure.ev100)).toBe(true);
    }
    scene.dispose();
  });
});
