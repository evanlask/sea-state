// Iterative complex FFT on interleaved (re, im) Float64Arrays. Twiddles and the bit-reversal
// permutation are precomputed per size; transforms run in place and never allocate.
//
// Sign convention: forward X[k] = Σ x[j] e^{-2πi jk/N}, inverse x[j] = Σ X[k] e^{+2πi jk/N}. Neither is
// normalized; divide by N (or N² in 2D) yourself where a round trip is wanted. The ocean synthesizes
// with the unnormalized inverse because its amplitudes are already physical.
//
// Decimation in time after a bit-reversal permutation, with three radix-2 stages fused per pass
// (radix-2³): a pass loads eight values an eighth of a block apart, runs all twelve butterflies of
// the three stages in registers and stores them once, so memory is walked log₈ N times instead of
// log₂ N. When log₂ N is not a multiple of three, the first one or two stages (whose twiddles are
// all 1) run as a plain radix-2 or radix-4 pass.

export class Fft {
  readonly size: number;
  private readonly swaps: Uint32Array; // bit-reversal permutation as (i, j) pairs, i < j
  private readonly firstStages: number; // log2(size) mod 3: stages run before the radix-8 passes
  // Per radix-8 pass (half = 2^firstStages, then ×8) and k < half: cos and sin of the seven angles
  // 2πk/(2h); 2πk/(4h), 2π(k + h)/(4h); 2π(k + m·h)/(8h) for m = 0..3 (h = half), 14 values per k.
  private readonly twiddles: Float64Array;

  constructor(size: number) {
    if (size < 1 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two: ${size}`);
    this.size = size;
    const bits = Math.round(Math.log2(size));
    this.firstStages = bits % 3;
    const swaps: number[] = [];
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
      if (r > i) swaps.push(i, r);
    }
    this.swaps = Uint32Array.from(swaps);
    const tw: number[] = [];
    for (let half = 1 << this.firstStages; 8 * half <= size; half *= 8) {
      for (let k = 0; k < half; k++) {
        const angles = [
          k / (2 * half),
          k / (4 * half),
          (k + half) / (4 * half),
          k / (8 * half),
          (k + half) / (8 * half),
          (k + 2 * half) / (8 * half),
          (k + 3 * half) / (8 * half),
        ];
        for (const a of angles) tw.push(Math.cos(2 * Math.PI * a), Math.sin(2 * Math.PI * a));
      }
    }
    this.twiddles = Float64Array.from(tw);
  }

  forward(data: Float64Array, offset = 0): void {
    this.run(data, offset, -1);
  }

  inverse(data: Float64Array, offset = 0): void {
    this.run(data, offset, 1);
  }

  // One contiguous transform of `size` complex values starting at complex index offset/2.
  private run(d: Float64Array, offset: number, sign: number): void {
    const n = this.size;
    const swaps = this.swaps;
    for (let s = 0; s < swaps.length; s += 2) {
      const a = offset + 2 * swaps[s];
      const b = offset + 2 * swaps[s + 1];
      const tr = d[a];
      const ti = d[a + 1];
      d[a] = d[b];
      d[a + 1] = d[b + 1];
      d[b] = tr;
      d[b + 1] = ti;
    }
    const end = offset + 2 * n;
    if (this.firstStages === 1) {
      for (let a = offset; a < end; a += 4) {
        const br = d[a + 2];
        const bi = d[a + 3];
        const ar = d[a];
        const ai = d[a + 1];
        d[a + 2] = ar - br;
        d[a + 3] = ai - bi;
        d[a] = ar + br;
        d[a + 1] = ai + bi;
      }
    } else if (this.firstStages === 2) {
      for (let i0 = offset; i0 < end; i0 += 8) {
        const i1 = i0 + 2;
        const i2 = i0 + 4;
        const i3 = i0 + 6;
        // Both stages' twiddles are 1, except the second stage's odd one: ±i.
        const y0r = d[i0] + d[i1];
        const y0i = d[i0 + 1] + d[i1 + 1];
        const y1r = d[i0] - d[i1];
        const y1i = d[i0 + 1] - d[i1 + 1];
        const y2r = d[i2] + d[i3];
        const y2i = d[i2 + 1] + d[i3 + 1];
        const u3r = -sign * (d[i2 + 1] - d[i3 + 1]);
        const u3i = sign * (d[i2] - d[i3]);
        d[i2] = y0r - y2r;
        d[i2 + 1] = y0i - y2i;
        d[i0] = y0r + y2r;
        d[i0 + 1] = y0i + y2i;
        d[i3] = y1r - u3r;
        d[i3 + 1] = y1i - u3i;
        d[i1] = y1r + u3r;
        d[i1 + 1] = y1i + u3i;
      }
    }
    const tw = this.twiddles;
    let t = 0;
    for (let half = 1 << this.firstStages; 8 * half <= n; half *= 8) {
      const q = 2 * half;
      const span = 8 * q;
      for (let k = 0; k < half; k++, t += 14) {
        const war = tw[t + 0];
        const wai = sign * tw[t + 1];
        const w2r = tw[t + 2];
        const w2i = sign * tw[t + 3];
        const w2sr = tw[t + 4];
        const w2si = sign * tw[t + 5];
        const w4r = tw[t + 6];
        const w4i = sign * tw[t + 7];
        const w5r = tw[t + 8];
        const w5i = sign * tw[t + 9];
        const w6r = tw[t + 10];
        const w6i = sign * tw[t + 11];
        const w7r = tw[t + 12];
        const w7i = sign * tw[t + 13];
        for (let i0 = offset + 2 * k; i0 < end; i0 += span) {
          const i1 = i0 + q;
          const i2 = i1 + q;
          const i3 = i2 + q;
          const i4 = i3 + q;
          const i5 = i4 + q;
          const i6 = i5 + q;
          const i7 = i6 + q;
          const x0r = d[i0];
          const x0i = d[i0 + 1];
          const x1r = d[i1];
          const x1i = d[i1 + 1];
          const x2r = d[i2];
          const x2i = d[i2 + 1];
          const x3r = d[i3];
          const x3i = d[i3 + 1];
          const x4r = d[i4];
          const x4i = d[i4 + 1];
          const x5r = d[i5];
          const x5i = d[i5 + 1];
          const x6r = d[i6];
          const x6i = d[i6 + 1];
          const x7r = d[i7];
          const x7i = d[i7 + 1];
          const t1r = x1r * war - x1i * wai;
          const t1i = x1r * wai + x1i * war;
          const y0r = x0r + t1r;
          const y0i = x0i + t1i;
          const y1r = x0r - t1r;
          const y1i = x0i - t1i;
          const t3r = x3r * war - x3i * wai;
          const t3i = x3r * wai + x3i * war;
          const y2r = x2r + t3r;
          const y2i = x2i + t3i;
          const y3r = x2r - t3r;
          const y3i = x2i - t3i;
          const t5r = x5r * war - x5i * wai;
          const t5i = x5r * wai + x5i * war;
          const y4r = x4r + t5r;
          const y4i = x4i + t5i;
          const y5r = x4r - t5r;
          const y5i = x4i - t5i;
          const t7r = x7r * war - x7i * wai;
          const t7i = x7r * wai + x7i * war;
          const y6r = x6r + t7r;
          const y6i = x6i + t7i;
          const y7r = x6r - t7r;
          const y7i = x6i - t7i;
          const s2r = y2r * w2r - y2i * w2i;
          const s2i = y2r * w2i + y2i * w2r;
          const z0r = y0r + s2r;
          const z0i = y0i + s2i;
          const z2r = y0r - s2r;
          const z2i = y0i - s2i;
          const s3r = y3r * w2sr - y3i * w2si;
          const s3i = y3r * w2si + y3i * w2sr;
          const z1r = y1r + s3r;
          const z1i = y1i + s3i;
          const z3r = y1r - s3r;
          const z3i = y1i - s3i;
          const s6r = y6r * w2r - y6i * w2i;
          const s6i = y6r * w2i + y6i * w2r;
          const z4r = y4r + s6r;
          const z4i = y4i + s6i;
          const z6r = y4r - s6r;
          const z6i = y4i - s6i;
          const s7r = y7r * w2sr - y7i * w2si;
          const s7i = y7r * w2si + y7i * w2sr;
          const z5r = y5r + s7r;
          const z5i = y5i + s7i;
          const z7r = y5r - s7r;
          const z7i = y5i - s7i;
          const v4r = z4r * w4r - z4i * w4i;
          const v4i = z4r * w4i + z4i * w4r;
          d[i4] = z0r - v4r;
          d[i4 + 1] = z0i - v4i;
          d[i0] = z0r + v4r;
          d[i0 + 1] = z0i + v4i;
          const v5r = z5r * w5r - z5i * w5i;
          const v5i = z5r * w5i + z5i * w5r;
          d[i5] = z1r - v5r;
          d[i5 + 1] = z1i - v5i;
          d[i1] = z1r + v5r;
          d[i1 + 1] = z1i + v5i;
          const v6r = z6r * w6r - z6i * w6i;
          const v6i = z6r * w6i + z6i * w6r;
          d[i6] = z2r - v6r;
          d[i6 + 1] = z2i - v6i;
          d[i2] = z2r + v6r;
          d[i2 + 1] = z2i + v6i;
          const v7r = z7r * w7r - z7i * w7i;
          const v7i = z7r * w7i + z7i * w7r;
          d[i7] = z3r - v7r;
          d[i7 + 1] = z3i - v7i;
          d[i3] = z3r + v7r;
          d[i3 + 1] = z3i + v7i;
        }
      }
    }
  }

  // Column pass of a 2D transform: the same butterflies, applied to whole rows at once, so memory is
  // walked contiguously instead of with a stride of one row per element.
  runColumns(d: Float64Array, sign: number): void {
    const n = this.size;
    const rowStride = 2 * n;
    const swaps = this.swaps;
    for (let s = 0; s < swaps.length; s += 2) {
      const a = swaps[s] * rowStride;
      const b = swaps[s + 1] * rowStride;
      for (let c = 0; c < rowStride; c++) {
        const t = d[a + c];
        d[a + c] = d[b + c];
        d[b + c] = t;
      }
    }
    if (this.firstStages === 1) {
      for (let a = 0; a < n * rowStride; a += 2 * rowStride) {
        const b = a + rowStride;
        for (let c = 0; c < rowStride; c += 2) {
          const br = d[b + c];
          const bi = d[b + c + 1];
          const ar = d[a + c];
          const ai = d[a + c + 1];
          d[b + c] = ar - br;
          d[b + c + 1] = ai - bi;
          d[a + c] = ar + br;
          d[a + c + 1] = ai + bi;
        }
      }
    } else if (this.firstStages === 2) {
      for (let r0 = 0; r0 < n * rowStride; r0 += 4 * rowStride) {
        const r1 = r0 + rowStride;
        const r2 = r1 + rowStride;
        const r3 = r2 + rowStride;
        for (let c = 0; c < rowStride; c += 2) {
          const y0r = d[r0 + c] + d[r1 + c];
          const y0i = d[r0 + c + 1] + d[r1 + c + 1];
          const y1r = d[r0 + c] - d[r1 + c];
          const y1i = d[r0 + c + 1] - d[r1 + c + 1];
          const y2r = d[r2 + c] + d[r3 + c];
          const y2i = d[r2 + c + 1] + d[r3 + c + 1];
          const u3r = -sign * (d[r2 + c + 1] - d[r3 + c + 1]);
          const u3i = sign * (d[r2 + c] - d[r3 + c]);
          d[r2 + c] = y0r - y2r;
          d[r2 + c + 1] = y0i - y2i;
          d[r0 + c] = y0r + y2r;
          d[r0 + c + 1] = y0i + y2i;
          d[r3 + c] = y1r - u3r;
          d[r3 + c + 1] = y1i - u3i;
          d[r1 + c] = y1r + u3r;
          d[r1 + c + 1] = y1i + u3i;
        }
      }
    }
    const tw = this.twiddles;
    let t = 0;
    for (let half = 1 << this.firstStages; 8 * half <= n; half *= 8) {
      const q = half * rowStride;
      for (let k = 0; k < half; k++, t += 14) {
        const war = tw[t + 0];
        const wai = sign * tw[t + 1];
        const w2r = tw[t + 2];
        const w2i = sign * tw[t + 3];
        const w2sr = tw[t + 4];
        const w2si = sign * tw[t + 5];
        const w4r = tw[t + 6];
        const w4i = sign * tw[t + 7];
        const w5r = tw[t + 8];
        const w5i = sign * tw[t + 9];
        const w6r = tw[t + 10];
        const w6i = sign * tw[t + 11];
        const w7r = tw[t + 12];
        const w7i = sign * tw[t + 13];
        for (let base = k; base < n; base += 8 * half) {
          const r0 = base * rowStride;
          const r1 = r0 + q;
          const r2 = r1 + q;
          const r3 = r2 + q;
          const r4 = r3 + q;
          const r5 = r4 + q;
          const r6 = r5 + q;
          const r7 = r6 + q;
          for (let c = 0; c < rowStride; c += 2) {
            const x0r = d[r0 + c];
            const x0i = d[r0 + c + 1];
            const x1r = d[r1 + c];
            const x1i = d[r1 + c + 1];
            const x2r = d[r2 + c];
            const x2i = d[r2 + c + 1];
            const x3r = d[r3 + c];
            const x3i = d[r3 + c + 1];
            const x4r = d[r4 + c];
            const x4i = d[r4 + c + 1];
            const x5r = d[r5 + c];
            const x5i = d[r5 + c + 1];
            const x6r = d[r6 + c];
            const x6i = d[r6 + c + 1];
            const x7r = d[r7 + c];
            const x7i = d[r7 + c + 1];
            const t1r = x1r * war - x1i * wai;
            const t1i = x1r * wai + x1i * war;
            const y0r = x0r + t1r;
            const y0i = x0i + t1i;
            const y1r = x0r - t1r;
            const y1i = x0i - t1i;
            const t3r = x3r * war - x3i * wai;
            const t3i = x3r * wai + x3i * war;
            const y2r = x2r + t3r;
            const y2i = x2i + t3i;
            const y3r = x2r - t3r;
            const y3i = x2i - t3i;
            const t5r = x5r * war - x5i * wai;
            const t5i = x5r * wai + x5i * war;
            const y4r = x4r + t5r;
            const y4i = x4i + t5i;
            const y5r = x4r - t5r;
            const y5i = x4i - t5i;
            const t7r = x7r * war - x7i * wai;
            const t7i = x7r * wai + x7i * war;
            const y6r = x6r + t7r;
            const y6i = x6i + t7i;
            const y7r = x6r - t7r;
            const y7i = x6i - t7i;
            const s2r = y2r * w2r - y2i * w2i;
            const s2i = y2r * w2i + y2i * w2r;
            const z0r = y0r + s2r;
            const z0i = y0i + s2i;
            const z2r = y0r - s2r;
            const z2i = y0i - s2i;
            const s3r = y3r * w2sr - y3i * w2si;
            const s3i = y3r * w2si + y3i * w2sr;
            const z1r = y1r + s3r;
            const z1i = y1i + s3i;
            const z3r = y1r - s3r;
            const z3i = y1i - s3i;
            const s6r = y6r * w2r - y6i * w2i;
            const s6i = y6r * w2i + y6i * w2r;
            const z4r = y4r + s6r;
            const z4i = y4i + s6i;
            const z6r = y4r - s6r;
            const z6i = y4i - s6i;
            const s7r = y7r * w2sr - y7i * w2si;
            const s7i = y7r * w2si + y7i * w2sr;
            const z5r = y5r + s7r;
            const z5i = y5i + s7i;
            const z7r = y5r - s7r;
            const z7i = y5i - s7i;
            const v4r = z4r * w4r - z4i * w4i;
            const v4i = z4r * w4i + z4i * w4r;
            d[r4 + c] = z0r - v4r;
            d[r4 + c + 1] = z0i - v4i;
            d[r0 + c] = z0r + v4r;
            d[r0 + c + 1] = z0i + v4i;
            const v5r = z5r * w5r - z5i * w5i;
            const v5i = z5r * w5i + z5i * w5r;
            d[r5 + c] = z1r - v5r;
            d[r5 + c + 1] = z1i - v5i;
            d[r1 + c] = z1r + v5r;
            d[r1 + c + 1] = z1i + v5i;
            const v6r = z6r * w6r - z6i * w6i;
            const v6i = z6r * w6i + z6i * w6r;
            d[r6 + c] = z2r - v6r;
            d[r6 + c + 1] = z2i - v6i;
            d[r2 + c] = z2r + v6r;
            d[r2 + c + 1] = z2i + v6i;
            const v7r = z7r * w7r - z7i * w7i;
            const v7i = z7r * w7i + z7i * w7r;
            d[r7 + c] = z3r - v7r;
            d[r7 + c + 1] = z3i - v7i;
            d[r3 + c] = z3r + v7r;
            d[r3 + c + 1] = z3i + v7i;
          }
        }
      }
    }
  }

  // Rows whose signed index exceeds `band` are skipped (they must be all zero), which halves the row
  // pass for band-limited spectra.
  runRows(d: Float64Array, sign: number, band = this.size): void {
    const rowStride = 2 * this.size;
    for (let row = 0; row < this.size; row++) {
      if (row > band && this.size - row > band) continue;
      this.run(d, row * rowStride, sign);
    }
  }
}

// N×N transforms on row-major interleaved data: element (row z, column x) at 2·(z·N + x).
export class Fft2d {
  readonly size: number;
  private readonly fft: Fft;

  constructor(size: number) {
    this.size = size;
    this.fft = new Fft(size);
  }

  forward(data: Float64Array): void {
    this.fft.runRows(data, -1);
    this.fft.runColumns(data, -1);
  }

  inverse(data: Float64Array): void {
    this.fft.runRows(data, 1);
    this.fft.runColumns(data, 1);
  }

  // Inverse for spectra that are zero outside rows |n| ≤ band.
  inverseBandLimited(data: Float64Array, band: number): void {
    this.fft.runRows(data, 1, band);
    this.fft.runColumns(data, 1);
  }
}
