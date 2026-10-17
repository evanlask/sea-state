// A session's SeaScene must give back everything it built on the GPU (gpuResources.ts): this builds
// one on a stand-in renderer (no GPU: three's objects are plain CPU-side until first use), walks its
// object graph for every texture, render target, material, geometry, compute kernel and storage
// buffer it holds, disposes the scene and checks that each one was disposed (or released).

import {
  BufferAttribute,
  Mesh,
  PerspectiveCamera,
  QuadMesh,
  type RenderTarget,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import type { QualityPreset } from '../app/Scenario';
import type { SpectrumMessage } from '../sim/world/protocol';
import { setStorageReleaser } from './gpuResources';
import type { PostSettings } from './post/postSettings';
import { SeaScene } from './SeaScene';

interface Disposing {
  addEventListener(type: 'dispose', listener: () => void): void;
}

type Kind = 'texture' | 'render target' | 'material' | 'geometry' | 'compute kernel' | 'object';

function kindOf(value: Record<string, unknown>): Kind | null {
  if (value.isRenderTarget) return 'render target';
  if (value.isTexture) return 'texture';
  if (value.isMaterial) return 'material';
  if (value.isBufferGeometry) return 'geometry';
  if (value.isComputeNode) return 'compute kernel';
  // Drawn objects and lights (cameras and groups hold nothing on the GPU).
  if (value.isMesh || value.isLine || value.isPoints || value.isSprite || value.isLight) return 'object';
  return null;
}

// Every GPU resource reachable from `root` through fields, arrays, maps and sets (not closures).
function reachable(root: object, skip: Set<unknown>) {
  const found = new Map<object, { kind: Kind; path: string }>();
  const buffers = new Map<BufferAttribute, string>();
  const seen = new WeakSet<object>();
  const stack: [unknown, string][] = [[root, 'scene']];
  while (stack.length > 0) {
    const [value, path] = stack.pop()!;
    if (value === null || typeof value !== 'object' || skip.has(value) || seen.has(value)) continue;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const kind = kindOf(record);
    if (kind) found.set(value, { kind, path });
    if (record.isStorageBufferAttribute || record.isStorageInstancedBufferAttribute)
      buffers.set(value as BufferAttribute, path);
    if (value instanceof Map) {
      for (const [k, v] of value) stack.push([k, `${path}<key>`], [v, `${path}.get()`]);
    } else if (value instanceof Set || Array.isArray(value)) {
      let i = 0;
      for (const v of value) stack.push([v, `${path}[${i++}]`]);
    } else {
      for (const key of Object.keys(value)) stack.push([record[key], `${path}.${key}`]);
    }
  }
  return { found, buffers };
}

// Just enough of a WebGPURenderer for the systems' constructors (compute dispatches are no-ops).
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

// Every post graph the presets build: each wraps the scene colour differently (GTAO, droplets,
// depth of field and FXAA / SMAA render it into targets of their own).
const POSTS: [string, QualityPreset, PostSettings][] = [
  [
    'High: TRAA, GTAO, SSR, droplets, DOF',
    'high',
    {
      aa: 'traa',
      bloom: true,
      ao: 'gtao-half',
      reflections: 'ssr-half',
      lensDroplets: true,
    },
  ],
  ['Medium: SMAA', 'medium', { aa: 'smaa', bloom: true }],
  ['Low: FXAA', 'low', { aa: 'fxaa', bloom: false }],
];

describe.each(POSTS)('SeaScene.dispose (%s)', (_name, quality, post) => {
  const released = new Set<BufferAttribute>();
  const renderer = standInRenderer();
  let scene: SeaScene;
  let found: Map<object, { kind: Kind; path: string }>;
  let buffers: Map<BufferAttribute, string>;
  const disposed = new WeakSet<object>();

  beforeAll(() => {
    const g = globalThis as Record<string, unknown>;
    g.document ??= { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {} }) };
    // SMAA decodes its lookup tables from data URLs (never loaded here).
    g.Image ??= class {
      src = '';
      onload: (() => void) | null = null;
    };
    scene = new SeaScene(renderer, {
      spectrum: spectrum(),
      quality,
      post,
      shadows: { enabled: true, mapSize: 1024, cascades: 2, maxFar: 600 },
      seed: 1,
      latitudeDeg: 40,
      longitudeDeg: -40,
    });
    // The post pipeline, and its graph, as the first frame builds them.
    const pipeline = (
      scene as unknown as { ensurePipeline(c: PerspectiveCamera): { build(): void } }
    ).ensurePipeline(new PerspectiveCamera());
    if (post.lensDroplets) scene.setDof({ enabled: true }); // photo mode
    pipeline.build();
    scene.showParity([{ x: 0, y: 0, z: 0 }]);
    // Installed by the constructor; swapped for a spy from here on.
    setStorageReleaser((attribute) => void released.add(attribute));
    // Shared by every QuadMesh (three's fullscreen triangle), not the session's.
    const shared = new Set<unknown>([renderer, new QuadMesh(null as never).geometry]);
    ({ found, buffers } = reachable(scene, shared));
    for (const resource of found.keys())
      (resource as Disposing).addEventListener('dispose', () => disposed.add(resource));
    // A render target's textures are destroyed with it (no dispose event of their own).
    for (const [resource, { kind }] of found) {
      if (kind !== 'render target') continue;
      const target = resource as RenderTarget;
      const owned: Texture[] = [...target.textures];
      if (target.depthTexture?.renderTarget === target) owned.push(target.depthTexture);
      for (const texture of owned)
        (target as Disposing).addEventListener('dispose', () => disposed.add(texture));
    }
    scene.dispose();
  });

  afterAll(() => setStorageReleaser(null));

  it('finds what a session builds', () => {
    const kinds = new Set([...found.values()].map((r) => r.kind));
    expect(kinds).toEqual(
      new Set(['texture', 'render target', 'material', 'geometry', 'compute kernel', 'object']),
    );
    expect(buffers.size).toBeGreaterThan(10);
  });

  it('disposes every texture, render target, material, geometry and kernel it holds', () => {
    const leaks = [...found]
      .filter(([resource, { kind }]) => kind !== 'object' && !disposed.has(resource))
      .map(([, { kind, path }]) => `${kind} at ${path}`);
    expect(leaks).toEqual([]);
  });

  it("releases every object's render objects (shared boat geometry and materials stay)", () => {
    // Either the object itself, or its own material (an object's render objects go with either).
    const released = (object: object): boolean => {
      const { material } = object as { material?: object };
      return disposed.has(object) || (material !== undefined && disposed.has(material));
    };
    const leaks = [...found]
      .filter(([resource, { kind }]) => kind === 'object' && !released(resource))
      .map(([, { path }]) => path);
    expect(leaks).toEqual([]);
  });

  it('frees every storage buffer', () => {
    const leaks = [...buffers].filter(([buffer]) => !released.has(buffer)).map(([, path]) => path);
    expect(leaks).toEqual([]);
  });

  it('is safe to call twice', () => {
    expect(() => scene.dispose()).not.toThrow();
  });

  it('keeps a placeholder mesh type around for the walk', () => {
    // (Guards the walk itself: a mesh is found as an object, its parts as geometry and material.)
    const mesh = new Mesh();
    const { found: parts } = reachable(mesh, new Set());
    expect([...parts.values()].map((p) => p.kind).sort()).toEqual(['geometry', 'material', 'object']);
  });
});
