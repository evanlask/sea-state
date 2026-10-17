import { describe, expect, it } from 'vite-plus/test';

import {
  cascadeBias,
  cascadeDepthRange,
  DEPTH_BIAS_METRES,
  fitShadowFar,
  footprintDepthRange,
  NORMAL_BIAS,
  quantizeShadowFar,
  SHADOW_FADE_START,
  SHADOW_FIT_DEFAULTS,
  type ShadowCaster,
  shadowLightMargin,
  shadowOffset,
  type ShadowView,
  sphereInView,
} from './shadowFit';

const DEG = Math.PI / 180;
const OPTIONS = { ...SHADOW_FIT_DEFAULTS, baseFar: 600 };

// A camera at (0, h, z0) looking horizontally toward −Z, 55° vertical FOV, 16:9.
function view(z0: number, height = 20): ShadowView {
  const tanHalfV = Math.tan(27.5 * DEG);
  return {
    position: { x: 0, y: height, z: z0 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    tanHalfV,
    tanHalfH: tanHalfV * (16 / 9),
  };
}

// Toward a light at this elevation, from behind the camera (+Z): shadows point away from it.
const lightBehind = (elevation: number) => ({
  x: 0,
  y: Math.sin(elevation * DEG),
  z: Math.cos(elevation * DEG),
});

const ship = (height: number, length: number, helm = true): ShadowCaster => ({
  x: 0,
  y: 0,
  z: 0,
  radius: length / 2,
  height,
  helm,
});

describe('shadowOffset', () => {
  it('runs height / tan(elevation) away from the light', () => {
    const offset = shadowOffset(60, lightBehind(15), 5000);
    expect(offset.x).toBeCloseTo(0, 9);
    expect(offset.z).toBeCloseTo(-60 / Math.tan(15 * DEG), 6);
  });

  it('is clamped to the longest shadow fitted, and zero with the light down', () => {
    expect(Math.hypot(...Object.values(shadowOffset(60, lightBehind(1), 800)))).toBeCloseTo(800, 6);
    expect(shadowOffset(60, { x: 0, y: -0.1, z: 1 }, 800)).toEqual({ x: 0, z: 0 });
    expect(shadowOffset(60, { x: 0, y: 1, z: 0 }, 800)).toEqual({ x: 0, z: 0 }); // overhead
  });
});

describe('sphereInView', () => {
  it('accepts spheres in the frustum or overlapping its sides, rejects those behind or beside it', () => {
    const v = view(0);
    expect(sphereInView(v, { x: 0, y: 20, z: -100 }, 1)).toBe(true);
    expect(sphereInView(v, { x: 0, y: 20, z: 50 }, 10)).toBe(false); // behind
    expect(sphereInView(v, { x: 0, y: 20, z: 5 }, 10)).toBe(true); // straddles the camera
    const edge = 100 * v.tanHalfH;
    expect(sphereInView(v, { x: edge + 5, y: 20, z: -100 }, 6)).toBe(true);
    expect(sphereInView(v, { x: edge + 50, y: 20, z: -100 }, 6)).toBe(false);
  });
});

describe('footprintDepthRange', () => {
  it('reaches from the hull’s near side to the far end of its shadow', () => {
    const range = footprintDepthRange(view(300), lightBehind(15), ship(52, 243), 1500)!;
    const shadow = (52 + 8) / Math.tan(15 * DEG); // HEIGHT_PAD 8 m
    expect(range.near).toBeCloseTo(300 - 121.5, 6);
    expect(range.far).toBeCloseTo(300 + shadow + 121.5, 6);
  });

  it('is null for a boat out of view', () => {
    expect(footprintDepthRange(view(-400), lightBehind(30), ship(10, 10), 1500)).toBeNull();
  });
});

describe('fitShadowFar', () => {
  it('keeps the base distance for small boats close by', () => {
    expect(fitShadowFar(view(20, 5), lightBehind(15), [ship(17, 11.5)], OPTIONS)).toBe(600);
  });

  it('stretches past a container ship’s shadow, ahead of the fade', () => {
    const far = fitShadowFar(view(312, 66), lightBehind(15), [ship(52, 243)], OPTIONS);
    const range = footprintDepthRange(view(312, 66), lightBehind(15), ship(52, 243), 1500)!;
    expect(far).toBeGreaterThan(600);
    expect(far * SHADOW_FADE_START).toBeGreaterThanOrEqual(range.far);
  });

  it('grows with lower sun and is capped', () => {
    const at = (elevation: number) =>
      fitShadowFar(view(312, 66), lightBehind(elevation), [ship(52, 243)], OPTIONS);
    expect(at(10)).toBeGreaterThan(at(30));
    expect(at(30)).toBeGreaterThan(at(60));
    expect(fitShadowFar(view(5000, 66), lightBehind(10), [ship(52, 243)], OPTIONS)).toBe(OPTIONS.maxFar);
  });

  it('fits fleet boats that start within the base range, not distant ones', () => {
    const near = { ...ship(60, 317, false), z: -300 };
    const distant = { ...ship(60, 317, false), z: -1500 };
    const v = view(20, 5);
    const helm = ship(1.4, 3.3);
    expect(fitShadowFar(v, lightBehind(20), [helm, near], OPTIONS)).toBeGreaterThan(600);
    expect(fitShadowFar(v, lightBehind(20), [helm, distant], OPTIONS)).toBe(600);
    // The helm boat is fitted however far away.
    expect(fitShadowFar(v, lightBehind(20), [{ ...distant, helm: true }], OPTIONS)).toBeGreaterThan(2000);
  });

  it('ignores a light below the horizon', () => {
    expect(fitShadowFar(view(312), { x: 0, y: -0.2, z: 1 }, [ship(52, 243)], OPTIONS)).toBe(600);
  });
});

describe('quantizeShadowFar', () => {
  it('grows at once to the next step and shrinks only two steps down', () => {
    expect(quantizeShadowFar(600, 600)).toBe(600);
    expect(quantizeShadowFar(601, 600)).toBe(700);
    expect(quantizeShadowFar(650, 800)).toBe(800); // one step below: hold
    expect(quantizeShadowFar(590, 800)).toBe(600); // two steps below: shrink
  });
});

describe('shadowLightMargin', () => {
  it('keeps the base margin for small boats and a high sun', () => {
    expect(shadowLightMargin(3.4, lightBehind(10), 300, 1500)).toBe(300);
    expect(shadowLightMargin(60, lightBehind(60), 300, 1500)).toBe(300);
  });

  it('reaches the top of a tall ship at a low sun (height / sin elevation)', () => {
    const margin = shadowLightMargin(60, lightBehind(8), 300, 1500);
    expect(margin).toBeGreaterThanOrEqual(68 / Math.sin(8 * DEG));
    expect(margin % 100).toBe(0);
    // No further than the longest fitted shadow's ray, however low the light.
    expect(shadowLightMargin(60, lightBehind(0.5), 300, 1500)).toBeLessThanOrEqual(1700);
  });
});

describe('cascadeDepthRange', () => {
  it('spans the margin plus the deepest slice extent', () => {
    const tanV = Math.tan(27.5 * DEG);
    const range = cascadeDepthRange(300, 600, tanV, tanV * (16 / 9));
    const diagonal = 2 * 600 * Math.hypot(tanV, tanV * (16 / 9)); // far-plane diagonal
    expect(range).toBeGreaterThanOrEqual(300 + diagonal);
    expect(range).toBeLessThan(300 + diagonal + 200);
    expect(cascadeDepthRange(800, 1200, tanV, tanV)).toBeGreaterThan(range);
  });
});

describe('cascadeBias', () => {
  it('holds ~3 cm of depth per cascade number at the base distance, whatever the depth range', () => {
    for (const range of [1600, 4000]) {
      const { bias, normalBias } = cascadeBias(1, 600, 600, 1, range);
      expect(-bias * (range - 1)).toBeCloseTo(2 * DEPTH_BIAS_METRES, 9);
      expect(normalBias).toBe(NORMAL_BIAS);
    }
  });

  it('grows with the cascades’ texel size when the distance stretches', () => {
    const base = cascadeBias(0, 600, 600, 1, 2000);
    const stretched = cascadeBias(0, 1200, 600, 1, 2000);
    expect(stretched.bias).toBeCloseTo(base.bias * 2, 12);
    expect(stretched.normalBias).toBeCloseTo(base.normalBias * 2, 12);
  });
});
