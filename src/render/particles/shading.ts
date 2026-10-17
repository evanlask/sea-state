// Shader-side helpers shared by the particle, spume and rain kernels: a PCG
// hash random stream, Henyey–Greenstein phase, and the lighting uniforms every
// effect is lit by (sun, ambient sky and the current lightning flash).
import { Color, Vector3 } from 'three/webgpu';

import { type N, tsl } from '../tsl';

const { float, uint, uniform, pow, vec3 } = tsl;

// PCG hash (Jarzynski & Olano 2020): one u32 in, a well-mixed u32 out.
export function pcg(value: N): N {
  const state = value.mul(uint(747796405)).add(uint(2891336453));
  const word = state
    .shiftRight(state.shiftRight(uint(28)).add(uint(4)))
    .bitXor(state)
    .mul(uint(277803737));
  return word.shiftRight(uint(22)).bitXor(word);
}

// A random stream inside one shader invocation. Each next() is a new variable,
// so draws happen in program order.
export class GpuRandom {
  private state: N;

  constructor(seed: N) {
    this.state = pcg(seed).toVar();
  }

  // Uniform in [0, 1).
  next(): N {
    this.state.assign(pcg(this.state));
    return float(this.state.shiftRight(uint(8)))
      .mul(1 / 16_777_216)
      .toVar();
  }

  range(min: N, max: N): N {
    return float(min).add(float(max).sub(min).mul(this.next()));
  }

  // Uniform inside the unit ball (cube-root radius, uniform direction).
  insideSphere(): N {
    const z = this.next().mul(2).sub(1);
    const angle = this.next().mul(Math.PI * 2);
    const r = this.next().pow(1 / 3);
    const ring = float(1).sub(z.mul(z)).max(0).sqrt();
    return vec3(ring.mul(angle.cos()), z, ring.mul(angle.sin())).mul(r);
  }
}

// Henyey–Greenstein phase function, normalized over the sphere.
export function henyeyGreenstein(cosTheta: N, g: number): N {
  const g2 = g * g;
  return float((1 - g2) / (4 * Math.PI)).div(pow(float(1 + g2).sub(cosTheta.mul(2 * g)), 1.5));
}

// Light shared by every effect. Colours are linear HDR radiance multipliers.
export class FxLighting {
  readonly sunDirection = uniform(new Vector3(0.3, 0.6, -0.7).normalize()); // towards the sun
  readonly sunColor = uniform(new Color(3, 2.9, 2.7));
  readonly ambientColor = uniform(new Color(0.5, 0.6, 0.75));
  readonly flashColor = uniform(new Color(0, 0, 0)); // lightning, already scaled by intensity
  // The sea's colour, brightest channel 1: spray and white water pick up a hint of it.
  readonly seaTint = uniform(new Color(0.25, 1, 0.85));

  // From the region's water (its subsurface tint, the colour light picks up through thin water).
  setSeaTint(rgb: readonly [number, number, number]): void {
    const peak = Math.max(rgb[0], rgb[1], rgb[2], 1e-3);
    (this.seaTint.value as Color).setRGB(rgb[0] / peak, rgb[1] / peak, rgb[2] / peak);
  }
}
