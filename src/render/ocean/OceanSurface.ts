// The rendered ocean as one unit: GPU spectrum simulation, CDLOD mesh with the ocean material, and
// the procedural foam texture, plus the knobs the scene turns each frame (wind → foam, region
// optics, rain, motion vectors).
//
// Call update() before rendering, setWind() from the weather, setWaterOptics() from the region.
// Boat wakes: setWakeGrids() with each snapshot's grids, update() with the boats (foam trails),
// renderWaterMask() just before the scene renders (cockpit / deck-well exclusion).

import type {
  Box3,
  Camera,
  Object3D,
  PerspectiveCamera,
  Vector2,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../../app/Scenario';
import type { WaterOptics } from '../../sim/astro/regions';
import type { BoatSnapshot, WakeGrid } from '../../sim/world/protocol';
import type { BoatVisual } from '../boats/kit/BoatVisual';
import type { OceanReflectionSource } from '../post/OceanReflections';
import type { N } from '../tsl';
import { FoamDetail } from './FoamDetail';
import { type GpuCascade, GpuOceanSimulation } from './GpuOcean';
import { DEFAULT_OCEAN_MESH, OceanMesh, oceanMeshFor } from './OceanMesh';
import { foamForWind, OCEAN_SHADING_QUALITY, type WindFoam } from './oceanOptics';
import { rainRippleParams } from './rainRipples';
import { updateOccluderSlots } from './ssrOccluders';
import { WakeLayer } from './WakeLayer';
import { WaterMask } from './WaterMask';

export interface OceanSurfaceOptions {
  cascades: readonly GpuCascade[];
  repeatPeriod: number;
  quality: QualityPreset;
  // Boat wakes, foam trails and water exclusion add 4 sampled textures to the fragment stage; off
  // on devices limited to WebGPU's default 16.
  wakes?: boolean;
  clipmapRings?: number; // graphics.clipmapRings; default DEFAULT_OCEAN_MESH.levels
  // Share of the scene light's (already cloud-shadowed) colour that arrives as the direct beam,
  // at a world position: scales the sun/moon glint (CloudSystem.glintNode).
  glint?: (worldPosition: N) => N;
}

// Fragment-stage sampled textures the device must allow for the wake layer.
export const OCEAN_WAKE_TEXTURE_LIMIT = 24;

export class OceanSurface {
  readonly simulation: GpuOceanSimulation;
  readonly mesh: OceanMesh;
  private foamDetail = new FoamDetail();
  private wakes: WakeLayer | null;
  private waterMask: WaterMask | null;
  private windSpeed = -1;
  private foam: WindFoam = foamForWind(0, []);

  constructor(options: OceanSurfaceOptions) {
    const quality = OCEAN_SHADING_QUALITY[options.quality];
    this.wakes = options.wakes === false ? null : new WakeLayer();
    this.waterMask = options.wakes === false ? null : new WaterMask();
    this.simulation = new GpuOceanSimulation(options.cascades, options.repeatPeriod);
    this.simulation.setAnisotropy(quality.anisotropy);
    this.mesh = new OceanMesh(
      {
        groups: this.simulation.groups,
        foamDetail: this.foamDetail.texture,
        quality,
        wake: this.wakes?.nodes,
        waterMask: this.waterMask?.texture,
        glint: options.glint,
      },
      options.clipmapRings === undefined ? DEFAULT_OCEAN_MESH : oceanMeshFor(options.clipmapRings),
    );
    this.mesh.mesh.receiveShadow = true;
    this.simulation.onSpectrumChange(() => this.refreshStatistics());
    this.refreshStatistics();
  }

  get groups(): GpuOceanSimulation['groups'] {
    return this.simulation.groups;
  }

  get object(): OceanMesh['mesh'] {
    return this.mesh.mesh;
  }

  // Current wind-driven foam parameters (e.g. for spume emitters).
  get foamParams(): Readonly<WindFoam> {
    return this.foam;
  }

  // A new spectrum, blended in over [activationTime, activationTime + duration] of simulation time.
  setSpectrum(cascades: readonly GpuCascade[], activationTime?: number, duration?: number): void {
    this.simulation.setSpectrum(cascades, activationTime, duration);
  }

  // Wind velocity (m/s, toward) at 10 m: breaking threshold, streak direction and strength.
  setWind(velocity: { x: number; z: number }): void {
    const speed = Math.hypot(velocity.x, velocity.z);
    const u = this.mesh.uniforms;
    if (speed > 1e-3) u.windDirection.value.set(velocity.x / speed, velocity.z / speed);
    if (Math.abs(speed - this.windSpeed) < 0.05) return;
    this.windSpeed = speed;
    this.applyFoam();
  }

  private applyFoam(): void {
    const u = this.mesh.uniforms;
    this.foam = foamForWind(Math.max(0, this.windSpeed), this.simulation.foamLayers);
    this.simulation.setFoam(this.foam);
    u.foamStreaks.value = this.foam.streaks;
    u.foamSpume.value = this.foam.spume;
    u.crestThreshold.value = this.foam.crestThreshold;
  }

  // Region optics (sim/astro/regions): absorption/scattering per metre and the art-directed colours.
  setWaterOptics(water: WaterOptics): void {
    const u = this.mesh.uniforms;
    (u.absorption.value as Vector3).fromArray(water.absorption);
    (u.scattering.value as Vector3).fromArray(water.scattering);
    (u.deepColor.value as Vector3).fromArray(water.deepColor);
    (u.subsurfaceTint.value as Vector3).fromArray(water.subsurfaceTint);
  }

  setMotionVectors(enabled: boolean): void {
    this.mesh.material.setMotionVectors(enabled);
  }

  // Screen-space reflections from the post plan: the SSR pass (post/OceanReflections.ts) traces
  // the opaque copies and rebuilds the sea's normal from what this source shares.
  setReflections(enabled: boolean): void {
    this.mesh.material.setReflections(enabled);
  }

  get reflectionSource(): OceanReflectionSource | null {
    const copies = this.mesh.material.opaqueCopies;
    if (!copies) return null;
    const u = this.mesh.uniforms;
    return {
      color: copies.color,
      depth: copies.depth,
      occluders: u.ssrOccluderData,
      occluderCount: u.ssrOccluders.count,
      frame: u.frame,
      surface: (xz, footprint, lodFootprint) => this.mesh.material.surfaceAt(xz, footprint, lodFootprint),
      displacement: (xz, distance) => this.mesh.displacementAt(xz, distance),
    };
  }

  // Where the reflections can hit (ssrOccluders.ts): every opaque thing in the scene as a root and
  // a box around it in the root's frame. Call right before rendering, with world matrices current;
  // `everything` (debug geometry outside the boats) falls back to the full march.
  updateReflectionOccluders(
    camera: PerspectiveCamera,
    occluders: Iterable<{ root: Object3D; bounds: Box3 }>,
    everything = false,
  ): void {
    const u = this.mesh.uniforms;
    updateOccluderSlots(u.ssrOccluders, camera, occluders, u.drawingBufferSize.value as Vector2, everything);
  }

  // Rain intensity 0..1 → ripple rings on the surface (none while dry).
  setRain(intensity: number): void {
    const r = rainRippleParams(intensity);
    const u = this.mesh.uniforms;
    u.rippleDensity.value = r.density;
    u.rippleSlope.value = r.slope;
    u.ripplePeriod.value = r.period;
    u.rippleVariance.value = r.variance;
  }

  // originX/originZ: float64 world position of the render origin.
  setWorldOrigin(originX: number, originZ: number): void {
    this.mesh.setWorldOrigin(originX, originZ);
  }

  // Boat wake grids from a simulation snapshot.
  setWakeGrids(grids: readonly WakeGrid[]): void {
    this.wakes?.setGrids(grids);
  }

  update(
    renderer: WebGPURenderer,
    camera: PerspectiveCamera,
    time: number,
    dt: number,
    boats: readonly BoatSnapshot[] = [],
  ): void {
    this.foamDetail.ensure(renderer);
    this.simulation.update(renderer, time, dt);
    this.wakes?.update(renderer, camera, time, dt, boats);
    this.mesh.update(camera);
    // Ripple phases (wrapped so float32 keeps them smooth) and the SSR jitter sequence.
    const u = this.mesh.uniforms;
    u.time.value = time % 3600;
    u.frame.value = ((u.frame.value as number) + 1) % 64;
    renderer.getDrawingBufferSize(u.drawingBufferSize.value as Vector2);
  }

  // Water-exclusion volumes of these boats, as the camera sees them; call right before rendering.
  renderWaterMask(renderer: WebGPURenderer, camera: Camera, visuals: Iterable<BoatVisual>): void {
    this.waterMask?.render(renderer, camera, visuals);
  }

  // Everything the ocean allocated: the mesh and material first (they sample the rest), then the
  // spectrum simulation, wakes, water mask and foam texture.
  dispose(): void {
    this.mesh.mesh.dispose();
    this.mesh.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.simulation.dispose();
    this.foamDetail.dispose();
    this.wakes?.dispose();
    this.waterMask?.dispose();
  }

  private refreshStatistics(): void {
    this.mesh.refreshStatistics();
    // Crest SSS is normalised by the significant amplitude, Hs / 2 = 2σ.
    this.mesh.uniforms.waveAmplitude.value = Math.max(0.1, 2 * Math.sqrt(this.simulation.heightVariance));
    if (this.windSpeed >= 0) this.applyFoam();
  }
}
