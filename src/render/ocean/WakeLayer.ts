// Boat wakes on the GPU, for the ocean's displacement and shading:
//
//  - Splat: every boat's eWave grid (sim/ocean/wake, uploaded from the worker's snapshots) is
//    resampled — Catmull-Rom, with analytic slopes, translated by the boat's velocity to the render
//    time — into two camera-centred levels (384 m at 0.75 m, 3 km at 6 m). Each texel holds
//    (η, ∂η/∂x, ∂η/∂z, crest foam): wake crests near breaking steepness (the cusps and stern
//    waves of a boat driven hard) go white without any persistent state.
//  - Foam trail: world-space windows around the camera (384 m at 0.75 m for the near detail,
//    folded into the finest wake level, and 4 km at 4 m for the long wakes; toroidally addressed,
//    so the camera moving costs nothing but clearing the strips it exposes) where every boat
//    stamps the white water along its hull and astern of it, as much as its flow actually breaks
//    (wakeFoam.ts: hull Froude number, propeller power and depth), broken into streaks along the
//    track. Two channels: a small craft's shallow turbulence fades in seconds (τ = 10 s), a ship's
//    deep bubbles over minutes (τ = 150 s), so a ship's wake stays visible for kilometres and a
//    yacht's for tens of metres.
//
// OceanMesh adds the height to its displacement, OceanMaterial the slopes to its normals and the
// foam to its whitecaps (see OceanWakeNodes).

import {
  type BufferAttribute,
  ClampToEdgeWrapping,
  type ComputeNode,
  HalfFloatType,
  LinearFilter,
  type PerspectiveCamera,
  RepeatWrapping,
  RGBAFormat,
  StorageTexture,
  Vector2,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu';

import { BOAT_SPECS } from '../../sim/boats/specs/index';
import { WAKE_RESOLUTION } from '../../sim/ocean/wake/WakeField';
import type { BoatKind, BoatSnapshot, WakeGrid } from '../../sim/world/protocol';
import { GpuResources } from '../gpuResources';
import { type N, tsl } from '../tsl';
import {
  deliveredPower,
  stampRate,
  TRAIL_MAX,
  TRAIL_TAU_FAST,
  TRAIL_TAU_SLOW,
  WAKE_CREST_SLOPE,
  type WakeFoamHull,
  wakeFoam,
  wakeFoamHull,
} from './wakeFoam';

const {
  Fn,
  If,
  Loop,
  abs,
  dot,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  int,
  max,
  min,
  mix,
  select,
  smoothstep,
  sqrt,
  storageTexture,
  texture,
  textureStore,
  uint,
  uniform,
  uniformArray,
  uvec2,
  vec2,
  vec4,
} = tsl;

const MAX_WAKE_GRIDS = 12;
const GRID = WAKE_RESOLUTION;
const GRID_TEXELS = GRID * GRID;
const EDGE_FADE = 4; // grid cells

export interface WakeLevelConfig {
  size: number; // texels per side
  texel: number; // m
}

const WAKE_LEVELS: readonly WakeLevelConfig[] = [
  { size: 512, texel: 0.75 },
  { size: 512, texel: 6 },
];

// Foam trail windows, finest first. The near one shares the finest wake level's texels and is
// folded into its crest-foam channel (no extra texture for the ocean to sample: its fragment stage
// is close to WebGPU's 16 samplers); the long one has its own texture.
export interface TrailLevelConfig {
  size: number; // texels per side
  texel: number; // m
}

export const TRAIL_LEVELS: readonly TrailLevelConfig[] = [
  WAKE_LEVELS[0] as WakeLevelConfig,
  { size: 1024, texel: 4 },
];
// OceanMaterial adds trail foam × this to the crest foam; the near trail is folded in pre-weighted.
const TRAIL_SHADE = 0.9;
const MAX_STAMPS = 2 * MAX_WAKE_GRIDS;
// Streaks in the white water: 1.5 m cells across the track, re-drawn every 16 m along it.
const STREAK_ACROSS = 1.5; // m
const STREAK_ALONG = 16; // m
const STREAK_DEPTH = 0.75; // deposit × (1 − depth … 1 + depth)
const CHURN_SPEED = 0.5; // m/s: a wash at rest churns as if the boat moved this fast

// What the ocean shaders sample.
export interface OceanWakeNodes {
  // Wake height at world xz, for the vertex stage (explicit LOD).
  height(xz: N): N;
  // vec4(η, ∂η/∂x, ∂η/∂z, crest foam + TRAIL_SHADE × near trail foam) at world xz, for the
  // fragment stage.
  surface(xz: N): N;
  // The same with an explicit LOD, for branches and passes without screen derivatives.
  surfaceLevel0(xz: N): N;
  // Persistent trail foam (0..TRAIL_MAX) at world xz beyond the near trail.
  trail(xz: N): N;
}

const createTexture = (size: number, name: string, wrap: boolean): StorageTexture => {
  const t = new StorageTexture(size, size);
  t.type = HalfFloatType;
  t.format = RGBAFormat;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.wrapS = t.wrapT = wrap ? RepeatWrapping : ClampToEdgeWrapping;
  t.name = name;
  return t;
};

// Catmull-Rom weights and their derivatives at t ∈ [0, 1).
function catmullRom(t: N): { w: N[]; d: N[] } {
  const t2 = t.mul(t);
  const t3 = t2.mul(t);
  return {
    w: [
      t3.mul(-0.5).add(t2).sub(t.mul(0.5)),
      t3.mul(1.5).sub(t2.mul(2.5)).add(1),
      t3.mul(-1.5).add(t2.mul(2)).add(t.mul(0.5)),
      t3.mul(0.5).sub(t2.mul(0.5)),
    ],
    d: [
      t2.mul(-1.5).add(t.mul(2)).sub(0.5),
      t2.mul(4.5).sub(t.mul(5)),
      t2.mul(-4.5).add(t.mul(4)).add(0.5),
      t2.mul(1.5).sub(t),
    ],
  };
}

interface Slot {
  boatId: string;
  grid: WakeGrid;
}

interface BoatTrail {
  x: number; // stern position last frame
  z: number;
  seen: boolean;
}

interface TrailLevel {
  config: TrailLevelConfig;
  texture: StorageTexture | null; // null: folded into the finest wake level
  state: N; // vec2 per texel: fast, slow channel
  min: N; // window corner, in cells
  prevMin: N;
}

export class WakeLayer {
  readonly levels: StorageTexture[];
  readonly trailLevels: TrailLevel[];
  readonly nodes: OceanWakeNodes;
  private readonly gpu = new GpuResources(); // kernels and storage buffers
  private readonly grids: N = this.gpu.storage(instancedArray(MAX_WAKE_GRIDS * GRID_TEXELS, 'float'));
  private readonly gridInfo: Vector4[] = Array.from({ length: MAX_WAKE_GRIDS }, () => new Vector4());
  private readonly gridInfoNode: N = uniformArray(this.gridInfo, 'vec4');
  private readonly gridCount: N = uniform(0);
  private readonly levelMins: Vector2[] = WAKE_LEVELS.map(() => new Vector2());
  private readonly levelMinNodes: N[] = this.levelMins.map((v) => uniform(v));
  private readonly stampA: Vector4[] = Array.from({ length: MAX_STAMPS }, () => new Vector4());
  private readonly stampB: Vector4[] = Array.from({ length: MAX_STAMPS }, () => new Vector4());
  private readonly stampANode: N = uniformArray(this.stampA, 'vec4');
  private readonly stampBNode: N = uniformArray(this.stampB, 'vec4');
  private readonly stampCount: N = uniform(0);
  private readonly trailDecay: N = uniform(new Vector2(1, 1)); // per frame: fast, slow channel
  private readonly trailCentre: N = uniform(new Vector2()); // m
  private readonly slots: (Slot | null)[] = Array.from({ length: MAX_WAKE_GRIDS }, () => null);
  private readonly trails = new Map<string, BoatTrail>();
  private readonly hulls = new Map<BoatKind, WakeFoamHull>();
  private readonly foam = wakeFoam(
    { lwl: 1, beam: 1, draft: 1, propDepth: 1, blockCoefficient: 0, power: 0 },
    0,
    0,
    false,
  );
  private dirty = false;
  private trailPlaced = false;
  private passes: ComputeNode[];

  constructor() {
    this.levels = WAKE_LEVELS.map((level, i) => createTexture(level.size, `ocean-wake-${i}`, false));
    this.trailLevels = TRAIL_LEVELS.map((config, i) => ({
      config,
      texture: i === 0 ? null : createTexture(config.size, `ocean-wake-trail-${i}`, true),
      state: this.gpu.storage(instancedArray(config.size * config.size, 'vec2')),
      min: uniform(new Vector2()),
      prevMin: uniform(new Vector2()),
    }));
    // Trails first: the finest splat reads the near trail.
    this.passes = [
      ...this.trailLevels.map((level, i) => this.trailKernel(level, i)),
      ...WAKE_LEVELS.map((level, i) => this.splatKernel(level, i)),
    ];
    this.nodes = {
      height: (xz) => this.sampleLevels(xz, true).x,
      surface: (xz) => this.sampleLevels(xz, false),
      surfaceLevel0: (xz) => this.sampleLevels(xz, true),
      trail: (xz) => this.sampleTrail(xz),
    };
  }

  // Grids from a snapshot: replace each boat's slot (an empty grid frees it).
  setGrids(grids: readonly WakeGrid[]): void {
    for (const grid of grids) {
      let index = this.slots.findIndex((s) => s?.boatId === grid.boatId);
      if (grid.height.length === 0 || grid.n !== GRID) {
        if (index >= 0) this.slots[index] = null;
        continue;
      }
      if (index < 0) index = this.slots.findIndex((s) => s === null);
      if (index < 0) continue; // more wakes than slots: the extra boats go without
      this.slots[index] = { boatId: grid.boatId, grid };
      const buffer = this.grids.value as BufferAttribute;
      (buffer.array as Float32Array).set(grid.height, index * GRID_TEXELS);
      buffer.addUpdateRange(index * GRID_TEXELS, GRID_TEXELS); // upload only the slots that changed
      this.dirty = true;
    }
  }

  update(
    renderer: WebGPURenderer,
    camera: PerspectiveCamera,
    time: number,
    dt: number,
    boats: readonly BoatSnapshot[],
  ): void {
    if (this.dirty) {
      this.grids.value.needsUpdate = true;
      this.dirty = false;
    }
    // Grids follow their boats to the render time (a steady wake is fixed in the boat's frame).
    let count = 0;
    this.slots.forEach((slot, i) => {
      const info = this.gridInfo[i] as Vector4;
      if (!slot) {
        info.set(0, 0, 1, 0);
        return;
      }
      const g = slot.grid;
      const lag = Math.max(-0.25, Math.min(0.25, time - g.time));
      info.set(g.minX + g.vx * lag, g.minZ + g.vz * lag, g.cell, 1);
      count = i + 1;
    });
    this.gridCount.value = count;
    WAKE_LEVELS.forEach((level, i) => {
      const snap = (v: number): number => (Math.floor(v / level.texel) - level.size / 2) * level.texel;
      this.levelMins[i]?.set(snap(camera.position.x), snap(camera.position.z));
    });
    this.updateTrail(camera, dt, boats);
    void renderer.compute(this.passes);
  }

  private updateTrail(camera: PerspectiveCamera, dt: number, boats: readonly BoatSnapshot[]): void {
    for (const level of this.trailLevels) {
      const { size, texel } = level.config;
      const minX = Math.floor(camera.position.x / texel) - size / 2;
      const minZ = Math.floor(camera.position.z / texel) - size / 2;
      const current = level.min.value as Vector2;
      (level.prevMin.value as Vector2).copy(this.trailPlaced ? current : new Vector2(minX, minZ));
      current.set(minX, minZ);
    }
    this.trailPlaced = true;
    (this.trailCentre.value as Vector2).set(camera.position.x, camera.position.z);
    const step = Math.min(Math.max(dt, 0), 0.1);
    (this.trailDecay.value as Vector2).set(
      Math.exp(-step / TRAIL_TAU_FAST),
      Math.exp(-step / TRAIL_TAU_SLOW),
    );

    for (const trail of this.trails.values()) trail.seen = false;
    let stamps = 0;
    for (const boat of boats) {
      if (stamps + 2 > MAX_STAMPS) break;
      const spec = BOAT_SPECS[boat.kind];
      let hull = this.hulls.get(boat.kind);
      if (!hull) {
        hull = wakeFoamHull(spec);
        this.hulls.set(boat.kind, hull);
      }
      const { lwl, beam } = spec.dimensions;
      const q = boat.orientation;
      // Bow direction (body −z) on the horizontal.
      let fx = -2 * (q.x * q.z + q.w * q.y);
      let fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      const len = Math.hypot(fx, fz) || 1;
      fx /= len;
      fz /= len;
      const sternX = boat.position.x - fx * lwl * 0.5;
      const sternZ = boat.position.z - fz * lwl * 0.5;
      let trail = this.trails.get(boat.id);
      if (!trail || Math.hypot(trail.x - sternX, trail.z - sternZ) > 50) {
        trail = { x: sternX, z: sternZ, seen: true };
        this.trails.set(boat.id, trail);
      }
      trail.seen = true;
      const speed = Math.hypot(boat.velocity.x, boat.velocity.z);
      const t = boat.telemetry;
      const foam = wakeFoam(hull, speed, deliveredPower(t), (t['airborne'] ?? 0) > 0.5, this.foam);
      // White water along the hull (its bow and stern waves breaking) and in the propeller wash
      // astern, each stamped at the rate that leaves its deposit on the water the boat passes.
      const hullRate = stampRate(foam.hull, speed, 0.85 * lwl, foam.hullWidth);
      const washRate = stampRate(foam.wash, speed, 0.3 * beam + speed * step, foam.washWidth, CHURN_SPEED);
      const slow = foam.persistent;
      const sx0 = trail.x;
      const sz0 = trail.z;
      this.stampA[stamps]?.set(
        boat.position.x + fx * lwl * 0.35,
        boat.position.z + fz * lwl * 0.35,
        sternX,
        sternZ,
      );
      this.stampB[stamps]?.set(foam.hullWidth, hullRate * step * (1 - slow), hullRate * step * slow, 0);
      stamps++;
      this.stampA[stamps]?.set(sx0, sz0, sternX - fx * beam * 0.3, sternZ - fz * beam * 0.3);
      this.stampB[stamps]?.set(foam.washWidth, washRate * step * (1 - slow), washRate * step * slow, 0);
      stamps++;
      trail.x = sternX;
      trail.z = sternZ;
    }
    for (const [id, trail] of this.trails) if (!trail.seen) this.trails.delete(id);
    this.stampCount.value = stamps;
  }

  // --- Kernels ---------------------------------------------------------------------------------

  private splatKernel(level: WakeLevelConfig, index: number): ComputeNode {
    const size = level.size;
    const store = storageTexture(this.levels[index]);
    const levelMin = this.levelMinNodes[index];
    const kernel = Fn(() => {
      const x = instanceIndex.mod(uint(size));
      const y = instanceIndex.div(uint(size));
      const world = levelMin.add(vec2(float(x).add(0.5), float(y).add(0.5)).mul(level.texel));
      const height = float(0).toVar();
      const gradX = float(0).toVar();
      const gradZ = float(0).toVar();
      Loop({ start: int(0), end: int(this.gridCount), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const info = this.gridInfoNode.element(i);
        // Grid coordinates with texel centres on integers.
        const u = world.x.sub(info.x).div(info.z).sub(0.5);
        const v = world.y.sub(info.y).div(info.z).sub(0.5);
        const inside = info.w
          .greaterThan(0.5)
          .and(u.greaterThanEqual(1))
          .and(v.greaterThanEqual(1))
          .and(u.lessThan(GRID - 2))
          .and(v.lessThan(GRID - 2));
        If(inside, () => {
          const c = floor(u);
          const r = floor(v);
          const cu = catmullRom(u.sub(c));
          const cv = catmullRom(v.sub(r));
          const base = i.mul(GRID_TEXELS).add(int(r).sub(1).mul(GRID)).add(int(c).sub(1)).toVar();
          let h: N = float(0);
          let hx: N = float(0);
          let hz: N = float(0);
          for (let j = 0; j < 4; j++) {
            for (let k = 0; k < 4; k++) {
              const f = this.grids.element(uint(base.add(j * GRID + k))).toVar();
              h = h.add(f.mul(cu.w[k].mul(cv.w[j])));
              hx = hx.add(f.mul(cu.d[k].mul(cv.w[j])));
              hz = hz.add(f.mul(cu.w[k].mul(cv.d[j])));
            }
          }
          const edge = min(min(u, v), min(float(GRID - 1).sub(u), float(GRID - 1).sub(v))).div(EDGE_FADE);
          const fade = smoothstep(0, 1, edge);
          height.addAssign(h.mul(fade));
          gradX.addAssign(hx.mul(fade).div(info.z));
          gradZ.addAssign(hz.mul(fade).div(info.z));
        });
      });
      // Only crests near breaking steepness whiten: the cusps and stern waves of a boat driven
      // hard; a yacht's or a ship's Kelvin waves at their usual speeds stay smooth.
      const slope = sqrt(gradX.mul(gradX).add(gradZ.mul(gradZ)));
      const crest = smoothstep(WAKE_CREST_SLOPE[0], WAKE_CREST_SLOPE[1], slope)
        .mul(smoothstep(-0.02, 0.08, height))
        .toVar();
      const near = this.trailLevels[0] as TrailLevel;
      if (index === 0) {
        // The near trail holds the same cells (toroidally addressed).
        const cell = near.min.add(vec2(float(x), float(y)));
        const t = cell.sub(floor(cell.div(size)).mul(size));
        const foam = near.state.element(uint(t.y).mul(uint(size)).add(uint(t.x)));
        crest.addAssign(foam.x.add(foam.y).mul(TRAIL_SHADE));
      }
      textureStore(store, uvec2(x, y), vec4(height, gradX, gradZ, crest)).toWriteOnly();
    })().compute(size * size, [64]);
    kernel.setName(`ocean-wake-splat-${index}`);
    return kernel;
  }

  private trailKernel(level: TrailLevel, index: number): ComputeNode {
    const { size, texel } = level.config;
    const streaky = texel < STREAK_ACROSS;
    const store = level.texture ? storageTexture(level.texture) : null;
    // Non-negative remainder for floats.
    const wrap = (a: N): N => a.sub(floor(a.div(size)).mul(size));
    // Value noise in [0, 1] over integer cells of (across, along).
    const cellHash = (i: N, j: N): N =>
      hash(
        i
          .toInt()
          .toUint()
          .mul(uint(73856093))
          .bitXor(j.toInt().toUint().mul(uint(19349663))),
      );
    const noise = (a: N, b: N): N => {
      const i = floor(a);
      const j = floor(b);
      const fa = fract(a);
      const fb = fract(b);
      const wa = fa.mul(fa).mul(fa.mul(-2).add(3));
      const wb = fb.mul(fb).mul(fb.mul(-2).add(3));
      const row0 = mix(cellHash(i, j), cellHash(i.add(1), j), wa);
      const row1 = mix(cellHash(i, j.add(1)), cellHash(i.add(1), j.add(1)), wa);
      return mix(row0, row1, wb);
    };
    const kernel = Fn(() => {
      const tx = instanceIndex.mod(uint(size));
      const ty = instanceIndex.div(uint(size));
      const t = vec2(float(tx), float(ty));
      // The world cell this texel holds in the current window (toroidal addressing).
      const cell = level.min.add(wrap(t.sub(level.min)));
      const prev = level.prevMin;
      const exposed = cell.x
        .lessThan(prev.x)
        .or(cell.y.lessThan(prev.y))
        .or(cell.x.greaterThanEqual(prev.x.add(size)))
        .or(cell.y.greaterThanEqual(prev.y.add(size)));
      const value = select(exposed, vec2(0), level.state.element(instanceIndex).mul(this.trailDecay)).toVar();
      const p = cell.add(0.5).mul(texel);
      Loop({ start: int(0), end: int(this.stampCount), type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const a = this.stampANode.element(i);
        const b = this.stampBNode.element(i);
        const p0 = a.xy;
        const seg = a.zw.sub(p0);
        const along = dot(p.sub(p0), seg)
          .div(max(dot(seg, seg), 1e-4))
          .clamp(0, 1);
        const distance = p.sub(p0.add(seg.mul(along))).length();
        // Never stamp narrower than a texel, keeping the deposit per area.
        const width = max(b.x, texel * 0.75);
        If(distance.lessThan(width), () => {
          let amount: N = b.yz.mul(
            b.x.div(width).mul(float(1).sub(smoothstep(width.mul(0.4), width, distance))),
          );
          if (streaky) {
            // The white water comes in ropes and patches along the track, not as a sheet.
            const dir = seg.div(max(seg.length(), 1e-3));
            const side = dot(p.sub(p0), vec2(dir.y.negate(), dir.x));
            const n = noise(side.div(STREAK_ACROSS), dot(p, dir).div(STREAK_ALONG));
            amount = amount.mul(n.mul(2 * STREAK_DEPTH).add(1 - STREAK_DEPTH));
          }
          value.addAssign(amount);
        });
      });
      // Capped in total; the slow channel keeps its share first.
      const slow = min(value.y, TRAIL_MAX);
      const fast = min(value.x, float(TRAIL_MAX).sub(slow));
      level.state.element(instanceIndex).assign(vec2(fast, slow));
      if (store) textureStore(store, uvec2(tx, ty), vec4(fast.add(slow), fast, slow, 1)).toWriteOnly();
    })().compute(size * size, [64]);
    kernel.setName(`ocean-wake-trail-${index}`);
    return kernel;
  }

  // --- Sampling for the ocean shaders -----------------------------------------------------------

  private sampleLevels(xz: N, vertex: boolean): N {
    let result: N = vec4(0);
    // Coarse first, then each finer level blended in where it covers.
    for (let i = WAKE_LEVELS.length - 1; i >= 0; i--) {
      const level = WAKE_LEVELS[i] as WakeLevelConfig;
      const extent = level.size * level.texel;
      const uv = xz.sub(this.levelMinNodes[i]).div(extent);
      const reach = max(abs(uv.x.sub(0.5)), abs(uv.y.sub(0.5)));
      const weight = float(1).sub(smoothstep(0.36, 0.47, reach));
      const tex = texture(this.levels[i], uv);
      const sample = vertex ? tex.level(0) : tex;
      result = i === WAKE_LEVELS.length - 1 ? sample.mul(weight) : mix(result, sample, weight);
    }
    return result;
  }

  // The long trail, where the near one (in the finest wake level's crest channel) doesn't cover.
  private sampleTrail(xz: N): N {
    const level = this.trailLevels[1] as TrailLevel;
    const extent = level.config.size * level.config.texel;
    const foam = texture(level.texture, xz.div(extent)).x;
    const d = xz.sub(this.trailCentre);
    const weight = float(1).sub(smoothstep(0.4, 0.48, max(abs(d.x), abs(d.y)).div(extent)));
    const fine = WAKE_LEVELS[0] as WakeLevelConfig;
    const uv = xz.sub(this.levelMinNodes[0]).div(fine.size * fine.texel);
    const near = float(1).sub(smoothstep(0.36, 0.47, max(abs(uv.x.sub(0.5)), abs(uv.y.sub(0.5)))));
    return foam.mul(weight).mul(float(1).sub(near));
  }

  dispose(): void {
    for (const pass of this.passes) this.gpu.track(pass);
    this.passes = [];
    this.gpu.dispose();
    for (const t of this.levels) t.dispose();
    for (const level of this.trailLevels) level.texture?.dispose();
  }
}
