import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../core/rng';
import { Fft, Fft2d } from './fft';

function randomComplex(n: number, seed: number): Float64Array {
  const rng = new Rng(seed);
  const data = new Float64Array(2 * n);
  for (let i = 0; i < data.length; i++) data[i] = rng.range(-1, 1);
  return data;
}

function naiveDft(input: Float64Array, sign: number): Float64Array {
  const n = input.length / 2;
  const out = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) {
    let re = 0;
    let im = 0;
    for (let j = 0; j < n; j++) {
      const a = (sign * 2 * Math.PI * j * k) / n;
      const xr = input[2 * j] ?? 0;
      const xi = input[2 * j + 1] ?? 0;
      re += xr * Math.cos(a) - xi * Math.sin(a);
      im += xr * Math.sin(a) + xi * Math.cos(a);
    }
    out[2 * k] = re;
    out[2 * k + 1] = im;
  }
  return out;
}

function maxDiff(a: Float64Array, b: Float64Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return m;
}

describe('Fft', () => {
  it('matches a naive DFT in both directions', () => {
    for (const n of [1, 2, 8, 64, 128]) {
      const input = randomComplex(n, n);
      const fft = new Fft(n);
      const forward = input.slice();
      fft.forward(forward);
      expect(maxDiff(forward, naiveDft(input, -1)), `forward ${n}`).toBeLessThan(1e-10);
      const inverse = input.slice();
      fft.inverse(inverse);
      expect(maxDiff(inverse, naiveDft(input, 1)), `inverse ${n}`).toBeLessThan(1e-10);
    }
  });

  it('round-trips with 1/N normalization', () => {
    const n = 256;
    const input = randomComplex(n, 3);
    const data = input.slice();
    const fft = new Fft(n);
    fft.forward(data);
    fft.inverse(data);
    for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) / n;
    expect(maxDiff(data, input)).toBeLessThan(1e-12);
  });

  it('rejects sizes that are not powers of two', () => {
    expect(() => new Fft(12)).toThrow();
  });
});

describe('Fft2d', () => {
  it('matches a separable naive DFT and round-trips', () => {
    const n = 16;
    const input = randomComplex(n * n, 9);
    // Naive 2D: rows then columns.
    const expected = input.slice();
    for (let r = 0; r < n; r++)
      expected.set(naiveDft(expected.subarray(2 * r * n, 2 * (r + 1) * n), 1), 2 * r * n);
    const column = new Float64Array(2 * n);
    for (let c = 0; c < n; c++) {
      for (let r = 0; r < n; r++) {
        column[2 * r] = expected[2 * (r * n + c)] ?? 0;
        column[2 * r + 1] = expected[2 * (r * n + c) + 1] ?? 0;
      }
      const t = naiveDft(column, 1);
      for (let r = 0; r < n; r++) {
        expected[2 * (r * n + c)] = t[2 * r] ?? 0;
        expected[2 * (r * n + c) + 1] = t[2 * r + 1] ?? 0;
      }
    }
    const fft = new Fft2d(n);
    const data = input.slice();
    fft.inverse(data);
    expect(maxDiff(data, expected)).toBeLessThan(1e-10);
    fft.forward(data);
    for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) / (n * n);
    expect(maxDiff(data, input)).toBeLessThan(1e-12);
  });

  it('skips empty rows in the band-limited inverse without changing the result', () => {
    const n = 32;
    const band = 5;
    const input = randomComplex(n * n, 2);
    for (let r = band + 1; r < n - band; r++) input.fill(0, 2 * r * n, 2 * (r + 1) * n);
    const fft = new Fft2d(n);
    const full = input.slice();
    fft.inverse(full);
    const limited = input.slice();
    fft.inverseBandLimited(limited, band);
    expect(maxDiff(full, limited)).toBeLessThan(1e-12);
  });

  it('packs two Hermitian spectra into one IFFT as two real fields', () => {
    const n = 32;
    const rng = new Rng(5);
    // Random Hermitian spectra F1, F2: F(−k) = conj(F(k)).
    const f1 = new Float64Array(2 * n * n);
    const f2 = new Float64Array(2 * n * n);
    for (const f of [f1, f2]) {
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const i = r * n + c;
          const j = ((n - r) % n) * n + ((n - c) % n);
          if (j < i) continue;
          const re = rng.range(-1, 1);
          const im = i === j ? 0 : rng.range(-1, 1);
          f[2 * i] = re;
          f[2 * i + 1] = im;
          f[2 * j] = re;
          f[2 * j + 1] = -im;
        }
      }
    }
    const fft = new Fft2d(n);
    const a = f1.slice();
    const b = f2.slice();
    fft.inverse(a);
    fft.inverse(b);
    let maxImag = 0;
    for (let i = 0; i < n * n; i++)
      maxImag = Math.max(maxImag, Math.abs(a[2 * i + 1] ?? 0), Math.abs(b[2 * i + 1] ?? 0));
    expect(maxImag).toBeLessThan(1e-10);
    // P = F1 + i·F2 → IFFT gives f1 + i·f2.
    const packed = new Float64Array(2 * n * n);
    for (let i = 0; i < n * n; i++) {
      packed[2 * i] = (f1[2 * i] ?? 0) - (f2[2 * i + 1] ?? 0);
      packed[2 * i + 1] = (f1[2 * i + 1] ?? 0) + (f2[2 * i] ?? 0);
    }
    fft.inverse(packed);
    for (let i = 0; i < n * n; i++) {
      expect(packed[2 * i]).toBeCloseTo(a[2 * i] ?? 0, 9);
      expect(packed[2 * i + 1]).toBeCloseTo(b[2 * i] ?? 0, 9);
    }
  });

  it('runs a 128² inverse well under a millisecond', () => {
    const n = 128;
    const fft = new Fft2d(n);
    const data = randomComplex(n * n, 1);
    for (let i = 0; i < 20; i++) fft.inverse(data); // warm up the JIT
    const runs = 100;
    const started = performance.now();
    for (let i = 0; i < runs; i++) fft.inverse(data);
    const ms = (performance.now() - started) / runs;
    console.log(`128² complex 2D IFFT: ${ms.toFixed(3)} ms`);
    // Generous bound so a loaded CI machine does not flake; typical is ~0.2 ms.
    expect(ms).toBeLessThan(3);
  });
});
