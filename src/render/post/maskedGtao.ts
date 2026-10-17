// three's GTAO, computed only where the composite uses it (PostPipeline: the boats and their
// fittings, not the sky, the sea or anything past a few hundred metres).
//
// Elsewhere the horizon search would be wasted (blended away at weight 0). three's own sky test
// (depth ≥ 1) never fires with a reversed-Z buffer (sky is depth 0), and a WGSL discard only demotes
// the invocation to a helper that keeps running. So the AO shader branches around the search and
// writes 1 (unoccluded) where `needed` is false, which the composite treats the same as no AO.

import GTAONode from 'three/addons/tsl/display/GTAONode.js';
import type { Camera, Node, NodeBuilder } from 'three/webgpu';

import { type N, tsl } from '../tsl';

const { Fn, If, uv } = tsl;

interface GtaoInternals {
  _ao: (() => N) | null; // the AO shader's TSL function, rebuilt when the sample count changes
  _material: { fragmentNode: N; needsUpdate: boolean };
}

export class MaskedGtaoNode extends GTAONode {
  private readonly needed: N;

  // needed: bool node, true where the AO is used; built from fullscreen uv() lookups (it runs in
  // the AO pass, at its resolution).
  constructor(depthNode: Node, camera: Camera, needed: N) {
    super(depthNode, null as unknown as Node, camera);
    this.needed = needed;
  }

  override setup(builder: NodeBuilder): ReturnType<GTAONode['setup']> {
    const output = super.setup(builder);
    const self = this as unknown as GtaoInternals;
    const full = self._ao;
    if (!full) return output;
    const needed = this.needed;
    // three binds a texture's sampler only if the first node built from it gathers, and the AO reads
    // depth with a plain load before its gather. Starting the AO from a gather (clamped to exactly 1)
    // builds that first and keeps the sampler the AO's own gather needs.
    const gathered = (this as unknown as { depthNode: N }).depthNode.gather();
    const masked: () => N = Fn(() => {
      const ao = gathered.sample(uv()).x.max(1).min(1).toVar('gtaoMasked');
      If(needed, () => {
        ao.assign(full());
      });
      return ao;
    });
    self._ao = masked;
    self._material.fragmentNode = masked();
    self._material.needsUpdate = true;
    return output;
  }
}
