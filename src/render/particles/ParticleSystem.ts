// GPU particle pool for spray, spume, white water, rain splashes and engine smoke.
//
// All state lives in storage buffers and is simulated and drawn on the GPU:
//   posSize  vec4  position xyz (m), visual radius (m)
//   velAge   vec4  velocity xyz (m/s), age (s)
//   meta     vec4  life (s, ≤ 0 = free slot), kind, random seed 0..1 plus the tone step (0..63),
//                  quadratic drag (1/m; smoke: the source radius, m)
// Free slots sit on a GPU stack (deadList + atomic deadCount): emitters pop, the simulation pushes
// particles that expire, fall into the sea or fly into a hull (HullVolumes). Nothing is read back.
// Nothing is spawned inside a hull either.
//
// Each frame: simulate, then the CPU emission queue, then the GPU emitters (spume, rain splashes).
// Drawing is one instanced quad per slot; free slots collapse to a degenerate quad. Blending is
// premultiplied "over" (with an additive share for glinting water) and unsorted: single puffs are
// faint enough that their order doesn't show.
import {
  type ComputeNode,
  CustomBlending,
  DoubleSide,
  FloatType,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type PerspectiveCamera,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu';

import { GpuResources, ViewportDepthCopy } from '../gpuResources';
import { type N, tsl } from '../tsl';
import { EmissionQueue, PARTICLE_KIND, REQUEST_VEC4S, type SpawnRequest } from './emissionQueue';
import { SMOKE_OPACITY } from './exhaust';
import type { HullVolumes } from './hullVolumes';
import type { OceanSampler } from './oceanSampler';
import { FxLighting, GpuRandom, henyeyGreenstein } from './shading';
import { powerLawRadiusNode } from './sprayMath';

const {
  Fn,
  If,
  atomicAdd,
  atomicStore,
  atomicSub,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  cos,
  dot,
  exp,
  float,
  floor,
  fract,
  instanceIndex,
  instancedArray,
  int,
  length,
  log,
  max,
  min,
  mix,
  normalize,
  perspectiveDepthToViewZ,
  positionGeometry,
  pow,
  saturate,
  screenUV,
  select,
  sin,
  smoothstep,
  sqrt,
  uint,
  uniform,
  uniformArray,
  varyingProperty,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
} = tsl;

// Per-kind simulation constants: default drag g/vt² (1/m), growth exponent g (radius ∝ (1 + age)^g,
// so a puff spreads in proportion to its size), turbulence (m/s²), behaviour (0 die on the sea,
// 1 float as mist, 2 ride as foam, 3 smoke).
const KIND_SIM = [
  new Vector4(0.12, 0, 0.6, 0), // droplet
  new Vector4(25, 0.8, 1.6, 1), // mist: vt ≈ 0.6 m/s, hangs in the air
  new Vector4(0.6, 0.6, 0.3, 2), // foam
  new Vector4(0.4, 0, 0, 0), // splash
  // Smoke: drag × 1/r0 (the exit jet mixes into the air within a few outlet diameters).
  new Vector4(0.2, 0, 0.5, 3),
];
// Per-kind look: streakiness, additive share, opacity, albedo.
const KIND_LOOK = [
  new Vector4(1, 0.3, 0.75, 0.92), // droplet
  new Vector4(0, 0.12, 0.06, 0.95), // mist
  new Vector4(0, 0.04, 0.3, 1), // foam
  new Vector4(1, 0.35, 0.6, 0.9), // splash
  new Vector4(0, 0, 1, 1), // smoke: opacity and albedo from its tone
];

// Per-kind optics: forward-lobe weight, sun scale, phase cap (×4π-normalized),
// elongation along the motion per m/s (wind-torn mist reads as streaks).
const KIND_OPTICS = [
  new Vector4(0.6, 0.7, 7, 0), // droplet
  new Vector4(0.35, 0.55, 3, 0.07), // mist
  new Vector4(0.1, 0.8, 2, 0), // foam
  new Vector4(0.6, 0.7, 7, 0), // splash
  new Vector4(0.15, 0.5, 2, 0.05), // smoke: soot absorbs, so little sunlight is scattered
];

// Per-kind shape: size power law (n(r) ∝ r^−alpha, sprayMath), shrink rate (1/s: clumps breaking
// into finer droplets), self-shadowing of dense puffs (lit on the sun's side, dark against the
// sun), brightness and sea-tint variation between particles.
const KIND_SHAPE = [
  new Vector4(2.2, 0.25, 0, 0.14), // droplet
  new Vector4(0, 0, 0.3, 0.08), // mist
  new Vector4(0, 0, 0.6, 0.14), // foam
  new Vector4(2.5, 0, 0, 0.12), // splash
  new Vector4(0, 0, 0.75, 0.1), // smoke
];

// Smoke (r0: the source radius): puffs rise at SMOKE_RISE·√(r0 / 0.7 m)/√(1 + t / SMOKE_RISE_TIME)
// as the plume entrains air, scaled by 6/(U + 2) in a wind (bent over flat), and spread at
// SMOKE_SPREAD·r0 per second (faster in a strong wind), slowing with age. Once a puff is three
// times the outlet's size its opacity falls as (3·r0 / r)^SMOKE_THINNING. Puffs stretch along the wind.
const SMOKE_RISE = 3.5; // m/s
const SMOKE_RISE_TIME = 3; // s
const SMOKE_SPREAD = 1.2; // 1/s
const SMOKE_DOWNWASH = 0.05; // m/s of sink per m/s of wind over 10 m/s, fading over ~4 s
const SMOKE_THINNING = 1;
// Exhaust absorbs: light grey at most, never as bright as the white cloud a puff's shape suggests.
const SMOKE_LIGHT = new Vector3(0.45, 0.45, 0.46); // albedo of a light haze
const SMOKE_DARK = new Vector3(0.13, 0.11, 0.09); // and of diesel soot, warm grey-brown
const TONE_STEPS = 63;

const SHUTTER = 1 / 60; // s: how long a streak a moving droplet paints
const MIN_PIXELS = 1.25; // particles smaller than this grow and fade instead of aliasing
const WIND_Z0 = 0.002; // m, sea-surface roughness length for the log wind profile
const GRAVITY = 9.81;

export interface ParticleSystemOptions {
  capacity: number;
  emitPerFrame: number;
  maxRequests?: number;
  ocean: OceanSampler | null;
  lighting: FxLighting;
  hulls?: HullVolumes | null; // nothing spawns or lives inside these
  // Particles that hit the water are appended to foamHits (nothing reads them yet); 0 disables.
  foamHitCapacity?: number;
}

// The per-particle values a GPU emitter writes.
export interface GpuParticle {
  position: N; // vec3
  velocity: N; // vec3
  size: N;
  life: N;
  kind: N; // float kind id
  seed: N; // 0..1
  drag: N;
  tone?: N; // 0..1 (smoke)
}

export class ParticleSystem {
  readonly capacity: number;
  readonly mesh: Mesh;
  readonly queue: EmissionQueue;
  readonly ocean: OceanSampler | null;
  readonly lighting: FxLighting;
  readonly hulls: HullVolumes | null;
  // Shared by the simulation and the GPU emitters.
  readonly uniforms = {
    dt: uniform(0),
    time: uniform(0),
    frame: uniform(0, 'uint'),
    wind: uniform(new Vector3()), // m/s at 10 m
    cameraPosition: uniform(new Vector3()),
    pixelScale: uniform(1000), // pixels per metre at 1 m depth
  };
  // Foam hits this frame: vec4(x, z, radius, kind); the counter is reset every frame.
  readonly foamHits: { buffer: N; count: N; capacity: number } | null;

  private active: number;
  private activeUniform: N;
  private posSize: N;
  private velAge: N;
  private meta: N;
  private deadList: N;
  private deadCount: N;
  private requests: N;
  private starts: N;
  private requestCount: N;
  private kindSim: N;
  private kindLook: N;
  private kindOptics: N;
  private kindShape: N;
  private resetNode: ComputeNode;
  private simulateNode: ComputeNode;
  private emitNode: ComputeNode;
  private clearHitsNode: ComputeNode | null = null;
  private needsReset = true;
  // The opaque scene's depth (soft particles): one copy for every render target, freed on dispose.
  private depthCopy = new ViewportDepthCopy(1, 1);
  private gpu = new GpuResources();

  constructor(options: ParticleSystemOptions) {
    this.capacity = options.capacity;
    this.active = options.capacity;
    this.ocean = options.ocean;
    this.lighting = options.lighting;
    this.hulls = options.hulls ?? null;
    const maxRequests = options.maxRequests ?? 256;
    this.queue = new EmissionQueue(maxRequests, options.emitPerFrame);
    const capacity = options.capacity;

    const gpu = this.gpu;
    this.posSize = gpu.storage(instancedArray(capacity, 'vec4'));
    this.velAge = gpu.storage(instancedArray(capacity, 'vec4'));
    this.meta = gpu.storage(instancedArray(capacity, 'vec4'));
    this.deadList = gpu.storage(instancedArray(capacity, 'uint'));
    this.deadCount = gpu.storage(instancedArray(1, 'int').toAtomic());
    this.requests = gpu.storage(instancedArray(maxRequests * REQUEST_VEC4S, 'vec4'));
    this.starts = gpu.storage(instancedArray(maxRequests, 'uint'));
    this.requestCount = uniform(0, 'uint');
    this.activeUniform = uniform(capacity, 'uint');
    this.kindSim = uniformArray(KIND_SIM, 'vec4');
    this.kindLook = uniformArray(KIND_LOOK, 'vec4');
    this.kindOptics = uniformArray(KIND_OPTICS, 'vec4');
    this.kindShape = uniformArray(KIND_SHAPE, 'vec4');

    const hitCapacity = options.foamHitCapacity ?? 2048;
    this.foamHits =
      hitCapacity > 0
        ? {
            buffer: gpu.storage(instancedArray(hitCapacity, 'vec4')),
            count: gpu.storage(instancedArray(1, 'uint').toAtomic()),
            capacity: hitCapacity,
          }
        : null;

    this.resetNode = this.buildReset();
    this.simulateNode = this.buildSimulate();
    this.emitNode = this.buildEmit(maxRequests);
    if (this.foamHits) {
      const hits = this.foamHits;
      const clear: ComputeNode = Fn(() => {
        atomicStore(hits.count.element(0), uint(0));
      })().compute(1, [1]);
      clear.setName('fx-clear-foam-hits');
      this.clearHitsNode = clear;
    }
    this.mesh = this.buildMesh();
  }

  // Lowers (or restores, up to capacity) the number of live slots. Clears the pool.
  setActiveCapacity(count: number): void {
    this.active = Math.max(1024, Math.min(this.capacity, Math.floor(count)));
    this.activeUniform.value = this.active;
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = this.active;
    this.needsReset = true;
  }

  get activeCapacity(): number {
    return this.active;
  }

  spawn(request: SpawnRequest): number {
    return this.queue.push(request);
  }

  // Pops a free slot: an int index, or −1 when the pool is full. Compute only.
  allocate(): N {
    const counter = this.deadCount.element(0);
    const previous = atomicSub(counter, int(1)).toVar();
    const index = int(-1).toVar();
    If(previous.greaterThan(0), () => {
      index.assign(int(this.deadList.element(uint(previous.sub(1)))));
    }).Else(() => {
      atomicAdd(counter, int(1));
    });
    return index;
  }

  // Bool node: the world position is inside a boat's hull or superstructure. Compute only.
  insideHull(position: N): N {
    return this.hulls ? this.hulls.inside(position) : tsl.bool(false);
  }

  // Writes a freshly spawned particle into a slot returned by allocate().
  write(index: N, particle: GpuParticle): void {
    const slot = uint(index);
    const tone = particle.tone ? floor(saturate(particle.tone).mul(TONE_STEPS).add(0.5)) : float(0);
    this.posSize.element(slot).assign(vec4(particle.position, particle.size));
    this.velAge.element(slot).assign(vec4(particle.velocity, 0));
    this.meta
      .element(slot)
      .assign(vec4(max(particle.life, 0.01), particle.kind, fract(particle.seed).add(tone), particle.drag));
  }

  // Default drag for a kind id, varied ±40% per particle.
  kindDrag(kind: N, random: GpuRandom): N {
    // The +0.25 keeps the int() conversion even when kind is a float variable (TSL elides it otherwise).
    return this.kindSim.element(int(kind.add(0.25))).x.mul(random.range(0.6, 1.4));
  }

  update(renderer: WebGPURenderer, camera: PerspectiveCamera, dt: number, time: number): void {
    const u = this.uniforms;
    u.dt.value = Math.min(Math.max(dt, 0), 0.1);
    u.time.value = time % 3600;
    u.frame.value = (u.frame.value + 1) >>> 0;
    u.cameraPosition.value.copy(camera.position);
    const size = renderer.getDrawingBufferSize(scratchSize);
    const p11 = camera.projectionMatrix.elements[5] ?? 1;
    u.pixelScale.value = p11 * size.y * 0.5;

    if (this.needsReset) {
      void renderer.compute(this.resetNode);
      this.needsReset = false;
    }
    if (this.clearHitsNode) void renderer.compute(this.clearHitsNode);
    this.simulateNode.count = this.active;
    void renderer.compute(this.simulateNode);

    const queue = this.queue;
    if (queue.total > 0) {
      const requests = this.requests.value;
      (requests.array as Float32Array).set(queue.data.subarray(0, queue.requestCount * REQUEST_VEC4S * 4));
      requests.clearUpdateRanges();
      requests.addUpdateRange(0, queue.requestCount * REQUEST_VEC4S * 4);
      requests.needsUpdate = true;
      const starts = this.starts.value;
      (starts.array as Uint32Array).set(queue.starts.subarray(0, queue.requestCount));
      starts.clearUpdateRanges();
      starts.addUpdateRange(0, queue.requestCount);
      starts.needsUpdate = true;
      this.requestCount.value = queue.requestCount;
      this.emitNode.count = queue.total;
      void renderer.compute(this.emitNode);
    }
    queue.clear();
  }

  // Debug only (dev tools): live particle count via a GPU readback.
  async debugLiveCount(renderer: WebGPURenderer): Promise<number> {
    const buffer = await renderer.getArrayBufferAsync(this.deadCount.value);
    return this.active - (new Int32Array(buffer)[0] ?? 0);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as NodeMaterial).dispose();
    this.resetNode.dispose();
    this.simulateNode.dispose();
    this.emitNode.dispose();
    this.clearHitsNode?.dispose();
    this.depthCopy.dispose();
    this.gpu.dispose();
  }

  private buildReset(): ComputeNode {
    const node: ComputeNode = Fn(() => {
      const i = instanceIndex;
      this.meta.element(i).assign(vec4(0));
      this.posSize.element(i).assign(vec4(0, -1e4, 0, 0));
      If(i.lessThan(this.activeUniform), () => {
        this.deadList.element(i).assign(i);
      });
      If(i.equal(uint(0)), () => {
        atomicStore(this.deadCount.element(0), int(this.activeUniform));
      });
    })().compute(this.capacity, [64]);
    node.setName('fx-particles-reset');
    return node;
  }

  private buildSimulate(): ComputeNode {
    const u = this.uniforms;
    const node: ComputeNode = Fn(() => {
      const i = instanceIndex;
      const meta = this.meta.element(i).toVar();
      If(meta.x.greaterThan(0), () => {
        const ps = this.posSize.element(i).toVar();
        const va = this.velAge.element(i).toVar();
        const sim = this.kindSim.element(int(meta.y));
        const shape = this.kindShape.element(int(meta.y));
        const dt = u.dt;
        const age = va.w.add(dt).toVar();
        const behaviour = sim.w;
        const isSmoke = behaviour.equal(3);

        // Log wind profile: slower near the water, a little faster above 10 m.
        const height = max(ps.y, 0.05);
        const profile = clamp(log(height.div(WIND_Z0)).div(Math.log(10 / WIND_Z0)), 0.35, 1.25);
        const wind = u.wind.mul(profile);
        // Per-particle gusty wobble so clouds of spray don't move rigidly.
        const s = meta.z.mul(97.0);
        const t = u.time;
        const wobble = vec3(
          sin(t.mul(1.3).add(s)),
          sin(t.mul(1.9).add(s.mul(1.7))).mul(0.5),
          cos(t.mul(1.1).add(s.mul(0.6))),
        );
        const turbulence = wobble.mul(sim.z).mul(length(u.wind).mul(0.08).add(0.5));

        // Smoke is the air it is in, plus a buoyant rise that fades as the plume entrains air; in a
        // strong wind it is bent over flat and pulled down in the lee of the stack and superstructure.
        const windSpeed = length(u.wind);
        const bent = clamp(float(6).div(windSpeed.add(2)), 0.15, 1.6);
        const downwash = max(windSpeed.sub(10), 0).mul(SMOKE_DOWNWASH).div(age.div(4).add(1));
        const rise = float(SMOKE_RISE)
          .mul(sqrt(max(meta.w, 0).div(0.7)))
          .mul(bent)
          .div(sqrt(age.div(SMOKE_RISE_TIME).add(1)))
          .sub(downwash);
        const target = select(isSmoke, wind.add(vec3(0, rise, 0)), wind);
        // Quadratic drag towards the air, integrated exactly over dt for stability.
        const relative = target.sub(va.xyz);
        const k = select(isSmoke, sim.x.div(max(meta.w, 0.02)), meta.w).mul(length(relative));
        const gravity = select(isSmoke, float(0), float(-GRAVITY));
        const velocity = target
          .add(va.xyz.sub(target).mul(exp(k.mul(dt).negate())))
          .add(vec3(0, gravity, 0).add(turbulence).mul(dt))
          .toVar();
        const position = ps.xyz.add(velocity.mul(dt)).toVar();
        // Puffs spread, fastest at first; clumps of water shrink as they shed droplets.
        // (Smoke mixes out faster in a strong wind.)
        const spread = meta.w
          .mul(SMOKE_SPREAD)
          .mul(windSpeed.div(15).add(1))
          .mul(pow(age.div(4).add(1), -0.4))
          .mul(dt);
        const grown = ps.w.mul(pow(age.add(1).div(va.w.add(1)), sim.y));
        const size = select(isSmoke, ps.w.add(spread), grown.mul(exp(shape.y.mul(dt).negate()))).toVar();

        const surface = (this.ocean ? this.ocean.height(position.xz, 5) : float(0)).toVar();
        const dead = age.greaterThanEqual(meta.x).toVar();
        // Water doesn't pass through hulls, decks or cabins: spray that lands on a boat ends there.
        if (this.hulls) {
          If(dead.not().and(isSmoke.not()), () => {
            If(this.insideHull(position), () => {
              dead.assign(true);
            });
          });
        }
        If(behaviour.equal(0), () => {
          // Droplets and splashes rejoin the sea.
          If(position.y.lessThan(surface).and(velocity.y.lessThan(0)), () => {
            if (this.foamHits) {
              const hits = this.foamHits;
              const slot = atomicAdd(hits.count.element(0), uint(1)).toVar();
              If(slot.lessThan(uint(hits.capacity)), () => {
                hits.buffer.element(slot).assign(vec4(position.x, position.z, size, meta.y));
              });
            }
            dead.assign(true);
          });
        })
          .ElseIf(behaviour.equal(1).or(isSmoke), () => {
            // Mist and smoke skim the surface instead of sinking.
            const floor = surface.add(size.mul(0.4));
            If(position.y.lessThan(floor), () => {
              position.y.assign(floor);
              velocity.y.assign(max(velocity.y, 0));
            });
          })
          .Else(() => {
            // White water rides the waves and slows in the water.
            const floor = surface.add(size.mul(0.25));
            If(position.y.lessThan(floor), () => {
              position.y.assign(floor);
              velocity.assign(vec3(velocity.x, max(velocity.y, 0), velocity.z).mul(exp(dt.mul(-2.5))));
            });
          });

        If(dead, () => {
          this.meta.element(i).assign(vec4(0, meta.y, meta.z, meta.w));
          this.posSize.element(i).assign(vec4(0, -1e4, 0, 0));
          const top = atomicAdd(this.deadCount.element(0), int(1)).toVar();
          this.deadList.element(uint(top)).assign(i);
        }).Else(() => {
          this.posSize.element(i).assign(vec4(position, size));
          this.velAge.element(i).assign(vec4(velocity, age));
        });
      });
    })().compute(this.capacity, [64]);
    node.setName('fx-particles-simulate');
    return node;
  }

  private buildEmit(maxRequests: number): ComputeNode {
    const steps = Math.ceil(Math.log2(Math.max(2, maxRequests)));
    const node: ComputeNode = Fn(() => {
      const thread = instanceIndex;
      // Binary search the prefix table for the request owning this thread.
      const lo = uint(0).toVar();
      const hi = this.requestCount.toVar();
      for (let step = 0; step < steps; step++) {
        If(hi.sub(lo).greaterThan(uint(1)), () => {
          const mid = lo.add(hi).shiftRight(uint(1));
          If(this.starts.element(mid).lessThanEqual(thread), () => {
            lo.assign(mid);
          }).Else(() => {
            hi.assign(mid);
          });
        });
      }
      const base = lo.mul(uint(REQUEST_VEC4S));
      const r0 = this.requests.element(base);
      const r1 = this.requests.element(base.add(uint(1)));
      const r2 = this.requests.element(base.add(uint(2)));
      const r3 = this.requests.element(base.add(uint(3)));
      const r4 = this.requests.element(base.add(uint(4)));
      const r5 = this.requests.element(base.add(uint(5)));
      const r6 = this.requests.element(base.add(uint(6)));
      const local = thread.sub(this.starts.element(lo));
      const random = new GpuRandom(
        uint(r5.y)
          .mul(uint(2654435761))
          .bitXor(local.mul(uint(40503)))
          .bitXor(this.uniforms.frame),
      );

      const kind = r3.w;
      const position = r0.xyz
        .add(r2.xyz.mul(random.range(-1, 1)))
        .add(random.insideSphere().mul(r0.w))
        .toVar();
      // Nothing starts inside a hull (smoke leaves the funnel tops, clear of the superstructure).
      const index = int(-1).toVar();
      const blocked = this.hulls ? kind.lessThan(3.5).and(this.insideHull(position)) : tsl.bool(false);
      If(blocked.not(), () => {
        index.assign(this.allocate());
      });
      If(index.greaterThanEqual(0), () => {
        // Fan: rotate the mean velocity about the axis (Rodrigues).
        const angle = random.range(-1, 1).mul(r2.w);
        const axis = r3.xyz;
        const v = r1.xyz;
        const c = cos(angle);
        const fanned = v
          .mul(c)
          .add(axis.cross(v).mul(sin(angle)))
          .add(axis.mul(dot(axis, v)).mul(float(1).sub(c)));
        const speed = float(1).sub(r5.z.mul(random.next()));
        const velocity = fanned.mul(speed).add(random.insideSphere().mul(r1.w)).add(r6.xyz);
        const alpha = select(r6.w.lessThan(0), this.kindShape.element(int(kind.add(0.25))).x, r6.w);
        const size = powerLawRadiusNode(r4.x, max(r4.y, r4.x), alpha, random.next());
        const life = mix(r4.z, r4.w, random.next());
        const drag = select(r5.x.lessThan(0), this.kindDrag(kind, random), r5.x.mul(random.range(0.7, 1.3)));
        this.write(index, { position, velocity, size, life, kind, seed: random.next(), drag, tone: r5.w });
      });
    })().compute(maxRequests * 64, [64]);
    node.setName('fx-particles-emit');
    return node;
  }

  private buildMesh(): Mesh {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = this.active;

    const u = this.uniforms;
    const light = this.lighting;
    const vColor = varyingProperty('vec4', 'v_fxColor');
    const vUv = varyingProperty('vec2', 'v_fxUv');
    const vInfo = varyingProperty('vec4', 'v_fxInfo'); // puff (mist/foam/smoke) weight, seed, view depth, soft distance
    const vShade = varyingProperty('vec2', 'v_fxShade'); // additive share, self-shadowing

    const material = new NodeMaterial();
    material.name = 'fx-particles';
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.fog = false;
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;

    material.vertexNode = Fn(() => {
      const i = instanceIndex;
      const meta = this.meta.element(i);
      const ps = this.posSize.element(i);
      const va = this.velAge.element(i);
      const kind = int(meta.y);
      const look = this.kindLook.element(kind);
      const shape = this.kindShape.element(kind);
      const corner = positionGeometry.xy;
      const seed = fract(meta.z);
      const tone = floor(meta.z).div(TONE_STEPS);
      const isSmoke = float(kind.equal(int(PARTICLE_KIND.smoke)));

      const center = cameraViewMatrix.mul(vec4(ps.xyz, 1)).xyz.toVar();
      const depth = max(center.z.negate(), 0.05);
      // Sub-pixel particles grow to MIN_PIXELS and fade by the area ratio instead of shimmering.
      const pixels = ps.w.mul(u.pixelScale).div(depth);
      const grow = max(float(1), float(MIN_PIXELS).div(max(pixels, 1e-4)));
      const radius = ps.w.mul(grow);

      // Streaks stretch along the screen-space velocity; round sprites get a random spin.
      const viewVelocity = cameraViewMatrix.mul(vec4(va.xyz, 0)).xyz;
      const speed = length(viewVelocity.xy);
      const motion = select(speed.greaterThan(1e-3), viewVelocity.xy.div(speed), vec2(0, 1));
      const spin = seed.mul(Math.PI * 2);
      const optics = this.kindOptics.element(kind);
      const alongMotion = saturate(look.x.add(optics.w.mul(20)));
      const axis = normalize(mix(vec2(cos(spin), sin(spin)), motion, alongMotion));
      const stretch = min(look.x.mul(speed).mul(SHUTTER), radius.mul(16));
      const halfLength = radius.mul(float(1).add(min(optics.w.mul(speed), 3))).add(stretch.mul(0.5));
      const side = vec2(axis.y.negate(), axis.x);
      // White water is a low churn: squash it vertically on screen.
      const isFoam = float(kind.equal(int(PARTICLE_KIND.foam)));
      const offset = axis
        .mul(corner.y.mul(halfLength))
        .add(side.mul(corner.x.mul(radius)))
        .mul(vec2(1, mix(1, 0.55, isFoam)));
      const viewPosition = center.add(vec3(offset, 0));

      // Fade in quickly, out over the last half of life; mist lingers longer, smoke thins away.
      const t = va.w.div(max(meta.x, 1e-3));
      const isMist = float(kind.equal(int(PARTICLE_KIND.mist)));
      const fadeIn = smoothstep(0, mix(mix(0.04, 0.15, isMist), 0.01, isSmoke), t);
      const fadeOut = float(1).sub(smoothstep(mix(mix(0.55, 0.35, isMist), 0.4, isSmoke), 1, t));
      // Spray within a few metres of the lens would be huge out-of-focus blobs: fade it out. Smoke
      // puffs fade as they fill much of the view (the camera coming into the plume), which also caps
      // their overdraw: drawn in full up to ~30° across, gone by ~65°.
      const nearFade = smoothstep(0.8, 4, depth).mul(
        mix(1, smoothstep(halfLength.mul(1.5), halfLength.mul(3.5), depth), isSmoke),
      );
      const coverage = float(1).div(grow.mul(grow)).mul(radius.div(halfLength).sqrt());
      // Smoke: denser and darker with soot, thinning as each puff spreads.
      const thinning = pow(saturate(meta.w.mul(3).div(max(ps.w, 1e-3))), SMOKE_THINNING);
      const smokeOpacity = mix(SMOKE_OPACITY[0], SMOKE_OPACITY[1], tone).mul(thinning);
      const opacity = mix(look.z, smokeOpacity, isSmoke);
      const alpha = opacity.mul(fadeIn).mul(fadeOut).mul(nearFade).mul(coverage);

      // Forward-scattering phase: water droplets glow when backlit by the sun.
      const toParticle = normalize(ps.xyz.sub(cameraPosition));
      const cosTheta = dot(toParticle, light.sunDirection);
      // Dense mist and foam scatter many times, so their lobe is weaker than single droplets'.
      const phase = min(
        mix(henyeyGreenstein(cosTheta, 0.1), henyeyGreenstein(cosTheta, 0.8), optics.x).mul(4 * Math.PI),
        optics.z,
      );
      const sunUp = smoothstep(-0.05, 0.05, light.sunDirection.y);
      // Each particle a little brighter or darker; water a little tinted by the sea it came from.
      const h1 = fract(seed.mul(7.31));
      const h2 = fract(seed.mul(13.7));
      const brightness = float(1).add(shape.w.mul(h1.mul(2).sub(1)));
      const water = mix(vec3(1), light.seaTint, h2.mul(shape.w).mul(1.5)).mul(look.w);
      const smoke = mix(vec3(SMOKE_LIGHT), vec3(SMOKE_DARK), tone);
      const albedo = mix(water, smoke, isSmoke).mul(brightness);
      const sun = light.sunColor.mul(phase).mul(sunUp).mul(optics.y);
      const ambient = light.ambientColor.add(light.flashColor);
      const radiance = ambient.add(sun).mul(albedo);
      // How much of the light is the sun's: the share the puff's own shadow takes away.
      const luma = vec3(0.2126, 0.7152, 0.0722);
      const sunShare = dot(sun, luma).div(max(dot(sun.add(ambient), luma), 1e-5));

      vColor.assign(vec4(radiance, alpha));
      vUv.assign(corner);
      vInfo.assign(
        vec4(max(max(isMist, isFoam), isSmoke), seed, depth, max(ps.w.mul(mix(1.5, 0.6, isFoam)), 0.05)),
      );
      vShade.assign(vec2(look.y, shape.z.mul(sunShare)));
      const clip = cameraProjectionMatrix.mul(vec4(viewPosition, 1));
      // Free slots, and particles faded to nothing (a smoke puff the camera is in), cost no fill.
      return select(meta.x.greaterThan(0).and(alpha.greaterThan(1e-4)), clip, vec4(0, 0, 2, 1));
    })();

    // The renderer uses a reversed float depth buffer (depth32float); the copy must match it.
    this.depthCopy.type = FloatType;
    const sceneDepth = viewportDepthTexture(screenUV, null, this.depthCopy);
    // outputNode (not fragmentNode) so MRT passes (TRAA velocity) still get every attachment.
    material.outputNode = Fn(() => {
      const uv = vUv;
      const r2 = dot(uv, uv);
      const edge = saturate(float(1).sub(r2));
      const droplet = exp(r2.mul(-4));
      // Mist: a lumpy puff, different for every particle.
      const seed = vInfo.y.mul(43.0);
      const lumps = sin(uv.x.mul(2.6).add(seed))
        .mul(sin(uv.y.mul(3.1).add(seed.mul(1.7))))
        .mul(0.5)
        .add(sin(uv.x.add(uv.y).mul(4.3).add(seed.mul(2.3))).mul(0.25))
        .add(0.6);
      const mist = exp(r2.mul(-2.2)).mul(saturate(lumps));
      const sprite = mix(droplet, mist, vInfo.x).mul(edge);
      // Dense puffs shade themselves: a sphere's normal, lit on the side towards the sun.
      const normal = normalize(vec3(uv.mul(0.9), sqrt(saturate(float(1).sub(r2))).add(0.25)));
      const sunView = normalize(cameraViewMatrix.mul(vec4(this.lighting.sunDirection, 0)).xyz);
      const facing = saturate(dot(normal, sunView).mul(0.5).add(0.5));
      // (Only darkens: the far side is in shade, the near side no brighter than the light allows.)
      const shade = float(1).sub(vShade.y.mul(float(1).sub(facing)));
      // Soft particles: fade where the sprite meets the scene (sea, hull).
      const sceneZ = perspectiveDepthToViewZ(sceneDepth.x, cameraNear, cameraFar).negate();
      const soft = saturate(sceneZ.sub(vInfo.z).div(vInfo.w));
      const alpha = vColor.a.mul(sprite).mul(soft);
      return vec4(vColor.rgb.mul(shade).mul(alpha), alpha.mul(float(1).sub(vShade.x)));
    })();

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'fx-particles';
    mesh.renderOrder = 10;
    return mesh;
  }
}

const scratchSize = new Vector2();
