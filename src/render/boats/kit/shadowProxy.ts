// Shadow proxies: a boat's static parts drawn into the shadow maps as one mesh rather than one per
// material slot. Every shadow pass (each sun cascade, each shadowed deck light) draws every caster in
// its frustum, and in the shadow pass each slot's own material only decides the faces drawn, so the
// slots that shade alike merge into a positions-only mesh per face side. The proxy sits on
// SHADOW_LAYER alone, which the shadow cameras see (enableShadowLayer) and the scene camera does not;
// the slots it replaces stop casting.

import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  type Material,
  Mesh,
  MeshBasicNodeMaterial,
  type Side,
} from 'three/webgpu';

export const SHADOW_LAYER = 1;
export const SHADOW_PROXY = 'shadow-proxy';

// Shadow cameras draw the proxies too (call once per shadow-casting light, before its first render).
export function enableShadowLayer(camera: Camera): void {
  camera.layers.enable(SHADOW_LAYER);
}

type ShadowMaterial = Material & {
  shadowSide: Side | null;
  positionNode?: unknown;
  castShadowPositionNode?: unknown;
  castShadowNode?: unknown;
  depthNode?: unknown;
  maskNode?: unknown;
  maskShadowNode?: unknown;
  displacementMap?: unknown;
  alphaMap?: unknown;
};

// The shadow pass draws an opaque, untested material's faces at its plain positions: only its side
// matters. Anything that moves vertices, discards fragments or writes its own depth stays separate.
function mergeable(material: Material): boolean {
  const m = material as ShadowMaterial;
  return (
    !m.transparent &&
    m.alphaTest === 0 &&
    !m.positionNode &&
    !m.castShadowPositionNode &&
    !m.castShadowNode &&
    !m.depthNode &&
    !m.maskNode &&
    !m.maskShadowNode &&
    !m.displacementMap &&
    !m.alphaMap
  );
}

// Merges the casting meshes (static, identity transforms relative to their parent) into proxies,
// one per face side, and stops them casting. Returns the proxies to add to the same parent.
export function shadowProxies(meshes: Iterable<Mesh>): Mesh[] {
  const groups = new Map<string, { side: Side; shadowSide: Side | null; meshes: Mesh[] }>();
  for (const mesh of meshes) {
    const material = mesh.material as Material;
    if (!mesh.castShadow || Array.isArray(mesh.material) || !mergeable(material)) continue;
    const shadowSide = (material as ShadowMaterial).shadowSide ?? null;
    const key = `${material.side}:${shadowSide}`;
    let group = groups.get(key);
    if (!group) {
      group = { side: material.side, shadowSide, meshes: [] };
      groups.set(key, group);
    }
    group.meshes.push(mesh);
  }
  const proxies: Mesh[] = [];
  for (const group of groups.values()) {
    if (group.meshes.length < 2) continue;
    const material = new MeshBasicNodeMaterial({ side: group.side });
    material.shadowSide = group.shadowSide;
    material.name = SHADOW_PROXY;
    const proxy = new Mesh(mergePositions(group.meshes.map((m) => m.geometry)), material);
    proxy.name = SHADOW_PROXY;
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    proxy.layers.set(SHADOW_LAYER);
    proxy.matrixAutoUpdate = false;
    for (const mesh of group.meshes) mesh.castShadow = false;
    proxies.push(proxy);
  }
  return proxies;
}

// One indexed, positions-only geometry from several indexed or plain ones.
function mergePositions(geometries: readonly BufferGeometry[]): BufferGeometry {
  let vertices = 0;
  let indices = 0;
  for (const g of geometries) {
    const count = g.getAttribute('position').count;
    vertices += count;
    indices += g.index ? g.index.count : count;
  }
  const positions = new Float32Array(vertices * 3);
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  let v = 0;
  let k = 0;
  for (const g of geometries) {
    const position = g.getAttribute('position');
    const count = position.count;
    for (let i = 0; i < count; i++) {
      positions[(v + i) * 3] = position.getX(i);
      positions[(v + i) * 3 + 1] = position.getY(i);
      positions[(v + i) * 3 + 2] = position.getZ(i);
    }
    if (g.index) {
      const source = g.index;
      for (let i = 0; i < source.count; i++) index[k++] = source.getX(i) + v;
    } else {
      for (let i = 0; i < count; i++) index[k++] = v + i;
    }
    v += count;
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setIndex(new BufferAttribute(index, 1));
  merged.computeBoundingSphere();
  return merged;
}
