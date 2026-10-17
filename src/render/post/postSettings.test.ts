import { describe, expect, it } from 'vite-plus/test';

import { QUALITY_PRESET_VALUES } from '../../settings/presets';
import { defaultSettings } from '../../settings/schema';
import { pyramidOffsets } from '../ocean/oceanOptics';
import {
  BLOOM_BY_QUALITY,
  cocScalePx,
  fNumberFromAperture,
  planPost,
  postGraphChanged,
  postSettingsFrom,
} from './postSettings';

describe('post plan', () => {
  it('maps settings to AA and motion vectors', () => {
    expect(planPost({ aa: 'fxaa', bloom: true }, 'low', { temporal: true })).toMatchObject({
      aa: 'fxaa',
      motionVectors: false,
    });
    expect(planPost({ aa: 'traa', bloom: true }, 'high', { temporal: true })).toMatchObject({
      aa: 'traa',
      motionVectors: true,
    });
  });

  it('falls back from TRAA to SMAA without temporal support', () => {
    const plan = planPost({ aa: 'traa', bloom: false }, 'ultra', { temporal: false });
    expect(plan.aa).toBe('smaa');
    expect(plan.motionVectors).toBe(false);
    expect(plan.bloom).toBeNull();
  });

  it('blooms only above diffuse white', () => {
    const plan = planPost({ aa: 'smaa', bloom: true }, 'medium', { temporal: true });
    expect(plan.bloom).toEqual(BLOOM_BY_QUALITY.medium);
    for (const params of Object.values(BLOOM_BY_QUALITY)) expect(params.threshold).toBeGreaterThan(1);
  });
});

describe('optional effects', () => {
  const presetPlan = (quality: 'low' | 'medium' | 'high' | 'ultra') => {
    const graphics = { ...defaultSettings().graphics, ...QUALITY_PRESET_VALUES[quality] };
    return planPost(postSettingsFrom(graphics), quality, { temporal: true });
  };

  it('follows the quality table: SSR and GTAO on High (half) and Ultra (full) only', () => {
    expect(presetPlan('low').ssr).toBeNull();
    expect(presetPlan('medium').ssr).toBeNull();
    expect(presetPlan('low').ao).toBeNull();
    expect(presetPlan('medium').ao).toBeNull();
    const high = presetPlan('high');
    const ultra = presetPlan('ultra');
    expect(high.ao?.resolutionScale).toBe(0.5);
    expect(ultra.ao?.resolutionScale).toBe(1);
    expect(ultra.ssr?.steps).toBeGreaterThan(high.ssr?.steps ?? Infinity);
    expect(high.ssr?.resolutionScale).toBe(0.5);
    expect(ultra.ssr?.resolutionScale).toBe(1);
  });

  it('adds the sun flare from High up', () => {
    expect(presetPlan('low').flare).toBeNull();
    expect(presetPlan('medium').flare).toBeNull();
    expect(presetPlan('high').flare).not.toBeNull();
    expect(presetPlan('ultra').flare).not.toBeNull();
  });

  it('keeps every optional effect out of the graph when off', () => {
    const plan = planPost({ aa: 'fxaa', bloom: false }, 'low', { temporal: true });
    expect(plan).toMatchObject({
      ao: null,
      droplets: false,
      ssr: null,
      motionVectors: false,
    });
  });

  it('keeps the scene pass outputs fixed from Medium up, so AA / AO changes rebuild only post', () => {
    for (const quality of ['medium', 'high', 'ultra'] as const)
      for (const aa of ['traa', 'smaa', 'fxaa'] as const)
        expect(planPost({ aa, bloom: false }, quality, { temporal: true }).motionVectors).toBe(true);
  });

  it('writes motion vectors for GTAO even without TRAA', () => {
    expect(
      planPost({ aa: 'fxaa', bloom: true, ao: 'gtao-half' }, 'low', { temporal: true }).motionVectors,
    ).toBe(true);
  });

  it('rebuilds the graph only when its shape changes', () => {
    const a = planPost({ aa: 'traa', bloom: true }, 'high', { temporal: true });
    expect(postGraphChanged(a, planPost({ aa: 'traa', bloom: true }, 'high', { temporal: true }))).toBe(
      false,
    );
    expect(
      postGraphChanged(
        a,
        planPost({ aa: 'traa', bloom: true, lensDroplets: true }, 'high', { temporal: true }),
      ),
    ).toBe(true);
    expect(
      postGraphChanged(a, planPost({ aa: 'traa', bloom: true, ao: 'gtao-full' }, 'high', { temporal: true })),
    ).toBe(true);
    // SSR is a post pass of its own (OceanReflections.ts).
    const half = planPost({ aa: 'traa', bloom: true, reflections: 'ssr-half' }, 'high', { temporal: true });
    const full = planPost({ aa: 'traa', bloom: true, reflections: 'ssr-full' }, 'high', { temporal: true });
    expect(postGraphChanged(a, half)).toBe(true);
    expect(postGraphChanged(half, full)).toBe(true);
  });
});

describe('depth of field', () => {
  it('maps the camera aperture 0..1 to f/22 … f/1.4', () => {
    expect(fNumberFromAperture(0)).toBeCloseTo(22);
    expect(fNumberFromAperture(1)).toBeCloseTo(1.4);
    expect(fNumberFromAperture(0.5)).toBeCloseTo(Math.sqrt(22 * 1.4));
  });

  it('blurs more with a wider aperture and a closer focus; a pinhole not at all', () => {
    const base = { enabled: true, focusDistance: 10, aperture: 0.5 };
    expect(cocScalePx({ ...base, aperture: 0 }, 60, 1080)).toBe(0);
    expect(cocScalePx({ ...base, aperture: 1 }, 60, 1080)).toBeGreaterThan(cocScalePx(base, 60, 1080));
    expect(cocScalePx({ ...base, focusDistance: 3 }, 60, 1080)).toBeGreaterThan(cocScalePx(base, 60, 1080));
    // A telephoto (narrow FOV) has a longer focal length: shallower depth of field.
    expect(cocScalePx(base, 20, 1080)).toBeGreaterThan(cocScalePx(base, 60, 1080));
  });
});

describe('ocean mip pyramid', () => {
  it('lays out every level of every layer back to back', () => {
    const offsets = pyramidOffsets(8, 2);
    // Levels 8², 4², 2², 1² per layer.
    expect(offsets).toEqual([0, 128, 160, 168, 170]);
  });
});
