// Water interface for hull physics, plus simple analytic seas for tests and
// tools. The FFT ocean (sim/ocean) implements WaterSampler for real play.

import { GRAVITY } from '../core/units';

// One water query at a 3D point. Everything is world frame (SI).
export interface WaterSample {
  // Free-surface elevation directly above/below the query's (x, z).
  height: number;
  // Unit surface normal at that surface point.
  normalX: number;
  normalY: number;
  normalZ: number;
  // Orbital water velocity AT THE QUERY POINT, depth-attenuated per cascade by
  // e^{k_c·min(y − η, 0)} (Wheeler-stretched so the surface value is unattenuated).
  velocityX: number;
  velocityY: number;
  velocityZ: number;
  // Pressure head (p − p_atm)/(ρg) at the query point, metres: below the surface
  // −y + Σ_c η_c·e^{k_c·(y − η)}, above it η − y. Zero on the surface, > 0 under water.
  // Hull clipping and Froude-Krylov forces use this, so short waves (large k_c) stop
  // over-driving deep hulls.
  pressureHead: number;
  // det(I + ∂D/∂x0) of the (choppy) surface above the point: 1 when flat,
  // below ~0.3 where a crest is folding over (breaking).
  jacobian: number;
  // At the surface above the point, for the waves at least 25 m long: their linear local steepness
  // Σ a·k·cos θ (a single wave's crest reads a·k) and horizontal orbital velocity, m/s. Breaking crests
  // are where the steepness is high (BreakingWaves, physics/flooding.ts).
  steepness: number;
  crestVelocityX: number;
  crestVelocityZ: number;
}

export interface WaterSampler {
  sample(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample;
  // Optional fast path for per-vertex hull loops: fills height, pressureHead and velocity (the same
  // values sample() gives) and may leave the other fields stale.
  sampleHead?(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample;
}

export const waterSample = (): WaterSample => ({
  height: 0,
  normalX: 0,
  normalY: 1,
  normalZ: 0,
  velocityX: 0,
  velocityY: 0,
  velocityZ: 0,
  pressureHead: 0,
  jacobian: 1,
  steepness: 0,
  crestVelocityX: 0,
  crestVelocityZ: 0,
});

// Calm water at a fixed level.
export class FlatWater implements WaterSampler {
  level: number;

  constructor(level = 0) {
    this.level = level;
  }

  sample(_x: number, y: number, _z: number, _time: number, out: WaterSample): WaterSample {
    out.height = this.level;
    out.normalX = 0;
    out.normalY = 1;
    out.normalZ = 0;
    out.velocityX = 0;
    out.velocityY = 0;
    out.velocityZ = 0;
    out.pressureHead = this.level - y;
    out.jacobian = 1;
    out.steepness = 0;
    out.crestVelocityX = 0;
    out.crestVelocityZ = 0;
    return out;
  }
}

export const flatWater: WaterSampler = new FlatWater(0);

export interface WaveParams {
  amplitude: number; // m
  wavelength: number; // m
  // Unit horizontal direction the wave travels toward (world x, z).
  directionX: number;
  directionZ: number;
  phase?: number; // rad
}

// Deep-water linear (Airy) wave. Pressure and orbital velocity decay as
// e^{k·(y − η)} below the surface (Wheeler stretching, so the head is exactly
// zero on the free surface).
export class AiryWave implements WaterSampler {
  readonly amplitude: number;
  readonly k: number;
  readonly omega: number;
  readonly dx: number;
  readonly dz: number;
  readonly phase: number;

  constructor(params: WaveParams) {
    const length = Math.hypot(params.directionX, params.directionZ) || 1;
    this.amplitude = params.amplitude;
    this.k = (2 * Math.PI) / params.wavelength;
    this.omega = Math.sqrt(GRAVITY * this.k);
    this.dx = params.directionX / length;
    this.dz = params.directionZ / length;
    this.phase = params.phase ?? 0;
  }

  sample(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample {
    const theta = this.k * (this.dx * x + this.dz * z) - this.omega * time + this.phase;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const a = this.amplitude;
    const eta = a * cos;
    const slope = -a * this.k * sin; // dη/ds along the travel direction
    const nx = -slope * this.dx;
    const nz = -slope * this.dz;
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    const decay = Math.exp(this.k * Math.min(y - eta, 0));
    const horizontal = a * this.omega * decay * cos;
    out.height = eta;
    out.normalX = nx * inv;
    out.normalY = inv;
    out.normalZ = nz * inv;
    out.velocityX = horizontal * this.dx;
    out.velocityY = a * this.omega * decay * sin;
    out.velocityZ = horizontal * this.dz;
    out.pressureHead = y < eta ? -y + eta * decay : eta - y;
    // As if the same wave were choppy (Gerstner), so steep crests read as breaking.
    out.jacobian = 1 - this.k * a * cos;
    out.steepness = this.k * a * cos;
    out.crestVelocityX = a * this.omega * cos * this.dx;
    out.crestVelocityZ = a * this.omega * cos * this.dz;
    return out;
  }
}

// Single deep-water Gerstner (trochoidal) wave: sharp crests, steep faces, for
// stress tests. Height at (x, z) is found by fixed-point inversion of the
// horizontal displacement (converges for k·a < 1).
export class GerstnerWave implements WaterSampler {
  readonly amplitude: number;
  readonly k: number;
  readonly omega: number;
  readonly dx: number;
  readonly dz: number;
  readonly phase: number;

  constructor(params: WaveParams) {
    const length = Math.hypot(params.directionX, params.directionZ) || 1;
    this.amplitude = params.amplitude;
    this.k = (2 * Math.PI) / params.wavelength;
    this.omega = Math.sqrt(GRAVITY * this.k);
    this.dx = params.directionX / length;
    this.dz = params.directionZ / length;
    this.phase = params.phase ?? 0;
    if (this.k * this.amplitude >= 1) throw new Error('Gerstner wave too steep (k·a must be < 1)');
  }

  sample(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample {
    const a = this.amplitude;
    const k = this.k;
    const s = this.dx * x + this.dz * z;
    const base = -this.omega * time + this.phase;
    // Surface particle whose displaced position lands on s: s = s0 − a·sin(k·s0 + base).
    let s0 = s;
    for (let i = 0; i < 8; i++) s0 = s + a * Math.sin(k * s0 + base);
    const theta = k * s0 + base;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const eta = a * cos;
    // Tangent along s: (1 − ka·cos θ, −ka·sin θ) → normal (ka·sin θ, 1 − ka·cos θ).
    const ns = k * a * sin;
    const ny = 1 - k * a * cos;
    const inv = 1 / Math.hypot(ns, ny);
    const decay = Math.exp(k * Math.min(y - eta, 0));
    const horizontal = a * this.omega * decay * cos;
    out.height = eta;
    out.normalX = ns * this.dx * inv;
    out.normalY = ny * inv;
    out.normalZ = ns * this.dz * inv;
    out.velocityX = horizontal * this.dx;
    out.velocityY = a * this.omega * decay * sin;
    out.velocityZ = horizontal * this.dz;
    out.pressureHead = y < eta ? -y + eta * decay : eta - y;
    out.jacobian = ny;
    out.steepness = k * a * cos;
    out.crestVelocityX = a * this.omega * cos * this.dx;
    out.crestVelocityZ = a * this.omega * cos * this.dz;
    return out;
  }
}
