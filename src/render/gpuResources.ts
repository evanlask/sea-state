// GPU resource lifetimes. Each session builds a fresh SeaScene and every one of its systems; leaving
// the session must give all of it back, or every voyage start / return to the menu leaks hundreds of
// MB of GPU memory (shadow maps, full-resolution copies, storage buffers) and the pipelines and node
// graphs that still reference them.
//
// - GpuResources: a per-system registry of what it created (textures, render targets, compute
//   kernels, materials, geometries, storage buffers); dispose() releases all of it, once.
// - Storage buffers: three r186 only frees a GPU buffer when a geometry holding it is disposed;
//   one that only compute kernels and bind groups use stays allocated for the renderer's lifetime
//   (three issue #32969: BufferAttribute.dispose() fires an event nothing listens to). The releaser
//   installed with the renderer deletes it through the renderer's attribute manager instead.
// - ViewportDepthCopy: viewportDepthTexture() keeps a clone of its depth texture per render target
//   it is drawn into and never disposes the clones; this texture hands out one shared copy (so every
//   lookup of it reads, and copies, the same texture once per render) and disposes it with itself.
// - disposeCascadedShadows: CSMShadowNode.dispose() leaves its per-cascade shadow nodes, and with
//   them the cascade shadow maps, allocated.
// - releaseSceneObjects: a 3D object's render objects (bind groups, uniform buffers, its share of a
//   pipeline, the cached node graph) are freed only by a dispose event on its object, material or
//   geometry; objects whose geometry and materials are shared (cached boat templates) need their own.

import {
  type BufferAttribute,
  DepthTexture,
  FramebufferTexture,
  type Object3D,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';

export interface Disposable {
  dispose(): void;
}

// A node whose value is a buffer attribute (instancedArray / attributeArray / storage).
interface StorageNode {
  value: BufferAttribute;
}

type Releaser = (attribute: BufferAttribute) => void;

let releaser: Releaser | null = null;

interface RendererInternals {
  _attributes?: { delete(attribute: BufferAttribute): unknown } | null;
}

// Frees buffers (releaseBuffer) through this renderer from now on (idempotent; the last one wins).
export function installStorageRelease(renderer: WebGPURenderer): void {
  releaser = (attribute) => {
    const attributes = (renderer as unknown as RendererInternals)._attributes;
    if (!attributes) return;
    try {
      // Destroys the GPU buffer and updates renderer.info.memory (a no-op if never uploaded).
      attributes.delete(attribute);
    } catch {
      // A buffer the backend never created (or already lost with the device): nothing to free.
    }
  };
}

// Tests: a stand-in for the renderer (null restores the default no-op).
export function setStorageReleaser(next: Releaser | null): void {
  releaser = next;
}

// Frees one buffer attribute's GPU allocation (the attribute keeps its CPU copy): a storage buffer,
// or a vertex buffer whose geometry is shared and stays (an InstancedMesh copy's instance matrices).
export function releaseBuffer(attribute: BufferAttribute): void {
  attribute.dispose();
  releaser?.(attribute);
}

// Everything one system created on the GPU, released in reverse order of registration.
export class GpuResources {
  private items: Disposable[] = [];
  private buffers = new Set<BufferAttribute>();
  private released = false;

  // Registers anything with dispose() (texture, render target, compute node, material, geometry,
  // node with internal targets); returns it.
  track<T extends Disposable>(resource: T): T {
    this.items.push(resource);
    return resource;
  }

  // Registers the buffer behind a storage node (instancedArray / attributeArray); returns the node.
  storage<T extends StorageNode>(node: T): T {
    this.buffers.add(node.value);
    return node;
  }

  get disposed(): boolean {
    return this.released;
  }

  // What is registered (tests, diagnostics).
  get counts(): { resources: number; buffers: number } {
    return { resources: this.items.length, buffers: this.buffers.size };
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    const errors: unknown[] = [];
    // Kernels and materials first (they hold bind groups on the buffers and textures).
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]?.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const buffer of this.buffers) releaseBuffer(buffer);
    this.items = [];
    this.buffers.clear();
    if (errors.length > 0) throw new AggregateError(errors, 'GpuResources.dispose: some resources failed');
  }
}

// viewportDepthTexture(uv, level, depth) with this as `depth`: every node reading it, in every
// render target, shares one copy (see the header), disposed with this texture.
export class ViewportDepthCopy extends DepthTexture {
  private shared: this | null = null;

  // The texture the copies land in (to sample it after the render, outside the node graph).
  get target(): DepthTexture {
    return this.clone();
  }

  override clone(): this {
    // The copy itself is a plain depth texture: clone it again and you get a real clone.
    if (this.shared) return this.shared;
    const copy = new DepthTexture().copy(this) as this;
    this.shared = copy;
    return copy;
  }

  override dispose(): void {
    this.shared?.dispose();
    this.shared = null;
    super.dispose();
  }
}

// The same for viewportTexture(uv, level, colour): one shared colour copy, disposed with this.
export class ViewportColorCopy extends FramebufferTexture {
  private shared: this | null = null;

  get target(): FramebufferTexture {
    return this.clone();
  }

  override clone(): this {
    if (this.shared) return this.shared;
    const copy = new FramebufferTexture(this.image.width, this.image.height).copy(this) as this;
    this.shared = copy;
    return copy;
  }

  override dispose(): void {
    this.shared?.dispose();
    this.shared = null;
    super.dispose();
  }
}

interface CascadedShadowNode {
  lights: readonly { shadow?: Disposable | null; dispose?(): void }[];
  dispose(): void;
}

// Disposes a CSMShadowNode with its cascades: their shadow nodes (shadow-map render targets) and
// light shadows, which CSMShadowNode.dispose() leaves behind.
export function disposeCascadedShadows(csm: CascadedShadowNode | null | undefined): void {
  if (!csm) return;
  const nodes = (csm as unknown as { _shadowNodes?: Disposable[] })._shadowNodes ?? [];
  for (const node of nodes) node.dispose();
  for (const light of csm.lights) {
    light.shadow?.dispose();
    light.dispose?.();
  }
  csm.dispose();
}

interface MeshLike {
  geometry?: Disposable;
  material?: Disposable | Disposable[];
}

// Disposes the geometries and materials of every mesh, line and point set under `root` (each once)
// and releases the objects' render objects. Only for subtrees that own their geometry and materials.
export function disposeOwnedTree(root: Object3D): void {
  const owned = new Set<Disposable>();
  const objects: Object3D[] = [];
  root.traverse((object) => {
    objects.push(object);
    const mesh = object as Object3D & MeshLike;
    if (mesh.geometry) owned.add(mesh.geometry);
    const material = mesh.material;
    if (Array.isArray(material)) for (const m of material) owned.add(m);
    else if (material) owned.add(material);
  });
  for (const object of objects) object.dispose();
  for (const resource of owned) resource.dispose();
}

// Releases the render objects of every object in the scene and the background mesh three builds
// for scene.backgroundNode. Geometry and materials are left to their owners.
export function releaseSceneObjects(scene: Scene): void {
  const objects: Object3D[] = [];
  scene.traverse((object) => void objects.push(object));
  for (const object of objects) object.dispose();
  const withNodes = scene as Scene & { backgroundNode?: Disposable | null };
  withNodes.backgroundNode?.dispose();
}
