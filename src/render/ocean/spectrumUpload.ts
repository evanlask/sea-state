// Converts the simulation's spectrum message into GPU cascade inputs: the h0
// texels as sent, plus each mode's quantized angular frequency (computed here
// from the same dispersion function the CPU uses). SpectrumBlend keeps the
// GPU's copy of a weather transition in step with the CPU physics ocean.

import { modeWaveNumber, signedMode } from '../../sim/ocean/cascades';
import { blendH0, transitionBlend } from '../../sim/ocean/h0';
import { quantizedDispersion } from '../../sim/ocean/spectrum';
import type { SpectrumMessage } from '../../sim/world/protocol';
import type { GpuCascade } from './GpuOcean';

export function gpuCascadesFromSpectrum(spectrum: SpectrumMessage): GpuCascade[] {
  return spectrum.cascades.map((cascade) => {
    const n = cascade.resolution;
    const omega = new Float32Array(n * n);
    const config = { size: cascade.size, resolution: n };
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const k = modeWaveNumber(
          config as Parameters<typeof modeWaveNumber>[0],
          signedMode(x, n),
          signedMode(y, n),
        );
        omega[y * n + x] = quantizedDispersion(k);
      }
    }
    return {
      size: n,
      patchLength: cascade.size,
      h0: cascade.h0,
      omega,
      choppiness: cascade.choppiness,
    };
  });
}

// A weather transition as the GPU evolves it: per cascade, h0 (and choppiness) blend from `from` to
// `to` with transitionBlend(start, duration, t). install() mirrors sim/ocean/CpuOcean.setSpectra step
// for step (an unfinished blend is frozen at the new start, in the same float32 arithmetic), so the
// physics cascades' h0 here equal the CPU's exactly, and both sides evaluate the same weight at the
// same simTime.
export class SpectrumBlend {
  readonly from: Float32Array[];
  readonly to: Float32Array[];
  readonly chopFrom: number[];
  readonly chopTo: number[];
  start = -Infinity;
  duration = 0;

  constructor(cascades: readonly GpuCascade[]) {
    this.from = cascades.map((c) => c.h0.slice());
    this.to = cascades.map((c) => c.h0.slice());
    this.chopFrom = cascades.map((c) => c.choppiness);
    this.chopTo = cascades.map((c) => c.choppiness);
  }

  install(cascades: readonly GpuCascade[], start = -Infinity, duration = 0): void {
    if (cascades.length !== this.to.length) throw new Error('SpectrumBlend: cascade layout changed');
    const w = transitionBlend(this.start, this.duration, start);
    cascades.forEach((cascade, i) => {
      const from = this.from[i] as Float32Array;
      const to = this.to[i] as Float32Array;
      if (cascade.h0.length !== to.length) throw new Error('SpectrumBlend: h0 size changed');
      blendH0(from, from, to, w);
      const chopFrom = this.chopFrom[i] as number;
      this.chopFrom[i] = chopFrom + ((this.chopTo[i] as number) - chopFrom) * w;
      to.set(cascade.h0);
      this.chopTo[i] = cascade.choppiness;
    });
    this.start = start;
    this.duration = duration;
  }

  weight(time: number): number {
    return transitionBlend(this.start, this.duration, time);
  }
}
