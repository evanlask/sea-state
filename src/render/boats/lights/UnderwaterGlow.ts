// The glow of underwater LEDs in the water around the boat: a soft additive patch lying on the
// surface over each fitting's beam. The ocean shades as if lit from above, so a real light under it
// would paint a blown-out disk and floodlight the hull from below; this stands in for the light
// scattered back up out of the water. One draw per fitting, shown only while lit or warming up
// (setWarmup builds the pipeline before the lights first go on).

import {
  AdditiveBlending,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
} from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import type { DeckMount } from './mounts';

const { exp, float, uniform, uv, vec2, vec3, vec4 } = tsl;

// Luminance at the centre of a patch, cd/m²: light scattered up from a few klm a few metres down,
// enough to read as a lit pool of water at night and nothing by day.
const UNDERWATER_GLOW_NITS = 6;
const SURFACE_LIFT = 0.06; // m above the design waterline, so a calm sea doesn't hide it
const WIDTH = 3.2; // m across the patch
const LENGTH = 4.4; // m along the beam
const REACH = 1.4; // m from the fitting to the patch centre, along the beam

export class UnderwaterGlow {
  readonly object = new Group();
  readonly count: number;
  private level: N = uniform(0);
  private material: MeshBasicNodeMaterial | null = null;
  private geometry: PlaneGeometry | null = null;
  private warm = false;

  constructor(mounts: readonly DeckMount[]) {
    this.object.name = 'underwater-glow';
    this.object.visible = false;
    const fittings = mounts.filter((m) => m.type === 'underwater');
    this.count = fittings.length;
    if (fittings.length === 0) return;
    const colour = fittings[0]!.colour;
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    });
    // Gaussian falloff from the centre of the patch (uv 0.5, 0.5), gone by the edge.
    const d = uv().sub(0.5).mul(vec2(2, 2));
    const falloff = exp(d.dot(d).mul(-4))
      .sub(float(Math.exp(-4)))
      .max(0);
    // Additive blending weights by alpha, so alpha stays 1 and the colour carries the level.
    material.colorNode = vec4(vec3(colour[0], colour[1], colour[2]).mul(falloff.mul(this.level)), 1);
    const geometry = new PlaneGeometry(WIDTH, LENGTH);
    geometry.rotateX(-Math.PI / 2);
    for (const m of fittings) {
      const dx = m.target.x - m.position.x;
      const dz = m.target.z - m.position.z;
      const l = Math.hypot(dx, dz) || 1;
      const mesh = new Mesh(geometry, material);
      mesh.name = `underwater-glow-${m.name}`;
      mesh.position.set(m.position.x + (dx / l) * REACH, SURFACE_LIFT, m.position.z + (dz / l) * REACH);
      mesh.rotation.y = Math.atan2(dx, dz);
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
    this.material = material;
    this.geometry = geometry;
  }

  // on: the fittings are lit; preExposure: the frame's exposure.
  update(on: boolean, preExposure: number): void {
    this.level.value = on ? UNDERWATER_GLOW_NITS * preExposure : 0;
    this.object.visible = on || this.warm;
  }

  // Warm-up: drawn while dark too, so the pipeline is built before the lights first go on.
  setWarmup(on: boolean): void {
    this.warm = on;
    this.object.visible = on || this.lit;
  }

  get lit(): boolean {
    return (this.level.value as number) > 0;
  }

  dispose(): void {
    this.material?.dispose();
    this.geometry?.dispose();
    this.object.removeFromParent();
  }
}
