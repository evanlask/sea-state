// CPU side of particle emission: spawn requests are packed each frame into a
// small Float32Array that is uploaded to a storage buffer, plus a prefix table
// (first particle index of each request) so every GPU thread can find its
// request with a short binary search. No GPU state is read back.

export const PARTICLE_KIND = {
  droplet: 0, // spray clumps: heavy, streaky, die on the water
  mist: 1, // fine spray / spume sheets: follow the wind, grow, fade
  foam: 2, // white water churn: rides the surface
  splash: 3, // tiny rain crowns: very short-lived droplets
  smoke: 4, // engine exhaust: buoyant, follows the air, spreads and thins
} as const;

type ParticleKind = keyof typeof PARTICLE_KIND;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface SpawnRequest {
  kind: ParticleKind;
  count: number;
  position: Vec3Like;
  positionRadius?: number; // random offset inside a sphere, m
  positionLine?: Vec3Like; // half-extent of a segment the spawn spreads along, m
  velocity: Vec3Like; // mean, m/s (relative to carrier)
  velocitySpread?: number; // random offset inside a sphere, m/s
  speedVariation?: number; // 0..1: speed scaled by 1 − variation·random, filling a sheet from the source out
  // Added to every particle's velocity after the fan and speed variation: the velocity of the hull
  // that throws the spray, so slow parts of a sheet still move with it rather than falling back
  // into it. Default 0.
  carrier?: Vec3Like;
  fanAxis?: Vec3Like; // velocity is rotated about this unit axis by up to ±fanAngle
  fanAngle?: number; // radians
  size: readonly [number, number]; // visual radius range, m
  // Exponent of the power-law size spread (n(r) ∝ r^−sizeSkew, sprayMath): 0 uniform; omitted = the
  // kind's (fine droplets are mostly small, sheets and puffs aren't).
  sizeSkew?: number;
  life: readonly [number, number]; // seconds
  // Quadratic air drag g/vt² (1/m), vt = terminal speed; omitted = the kind's default.
  // Smoke: the source radius (m) instead, which sets how fast each puff spreads and thins.
  drag?: number;
  tone?: number; // 0..1, smoke: soot (light haze … dark brown-grey); default 0
}

// vec4s per packed request:
//   0 position.xyz, positionRadius
//   1 velocity.xyz, velocitySpread
//   2 line.xyz, fanAngle
//   3 fanAxis.xyz, kind
//   4 sizeMin, sizeMax, lifeMin, lifeMax
//   5 drag (−1 = kind default), seed, speedVariation, tone
//   6 carrier.xyz, sizeSkew (−1 = kind default)
export const REQUEST_VEC4S = 7;
export const REQUEST_FLOATS = REQUEST_VEC4S * 4;

const SEED_RANGE = 1 << 24; // integers stay exact in float32

export class EmissionQueue {
  readonly maxRequests: number;
  readonly maxParticles: number; // per frame
  readonly data: Float32Array;
  readonly starts: Uint32Array;
  private requests = 0;
  private particles = 0;
  private seedCounter = 0;

  constructor(maxRequests: number, maxParticlesPerFrame: number) {
    this.maxRequests = maxRequests;
    this.maxParticles = maxParticlesPerFrame;
    this.data = new Float32Array(maxRequests * REQUEST_FLOATS);
    this.starts = new Uint32Array(maxRequests);
  }

  get requestCount(): number {
    return this.requests;
  }

  // Particles queued this frame (the emit dispatch size).
  get total(): number {
    return this.particles;
  }

  // Queues a request; the count is clipped to what is left of the frame budget.
  // Returns the number of particles actually queued.
  push(request: SpawnRequest): number {
    const count = Math.min(Math.floor(request.count), this.maxParticles - this.particles);
    // (`!(count > 0)`, not `count <= 0`: a NaN count would otherwise turn the frame's total into NaN.)
    if (!(count > 0) || this.requests >= this.maxRequests) return 0;
    const index = this.requests;
    const o = index * REQUEST_FLOATS;
    const d = this.data;
    const { position: p, velocity: v } = request;
    const line = request.positionLine;
    const axis = request.fanAxis;
    d[o] = p.x;
    d[o + 1] = p.y;
    d[o + 2] = p.z;
    d[o + 3] = request.positionRadius ?? 0;
    d[o + 4] = v.x;
    d[o + 5] = v.y;
    d[o + 6] = v.z;
    d[o + 7] = request.velocitySpread ?? 0;
    d[o + 8] = line?.x ?? 0;
    d[o + 9] = line?.y ?? 0;
    d[o + 10] = line?.z ?? 0;
    d[o + 11] = axis ? (request.fanAngle ?? 0) : 0;
    d[o + 12] = axis?.x ?? 0;
    d[o + 13] = axis?.y ?? 1;
    d[o + 14] = axis?.z ?? 0;
    d[o + 15] = PARTICLE_KIND[request.kind];
    d[o + 16] = request.size[0];
    d[o + 17] = request.size[1];
    d[o + 18] = request.life[0];
    d[o + 19] = request.life[1];
    d[o + 20] = request.drag ?? -1;
    d[o + 21] = this.seedCounter;
    d[o + 22] = request.speedVariation ?? 0;
    d[o + 23] = request.tone ?? 0;
    const carrier = request.carrier;
    d[o + 24] = carrier?.x ?? 0;
    d[o + 25] = carrier?.y ?? 0;
    d[o + 26] = carrier?.z ?? 0;
    d[o + 27] = request.sizeSkew ?? -1;
    this.seedCounter = (this.seedCounter + 1) % SEED_RANGE;
    this.starts[index] = this.particles;
    this.requests++;
    this.particles += count;
    return count;
  }

  clear(): void {
    this.requests = 0;
    this.particles = 0;
  }
}

// Index of the request that owns particle `thread`: the last request whose start
// is ≤ thread. Mirrors the shader's fixed-iteration binary search.
export function findRequest(starts: ArrayLike<number>, requestCount: number, thread: number): number {
  let lo = 0;
  let hi = requestCount;
  const steps = Math.ceil(Math.log2(Math.max(2, starts.length)));
  for (let i = 0; i < steps; i++) {
    if (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if ((starts[mid] ?? Infinity) <= thread) lo = mid;
      else hi = mid;
    }
  }
  return lo;
}
