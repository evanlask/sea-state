// eWave (Tessendorf 2014, "eWave: Using an Exponential Solver on the iWave Problem") on a periodic
// N×N grid: linear deep-water waves stepped *exactly* in Fourier space. Each update
//   1. FFTs h + iφ (surface height and surface velocity potential, both real),
//   2. rotates every mode (h̃, φ̃) by the exact solution of ∂h̃/∂t = |k|·φ̃, ∂φ̃/∂t = −g·h̃ over dt
//      (ω = √(g|k|), so every wavelength travels at its true phase speed — the Kelvin angle and
//      the wake's dispersion are right whatever the time step),
//   3. inverse FFTs back,
//   4. kicks φ by the surface pressure p/ρ (the boat's footprint): ∂φ/∂t = −g·h − p/ρ,
//   5. multiplies both fields by a sponge mask that absorbs waves near the borders (the grid is
//      periodic, so nothing may wrap around).
// The mean height is pinned to the hydrostatic −mean(p)/(ρg), so a boat at rest leaves h = −p/(ρg)
// exactly and h + p/(ρg) — the wake proper — is zero.
//
// Allocation-free after construction; two complex N² FFTs per step.

import { GRAVITY } from '../../core/units';
import { Fft2d } from '../fft';

export class EWave {
  readonly n: number;
  readonly cell: number; // m
  readonly dt: number; // s, fixed: the mode rotations are precomputed for it
  readonly height: Float64Array; // h, m (row z, column x at z·n + x)
  readonly potential: Float64Array; // φ at the surface, m²/s
  readonly sponge: Float64Array; // per-step multiplier, 1 inside, → 0 at the borders
  private readonly fft: Fft2d;
  private readonly z: Float64Array; // interleaved complex work buffer
  // Per mode: cos(ωdt), (|k|/ω)·sin(ωdt), (ω/|k|)·sin(ωdt), each already divided by N² (the
  // unnormalised inverse FFT).
  private readonly cosW: Float64Array;
  private readonly kOverW: Float64Array;
  private readonly wOverK: Float64Array;
  // Index of the mode −k for each k.
  private readonly mirror: Uint32Array;

  constructor(n: number, cell: number, dt: number, spongeWidth: number, spongeRate: number) {
    this.n = n;
    this.cell = cell;
    this.dt = dt;
    const n2 = n * n;
    this.height = new Float64Array(n2);
    this.potential = new Float64Array(n2);
    this.sponge = new Float64Array(n2);
    this.fft = new Fft2d(n);
    this.z = new Float64Array(2 * n2);
    this.cosW = new Float64Array(n2);
    this.kOverW = new Float64Array(n2);
    this.wOverK = new Float64Array(n2);
    this.mirror = new Uint32Array(n2);
    const inv = 1 / n2;
    const dk = (2 * Math.PI) / (n * cell);
    for (let r = 0; r < n; r++) {
      const kz = (r < n / 2 ? r : r - n) * dk;
      for (let c = 0; c < n; c++) {
        const kx = (c < n / 2 ? c : c - n) * dk;
        const i = r * n + c;
        this.mirror[i] = ((n - r) % n) * n + ((n - c) % n);
        const k = Math.hypot(kx, kz);
        if (k === 0) {
          // The mean is handled in space (pinned to the hydrostatic value).
          this.cosW[i] = 0;
          this.kOverW[i] = 0;
          this.wOverK[i] = 0;
          continue;
        }
        const w = Math.sqrt(GRAVITY * k);
        this.cosW[i] = Math.cos(w * dt) * inv;
        this.kOverW[i] = (k / w) * Math.sin(w * dt) * inv;
        this.wOverK[i] = (w / k) * Math.sin(w * dt) * inv;
      }
    }
    this.setSponge(spongeWidth, spongeRate);
  }

  // Quadratic absorbing ramp over `width` metres from each border, peaking at `rate` (1/s); the
  // outermost cell is zeroed outright so nothing can wrap. rate 0: fully periodic (tests).
  setSponge(width: number, rate: number): void {
    const n = this.n;
    if (rate <= 0) {
      this.sponge.fill(1);
      return;
    }
    const w = Math.max(width, this.cell);
    const edge = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = Math.min(i + 0.5, n - i - 0.5) * this.cell; // distance to the nearer border
      const t = Math.max(0, (w - d) / w);
      edge[i] = rate * t * t;
    }
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const border = r === 0 || c === 0 || r === n - 1 || c === n - 1;
        const sigma = (edge[r] as number) + (edge[c] as number);
        this.sponge[r * n + c] = border ? 0 : Math.exp(-sigma * this.dt);
      }
    }
  }

  clear(): void {
    this.height.fill(0);
    this.potential.fill(0);
  }

  // Free propagation over dt (steps 1–3).
  propagate(): void {
    const n2 = this.n * this.n;
    const z = this.z;
    const h = this.height;
    const phi = this.potential;
    for (let i = 0; i < n2; i++) {
      z[2 * i] = h[i] as number;
      z[2 * i + 1] = phi[i] as number;
    }
    this.fft.forward(z);
    const mirror = this.mirror;
    const cw = this.cosW;
    const kw = this.kOverW;
    const wk = this.wOverK;
    for (let i = 0; i < n2; i++) {
      const m = mirror[i] as number;
      if (m < i) continue; // each ±k pair once
      const a = z[2 * i] as number;
      const b = z[2 * i + 1] as number;
      const c = z[2 * m] as number;
      const d = z[2 * m + 1] as number;
      // Unpack the two real fields: H = (Z(k) + Z*(−k))/2, Φ = (Z(k) − Z*(−k))/2i.
      const hr = 0.5 * (a + c);
      const hi = 0.5 * (b - d);
      const pr = 0.5 * (b + d);
      const pi = 0.5 * (c - a);
      const C = cw[i] as number;
      const A = kw[i] as number;
      const B = wk[i] as number;
      const hr2 = C * hr + A * pr;
      const hi2 = C * hi + A * pi;
      const pr2 = C * pr - B * hr;
      const pi2 = C * pi - B * hi;
      // Repack: Z'(k) = H' + iΦ', Z'(−k) = conj(H') + i·conj(Φ').
      z[2 * i] = hr2 - pi2;
      z[2 * i + 1] = hi2 + pr2;
      if (m !== i) {
        z[2 * m] = hr2 + pi2;
        z[2 * m + 1] = pr2 - hi2;
      }
    }
    this.fft.inverse(z);
    for (let i = 0; i < n2; i++) {
      h[i] = z[2 * i] as number;
      phi[i] = z[2 * i + 1] as number;
    }
  }

  // Steps 4–5: φ −= dt·p/ρ, the mean height pinned to −mean(p)/(ρg), then the sponge.
  // pressure: p/ρ per cell (m²/s²), or null for none.
  force(pressure: Float64Array | null): void {
    const n2 = this.n * this.n;
    const h = this.height;
    const phi = this.potential;
    const s = this.sponge;
    const dt = this.dt;
    let mean = 0;
    if (pressure) {
      for (let i = 0; i < n2; i++) mean += pressure[i] as number;
      mean /= n2;
      for (let i = 0; i < n2; i++) phi[i] = (phi[i] as number) - dt * (pressure[i] as number);
    }
    // The k = 0 mode was dropped by propagate(); restore the hydrostatic mean.
    const level = -mean / GRAVITY;
    for (let i = 0; i < n2; i++) {
      const k = s[i] as number;
      h[i] = ((h[i] as number) + level) * k;
      phi[i] = (phi[i] as number) * k;
    }
  }

  // Shifts both fields by whole cells (the grid followed its boat): new(i) = old(i + d); the
  // exposed strips start calm.
  scroll(dCol: number, dRow: number): void {
    if (dCol === 0 && dRow === 0) return;
    this.shift(this.height, dCol, dRow);
    this.shift(this.potential, dCol, dRow);
  }

  private shift(field: Float64Array, dCol: number, dRow: number): void {
    const n = this.n;
    const z = this.z; // scratch
    z.set(field);
    for (let r = 0; r < n; r++) {
      const sr = r + dRow;
      for (let c = 0; c < n; c++) {
        const sc = c + dCol;
        field[r * n + c] = sr >= 0 && sr < n && sc >= 0 && sc < n ? (z[sr * n + sc] as number) : 0;
      }
    }
  }

  // Potential energy per unit density, ∫ g·h²/2 dA (m⁵/s²); the kinetic half needs a transform.
  potentialEnergy(): number {
    let e = 0;
    const h = this.height;
    for (let i = 0; i < h.length; i++) e += (h[i] as number) * (h[i] as number);
    return 0.5 * GRAVITY * e * this.cell * this.cell;
  }
}
