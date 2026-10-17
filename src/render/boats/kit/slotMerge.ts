// Slot merging: PartBuilder slots whose materials are plain simple or lamp materials that differ
// only in their colours and finish (materials.ts SimpleParams / LampParams) become one mesh, the
// values carried per vertex and shaded by a merged material that computes exactly what each slot's
// own would. Chrome, rubber, frames, lamp lenses and the like are one draw instead of one each.
// The wheelhouse interior merges on its own, so it can still be hidden from afar (BoatVisual).

import { BufferAttribute, type BufferGeometry, type Material } from 'three/webgpu';

import {
  LAMP_BASE,
  LAMP_CHANNEL,
  LAMP_GLOW,
  lampParamsOf,
  mergedLampMaterial,
  mergedSimpleMaterial,
  SIMPLE_COLOR,
  SIMPLE_PBR,
  simpleParamsOf,
} from './materials';

// The wheelhouse interior's own slots (kit/bridge.ts) and the name of their merged mesh.
export const INTERIOR_SLOTS: ReadonlySet<string> = new Set(['ceiling', 'ceilingLight', 'console']);
export const INTERIOR_MESH = 'interior';

const CHANNELS = ['always', 'interior', 'deck', 'screen'] as const;

export interface SlotGeometry {
  slot: string;
  geometry: BufferGeometry;
  material: Material;
}

export interface MergedSlots {
  name: string;
  slots: string[];
  geometries: BufferGeometry[]; // with the per-vertex values added, to merge
  material: Material;
}

// Merged materials per slot-material set (a template's) and kind of merge, so every LOD and every
// builder of a model shares them (and they go with the template's other materials).
const mergedMaterials = new WeakMap<object, Map<string, Material>>();

function mergedMaterial(owner: object, key: string, create: () => Material): Material {
  let byKey = mergedMaterials.get(owner);
  if (!byKey) {
    byKey = new Map();
    mergedMaterials.set(owner, byKey);
  }
  let material = byKey.get(key);
  if (!material) {
    material = create();
    byKey.set(key, material);
  }
  return material;
}

const aoIds = new WeakMap<object, number>();
let nextAoId = 1;
const aoId = (ao: object | null): number => {
  if (!ao) return 0;
  let id = aoIds.get(ao);
  if (id === undefined) aoIds.set(ao, (id = nextAoId++));
  return id;
};

function constant(geometry: BufferGeometry, name: string, values: readonly number[]): void {
  const count = geometry.getAttribute('position').count;
  const size = values.length;
  const array = new Float32Array(count * size);
  for (let i = 0; i < count; i++) for (let k = 0; k < size; k++) array[i * size + k] = values[k]!;
  geometry.setAttribute(name, new BufferAttribute(array, size));
}

// Splits the slots into merge groups (two or more slots each) and the rest, which keep a mesh each.
export function planSlotMerges(
  slots: readonly SlotGeometry[],
  owner: object,
): { merged: MergedSlots[]; rest: SlotGeometry[] } {
  const groups = new Map<string, MergedSlots & { entries: SlotGeometry[] }>();
  const rest: SlotGeometry[] = [];
  for (const entry of slots) {
    const interior = INTERIOR_SLOTS.has(entry.slot);
    const simple = simpleParamsOf(entry.material);
    const lamp = simple ? undefined : lampParamsOf(entry.material);
    if (!simple && !lamp) {
      rest.push(entry);
      continue;
    }
    const key = simple
      ? `simple:${aoId(simple.ao)}:${simple.side}:${simple.brushed}:${interior}`
      : `lamp:${interior}`;
    let group = groups.get(key);
    if (!group) {
      const material = simple
        ? mergedMaterial(owner, `simple:${aoId(simple.ao)}:${simple.side}:${simple.brushed}`, () =>
            mergedSimpleMaterial({ ao: simple.ao, brushed: simple.brushed, side: simple.side }),
          )
        : mergedMaterial(owner, 'lamp', mergedLampMaterial);
      const name = interior ? INTERIOR_MESH : simple ? 'simple' : 'lamps';
      group = { name, slots: [], geometries: [], material, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  const merged: MergedSlots[] = [];
  for (const group of groups.values()) {
    if (group.entries.length < 2) {
      rest.push(...group.entries);
      continue;
    }
    for (const { slot, geometry, material } of group.entries) {
      const simple = simpleParamsOf(material);
      if (simple) {
        constant(geometry, SIMPLE_COLOR, [simple.color.r, simple.color.g, simple.color.b]);
        constant(geometry, SIMPLE_PBR, [simple.roughness, simple.metalness]);
      } else {
        const lamp = lampParamsOf(material)!;
        constant(geometry, LAMP_BASE, [lamp.base.r, lamp.base.g, lamp.base.b]);
        constant(geometry, LAMP_GLOW, [lamp.glow.r, lamp.glow.g, lamp.glow.b]);
        constant(
          geometry,
          LAMP_CHANNEL,
          CHANNELS.map((c) => (c === lamp.channel ? 1 : 0)),
        );
      }
      group.slots.push(slot);
      group.geometries.push(geometry);
    }
    merged.push({
      name: group.name,
      slots: group.slots,
      geometries: group.geometries,
      material: group.material,
    });
  }
  return { merged, rest };
}
