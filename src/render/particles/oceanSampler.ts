// Ocean surface sampling for the effect kernels: sums the FFT cascade array
// textures (the same layout OceanMesh draws) to get the sea height, and the
// foam / Jacobian textures to find breaking crests. Sampling is Lagrangian, so
// one fixed-point step maps a world point back to the grid point that moved there.
import { Vector2 } from 'three/webgpu';

import type { CascadeGroup } from '../ocean/GpuOcean';
import { type N, tsl } from '../tsl';

const { float, max, texture, uniformArray, vec2, vec3 } = tsl;

// Writes the per-cascade sampling offset: the floating world origin reduced
// modulo the cascade's patch length (matching OceanMesh.setWorldOrigin).
export type CascadeOffsets = (groupIndex: number, layer: number, patchLength: number, out: Vector2) => void;

export class OceanSampler {
  readonly groups: readonly CascadeGroup[];
  private offsetValues: Vector2[][];
  private offsetUniforms: N[];

  constructor(groups: readonly CascadeGroup[]) {
    this.groups = groups;
    this.offsetValues = groups.map((group) => group.cascadeIndices.map(() => new Vector2()));
    this.offsetUniforms = this.offsetValues.map((values) => uniformArray(values, 'vec2'));
  }

  setOffsets(offsets: CascadeOffsets): void {
    this.groups.forEach((group, g) => {
      group.patchLengths.forEach((patch, layer) => {
        const value = this.offsetValues[g]?.[layer];
        if (value) offsets(g, layer, patch, value);
      });
    });
  }

  private forEachCascade(
    minPatch: number,
    visit: (group: CascadeGroup, g: number, layer: number) => void,
  ): void {
    this.groups.forEach((group, g) => {
      group.patchLengths.forEach((patch, layer) => {
        if (patch >= minPatch) visit(group, g, layer);
      });
    });
  }

  private uv(xz: N, g: number, layer: number, patch: number): N {
    return xz.add(this.offsetUniforms[g]?.element(layer)).div(patch);
  }

  // Displacement (dx, dy, dz) of the grid point at xz. Cascades shorter than
  // minPatch are skipped (they move the surface by centimetres).
  displacement(xz: N, minPatch = 0): N {
    let total: N = vec3(0);
    this.forEachCascade(minPatch, (group, g, layer) => {
      const patch = group.patchLengths[layer] ?? 1;
      total = total.add(
        texture(group.displacement, this.uv(xz, g, layer, patch))
          .depth(layer)
          .level(0).xyz,
      );
    });
    return total;
  }

  // Sea surface height under world point xz (y = 0 is mean sea level).
  height(xz: N, minPatch = 0): N {
    const first = this.displacement(xz, minPatch);
    return this.displacement(xz.sub(first.xz), minPatch).y;
  }

  // vec2(total foam, Jacobian of the summed displacement) at a grid point. Crests
  // break where the combined Jacobian dips towards / below zero; the per-cascade
  // foam layers alone miss steepness that only appears when cascades add up.
  breaking(xz: N, minPatch = 0): N {
    let foam: N = float(0);
    let slopes: N = vec3(0); // Σ ∂Dx/∂x, Σ ∂Dz/∂z, Σ ∂Dx/∂z
    this.forEachCascade(minPatch, (group, g, layer) => {
      const patch = group.patchLengths[layer] ?? 1;
      const uv = this.uv(xz, g, layer, patch);
      const derivatives = texture(group.derivatives, uv).depth(layer).level(0);
      const shear = texture(group.displacement, uv).depth(layer).level(0).w;
      slopes = slopes.add(vec3(derivatives.z, derivatives.w, shear));
      foam = foam.add(max(texture(group.foam, uv).depth(layer).level(0).x, 0));
    });
    const jacobian = float(1).add(slopes.x).mul(float(1).add(slopes.y)).sub(slopes.z.mul(slopes.z));
    return vec2(foam, jacobian);
  }
}
