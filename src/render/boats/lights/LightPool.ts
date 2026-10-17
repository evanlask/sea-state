// The scene lights the helm boat's lights may use, created once per session at the quality preset's
// full budget and lent to whichever boat has the helm. three keys every lit material's pipeline on
// the scene's light set (each light's id, order and castShadow), so adding, removing, hiding or
// re-shadowing a light recompiles them all (a 0.5–1.5 s stall). The pool never changes: taking the
// helm of another boat re-aims the same lights at its mounts, and lights it doesn't need sit at
// intensity 0. Every slot is a SpotLight (point-light mounts become downward hemispheres, see
// DeckLights), and castShadow is fixed per slot.
//
// The pool's group is a direct child of the scene from the start (so the light order never changes)
// and copies the helm boat's transform each frame; the lights are placed in the boat's body frame.

import { Group, type Object3D, SpotLight, Vector3 } from 'three/webgpu';

import { enableShadowLayer } from '../kit/shadowProxy';
import {
  createFleetLightState,
  type FleetBeam,
  type FleetCandidate,
  fleetDistanceFade,
  type FleetLightState,
  updateFleetLights,
} from './fleetLighting';
import type { LightBudget } from './lightBudget';

const DEG = Math.PI / 180;

export class SceneLightPool {
  readonly object = new Group();
  readonly spill: readonly SpotLight[]; // nav-light spill, unshadowed
  readonly deck: readonly SpotLight[]; // deck lights; the first `shadowed` cast shadows
  readonly shadowed: number;
  private readonly all: readonly SpotLight[];
  private warm = false;

  constructor(budget: Readonly<LightBudget>) {
    this.object.name = 'boat-light-pool';
    const spot = (name: string): SpotLight => {
      const light = new SpotLight(0xffffff, 0, 10, 60 * DEG, 0.5, 2);
      light.name = name;
      light.castShadow = false;
      this.object.add(light, light.target);
      return light;
    };
    this.spill = Array.from({ length: Math.max(0, budget.navSpill) }, (_, i) => spot(`pool-spill-${i}`));
    this.shadowed = Math.max(0, Math.min(budget.deckShadows, budget.deckLights));
    this.deck = Array.from({ length: Math.max(0, budget.deckLights) }, (_, i) => {
      const light = spot(`pool-deck-${i}`);
      if (i < this.shadowed) {
        light.castShadow = true;
        light.shadow.mapSize.set(budget.shadowMapSize, budget.shadowMapSize);
        light.shadow.camera.near = 0.3;
        light.shadow.bias = -0.0004;
        light.shadow.normalBias = 0.02;
        light.shadow.autoUpdate = false;
        enableShadowLayer(light.shadow.camera);
      }
      return light;
    });
    this.all = [...this.spill, ...this.deck];
  }

  get lights(): readonly SpotLight[] {
    return this.all;
  }

  // Follows the boat holding the pool (its root's parent is the scene, so local = world).
  follow(root: Object3D | null | undefined): void {
    if (!root) return;
    this.object.position.copy(root.position);
    this.object.quaternion.copy(root.quaternion);
    this.object.scale.copy(root.scale);
  }

  // Warm-up: the shadowed slots render their shadow maps whether lit or not, so the shadow passes'
  // pipelines are built behind the loading screen too.
  setWarmup(on: boolean): void {
    this.warm = on;
  }

  // After the boats' lights have updated this frame.
  applyWarmup(): void {
    if (!this.warm) return;
    for (let i = 0; i < this.shadowed; i++) this.deck[i]!.shadow.autoUpdate = true;
  }

  // Every light dark (no boat holds the pool).
  idle(): void {
    for (const light of this.lights) {
      light.intensity = 0;
      if (light.castShadow) light.shadow.autoUpdate = false;
    }
  }

  dispose(): void {
    for (const light of this.lights) {
      if (light.castShadow) light.shadow.dispose();
      light.dispose();
    }
    this.object.removeFromParent();
  }
}

// A fleet boat that may borrow a fleet light this frame.
export interface FleetLightSource {
  id: string;
  root: Object3D; // the boat's body frame, a direct child of the scene
  beam: FleetBeam | null;
  on: boolean; // its deck lights (or extras) are on
}

const eye = new Vector3();

// The fleet's scene lights: a fixed few unshadowed spot lights (FLEET_LIGHTS, by quality), created
// once per session like SceneLightPool and for the same reason, each shining one boat's fleetBeam.
// Which boats get them is fleetLighting's choice; the rest of the fleet shows lamps and glows only.
// Unshadowed and without a light map, they add no sampler to any lit material (the crab's hull uses
// 15 of 16), only a light term to every lit fragment, and their distance keeps the lit patch local.
// The group is a direct child of the scene at the identity, so the lights are placed in world space.
export class FleetLightPool {
  readonly object = new Group();
  readonly lights: readonly SpotLight[];
  private state: FleetLightState;
  private candidates: FleetCandidate[] = [];
  private readonly byId = new Map<string, FleetLightSource>();

  constructor(count: number) {
    this.object.name = 'fleet-light-pool';
    this.lights = Array.from({ length: Math.max(0, count) }, (_, i) => {
      const light = new SpotLight(0xffffff, 0, 10, 60 * DEG, 0.5, 2);
      light.name = `pool-fleet-${i}`;
      light.castShadow = false;
      this.object.add(light, light.target);
      return light;
    });
    this.state = createFleetLightState(this.lights.length);
  }

  // Boats holding a light, and how far faded in (debugging).
  get assignments(): readonly { id: string; level: number }[] {
    return this.state.slots.flatMap((s) => (s.id === null ? [] : [{ id: s.id, level: s.level }]));
  }

  // After the boats have moved this frame; `sources` excludes the helm boat (SceneLightPool's).
  update(sources: readonly FleetLightSource[], camera: Object3D, preExposure: number, dt: number): void {
    if (this.lights.length === 0) return;
    camera.getWorldPosition(eye);
    const byId = this.byId;
    byId.clear();
    this.candidates.length = 0;
    for (const source of sources) {
      if (!source.on || !source.beam) continue;
      byId.set(source.id, source);
      this.candidates.push({ id: source.id, distance: eye.distanceTo(source.root.position) });
    }
    updateFleetLights(this.state, this.candidates, dt);
    this.state.slots.forEach((slot, i) => {
      const light = this.lights[i]!;
      const source = slot.id === null ? undefined : byId.get(slot.id);
      const beam = source?.beam;
      if (!source || !beam) {
        light.intensity = 0;
        return;
      }
      const { root } = source;
      const fade = fleetDistanceFade(eye.distanceTo(root.position));
      light.intensity = beam.intensity * preExposure * slot.level * fade;
      light.color.setRGB(beam.colour[0], beam.colour[1], beam.colour[2]);
      light.distance = beam.range;
      light.angle = beam.angle;
      light.penumbra = beam.penumbra;
      toWorld(root, beam.position, light.position);
      toWorld(root, beam.target, light.target.position);
    });
  }

  // Every light dark.
  idle(): void {
    for (const light of this.lights) light.intensity = 0;
    this.state = createFleetLightState(this.lights.length);
  }

  dispose(): void {
    for (const light of this.lights) light.dispose();
    this.object.removeFromParent();
  }
}

// Body frame → world, for a root whose parent is the scene (its matrix may not be updated yet).
function toWorld(root: Object3D, p: { x: number; y: number; z: number }, out: Vector3): void {
  out.set(p.x, p.y, p.z).multiply(root.scale).applyQuaternion(root.quaternion).add(root.position);
}
