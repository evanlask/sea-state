import { describe, expect, it } from 'vite-plus/test';

import type { QualityPreset } from '../../app/Scenario';
import { CLOUD_QUALITY, cloudBufferSizes, cloudQualityFor } from './cloudQuality';

const ORDER: readonly QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

describe('cloud quality tiers', () => {
  it('follows the plan: low ¼ 48, medium ¼ 64, high ½ 96, ultra ½ 128', () => {
    expect(ORDER.map((p) => [CLOUD_QUALITY[p].resolution, CLOUD_QUALITY[p].steps])).toEqual([
      [0.25, 48],
      [0.25, 64],
      [0.5, 96],
      [0.5, 128],
    ]);
  });

  it('never gets cheaper going up a tier', () => {
    for (let i = 1; i < ORDER.length; i++) {
      const a = CLOUD_QUALITY[ORDER[i - 1] ?? 'low'];
      const b = CLOUD_QUALITY[ORDER[i] ?? 'low'];
      expect(b.steps).toBeGreaterThanOrEqual(a.steps);
      expect(b.lightSteps).toBeGreaterThanOrEqual(a.lightSteps);
      expect(b.shadowSize).toBeGreaterThanOrEqual(a.shadowSize);
    }
  });

  it('marches whole workgroups of shadow-map rows and keeps re-centring on whole texels', () => {
    for (const p of ORDER) {
      const q = CLOUD_QUALITY[p];
      expect(q.shadowSize % (q.shadowSlices * 8)).toBe(0);
      expect(Number.isInteger(1000 / (32_000 / q.shadowSize))).toBe(true);
    }
  });

  it('maps custom settings onto resolution, steps and upscaling', () => {
    const halfCheap = cloudQualityFor('medium', { resolution: 'half', steps: 80 });
    expect([halfCheap.resolution, halfCheap.steps, halfCheap.upscale]).toEqual([0.5, 80, 2]);
    expect(cloudQualityFor('high', { resolution: 'half', steps: 200 }).upscale).toBe(1);
    const quarter = cloudQualityFor('high', { resolution: 'quarter', steps: 4 });
    expect([quarter.resolution, quarter.steps, quarter.upscale]).toEqual([0.25, 16, 1]);
    expect(cloudQualityFor('low')).toBe(CLOUD_QUALITY.low);
  });

  it('sizes the output and march buffers from the drawing buffer', () => {
    const high = cloudBufferSizes(1920, 1080, CLOUD_QUALITY.high);
    expect(high.output).toEqual([960, 540]);
    expect(high.march).toEqual([480, 270]);
    const low = cloudBufferSizes(1921, 1081, CLOUD_QUALITY.low);
    expect(low.output).toEqual([481, 271]);
    expect(low.march).toEqual(low.output);
    expect(cloudBufferSizes(1, 1, CLOUD_QUALITY.low).output).toEqual([8, 8]);
  });
});
