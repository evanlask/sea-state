// Ocean surface mesh: an instanced CDLOD quadtree around the camera.
//
// Every selected quadtree node draws the same G×G grid, scaled to the node's
// size. Near the outer edge of each level's distance range, vertices morph
// onto the next coarser grid, so neighbouring levels meet without cracks and
// the mesh never swims (vertices stay on world-aligned grids). Displacement
// comes from the cascade array textures; shading (normals, foam, glints,
// refraction) is per pixel in OceanMaterial.

import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  type PerspectiveCamera,
  type Texture,
  Vector2,
} from 'three/webgpu';

import { EARTH_RADIUS } from '../../sim/core/units';
import { type N, tsl } from '../tsl';
import type { CascadeGroup } from './GpuOcean';
import {
  createFoamJacobianStds,
  createOceanVariances,
  OceanMaterial,
  OceanShadingUniforms,
} from './OceanMaterial';
import { jacobianStd, type OceanShadingQuality } from './oceanOptics';
import type { OceanWakeNodes } from './WakeLayer';

const {
  Fn,
  attribute,
  cameraPosition,
  float,
  fract,
  length,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  texture,
  uniformArray,
  varying,
  vec3,
} = tsl;

export interface OceanMeshOptions {
  gridResolution: number; // quads per node edge (power of two)
  baseNodeSize: number; // metres, level-0 node edge
  levels: number;
  maxInstances: number;
}

export const DEFAULT_OCEAN_MESH: OceanMeshOptions = {
  gridResolution: 32,
  baseNodeSize: 8,
  levels: 11,
  maxInstances: 1024,
};

// graphics.clipmapRings → mesh: one CDLOD level per ring. The sea keeps the same far reach (8 km
// root nodes, as with the original 11 levels), so fewer rings mean coarser vertices near the camera
// (each ring removed doubles the spacing: 11 → 0.25 m, 10 (Ultra) → 0.5 m, 9 (High) → 1 m) and
// proportionally fewer vertices to displace. Normals and foam stay per pixel.
export function oceanMeshFor(rings: number): OceanMeshOptions {
  const levels = Math.round(
    Math.min(12, Math.max(4, Number.isFinite(rings) ? rings : DEFAULT_OCEAN_MESH.levels)),
  );
  const rootSize = DEFAULT_OCEAN_MESH.baseNodeSize * 2 ** (DEFAULT_OCEAN_MESH.levels - 1);
  return { ...DEFAULT_OCEAN_MESH, levels, baseNodeSize: rootSize / 2 ** (levels - 1) };
}

// Distance at which level l hands over to level l+1. Larger than the node
// diagonal so a node never needs more than one morph.
const RANGE_FACTOR = 3;
const MORPH_START = 0.7;

export interface SelectedNode {
  x: number;
  z: number;
  size: number;
  level: number;
}

// Pure quadtree selection (exported for tests). Returns nodes covering the sea around the camera,
// finest near the camera.
export function selectNodes(
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  options: OceanMeshOptions,
  out: SelectedNode[] = [],
): SelectedNode[] {
  out.length = 0;
  const { baseNodeSize, levels } = options;
  const top = levels - 1;
  const rootSize = baseNodeSize * 2 ** top;
  const range = (level: number): number => baseNodeSize * 2 ** level * RANGE_FACTOR;
  // 3×3 roots around the root cell holding the camera: at least rootSize of sea on every side.
  const originX = Math.floor(cameraX / rootSize) * rootSize;
  const originZ = Math.floor(cameraZ / rootSize) * rootSize;
  const visit = (x: number, z: number, size: number, level: number): void => {
    if (level > 0) {
      // Closest point of the node's footprint to the camera (sea level, 3D distance).
      const dx = Math.max(x - cameraX, 0, cameraX - (x + size));
      const dz = Math.max(z - cameraZ, 0, cameraZ - (z + size));
      const distance = Math.hypot(dx, dz, cameraY);
      if (distance < range(level - 1)) {
        const half = size / 2;
        visit(x, z, half, level - 1);
        visit(x + half, z, half, level - 1);
        visit(x, z + half, half, level - 1);
        visit(x + half, z + half, half, level - 1);
        return;
      }
    }
    out.push({ x, z, size, level });
  };
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) visit(originX + i * rootSize, originZ + j * rootSize, rootSize, top);
  }
  return out;
}

function createNodeGeometry(resolution: number): InstancedBufferGeometry {
  const vertices = (resolution + 1) * (resolution + 1);
  const grid = new Float32Array(vertices * 3);
  for (let y = 0; y <= resolution; y++) {
    for (let x = 0; x <= resolution; x++) {
      const i = (y * (resolution + 1) + x) * 3;
      grid[i] = x;
      grid[i + 1] = 0;
      grid[i + 2] = y;
    }
  }
  const indices = new Uint32Array(resolution * resolution * 6);
  let k = 0;
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const a = y * (resolution + 1) + x;
      const b = a + 1;
      const c = a + resolution + 1;
      const d = c + 1;
      // Alternate the diagonal for more isotropic tessellation.
      if ((x + y) % 2 === 0) indices.set([a, c, b, b, c, d], k);
      else indices.set([a, c, d, a, d, b], k);
      k += 6;
    }
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(grid, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

export interface OceanShadingInputs {
  groups: readonly CascadeGroup[];
  foamDetail: Texture;
  quality: OceanShadingQuality;
  wake?: OceanWakeNodes; // boat wakes: height, slopes, foam (WakeLayer)
  waterMask?: Texture; // exclusion volumes (WaterMask)
  glint?: (worldPosition: N) => N; // direct-beam share of the sun/moon light (cloud cover)
}

export class OceanMesh {
  readonly mesh: Mesh;
  readonly material: OceanMaterial;
  readonly uniforms = new OceanShadingUniforms();
  private options: OceanMeshOptions;
  private nodeInfo: InstancedBufferAttribute;
  private selected: SelectedNode[] = [];
  private offsetUniforms: N[];
  private offsetValues: Vector2[][];
  private varianceUniforms: N[];
  private jacobianStdUniforms: N[];
  private groups: readonly CascadeGroup[];
  private viewProjection = new Matrix4();
  private hasPreviousFrame = false;
  // The cascades' displacement (m, render frame) of a Lagrangian point xz at a distance from the
  // camera (the small cascades fade out), as the vertices are displaced; wakes not included.
  readonly displacementAt: (xz: N, distance: N) => N;

  constructor(inputs: OceanShadingInputs, options: OceanMeshOptions = DEFAULT_OCEAN_MESH) {
    this.options = options;
    this.groups = inputs.groups;
    const geometry = createNodeGeometry(options.gridResolution);
    this.nodeInfo = new InstancedBufferAttribute(new Float32Array(options.maxInstances * 4), 4);
    this.nodeInfo.setUsage(DynamicDrawUsage);
    geometry.setAttribute('nodeInfo', this.nodeInfo);

    // Per cascade: the floating world origin reduced mod the patch length, so
    // sampling stays precise however far the boats travel.
    this.offsetValues = inputs.groups.map((group) => group.cascadeIndices.map(() => new Vector2()));
    this.offsetUniforms = this.offsetValues.map((values) => uniformArray(values, 'vec2'));
    this.varianceUniforms = createOceanVariances(inputs.groups);
    this.jacobianStdUniforms = createFoamJacobianStds(inputs.groups);

    const info = attribute('nodeInfo', 'vec4');
    const grid = attribute('position').xz;
    const resolution = float(options.gridResolution);

    // Morphed world-space (Lagrangian) position of this vertex.
    const lagrangian = Fn(() => {
      const nodeOrigin = info.xy;
      const nodeSize = info.z;
      const level = info.w;
      const rangeEnd = float(options.baseNodeSize * RANGE_FACTOR).mul(pow(2, level));
      const rangeStart = rangeEnd.mul(MORPH_START);
      const flat = nodeOrigin.add(grid.div(resolution).mul(nodeSize));
      const distance = length(vec3(flat.x, 0, flat.y).sub(cameraPosition));
      const morph = saturate(distance.sub(rangeStart).div(rangeEnd.sub(rangeStart)));
      const odd = fract(grid.mul(0.5)).mul(2);
      const morphedGrid = grid.sub(odd.mul(morph));
      return nodeOrigin.add(morphedGrid.div(resolution).mul(nodeSize));
    })();

    const sampleDisplacement = (xz: N, distance: N, previous: boolean): N => {
      let total: N = vec3(0);
      inputs.groups.forEach((group, g) => {
        group.cascadeIndices.forEach((_, layer) => {
          const patch = group.patchLengths[layer] ?? 1;
          // Small cascades fade with distance to avoid aliasing.
          const fade = patch < 50 ? float(1).sub(smoothstep(patch * 20, patch * 60, distance)) : float(1);
          const uv = xz
            .add(this.offsetUniforms[g]?.element(layer))
            .div(patch)
            .add(0.5 / group.size);
          const source = previous ? group.previousDisplacement : group.displacement;
          const sample = texture(source, uv).depth(layer).level(0);
          total = total.add(sample.xyz.mul(fade));
        });
      });
      return total;
    };

    this.displacementAt = (xz, distance) => sampleDisplacement(xz, distance, false);

    // World position of a Lagrangian point with the given displacement field.
    const surfacePoint = (previous: boolean): N =>
      Fn(() => {
        const xz = lagrangian;
        const distance = length(vec3(xz.x, 0, xz.y).sub(cameraPosition));
        let displacement = sampleDisplacement(xz, distance, previous);
        // Boat wakes ride on the waves (the same field both frames: motion vectors stay smooth).
        if (inputs.wake) displacement = displacement.add(vec3(0, inputs.wake.height(xz), 0));
        // Earth curvature: the sea drops away with distance, giving a real horizon.
        const flatDistance = length(xz.sub(cameraPosition.xz));
        const drop = flatDistance.mul(flatDistance).div(2 * EARTH_RADIUS);
        return vec3(xz.x, 0, xz.y)
          .add(displacement)
          .sub(vec3(0, drop, 0));
      })();

    this.material = new OceanMaterial({
      groups: inputs.groups,
      offsets: this.offsetUniforms,
      variances: this.varianceUniforms,
      jacobianStds: this.jacobianStdUniforms,
      lagrangian: varying(lagrangian, 'v_oceanLagrangian'),
      // Only built into the shader once motion vectors are switched on.
      previousPosition: varying(surfacePoint(true), 'v_oceanPrevious'),
      foamDetail: inputs.foamDetail,
      quality: inputs.quality,
      uniforms: this.uniforms,
      wake: inputs.wake,
      waterMask: inputs.waterMask,
      glint: inputs.glint?.(positionWorld),
    });
    this.material.positionNode = surfacePoint(false);

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ocean';
    // First among transparent objects when refracting (spray and rain blend over it).
    this.mesh.renderOrder = -1;
    // Draw count is driven by the quadtree selection.
    geometry.instanceCount = 0;
  }

  // Refreshes the per-cascade analytic slope variances and Jacobian deviations (after a spectrum
  // upload or a step of a weather blend).
  refreshStatistics(): void {
    this.groups.forEach((group, g) => {
      const values = this.varianceUniforms[g]?.array as number[] | undefined;
      const stds = this.jacobianStdUniforms[g]?.array as number[] | undefined;
      group.statistics.forEach((s, layer) => {
        const slopeVariance = s.slopeVarianceX + s.slopeVarianceZ;
        if (values) values[layer] = slopeVariance;
        if (stds) stds[layer] = jacobianStd(group.choppiness[layer] ?? 1, slopeVariance);
      });
    });
  }

  // originX/originZ: float64 world position of the render origin.
  setWorldOrigin(originX: number, originZ: number): void {
    this.groups.forEach((group, g) => {
      group.patchLengths.forEach((patch, layer) => {
        const wrap = (value: number): number => ((value % patch) + patch) % patch;
        this.offsetValues[g]?.[layer]?.set(wrap(originX), wrap(originZ));
      });
    });
  }

  update(camera: PerspectiveCamera): void {
    selectNodes(camera.position.x, camera.position.y, camera.position.z, this.options, this.selected);
    const count = Math.min(this.selected.length, this.options.maxInstances);
    const array = this.nodeInfo.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const node = this.selected[i];
      if (!node) break;
      array[i * 4] = node.x;
      array[i * 4 + 1] = node.z;
      array[i * 4 + 2] = node.size;
      array[i * 4 + 3] = node.level;
    }
    this.nodeInfo.needsUpdate = true;
    this.nodeInfo.addUpdateRange(0, count * 4);
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = count;

    // Unjittered view-projections for motion vectors (TRAA jitters later, inside the render).
    camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const u = this.uniforms;
    (u.previousViewProjection.value as Matrix4).copy(
      this.hasPreviousFrame ? (u.viewProjection.value as Matrix4) : this.viewProjection,
    );
    (u.viewProjection.value as Matrix4).copy(this.viewProjection);
    this.hasPreviousFrame = true;
  }
}
