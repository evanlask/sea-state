// CPU copy of the physics cascades. Evolves h(k, t) and synthesizes displacement fields with inverse
// FFTs on a fixed 60 Hz sample grid, keeping the two samples that bracket the query time.
//
// Conventions shared with the GPU:
//   h(k, t) = h0(k) e^{−iωt} + conj(h0(−k)) e^{+iωt},  ω = quantizedDispersion(|k|), t reduced mod T_REPEAT
//   η(x)    = Σ_k h(k) e^{+ik·x}  (unnormalized inverse FFT; sample (i, j) is x = iL/N, z = jL/N)
//   D(k)    = i·λ·(k/|k|)·h(k),   a surface particle at rest position x0 sits at x0 + D(x0)
// With this sign a mode h0(k) travels along +k, and D pulls particles toward crests (Gerstner):
// a single mode η = A cos(k·x − ωt) gives D = −λ·k̂·A sin(k·x − ωt).
// (Tessendorf writes e^{+iωt} and D = −i k̂ h; that pairing sends waves along −k and, with x0 + λD,
// sharpens troughs instead of crests.)
// Physics queries sample these grids bilinearly; the GPU matches by sampling the physics cascade
// textures with plain bilinear filtering at UV = (x0 + offset)/L + 0.5/N (texel centres).

import { type CascadeConfig, modeWaveNumber, signedMode } from './cascades';
import { Fft2d } from './fft';
import { blendH0, type CascadeSpectrum, transitionBlend } from './h0';
import { OMEGA_0, quantizedDispersion, T_REPEAT } from './spectrum';

const OCEAN_UPDATE_RATE = 60; // Hz
export const OCEAN_UPDATE_INTERVAL = 1 / OCEAN_UPDATE_RATE;
const PHASE_FINE = 256; // fine phase table size (see CpuOcean.fineCos)

// Per texel and time slot: displacement, height gradient and the horizontal displacement Jacobian.
export const CH_DX = 0;
export const CH_DY = 1;
export const CH_DZ = 2;
export const CH_DY_X = 3; // ∂Dy/∂x0
export const CH_DY_Z = 4; // ∂Dy/∂z0
export const CH_DX_X = 5; // ∂Dx/∂x0
export const CH_DX_Z = 6; // ∂Dx/∂z0 (= ∂Dz/∂x0: D is a gradient field)
export const CH_DZ_Z = 7; // ∂Dz/∂z0
export const FIELD_CHANNELS = 8;
export const TEXEL_STRIDE = 2 * FIELD_CHANNELS; // both time slots of a texel are adjacent

export class CpuCascade {
  readonly config: CascadeConfig;
  readonly n: number;
  readonly size: number;
  // Two time slots interleaved per texel: [slot 0: 8 channels][slot 1: 8 channels].
  readonly field: Float32Array;
  readonly from: Float32Array; // h0 the current transition starts from
  readonly to: Float32Array; // h0 it ends at
  chopFrom = 0;
  chopTo = 0;
  kFrom = 0;
  kTo = 0;
  readonly active: Uint32Array;
  readonly omega: Float64Array;
  readonly omegaSteps: Int32Array; // ω / OMEGA_0 (quantizedDispersion makes it a whole number)
  readonly kxHat: Float64Array;
  readonly kzHat: Float64Array;

  constructor(config: CascadeConfig) {
    this.config = config;
    this.n = config.resolution;
    this.size = config.size;
    const n = this.n;
    this.field = new Float32Array(n * n * TEXEL_STRIDE);
    this.from = new Float32Array(n * n * 4);
    this.to = new Float32Array(n * n * 4);
    const active: number[] = [];
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const k = modeWaveNumber(config, signedMode(col, n), signedMode(row, n));
        if (k >= config.kMin && k < config.kMax) active.push(row * n + col);
      }
    }
    this.active = Uint32Array.from(active);
    this.omega = new Float64Array(active.length);
    this.omegaSteps = new Int32Array(active.length);
    this.kxHat = new Float64Array(active.length);
    this.kzHat = new Float64Array(active.length);
    for (let i = 0; i < active.length; i++) {
      const texel = active[i] as number;
      const m = signedMode(texel % n, n);
      const nz = signedMode(Math.floor(texel / n), n);
      const k = modeWaveNumber(config, m, nz);
      this.omega[i] = quantizedDispersion(k);
      this.omegaSteps[i] = Math.round(this.omega[i] / OMEGA_0);
      this.kxHat[i] = m / Math.hypot(m, nz);
      this.kzHat[i] = nz / Math.hypot(m, nz);
    }
  }
}

interface ResolutionWorkspace {
  fft: Fft2d;
  a0: Float64Array; // Dy + i·Dx of the first cascade of a pair
  a1: Float64Array; // Dy + i·Dx of the second
  b: Float64Array; // Dz(first) + i·Dz(second)
  dx: Float64Array;
  dy: Float64Array;
  dz: Float64Array;
}

export class CpuOcean {
  readonly cascades: CpuCascade[];
  readonly interval: number;
  private readonly pairs: [number, number][] = []; // cascade indices sharing one Dz FFT; −1 = none
  private readonly workspaces = new Map<number, ResolutionWorkspace>();
  private readonly slotSample = [Number.NaN, Number.NaN]; // sample index held by each slot
  private readonly samplesPerRepeat: number; // 0 when T_REPEAT is not a whole number of samples
  // e^{2πi·m/R} (R = samplesPerRepeat) as fine[m mod PHASE_FINE]·coarse[m / PHASE_FINE]: with every ω
  // a whole multiple of OMEGA_0 = 2π/T_REPEAT, the phase of mode ω = q·OMEGA_0 at sample j is
  // 2π·(q·j mod R)/R, so two small tables and one complex product replace a cos and a sin per mode.
  private readonly fineCos: Float64Array;
  private readonly fineSin: Float64Array;
  private readonly coarseCos: Float64Array;
  private readonly coarseSin: Float64Array;
  private transitionStart = -Infinity;
  private transitionDuration = 0;
  private hasSpectrum = false;
  updateCount = 0; // samples computed so far
  spectraVersion = 0; // setSpectra calls so far
  lastUpdateMs = 0;

  constructor(cascades: readonly CascadeConfig[], interval = OCEAN_UPDATE_INTERVAL) {
    this.cascades = cascades.map((config) => new CpuCascade(config));
    this.interval = interval;
    const repeat = T_REPEAT / interval;
    this.samplesPerRepeat = Math.abs(repeat - Math.round(repeat)) < 1e-6 ? Math.round(repeat) : 0;
    const r = this.samplesPerRepeat;
    const coarse = r > 0 ? Math.ceil(r / PHASE_FINE) : 0;
    this.fineCos = new Float64Array(r > 0 ? PHASE_FINE : 0);
    this.fineSin = new Float64Array(this.fineCos.length);
    this.coarseCos = new Float64Array(coarse);
    this.coarseSin = new Float64Array(coarse);
    for (let m = 0; m < this.fineCos.length; m++) {
      this.fineCos[m] = Math.cos((2 * Math.PI * m) / r);
      this.fineSin[m] = Math.sin((2 * Math.PI * m) / r);
    }
    for (let m = 0; m < coarse; m++) {
      this.coarseCos[m] = Math.cos((2 * Math.PI * m * PHASE_FINE) / r);
      this.coarseSin[m] = Math.sin((2 * Math.PI * m * PHASE_FINE) / r);
    }
    for (let i = 0; i < this.cascades.length; i++) {
      const n = (this.cascades[i] as CpuCascade).n;
      const next = this.cascades[i + 1];
      if (next && next.n === n) {
        this.pairs.push([i, i + 1]);
        i++;
      } else {
        this.pairs.push([i, -1]);
      }
      if (!this.workspaces.has(n)) {
        this.workspaces.set(n, {
          fft: new Fft2d(n),
          a0: new Float64Array(2 * n * n),
          a1: new Float64Array(2 * n * n),
          b: new Float64Array(2 * n * n),
          dx: new Float64Array(n * n),
          dy: new Float64Array(n * n),
          dz: new Float64Array(n * n),
        });
      }
    }
  }

  // Installs a new spectrum, blending to it over [startTime, startTime + duration]. A transition
  // already in progress is frozen at startTime and becomes the new starting point; the GPU must do
  // the same (see fromH0) so both sides keep identical h0.
  setSpectra(spectra: readonly CascadeSpectrum[], startTime = -Infinity, duration = 0): void {
    if (spectra.length !== this.cascades.length) throw new Error('CpuOcean: one spectrum per cascade');
    const w = this.hasSpectrum
      ? transitionBlend(this.transitionStart, this.transitionDuration, startTime)
      : 1;
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i] as CpuCascade;
      const s = spectra[i] as CascadeSpectrum;
      if (s.h0.length !== c.to.length) throw new Error('CpuOcean: h0 size does not match its cascade');
      if (this.hasSpectrum) {
        blendH0(c.from, c.from, c.to, w);
        c.chopFrom += (c.chopTo - c.chopFrom) * w;
        c.kFrom += (c.kTo - c.kFrom) * w;
      } else {
        c.from.set(s.h0);
        c.chopFrom = s.choppiness;
        c.kFrom = s.kRepresentative;
      }
      c.to.set(s.h0);
      c.chopTo = s.choppiness;
      c.kTo = s.kRepresentative;
    }
    this.transitionStart = startTime;
    this.transitionDuration = duration;
    this.hasSpectrum = true;
    this.spectraVersion++;
    this.slotSample[0] = Number.NaN;
    this.slotSample[1] = Number.NaN;
  }

  // h0 a transition starts from, after freezing any earlier transition; post this to the GPU.
  fromH0(cascade: number): Float32Array {
    return (this.cascades[cascade] as CpuCascade).from;
  }

  blendWeight(time: number): number {
    return transitionBlend(this.transitionStart, this.transitionDuration, time);
  }

  choppinessAt(cascade: number, time: number): number {
    const c = this.cascades[cascade] as CpuCascade;
    return c.chopFrom + (c.chopTo - c.chopFrom) * this.blendWeight(time);
  }

  representativeK(cascade: number, time: number): number {
    const c = this.cascades[cascade] as CpuCascade;
    return c.kFrom + (c.kTo - c.kFrom) * this.blendWeight(time);
  }

  // Index of the sample at or before `time`; the query bracket is [k, k + 1].
  sampleIndex(time: number): number {
    return Math.floor(time / this.interval + 1e-7);
  }

  sampleTime(index: number): number {
    return index * this.interval;
  }

  // Slot (0 or 1) holding sample index k.
  slotOf(index: number): number {
    return index & 1;
  }

  // Makes sure both samples bracketing `time` are computed: at most one FFT update per 60 Hz step when
  // time advances steadily, two after a jump.
  prepare(time: number): void {
    const k0 = this.sampleIndex(time);
    this.ensureSample(k0);
    this.ensureSample(k0 + 1);
  }

  private ensureSample(index: number): void {
    const slot = index & 1;
    if (this.slotSample[slot] === index) return;
    this.computeSample(index, slot);
    this.slotSample[slot] = index;
  }

  private computeSample(index: number, slot: number): void {
    const started = performance.now();
    const time = index * this.interval;
    // Exact periodicity: reduce the sample index, not the float time, when T_REPEAT allows it.
    const r = this.samplesPerRepeat;
    const phaseIndex = r > 0 ? ((index % r) + r) % r : -1;
    const phaseTime = r > 0 ? phaseIndex * this.interval : time - T_REPEAT * Math.floor(time / T_REPEAT);
    const w = this.hasSpectrum ? this.blendWeight(time) : 0;
    for (const [first, second] of this.pairs) {
      const c0 = this.cascades[first] as CpuCascade;
      const c1 = second >= 0 ? (this.cascades[second] as CpuCascade) : null;
      const ws = this.workspaces.get(c0.n) as ResolutionWorkspace;
      ws.a0.fill(0);
      ws.b.fill(0);
      this.evolve(c0, ws.a0, ws.b, 0, phaseTime, phaseIndex, w);
      if (c1) {
        ws.a1.fill(0);
        this.evolve(c1, ws.a1, ws.b, 1, phaseTime, phaseIndex, w);
      }
      const band = Math.max(c0.config.bandRadius, c1?.config.bandRadius ?? 0);
      ws.fft.inverseBandLimited(ws.a0, Math.ceil(c0.config.bandRadius));
      ws.fft.inverseBandLimited(ws.b, Math.ceil(band));
      writeField(c0, slot, ws.a0, ws.b, 0, ws);
      if (c1) {
        ws.fft.inverseBandLimited(ws.a1, Math.ceil(c1.config.bandRadius));
        writeField(c1, slot, ws.a1, ws.b, 1, ws);
      }
    }
    this.updateCount++;
    this.lastUpdateMs = performance.now() - started;
  }

  // Writes Dy + i·Dx into a and adds Dz into the real (part 0) or imaginary (part 1) half of b.
  // j: the sample's index within T_REPEAT (phases from the tables), or −1 to evaluate ω·t directly.
  private evolve(
    c: CpuCascade,
    a: Float64Array,
    b: Float64Array,
    part: number,
    t: number,
    j: number,
    w: number,
  ): void {
    const r = this.samplesPerRepeat;
    const fineCos = this.fineCos;
    const fineSin = this.fineSin;
    const coarseCos = this.coarseCos;
    const coarseSin = this.coarseSin;
    const lambda = c.chopFrom + (c.chopTo - c.chopFrom) * w;
    const from = c.from;
    const to = c.to;
    const blend = w > 0 && w < 1;
    const src = w >= 1 ? to : from;
    for (let i = 0; i < c.active.length; i++) {
      const p = c.active[i] as number;
      const q = 4 * p;
      let h0r = src[q] as number;
      let h0i = src[q + 1] as number;
      let hcr = src[q + 2] as number;
      let hci = src[q + 3] as number;
      if (blend) {
        h0r += ((to[q] as number) - h0r) * w;
        h0i += ((to[q + 1] as number) - h0i) * w;
        hcr += ((to[q + 2] as number) - hcr) * w;
        hci += ((to[q + 3] as number) - hci) * w;
      }
      let cs: number;
      let sn: number;
      if (j >= 0) {
        const m = ((c.omegaSteps[i] as number) * j) % r; // exact: q·j < 2^53
        const fine = m % PHASE_FINE;
        const crs = (m - fine) / PHASE_FINE;
        const fc = fineCos[fine] as number;
        const fs = fineSin[fine] as number;
        const cc = coarseCos[crs] as number;
        const cn = coarseSin[crs] as number;
        cs = cc * fc - cn * fs;
        sn = cn * fc + cc * fs;
      } else {
        const phase = (c.omega[i] as number) * t;
        cs = Math.cos(phase);
        sn = Math.sin(phase);
      }
      // h0·e^{−iωt} + conj(h0(−k))·e^{+iωt}
      const hr = h0r * cs + h0i * sn + hcr * cs - hci * sn;
      const hi = h0i * cs - h0r * sn + hcr * sn + hci * cs;
      // Dy + i·Dx = h + i·(iλk̂x h) = h·(1 − λk̂x)
      const f = 1 - lambda * (c.kxHat[i] as number);
      a[2 * p] = hr * f;
      a[2 * p + 1] = hi * f;
      // Dz = iλk̂z h
      const g = lambda * (c.kzHat[i] as number);
      const dzr = -g * hi;
      const dzi = g * hr;
      if (part === 0) {
        b[2 * p] = (b[2 * p] as number) + dzr;
        b[2 * p + 1] = (b[2 * p + 1] as number) + dzi;
      } else {
        // + i·Dz
        b[2 * p] = (b[2 * p] as number) - dzi;
        b[2 * p + 1] = (b[2 * p + 1] as number) + dzr;
      }
    }
  }
}

// Unpacks the IFFT outputs into one time slot and adds fourth-order central differences (periodic).
// Second-order differences lose 36% of the slope at 4 samples per wavelength; fourth-order loses 15%.
function writeField(
  c: CpuCascade,
  slot: number,
  a: Float64Array,
  b: Float64Array,
  part: number,
  ws: ResolutionWorkspace,
): void {
  const n = c.n;
  const mask = n - 1;
  const { dx, dy, dz } = ws;
  for (let i = 0; i < n * n; i++) {
    dy[i] = a[2 * i] as number;
    dx[i] = a[2 * i + 1] as number;
    dz[i] = b[2 * i + part] as number;
  }
  const inv12h = n / (12 * c.size);
  const field = c.field;
  const base = slot * FIELD_CHANNELS;
  for (let row = 0; row < n; row++) {
    const r = row * n;
    const rm1 = ((row - 1) & mask) * n;
    const rm2 = ((row - 2) & mask) * n;
    const rp1 = ((row + 1) & mask) * n;
    const rp2 = ((row + 2) & mask) * n;
    let o = r * TEXEL_STRIDE + base;
    for (let col = 0; col < n; col++, o += TEXEL_STRIDE) {
      const i = r + col;
      // Neighbours along the row (wrapping only at the ends) and down the column.
      const xm2 = r + ((col - 2) & mask);
      const xm1 = r + ((col - 1) & mask);
      const xp1 = r + ((col + 1) & mask);
      const xp2 = r + ((col + 2) & mask);
      const zm2 = rm2 + col;
      const zm1 = rm1 + col;
      const zp1 = rp1 + col;
      const zp2 = rp2 + col;
      // diff(f) = f[−2] − f[+2] + 8·(f[+1] − f[−1])
      field[o] = dx[i];
      field[o + 1] = dy[i];
      field[o + 2] = dz[i];
      field[o + 3] = (dy[xm2] - dy[xp2] + 8 * (dy[xp1] - dy[xm1])) * inv12h;
      field[o + 4] = (dy[zm2] - dy[zp2] + 8 * (dy[zp1] - dy[zm1])) * inv12h;
      field[o + 5] = (dx[xm2] - dx[xp2] + 8 * (dx[xp1] - dx[xm1])) * inv12h;
      field[o + 6] = (dx[zm2] - dx[zp2] + 8 * (dx[zp1] - dx[zm1])) * inv12h;
      field[o + 7] = (dz[zm2] - dz[zp2] + 8 * (dz[zp1] - dz[zm1])) * inv12h;
    }
  }
}

// The channel order writeField writes (literal offsets there keep its inner loop tight).
if (
  CH_DX !== 0 ||
  CH_DY !== 1 ||
  CH_DZ !== 2 ||
  CH_DY_X !== 3 ||
  CH_DY_Z !== 4 ||
  CH_DX_X !== 5 ||
  CH_DX_Z !== 6 ||
  CH_DZ_Z !== 7
)
  throw new Error('CpuOcean: writeField assumes the channel order');
