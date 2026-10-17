// Pure spray maths shared by the CPU emitters, the particle kernels and their tests: the droplet
// size distribution and how the spray of a hull scales with its size.
import { type N, tsl } from '../tsl';

const { abs, float, log, exp, mix, pow, select } = tsl;

// Radius drawn from a truncated power law n(r) ∝ r^−alpha on [min, max] (inverse CDF at u ∈ [0, 1)).
// alpha 0 is uniform, 1 log-uniform; spray and splash droplets are close to alpha ≈ 3, where every
// decade of size covers about as much of the view: many fine droplets, a few big clumps.
export function powerLawRadius(min: number, max: number, alpha: number, u: number): number {
  if (max <= min) return min;
  const e = 1 - alpha;
  if (Math.abs(e) < 1e-3) return min * (max / min) ** u;
  return (min ** e + u * (max ** e - min ** e)) ** (1 / e);
}

// The same in a shader (min, max and u nodes; alpha a node or number).
export function powerLawRadiusNode(min: N, max: N, alpha: N, u: N): N {
  const e = float(1).sub(alpha);
  const logUniform = min.mul(exp(log(max.div(min)).mul(u)));
  const safe = select(abs(e).lessThan(1e-3), float(1), e);
  const power = pow(mix(pow(min, safe), pow(max, safe), u), float(1).div(safe));
  return select(abs(e).lessThan(1e-3), logUniform, power);
}

// How the spray of a hull scales with its size: 1 for a ~9 m waterline (the center console), from
// 0.5 for the jet ski to 4 for the ships. Droplets keep their real (mm–cm) sizes; the sheets, mist
// and white water a hull throws grow with it, as do the clumps a ship's bow wave breaks into.
export function hullSprayScale(lwl: number): number {
  return Math.min(4, Math.max(0.5, Math.sqrt(lwl / 9)));
}
