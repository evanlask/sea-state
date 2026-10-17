// Work, courtesy and accent lights on two switches: the deck group (floods, spreaders, courtesy
// lights) and the extras (searchlights, underwater LEDs, the jet ski's headlight, the funnel
// floodlight). Floods are spot lights (the first few by priority cast shadows, within the quality
// budget), cockpit and promenade fittings point lights; every fitting gets a lamp + glow (beam-masked,
// so a flood glares only when you look into it), underwater LEDs a glow in the water; plus the
// cabin-window glow hook the boat models multiply into their window emissive.

import { Color, Group, PointLight, SpotLight } from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import { enableShadowLayer } from '../kit/shadowProxy';
import { POINT_AS_SPOT_ANGLE, POINT_AS_SPOT_PENUMBRA } from './fleetLighting';
import { type LampEntry, LampField } from './LampField';
import { allocateLights, assignPoolSlots, type LightBudget } from './lightBudget';
import { type DeckGroup, deckGroupOf, type DeckMount, LED_WARM } from './mounts';
import { UnderwaterGlow } from './UnderwaterGlow';

const { uniform } = tsl;

// A lit interior seen through glass from outside, cd/m² (curtained cabins a few, bright saloons ~50);
// at night pre-exposure makes even this bloom, so keep the average low.
const CABIN_LUMINANCE = 6;
const SHADOW_DISTANCE = 400; // m camera-to-boat beyond which shadow maps stop re-rendering
const HOUSING_LEAK = 0.01; // share of the beam intensity a flood's housing shows off-axis

interface DeckSlot {
  mount: DeckMount;
  light: SpotLight | PointLight;
  shadow: boolean;
}

// Scene lights lent by SceneLightPool: the first `shadowed` cast shadows.
export interface DeckLightPool {
  lights: readonly SpotLight[];
  shadowed: number;
}

export interface DeckLightsOptions {
  mounts: readonly DeckMount[];
  budget: Pick<LightBudget, 'deckLights' | 'deckShadows' | 'shadowMapSize'>;
  lens?: boolean;
}

export class DeckLights {
  readonly object = new Group();
  readonly mounts: readonly DeckMount[];
  readonly field: LampField;
  readonly underwater: UnderwaterGlow;
  // Pre-exposed window luminance: windowMaterial.emissiveNode = tint.mul(deckLights.cabinGlowNode).
  readonly cabinGlowNode: N = uniform(0);
  readonly cabinColour = new Color(LED_WARM[0], LED_WARM[1], LED_WARM[2]);
  private lampMounts: DeckMount[];
  private slots: DeckSlot[] = [];
  private owned: DeckSlot[] = [];
  private pool: DeckLightPool | null = null;
  private on: Record<DeckGroup, boolean> = { deck: false, extra: false };
  private cabin = 0;

  constructor(options: DeckLightsOptions) {
    this.object.name = 'deck-lights';
    this.mounts = options.mounts.map((m) => ({ ...m }));
    this.lampMounts = this.mounts.filter((m) => m.lamp);
    const entries: LampEntry[] = this.lampMounts.map((m) => ({
      position: m.position,
      lensRadius: m.lensRadius,
      colour: m.colour,
      intensity: m.intensity,
      shape:
        m.light === 'point'
          ? { mode: 'cone', direction: { x: 0, y: -1, z: 0 }, angle: Math.PI, leak: 1 }
          : {
              mode: 'cone',
              direction: {
                x: m.target.x - m.position.x,
                y: m.target.y - m.position.y,
                z: m.target.z - m.position.z,
              },
              angle: m.angle,
              leak: HOUSING_LEAK,
            },
    }));
    this.field = new LampField(entries, { lens: options.lens });
    this.underwater = new UnderwaterGlow(this.mounts);
    this.object.add(this.field.object, this.underwater.object);

    const picked = allocateLights(this.mounts, options.budget.deckLights, options.budget.deckShadows);
    for (const { item: m, shadow: shadowWanted } of picked) {
      const colour = new Color(m.colour[0], m.colour[1], m.colour[2]);
      let light: SpotLight | PointLight;
      let shadow = false;
      if (m.light === 'spot') {
        const spot = new SpotLight(colour, 0, m.range, m.angle, m.penumbra, 2);
        spot.target.position.set(m.target.x, m.target.y, m.target.z);
        this.object.add(spot.target);
        shadow = shadowWanted;
        if (shadow) {
          spot.castShadow = true;
          spot.shadow.mapSize.set(options.budget.shadowMapSize, options.budget.shadowMapSize);
          spot.shadow.camera.near = 0.3;
          spot.shadow.camera.far = m.range;
          spot.shadow.bias = -0.0004;
          spot.shadow.normalBias = 0.02;
          enableShadowLayer(spot.shadow.camera);
        }
        light = spot;
      } else {
        light = new PointLight(colour, 0, m.range, 2);
      }
      light.name = `deck-${m.name}`;
      light.position.set(m.position.x, m.position.y, m.position.z);
      this.object.add(light);
      this.owned.push({ mount: m, light, shadow });
    }
    this.slots = this.owned;
  }

  // Uses the pool's lights instead of its own (null: back to its own, if any). The pool's lights are
  // re-aimed, never added or removed; the ones this boat doesn't need go dark.
  bindPool(pool: DeckLightPool | null): void {
    if (pool === this.pool) return;
    for (const slot of this.slots) slot.light.intensity = 0;
    this.pool = pool;
    if (!pool) {
      this.slots = this.owned;
      return;
    }
    this.assignPool(pool);
  }

  // Shares the pool's lights among the fittings that are switched on (all of them while everything
  // is off), so a searchlight switched on alone gets a light even on a small budget.
  private assignPool(pool: DeckLightPool): void {
    for (const light of pool.lights) {
      light.intensity = 0;
      if (light.castShadow) light.shadow.autoUpdate = false;
    }
    const live = this.mounts.filter((m) => this.on[deckGroupOf(m.type)]);
    const candidates = live.length > 0 ? live : this.mounts;
    const shadowed = Math.min(pool.shadowed, pool.lights.length);
    this.slots = assignPoolSlots(candidates, shadowed, pool.lights.length - shadowed).map(
      ({ item: m, slot, shadow }) => {
        const light = pool.lights[slot]!;
        light.color.setRGB(m.colour[0], m.colour[1], m.colour[2]);
        light.distance = m.range;
        light.decay = 2;
        light.position.set(m.position.x, m.position.y, m.position.z);
        if (m.light === 'spot') {
          light.angle = m.angle;
          light.penumbra = m.penumbra;
          light.target.position.set(m.target.x, m.target.y, m.target.z);
        } else {
          light.angle = POINT_AS_SPOT_ANGLE;
          light.penumbra = POINT_AS_SPOT_PENUMBRA;
          light.target.position.set(m.position.x, m.position.y - 1, m.position.z);
        }
        return { mount: m, light, shadow };
      },
    );
  }

  // The deck group's switch.
  get enabled(): boolean {
    return this.on.deck;
  }

  get extraEnabled(): boolean {
    return this.on.extra;
  }

  get sceneLights(): number {
    return this.slots.length;
  }

  get shadowedLights(): number {
    return this.slots.filter((s) => s.shadow).length;
  }

  // Shorthand for setGroup('deck', on).
  setEnabled(on: boolean): void {
    this.setGroup('deck', on);
  }

  setGroup(group: DeckGroup, on: boolean): void {
    if (this.on[group] === on) return;
    this.on[group] = on;
    this.lampMounts.forEach((m, i) => {
      if (deckGroupOf(m.type) === group) this.field.setOn(i, on);
    });
    if (this.pool) this.assignPool(this.pool);
  }

  // 0..1 share of cabins lit.
  setCabin(level: number): void {
    this.cabin = Math.min(1, Math.max(0, level));
  }

  update(preExposure: number, cameraDistance: number): void {
    const near = cameraDistance < SHADOW_DISTANCE;
    for (const slot of this.slots) {
      const on = this.on[deckGroupOf(slot.mount.type)];
      slot.light.intensity = on ? slot.mount.intensity * preExposure : 0;
      if (slot.shadow) slot.light.shadow.autoUpdate = on && near;
    }
    this.underwater.update(this.on.extra, preExposure);
    this.cabinGlowNode.value = this.cabin * CABIN_LUMINANCE * preExposure;
  }

  dispose(): void {
    this.bindPool(null);
    this.field.dispose();
    this.underwater.dispose();
    for (const slot of this.owned) {
      slot.light.shadow?.dispose();
      slot.light.dispose();
    }
    this.object.removeFromParent();
  }
}
