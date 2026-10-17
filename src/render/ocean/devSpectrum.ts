// Standalone Phillips-style test spectrum (directional cosine spread) for the FX lab, in the same
// h0 layout and quantized dispersion as the real spectra from sim/ocean.
import { Rng } from '../../sim/core/rng';
import { GRAVITY } from '../../sim/core/units';
import type { GpuCascade } from './GpuOcean';

export const DEV_REPEAT_PERIOD = 1000;

export interface DevSpectrumOptions {
  windSpeed: number; // m/s
  windToward: number; // radians, direction the waves travel (clockwise from north)
  amplitude: number;
  seed: number;
}

export function devCascades(options: DevSpectrumOptions): GpuCascade[] {
  // Patch sizes chosen so cascades overlap little and don't tile visibly.
  const layout: [number, number, number, number][] = [
    // [size, patch length, kMin multiplier, kMax multiplier]
    [128, 1024, 0, 32],
    [128, 192, 6, 32],
    [128, 36, 6, 32],
    [256, 7, 6, 128],
  ];
  const omega0 = (2 * Math.PI) / DEV_REPEAT_PERIOD;
  const dirX = Math.sin(options.windToward);
  const dirZ = -Math.cos(options.windToward);
  const peakLength = (options.windSpeed * options.windSpeed) / GRAVITY;

  return layout.map(([size, patchLength, kMinMul, kMaxMul], cascadeIndex) => {
    const rng = new Rng(options.seed * 31 + cascadeIndex);
    const h0 = new Float32Array(size * size * 4);
    const omega = new Float32Array(size * size);
    const dk = (2 * Math.PI) / patchLength;
    const kMin = kMinMul * dk;
    const kMax = kMaxMul * dk;
    const amplitude = (index: number): [number, number] => {
      const x = index % size;
      const y = Math.floor(index / size);
      const mx = x < size / 2 ? x : x - size;
      const my = y < size / 2 ? y : y - size;
      const kx = mx * dk;
      const kz = my * dk;
      const k = Math.hypot(kx, kz);
      if (k === 0 || k < kMin || k >= kMax) return [0, 0];
      const cos = (kx * dirX + kz * dirZ) / k;
      const directional = cos > 0 ? cos * cos : cos * cos * 0.05;
      const damping = Math.exp(-k * k * 0.01 * 0.01);
      const phillips =
        (options.amplitude * Math.exp(-1 / (k * peakLength * k * peakLength)) * directional * damping) /
        k ** 4;
      return [Math.sqrt(phillips / 2) * dk, 0];
    };
    const gaussians = new Float32Array(size * size * 2);
    for (let i = 0; i < gaussians.length; i++) gaussians[i] = rng.gaussian();
    for (let index = 0; index < size * size; index++) {
      const x = index % size;
      const y = Math.floor(index / size);
      const mirror = ((size - y) % size) * size + ((size - x) % size);
      const [a] = amplitude(index);
      const [b] = amplitude(mirror);
      const h0kRe = (gaussians[index * 2] ?? 0) * a;
      const h0kIm = (gaussians[index * 2 + 1] ?? 0) * a;
      const h0mRe = (gaussians[mirror * 2] ?? 0) * b;
      const h0mIm = (gaussians[mirror * 2 + 1] ?? 0) * b;
      h0[index * 4] = h0kRe;
      h0[index * 4 + 1] = h0kIm;
      h0[index * 4 + 2] = h0mRe; // conj(h0(−k))
      h0[index * 4 + 3] = -h0mIm;
      const mx = x < size / 2 ? x : x - size;
      const my = y < size / 2 ? y : y - size;
      const k = Math.hypot(mx * dk, my * dk);
      omega[index] = Math.floor(Math.sqrt(GRAVITY * k) / omega0) * omega0;
    }
    return { size, patchLength, h0, omega, choppiness: 1 };
  });
}
