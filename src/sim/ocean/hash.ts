// Stateless integer hashing for random values addressed by coordinates (spectrum modes, gust knots).
// Unlike a sequential stream, a value depends only on its address, so changing a grid size or the
// order of evaluation never changes it.

// lowbias32 (Chris Wellons): good avalanche with two multiplies.
export function hash32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hash4(a: number, b: number, c: number, d: number): number {
  return hash32(hash32(hash32(hash32(a >>> 0) ^ (b >>> 0)) ^ (c >>> 0)) ^ (d >>> 0));
}

// Uniform in (0, 1); never 0, so it is safe inside a logarithm.
export function hashToUnit(h: number): number {
  return ((h >>> 0) + 0.5) / 4294967296;
}
