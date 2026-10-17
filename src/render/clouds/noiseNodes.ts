// Tileable noise for the cloud textures, as TSL node builders (inlined into the generating
// kernels): a PCG3D integer hash (deterministic on every GPU), periodic gradient (Perlin) noise and
// periodic Worley (cellular) noise. Periods are in lattice cells, so the textures wrap seamlessly.
// After Sébastien Hillaire's TileableVolumeNoise (MIT) as used by takram three-clouds (MIT).

import { type N, tsl } from '../tsl';

const { Loop, dot, float, floor, int, max, min, mix, uint, uvec3, vec3 } = tsl;

const INV_2_32 = 1 / 4294967296;

// PCG3D (Jarzynski & Olano 2020): uvec3 → three well-mixed u32, returned as floats in [0, 1).
export function hash3(v: N): N {
  const k = uint(1664525);
  const c = uint(1013904223);
  const x = v.x.mul(k).add(c).toVar();
  const y = v.y.mul(k).add(c).toVar();
  const z = v.z.mul(k).add(c).toVar();
  x.addAssign(y.mul(z));
  y.addAssign(z.mul(x));
  z.addAssign(x.mul(y));
  x.assign(x.bitXor(x.shiftRight(uint(16))));
  y.assign(y.bitXor(y.shiftRight(uint(16))));
  z.assign(z.bitXor(z.shiftRight(uint(16))));
  x.addAssign(y.mul(z));
  y.addAssign(z.mul(x));
  z.addAssign(x.mul(y));
  return min(vec3(float(x), float(y), float(z)).mul(INV_2_32), 0.99999994);
}

// Lattice cell → hash input: wrapped into [0, period) and offset by a seed.
const cellKey = (cell: N, period: N, seed: number): N => {
  const wrapped = cell.sub(floor(cell.div(period)).mul(period));
  return uvec3(wrapped.add(0.5)).add(uvec3(seed * 101, seed * 37, seed * 13));
};

// Periodic gradient noise at p (lattice units), roughly −1..1.
export function perlin3(p: N, period: N, seed = 0): N {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const u = f
    .mul(f)
    .mul(f)
    .mul(f.mul(f.mul(6).sub(15)).add(10))
    .toVar();
  const corner = (cx: number, cy: number, cz: number): N => {
    const offset = vec3(cx, cy, cz);
    const g = hash3(cellKey(i.add(offset), period, seed))
      .mul(2)
      .sub(1);
    return dot(g, f.sub(offset));
  };
  const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), u.x);
  const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), u.x);
  const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), u.x);
  const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z).mul(1.4);
}

// Periodic Worley noise at p (lattice units): squared distance to the nearest feature point,
// clamped to 0..1 (one feature point per cell).
export function worley3(p: N, period: N, seed = 0): N {
  const i = floor(p).toVar();
  const f = p.sub(i).toVar();
  const best = float(1).toVar();
  Loop(27, ({ i: n }: { i: N }) => {
    const offset = vec3(float(n.mod(int(3))), float(n.div(int(3)).mod(int(3))), float(n.div(int(9)))).sub(1);
    const point = hash3(cellKey(i.add(offset), period, seed));
    const d = offset.add(point).sub(f);
    best.assign(min(best, dot(d, d)));
  });
  return best;
}

// Perlin FBM over `octaves` doubling octaves starting at `frequency` cells per tile, mapped to 0..1.
export function perlinFbm(uvw: N, frequency: N, octaves: number, seed = 0): N {
  let sum: N = float(0);
  let weight = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const f = frequency.mul(2 ** o);
    sum = sum.add(perlin3(uvw.mul(f), f, seed + o).mul(weight));
    total += weight;
    weight *= 0.5;
  }
  return max(sum.div(total).mul(0.5).add(0.5), 0).min(1);
}

// 1 − Worley at a given cell count (bright cell centres), for FBM building.
export const worleyCells = (uvw: N, cells: number, seed = 0): N =>
  float(1).sub(worley3(uvw.mul(cells), vec3(cells), seed));

// Worley FBM as in the Nubis/takram noise: three octaves blended 0.625 / 0.25 / 0.125.
export function worleyFbm(uvw: N, cells: number, seed = 0): N {
  const a = worleyCells(uvw, cells, seed).toVar();
  const b = worleyCells(uvw, cells * 2, seed + 1).toVar();
  const c = worleyCells(uvw, cells * 4, seed + 2).toVar();
  return a.mul(0.625).add(b.mul(0.25)).add(c.mul(0.125));
}
