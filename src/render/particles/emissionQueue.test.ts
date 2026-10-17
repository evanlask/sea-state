// Emission queue packing and the request lookup the emit shader mirrors.
import { describe, expect, it } from 'vite-plus/test';

import {
  EmissionQueue,
  findRequest,
  PARTICLE_KIND,
  REQUEST_FLOATS,
  type SpawnRequest,
} from './emissionQueue';

const request = (count: number, overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
  kind: 'droplet',
  count,
  position: { x: 1, y: 2, z: 3 },
  velocity: { x: 4, y: 5, z: 6 },
  size: [0.1, 0.2],
  life: [1, 2],
  ...overrides,
});

describe('EmissionQueue', () => {
  it('packs every field at the documented offsets', () => {
    const queue = new EmissionQueue(4, 1000);
    queue.push(
      request(10, {
        kind: 'mist',
        positionRadius: 0.5,
        positionLine: { x: 7, y: 8, z: 9 },
        velocitySpread: 1.5,
        fanAxis: { x: 0, y: 0, z: 1 },
        fanAngle: 0.7,
        drag: 0.25,
        speedVariation: 0.5,
        tone: 0.75,
        carrier: { x: 10, y: 11, z: 12 },
      }),
    );
    expect(Array.from(queue.data.subarray(0, REQUEST_FLOATS))).toEqual([
      1,
      2,
      3,
      0.5,
      4,
      5,
      6,
      1.5,
      7,
      8,
      9,
      Math.fround(0.7),
      0,
      0,
      1,
      PARTICLE_KIND.mist,
      Math.fround(0.1),
      Math.fround(0.2),
      1,
      2,
      0.25,
      0,
      0.5,
      0.75,
      10,
      11,
      12,
      -1,
    ]);
  });

  it('uses defaults for optional fields', () => {
    const queue = new EmissionQueue(2, 100);
    queue.push(request(3, { fanAngle: 1 }));
    const d = queue.data;
    expect(d[3]).toBe(0); // radius
    expect(d[7]).toBe(0); // velocity spread
    expect(d[11]).toBe(0); // no fan without an axis
    expect([d[12], d[13], d[14]]).toEqual([0, 1, 0]);
    expect(d[20]).toBe(-1); // kind default drag
    expect([d[23], d[24], d[25], d[26]]).toEqual([0, 0, 0, 0]); // no tone, no carrier
    expect(d[27]).toBe(-1); // the kind's size spread
  });

  it('builds a prefix table of start indices', () => {
    const queue = new EmissionQueue(8, 1000);
    queue.push(request(5));
    queue.push(request(0)); // ignored
    queue.push(request(7.9)); // floored
    queue.push(request(1));
    expect(queue.requestCount).toBe(3);
    expect(queue.total).toBe(13);
    expect(Array.from(queue.starts.subarray(0, 3))).toEqual([0, 5, 12]);
  });

  it('clips to the per-frame particle budget and the request limit', () => {
    const queue = new EmissionQueue(2, 10);
    expect(queue.push(request(6))).toBe(6);
    expect(queue.push(request(6))).toBe(4);
    expect(queue.push(request(1))).toBe(0);
    expect(queue.total).toBe(10);
    const small = new EmissionQueue(1, 100);
    small.push(request(1));
    expect(small.push(request(1))).toBe(0);
  });

  it('drops a request with a NaN count instead of poisoning the frame total', () => {
    const queue = new EmissionQueue(4, 100);
    expect(queue.push(request(Number.NaN))).toBe(0);
    expect(queue.total).toBe(0);
    expect(queue.requestCount).toBe(0);
    expect(queue.push(request(5))).toBe(5);
    expect(queue.total).toBe(5);
  });

  it('gives each request a fresh seed and resets on clear', () => {
    const queue = new EmissionQueue(4, 100);
    queue.push(request(1));
    queue.push(request(1));
    expect(queue.data[21]).not.toBe(queue.data[21 + REQUEST_FLOATS]);
    queue.clear();
    expect(queue.total).toBe(0);
    expect(queue.requestCount).toBe(0);
  });
});

describe('findRequest', () => {
  it('maps every particle to the request that owns it', () => {
    const queue = new EmissionQueue(64, 100_000);
    const counts: number[] = [];
    for (let i = 0; i < 37; i++) {
      const count = 1 + ((i * 7919) % 23);
      counts.push(count);
      queue.push(request(count));
    }
    let thread = 0;
    counts.forEach((count, index) => {
      for (let k = 0; k < count; k++, thread++) {
        expect(findRequest(queue.starts, queue.requestCount, thread)).toBe(index);
      }
    });
  });

  it('handles a single request', () => {
    expect(findRequest(new Uint32Array([0, 0]), 1, 5)).toBe(0);
  });
});
