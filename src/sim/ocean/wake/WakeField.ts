// Per-boat coarse wakes: one eWave grid per boat, centred a little astern of it and scrolled by
// whole cells as it moves, driven by the boat's moving pressure footprint, plus the summed field
// every other boat's hull samples (sim/ocean/wake/WakeSurface.ts).
//
// Each grid publishes the wake proper, η_w = h + p/(ρg): the free-surface height minus the static
// depression under the hull, so a boat at rest leaves no wake and the rendered water meets its hull
// at the waterline. Samples at time t are taken from the latest update (t_w ≤ t + one step),
// translated with the boat's velocity by t − t_w — a steady wake is fixed in the boat's frame.

import { GRAVITY, RHO_SEAWATER } from '../../core/units';
import { EWave } from './EWave';

export const WAKE_STEP = 1 / 30; // s between wake updates (the world runs them every 4th master step)
export const WAKE_RESOLUTION = 128;

export interface WakeGridConfig {
  n: number; // cells per side (power of two)
  cell: number; // m
  designSpeed: number; // m/s, sizes the sponge (one wake wavelength 2πV²/g where it fits)
}

// What a boat's footprint looks like at one update.
export interface WakeSource {
  x: number; // body origin, world m
  z: number;
  forwardX: number; // unit bow direction on the horizontal
  forwardZ: number;
  vx: number; // m/s
  vz: number;
  load: number; // N: vertical water force the footprint carries (≈ weight afloat, 0 airborne)
  length: number; // wetted footprint length and beam, m
  beam: number;
  offset: number; // footprint centre ahead (+) of the body origin, m
}

export const wakeSource = (): WakeSource => ({
  x: 0,
  z: 0,
  forwardX: 0,
  forwardZ: -1,
  vx: 0,
  vz: 0,
  load: 0,
  length: 1,
  beam: 1,
  offset: 0,
});

export interface WakeSample {
  height: number; // m
  slopeX: number; // ∂η/∂x
  slopeZ: number;
  velocityY: number; // ∂η/∂t, m/s
  pressure: number; // depth-attenuated height (pressure head), m
  count: number; // grids that contributed
}

export const wakeSample = (): WakeSample => ({
  height: 0,
  slopeX: 0,
  slopeZ: 0,
  velocityY: 0,
  pressure: 0,
  count: 0,
});

// Below this wake amplitude a grid is treated as calm (skipped by samplers, not stepped when idle).
const CALM = 2e-4; // m
const IDLE_SPEED = 0.25; // m/s
const EDGE_FADE = 4; // cells of fade-in from each border when sampling
const LOAD_RAMP = 4; // s

export class BoatWake {
  readonly config: WakeGridConfig;
  readonly wave: EWave;
  readonly n: number;
  readonly cell: number;
  originCol = 0; // integer cell index of texel (0, 0); its centre is at ((originCol + 0.5)·cell, …)
  originRow = 0;
  readonly pressure: Float64Array; // p/ρ, m²/s²
  readonly surface: Float32Array; // η_w, m
  readonly vertical: Float32Array; // ∂η_w/∂t, m/s
  readonly slopeX: Float32Array;
  readonly slopeZ: Float32Array;
  time = Number.NEGATIVE_INFINITY; // when the published fields were valid
  vx = 0; // source velocity then (sampling translates by it)
  vz = 0;
  peak = 0; // max |η_w|
  cpuUs = 0; // smoothed µs per update
  updated = false; // since the last publication
  enabled = true; // false: far from the player (LOD), contributes nothing
  // Depth decay of the wake's pressure and orbital motion, e^{−k·depth} at the design wavelength.
  readonly decayK: number;
  private placed = false;
  private pressurePeak = 0; // max p/ρ of the current footprint
  private age = 0; // s since placement: the load ramps in (no Cauchy–Poisson ring at spawn)
  private headingX = 0;
  private headingZ = -1;
  // Pressure bounding box of the last update (cleared before the next raster).
  private boxC0 = 0;
  private boxC1 = -1;
  private boxR0 = 0;
  private boxR1 = -1;

  constructor(config: WakeGridConfig) {
    this.config = config;
    const n = config.n;
    this.n = n;
    this.cell = config.cell;
    const extent = n * config.cell;
    const v = Math.max(1, config.designSpeed);
    const lambda = (2 * Math.PI * v * v) / GRAVITY;
    // At least one wake wavelength, but planing craft make waves longer than their grid holds.
    const width = Math.min(Math.max(lambda, 6 * config.cell), 0.3 * extent);
    const groupSpeed = 0.5 * Math.sqrt((GRAVITY * width) / (2 * Math.PI));
    this.wave = new EWave(n, config.cell, WAKE_STEP, width, (18 * groupSpeed) / width);
    this.decayK = (2 * Math.PI) / Math.max(width, lambda);
    const n2 = n * n;
    this.pressure = new Float64Array(n2);
    this.surface = new Float32Array(n2);
    this.vertical = new Float32Array(n2);
    this.slopeX = new Float32Array(n2);
    this.slopeZ = new Float32Array(n2);
  }

  get extent(): number {
    return this.n * this.cell;
  }

  // World x/z of the grid's (0, 0) corner.
  get minX(): number {
    return this.originCol * this.cell;
  }

  get minZ(): number {
    return this.originRow * this.cell;
  }

  reset(): void {
    this.wave.clear();
    this.pressure.fill(0);
    this.surface.fill(0);
    this.vertical.fill(0);
    this.slopeX.fill(0);
    this.slopeZ.fill(0);
    this.boxC1 = this.boxR1 = -1;
    this.peak = 0;
    this.placed = false;
  }

  // A boat at rest in a calm grid has nothing to step.
  idle(source: WakeSource): boolean {
    return this.placed && this.peak < CALM && Math.hypot(source.vx, source.vz) < IDLE_SPEED;
  }

  // One WAKE_STEP: follow the boat, propagate, apply its footprint, publish η_w at `time`.
  update(source: WakeSource, time: number): void {
    // A non-finite source (a boat that blew up) would put NaN into the spectral solver, where it
    // stays: every boat sampling this wake would then read NaN. Start the grid over instead.
    if (
      !Number.isFinite(
        source.x + source.z + source.vx + source.vz + source.forwardX + source.forwardZ + source.load,
      ) ||
      !Number.isFinite(source.length + source.beam + source.offset)
    ) {
      this.reset();
      this.updated = true;
      return;
    }
    const started = performance.now();
    this.follow(source);
    this.wave.propagate();
    this.rasterize(source);
    this.wave.force(this.pressure);
    this.publish(time, source);
    const us = (performance.now() - started) * 1000;
    this.cpuUs += (us - this.cpuUs) * (this.cpuUs === 0 ? 1 : 0.05);
  }

  // Grid centre: a quarter of the extent astern of the boat, where its wake is.
  private follow(source: WakeSource): void {
    const speed = Math.hypot(source.vx, source.vz);
    if (speed > 0.5) {
      this.headingX = source.vx / speed;
      this.headingZ = source.vz / speed;
    } else if (!this.placed) {
      this.headingX = source.forwardX;
      this.headingZ = source.forwardZ;
    }
    const aft = 0.25 * this.extent * Math.min(1, speed / Math.max(1, 0.5 * this.config.designSpeed));
    const cx = source.x - this.headingX * aft;
    const cz = source.z - this.headingZ * aft;
    const col = Math.round(cx / this.cell - this.n / 2);
    const row = Math.round(cz / this.cell - this.n / 2);
    const dCol = col - this.originCol;
    const dRow = row - this.originRow;
    if (!this.placed || Math.abs(dCol) >= this.n || Math.abs(dRow) >= this.n) {
      // First placement, or a jump (respawn): start calm.
      this.age = 0;
      this.wave.clear();
      this.surface.fill(0);
      this.boxC1 = this.boxR1 = -1;
      this.pressure.fill(0);
    } else if (dCol !== 0 || dRow !== 0) {
      this.wave.scroll(dCol, dRow);
      shiftField(this.surface, this.n, dCol, dRow);
      // The pressure box is re-rasterised anyway; drop it in the old frame.
      this.clearBox();
    }
    this.originCol = col;
    this.originRow = row;
    this.placed = true;
  }

  private clearBox(): void {
    this.pressurePeak = 0;
    const n = this.n;
    const p = this.pressure;
    for (let r = this.boxR0; r <= this.boxR1; r++) {
      for (let c = this.boxC0; c <= this.boxC1; c++) p[r * n + c] = 0;
    }
    this.boxC1 = this.boxR1 = -1;
  }

  // Footprint p/ρ = (load/ρ)·f/∫f, f = (1 − u²)²(1 − v²) over the wetted length × beam (smooth
  // enough for coarse cells, full enough for honest bow and stern waves); supersampled 2×2 and at
  // least ~3 cells long, 2.5 wide.
  private rasterize(s: WakeSource): void {
    this.clearBox();
    this.age += WAKE_STEP;
    const ramp = Math.min(1, this.age / LOAD_RAMP);
    const load = s.load * ramp * ramp * (3 - 2 * ramp);
    if (load <= 0) return;
    const n = this.n;
    const cell = this.cell;
    const halfL = 0.5 * Math.max(s.length, 3 * cell);
    const halfB = 0.5 * Math.max(s.beam, 2.5 * cell);
    const fx = s.forwardX;
    const fz = s.forwardZ;
    const cx = s.x + fx * s.offset;
    const cz = s.z + fz * s.offset;
    const ex = Math.abs(fx) * halfL + Math.abs(fz) * halfB;
    const ez = Math.abs(fz) * halfL + Math.abs(fx) * halfB;
    const c0 = Math.max(1, Math.floor((cx - ex) / cell) - this.originCol);
    const c1 = Math.min(n - 2, Math.ceil((cx + ex) / cell) - this.originCol);
    const r0 = Math.max(1, Math.floor((cz - ez) / cell) - this.originRow);
    const r1 = Math.min(n - 2, Math.ceil((cz + ez) / cell) - this.originRow);
    if (c0 > c1 || r0 > r1) return;
    const p = this.pressure;
    let total = 0;
    let top = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let f = 0;
        for (let sy = 0; sy < 2; sy++) {
          const z = (this.originRow + r + 0.25 + 0.5 * sy) * cell - cz;
          for (let sx = 0; sx < 2; sx++) {
            const x = (this.originCol + c + 0.25 + 0.5 * sx) * cell - cx;
            const u = (x * fx + z * fz) / halfL;
            const v = (x * -fz + z * fx) / halfB;
            const u2 = u * u;
            const v2 = v * v;
            if (u2 < 1 && v2 < 1) f += (1 - u2) * (1 - u2) * (1 - v2);
          }
        }
        p[r * n + c] = f;
        total += f;
        if (f > top) top = f;
      }
    }
    this.boxC0 = c0;
    this.boxC1 = c1;
    this.boxR0 = r0;
    this.boxR1 = r1;
    if (total <= 0) return;
    const scale = load / RHO_SEAWATER / (total * cell * cell);
    this.pressurePeak = top * scale;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) p[r * n + c] = (p[r * n + c] as number) * scale;
    }
  }

  private publish(time: number, source: WakeSource): void {
    const n = this.n;
    const h = this.wave.height;
    const p = this.pressure;
    const out = this.surface;
    const w = this.vertical;
    const dt = this.time > Number.NEGATIVE_INFINITY ? Math.max(1e-3, time - this.time) : WAKE_STEP;
    const invG = 1 / GRAVITY;
    // Under the hull itself η_w is meaningless (the hull is there; at speed the water has not
    // sunk to the static draft, so η_w → +draft); fade it out across the footprint.
    const invPeak = this.pressurePeak > 0 ? 1 / this.pressurePeak : 0;
    let peak = 0;
    for (let i = 0; i < n * n; i++) {
      const pi = p[i] as number;
      const eta = ((h[i] as number) + pi * invG) * (1 - pi * invPeak);
      w[i] = (eta - (out[i] as number)) / dt;
      out[i] = eta;
      const a = eta < 0 ? -eta : eta;
      if (a > peak) peak = a;
    }
    const inv2 = 0.5 / this.cell;
    const sx = this.slopeX;
    const sz = this.slopeZ;
    for (let r = 0; r < n; r++) {
      const up = r > 0 ? r - 1 : r;
      const down = r < n - 1 ? r + 1 : r;
      for (let c = 0; c < n; c++) {
        const left = c > 0 ? c - 1 : c;
        const right = c < n - 1 ? c + 1 : c;
        const i = r * n + c;
        sx[i] = ((out[r * n + right] as number) - (out[r * n + left] as number)) * inv2;
        sz[i] = ((out[down * n + c] as number) - (out[up * n + c] as number)) * inv2;
      }
    }
    this.peak = peak;
    this.time = time;
    this.vx = source.vx;
    this.vz = source.vz;
    this.updated = true;
  }

  // Adds this grid's wake at world (x, z) and time to `out` (depth ≥ 0 attenuates the pressure and
  // vertical velocity). Returns false where the grid has nothing.
  addTo(x: number, z: number, time: number, depth: number, out: WakeSample): boolean {
    if (!this.enabled || this.peak < CALM) return false;
    let lag = time - this.time;
    lag = lag < -0.2 ? -0.2 : lag > 0.2 ? 0.2 : lag;
    const n = this.n;
    const u = (x - this.vx * lag) / this.cell - this.originCol - 0.5;
    const v = (z - this.vz * lag) / this.cell - this.originRow - 0.5;
    if (!(u >= 0 && v >= 0 && u < n - 1 && v < n - 1)) return false;
    const c = Math.floor(u);
    const r = Math.floor(v);
    const fu = u - c;
    const fv = v - r;
    const edge = Math.min(u, v, n - 1 - u, n - 1 - v) / EDGE_FADE;
    const fade = edge >= 1 ? 1 : edge * edge * (3 - 2 * edge);
    const i = r * n + c;
    const w00 = (1 - fu) * (1 - fv) * fade;
    const w10 = fu * (1 - fv) * fade;
    const w01 = (1 - fu) * fv * fade;
    const w11 = fu * fv * fade;
    const height = bilerp(this.surface, i, n, w00, w10, w01, w11);
    const decay = depth > 0 ? Math.exp(-this.decayK * depth) : 1;
    out.height += height;
    out.pressure += height * decay;
    out.slopeX += bilerp(this.slopeX, i, n, w00, w10, w01, w11);
    out.slopeZ += bilerp(this.slopeZ, i, n, w00, w10, w01, w11);
    out.velocityY += bilerp(this.vertical, i, n, w00, w10, w01, w11) * decay;
    out.count++;
    return true;
  }
}

function bilerp(
  f: Float32Array,
  i: number,
  n: number,
  w00: number,
  w10: number,
  w01: number,
  w11: number,
): number {
  const j = i + n;
  return (
    w00 * (f[i] as number) + w10 * (f[i + 1] as number) + w01 * (f[j] as number) + w11 * (f[j + 1] as number)
  );
}

// new(i) = old(i + d) on an n×n Float32 field, zeros where exposed (in place, row order chosen so
// sources are read before they are overwritten).
function shiftField(f: Float32Array, n: number, dCol: number, dRow: number): void {
  const rowStep = dRow > 0 ? 1 : -1;
  const colStep = dCol > 0 ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const r = rowStep > 0 ? k : n - 1 - k;
    const sr = r + dRow;
    for (let m = 0; m < n; m++) {
      const c = colStep > 0 ? m : n - 1 - m;
      const sc = c + dCol;
      f[r * n + c] = sr >= 0 && sr < n && sc >= 0 && sc < n ? (f[sr * n + sc] as number) : 0;
    }
  }
}

// All boats' wakes. Boat j samples Σ over i ≠ j. Grids come and go with the fleet.
export class WakeField {
  readonly wakes: BoatWake[];

  constructor(configs: readonly WakeGridConfig[] = []) {
    this.wakes = configs.map((config) => new BoatWake(config));
  }

  add(config: WakeGridConfig): BoatWake {
    const wake = new BoatWake(config);
    this.wakes.push(wake);
    return wake;
  }

  remove(wake: BoatWake): void {
    const index = this.wakes.indexOf(wake);
    if (index >= 0) this.wakes.splice(index, 1);
  }

  // Sum of every grid but `exclude` (a boat's own) at (x, z, time); depth (m, ≥ 0) attenuates
  // pressure and w.
  sample(
    x: number,
    z: number,
    time: number,
    exclude: BoatWake | null,
    depth: number,
    out: WakeSample,
  ): WakeSample {
    out.height = out.slopeX = out.slopeZ = out.velocityY = out.pressure = 0;
    out.count = 0;
    const wakes = this.wakes;
    for (let i = 0; i < wakes.length; i++) {
      const wake = wakes[i] as BoatWake;
      if (wake !== exclude) wake.addTo(x, z, time, depth, out);
    }
    return out;
  }
}
