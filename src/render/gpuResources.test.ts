import { DepthTexture, StorageBufferAttribute } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  disposeCascadedShadows,
  GpuResources,
  installStorageRelease,
  releaseBuffer,
  setStorageReleaser,
  ViewportDepthCopy,
} from './gpuResources';
import { tsl } from './tsl';

const disposable = (log: string[], name: string, fail = false) => ({
  dispose() {
    log.push(name);
    if (fail) throw new Error(name);
  },
});

describe('GpuResources', () => {
  afterEach(() => setStorageReleaser(null));

  it('disposes in reverse order, then frees the storage buffers, once', () => {
    const log: string[] = [];
    const released: unknown[] = [];
    setStorageReleaser((attribute) => void released.push(attribute));
    const gpu = new GpuResources();
    gpu.track(disposable(log, 'texture'));
    gpu.track(disposable(log, 'kernel'));
    const node = gpu.storage(tsl.instancedArray(16, 'vec4'));
    expect(gpu.counts).toEqual({ resources: 2, buffers: 1 });
    gpu.dispose();
    gpu.dispose();
    expect(log).toEqual(['kernel', 'texture']);
    expect(released).toEqual([node.value]);
    expect(gpu.disposed).toBe(true);
  });

  it('keeps going past a resource that fails to dispose', () => {
    const log: string[] = [];
    const gpu = new GpuResources();
    gpu.track(disposable(log, 'a'));
    gpu.track(disposable(log, 'b', true));
    gpu.track(disposable(log, 'c'));
    expect(() => gpu.dispose()).toThrow(AggregateError);
    expect(log).toEqual(['c', 'b', 'a']);
  });

  it("frees a buffer through the renderer's attribute manager", () => {
    const deleted: unknown[] = [];
    const renderer = { _attributes: { delete: (a: unknown) => void deleted.push(a) } };
    installStorageRelease(renderer as never);
    const attribute = new StorageBufferAttribute(4, 4);
    let events = 0;
    attribute.addEventListener('dispose', () => events++);
    releaseBuffer(attribute);
    expect(deleted).toEqual([attribute]);
    expect(events).toBe(1);
  });
});

describe('ViewportDepthCopy', () => {
  it('hands every render target the same copy and disposes it with itself', () => {
    const depth = new ViewportDepthCopy(1, 1);
    const a = depth.clone();
    const b = depth.clone();
    expect(a).toBe(b);
    expect(a).not.toBe(depth);
    expect(a).toBeInstanceOf(DepthTexture);
    let disposed = 0;
    a.addEventListener('dispose', () => disposed++);
    depth.dispose();
    expect(disposed).toBe(1);
    expect(depth.clone()).not.toBe(a); // a fresh copy after disposal
  });
});

describe('disposeCascadedShadows', () => {
  it('disposes the cascade shadow nodes and light shadows CSMShadowNode.dispose leaves', () => {
    const log: string[] = [];
    const csm = {
      _shadowNodes: [disposable(log, 'node0'), disposable(log, 'node1')],
      lights: [{ shadow: disposable(log, 'shadow0') }, { shadow: disposable(log, 'shadow1') }],
      dispose: () => log.push('csm'),
    };
    disposeCascadedShadows(csm);
    expect(log).toEqual(['node0', 'node1', 'shadow0', 'shadow1', 'csm']);
    expect(() => disposeCascadedShadows(null)).not.toThrow();
  });
});
