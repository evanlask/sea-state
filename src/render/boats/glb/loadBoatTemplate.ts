// Loads a drop-in boat model (GLB + align.json, listed in the asset manifest) into a BoatTemplate,
// so BoatVisual and the scene treat it like a procedural model: LODs, light markers, helm eye and
// a convex water-exclusion volume from the hull below the deck line. Imported on demand only
// when the manifest lists a model, so the loaders stay out of the main bundle otherwise.
//
// Decoders: Meshopt (bundled), Draco (public/libs/draco/) and Basis/KTX2 (public/libs/basis/);
// the last two load their worker files only when a model actually uses them.

import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import {
  BoxGeometry,
  type BufferGeometry,
  Box3,
  Group,
  InstancedMesh,
  Mesh,
  type Object3D,
  Vector3,
} from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

import { fetchWithProgress } from '../../../app/loading/fetch';
import type { LoadingManager } from '../../../app/loading/LoadingManager';
import { assetUrl } from '../../../app/loading/manifest';
import { BOAT_LENGTH } from '../../../app/Scenario';
import { BOAT_SPECS } from '../../../sim/boats/specs/index';
import type { BoatKind } from '../../../sim/world/protocol';
import type { BoatTemplate, LightMountSpec } from '../kit/BoatVisual';
import {
  alignRotation,
  alignTransform,
  type BoatAlignSpec,
  defaultEye,
  markerKind,
  maskPoints,
  parseAlign,
} from './align';
import { type BoatModelFiles, MODEL_LABELS as LABELS } from './files';

interface Loaders {
  gltf: GLTFLoader;
  dispose(): void;
}

function createLoaders(renderer: WebGPURenderer, base: string): Loaders {
  const draco = new DRACOLoader().setDecoderPath({
    js: `${base}libs/draco/draco_wasm_wrapper.js`,
    wasm: `${base}libs/draco/draco_decoder.wasm`,
  });
  const ktx2 = new KTX2Loader().setTranscoderPath(`${base}libs/basis/`).detectSupport(renderer);
  const gltf = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco).setKTX2Loader(ktx2);
  return {
    gltf,
    dispose: () => {
      draco.dispose();
      ktx2.dispose();
    },
  };
}

export async function loadBoatTemplate(
  kind: BoatKind,
  files: BoatModelFiles,
  renderer: WebGPURenderer,
  loading: LoadingManager,
  base: string = import.meta.env.BASE_URL,
): Promise<BoatTemplate> {
  const label = LABELS[kind];
  const alignJson = files.align
    ? fetchWithProgress(assetUrl(base, files.align.path, files.align.entry), { retries: 1 }).then(
        (buffer) => JSON.parse(new TextDecoder().decode(buffer)) as unknown,
      )
    : Promise.resolve({});
  // All LODs download in parallel; the loading screen sums them into one byte count. align.json is
  // awaited with them, so a failure of either can't leave the other's rejection unhandled.
  const [buffers, alignRaw] = await Promise.all([
    Promise.all(
      files.lods.map(({ path, entry }, lod) =>
        loading.download(
          {
            id: `model:${kind}:${lod}`,
            label: `Downloading ${label}${lod > 0 ? ` (far detail ${lod})` : ''}`,
            kind: 'download',
            bytes: entry.bytes,
            url: assetUrl(base, path, entry),
          },
          { onError: 'throw' },
        ),
      ),
    ),
    alignJson,
  ]);
  const spec = parseAlign(alignRaw);
  return loading.run(
    { id: `model:${kind}:decode`, label: `Decoding ${label}`, kind: 'decode', weight: 0.5 },
    async () => {
      const loaders = createLoaders(renderer, base);
      try {
        const resourcePath = `${base}models/${kind}/`;
        const scenes: Object3D[] = [];
        for (const buffer of buffers)
          scenes.push((await loaders.gltf.parseAsync(buffer, resourcePath)).scene);
        return buildTemplate(kind, scenes, spec);
      } finally {
        loaders.dispose();
      }
    },
    { onError: 'throw' },
  );
}

const box = new Box3();
const v = new Vector3();

function buildTemplate(kind: BoatKind, scenes: Object3D[], spec: BoatAlignSpec): BoatTemplate {
  const dims = BOAT_SPECS[kind].dimensions;
  const quaternion = alignRotation(spec);
  // Every LOD shares LOD0's transform, so a simplified mesh with a shrunk outline can't shift.
  let transform: ReturnType<typeof alignTransform> | null = null;
  const lods = scenes.map((scene, i) => {
    const wrapper = new Group();
    wrapper.name = `glb-lod${i}`;
    wrapper.add(scene);
    wrapper.quaternion.copy(quaternion);
    wrapper.updateMatrixWorld(true);
    if (!transform) {
      box.setFromObject(wrapper, true);
      if (box.isEmpty()) throw new Error(`${kind} model has no geometry`);
      transform = alignTransform(box, spec, { loa: BOAT_LENGTH[kind], draft: dims.overallDraft });
    }
    wrapper.scale.setScalar(transform.scale);
    wrapper.position.copy(transform.position);
    wrapper.updateMatrixWorld(true);
    scene.traverse((object) => {
      if (object instanceof Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    stripLights(scene);
    return wrapper;
  });
  const lod0 = lods[0]!;
  const bounds = new Box3().setFromObject(lod0, true);

  const lights: LightMountSpec[] = [...(spec.lights ?? [])];
  lod0.traverse((object) => {
    const lightKind = markerKind(object.name);
    if (!lightKind) return;
    const position = object.getWorldPosition(new Vector3());
    // glTF lights shine down their local −Z.
    const direction = new Vector3(0, 0, -1).transformDirection(object.matrixWorld);
    lights.push({ kind: lightKind, position: position.toArray(), direction: direction.toArray() });
  });

  return {
    kind,
    name: `${LABELS[kind]} (drop-in model)`,
    length: BOAT_LENGTH[kind],
    lods,
    triangles: lods.map(triangleCount),
    lights,
    floods: [],
    animated: [],
    eye: spec.eye ? new Vector3(...spec.eye) : defaultEye(bounds),
    waterMask: waterMaskFor(lod0, bounds, spec.maskTop ?? Math.max(0.2, dims.depth - dims.draft)),
  };
}

// A model's own glTF lights (KHR_lights_punctual) would join the scene's light set when the boat
// appears, recompiling every lit material; the game lights boats itself (lights/). Each becomes an
// empty node with its name, transform and children, so light:<mount> markers still place mounts.
function stripLights(root: Object3D): void {
  const lights: Object3D[] = [];
  root.traverse((object) => {
    if ((object as Object3D & { isLight?: boolean }).isLight) lights.push(object);
  });
  for (const light of lights) {
    const node = new Group();
    node.name = light.name;
    node.userData = light.userData;
    node.position.copy(light.position);
    node.quaternion.copy(light.quaternion);
    node.scale.copy(light.scale);
    // add() takes each child out of light.children.
    while (light.children[0]) node.add(light.children[0]);
    light.parent?.add(node);
    light.removeFromParent();
  }
}

function triangleCount(root: Object3D): number {
  let total = 0;
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    const count = geometry.index ? geometry.index.count : (geometry.getAttribute('position')?.count ?? 0);
    total += (count / 3) * (object instanceof InstancedMesh ? object.count : 1);
  });
  return Math.round(total);
}

// Convex hull of the hull's vertices from the keel up to `top` m above the waterline: the sea stays
// out of an open hull or a deck well, and the hull's convex outline keeps the water right up to it.
// A box from the bounds is the fallback for degenerate models.
function waterMaskFor(root: Object3D, bounds: Box3, top: number): BufferGeometry {
  const positions: number[] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const attribute = (object.geometry as BufferGeometry).getAttribute('position');
    if (!attribute) return;
    const step = Math.max(1, Math.floor(attribute.count / 50_000));
    for (let i = 0; i < attribute.count; i += step) {
      v.fromBufferAttribute(attribute, i).applyMatrix4(object.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
  });
  const points = maskPoints(positions, top);
  if (points.length >= 12) {
    try {
      const hull = new ConvexGeometry(
        Array.from({ length: points.length / 3 }, (_, i) => new Vector3().fromArray(points, i * 3)),
      );
      if (hull.getAttribute('position').count > 0) return hull;
    } catch (error) {
      console.warn('Water mask: convex hull failed; using the bounding box.', error);
    }
  }
  const height = Math.min(bounds.max.y, top) - bounds.min.y;
  const geometry = new BoxGeometry(
    bounds.max.x - bounds.min.x,
    Math.max(0.1, height),
    bounds.max.z - bounds.min.z,
  );
  bounds.getCenter(v);
  geometry.translate(v.x, bounds.min.y + height / 2, v.z);
  return geometry;
}
