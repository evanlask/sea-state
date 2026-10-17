// GPU inverse FFT over square complex grids, using workgroup shared memory.
//
// Each element of the storage buffer is a vec4 holding two complex numbers
// (xy and zw), so two real-valued fields pack into each complex transform and
// four real fields ride through every pass together. One workgroup transforms
// one row (or column) of one layer: N/2 threads each own one butterfly per
// radix-2 stage, so N may be at most 512 (256 threads, the WebGPU default
// workgroup limit).
//
// Index layout is natural FFT order: storage index x holds wavenumber index
// m = x for x < N/2 and m = x − N otherwise, so no output shift is needed.
// The transform is unnormalized: out[n] = Σ_k in[k]·e^{+2πi·kn/N}.
import type { ComputeNode } from 'three/webgpu';

import { type N, tsl } from '../tsl';

const {
  Fn,
  cos,
  float,
  invocationLocalIndex,
  sin,
  uint,
  vec2,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
} = tsl;

// A storage buffer node of vec4 (two complex numbers per element).
export type ComplexGridBuffer = N;

const complexMul = (a: N, b: N): N => vec2(a.x.mul(b.x).sub(a.y.mul(b.y)), a.x.mul(b.y).add(a.y.mul(b.x)));

// Reverses the low `bits` bits of an index (unrolled at shader build time).
function bitReverse(value: N, bits: number): N {
  let result: N = uint(0);
  for (let bit = 0; bit < bits; bit++) {
    result = result.bitOr(
      value
        .shiftRight(uint(bit))
        .bitAnd(uint(1))
        .shiftLeft(uint(bits - 1 - bit)),
    );
  }
  return result;
}

export interface FftPasses {
  rows: ComputeNode;
  columns: ComputeNode;
}

// Builds the row and column passes for `layers` N×N grids stored back to back.
// Run rows then columns for a full 2D inverse transform; each pass is in place.
export function createInverseFft2D(buffer: ComplexGridBuffer, size: number, layers: number): FftPasses {
  const log2 = Math.log2(size);
  if (!Number.isInteger(log2) || size < 4 || size > 512) {
    throw new Error(`FFT size must be a power of two between 4 and 512, got ${size}`);
  }
  const threads = size / 2;

  const pass = (vertical: boolean): ComputeNode => {
    const kernel = Fn(() => {
      const shared = workgroupArray('vec4', size);
      const thread = invocationLocalIndex;
      const line = workgroupId.x;
      const layerBase = line.div(uint(size)).mul(uint(size * size));
      const lineInLayer = line.mod(uint(size));
      // Element e along this line, as a flat buffer index.
      const indexOf = (element: N): N =>
        vertical
          ? layerBase.add(element.mul(uint(size))).add(lineInLayer)
          : layerBase.add(lineInLayer.mul(uint(size))).add(element);

      const even = thread.mul(uint(2));
      const odd = even.add(uint(1));
      shared.element(bitReverse(even, log2)).assign(buffer.element(indexOf(even)));
      shared.element(bitReverse(odd, log2)).assign(buffer.element(indexOf(odd)));
      workgroupBarrier();

      for (let stage = 0; stage < log2; stage++) {
        const half = 1 << stage;
        const span = half * 2;
        const position = thread.bitAnd(uint(half - 1));
        const group = thread.shiftRight(uint(stage));
        const i = group.mul(uint(span)).add(position);
        const j = i.add(uint(half));
        const angle = float(position).mul((2 * Math.PI) / span);
        const twiddle = vec2(cos(angle), sin(angle));
        const a = shared.element(i).toVar();
        const b = shared.element(j).toVar();
        const tb = vec4(complexMul(twiddle, b.xy), complexMul(twiddle, b.zw));
        shared.element(i).assign(a.add(tb));
        shared.element(j).assign(a.sub(tb));
        workgroupBarrier();
      }

      buffer.element(indexOf(even)).assign(shared.element(even));
      buffer.element(indexOf(odd)).assign(shared.element(odd));
    });
    // An explicit workgroup grid (not a thread count) avoids the bounds-check early
    // return TSL would otherwise insert, which is not allowed before a barrier.
    const node: ComputeNode = kernel().compute([size * layers, 1, 1], [threads]);
    node.setName(vertical ? `ifft-columns-${size}` : `ifft-rows-${size}`);
    return node;
  };

  return { rows: pass(false), columns: pass(true) };
}
