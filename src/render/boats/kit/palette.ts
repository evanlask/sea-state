// Standard material set for a vessel: one material per kit slot (see SLOTS and
// BRIDGE_SLOTS), coloured from a small palette and shaded with the model's AO
// volume, plus the boat's surface-detail layers where loaded (see ../detail/tuning.ts).
// Models add their own extra slots on top.

import type { ColorRepresentation, Material } from 'three/webgpu';

import type { BoatKind } from '../../../sim/world/protocol';
import { boatDetail } from '../detail/detail';
import { BRIDGE_SLOTS } from './bridge';
import { screenAtlas } from './liveries';
import {
  type AoVolume,
  deckMaterial,
  glassMaterial,
  hullPaintMaterial,
  type HullPaintOptions,
  lampMaterial,
  paintMaterial,
  type PlateLayout,
  simpleMaterial,
  windowFacadeMaterial,
  type WindowFacadeOptions,
} from './materials';
import { SLOTS } from './props';

export interface Palette {
  hull: HullPaintOptions;
  deck: ColorRepresentation;
  deckWear?: number;
  house: ColorRepresentation;
  trim: ColorRepresentation;
  machinery: ColorRepresentation;
  grime?: number;
  rust?: number;
  housePlates?: PlateLayout | null;
  windows?: Partial<WindowFacadeOptions>;
  glassTint?: ColorRepresentation;
}

export function createSlotMaterials(
  p: Palette,
  ao: AoVolume | null,
  kind?: BoatKind,
): Record<string, Material> {
  const detail = (part: string) => (kind ? boatDetail(kind, part) : null);
  const grime = p.grime ?? 0.35;
  const rust = p.rust ?? 0.15;
  const plates = p.housePlates === undefined ? { horizontal: 2.8, vertical: 2.8 } : p.housePlates;
  return {
    [SLOTS.hull]: hullPaintMaterial({ ...p.hull, ao, detail: detail(SLOTS.hull) }),
    [SLOTS.deck]: deckMaterial({
      color: p.deck,
      ao,
      grime: grime + 0.1,
      rust: rust * 0.6,
      wear: p.deckWear ?? 0.3,
      detail: detail(SLOTS.deck),
    }),
    [SLOTS.house]: paintMaterial({
      color: p.house,
      ao,
      grime,
      rust: rust * 0.5,
      streaks: 0.45,
      plates,
      name: 'house',
      detail: detail(SLOTS.house),
    }),
    [SLOTS.trim]: paintMaterial({
      color: p.trim,
      ao,
      grime: grime * 0.8,
      rust: rust * 0.4,
      roughness: 0.45,
      name: 'trim',
      detail: detail(SLOTS.trim),
    }),
    [SLOTS.machinery]: paintMaterial({
      color: p.machinery,
      ao,
      grime: grime + 0.15,
      rust: rust + 0.15,
      roughness: 0.5,
      name: 'machinery',
      detail: detail(SLOTS.machinery),
    }),
    [SLOTS.steel]: simpleMaterial({
      color: 0x8c9091,
      roughness: 0.45,
      metalness: 0.85,
      ao,
      brushed: true,
      name: 'steel',
      detail: detail(SLOTS.steel),
    }),
    [SLOTS.chrome]: simpleMaterial({ color: 0xe6e8ea, roughness: 0.12, metalness: 1, ao, name: 'chrome' }),
    [SLOTS.black]: simpleMaterial({
      color: 0x1a1b1c,
      roughness: 0.7,
      ao,
      name: 'black',
      detail: detail(SLOTS.black),
    }),
    [SLOTS.glass]: glassMaterial({ tint: p.glassTint }),
    [SLOTS.orange]: simpleMaterial({ color: 0xe8541c, roughness: 0.4, ao, name: 'orange' }),
    [SLOTS.white]: simpleMaterial({ color: 0xe9e8e3, roughness: 0.4, ao, name: 'white' }),
    [SLOTS.red]: paintMaterial({ color: 0x9a2a22, ao, grime, rust, name: 'red', detail: detail(SLOTS.red) }),
    [SLOTS.lampWhite]: lampMaterial({ color: 0xfff1d8, nits: 3000, channel: 'interior', base: 0xd8d8d0 }),
    [SLOTS.lampRed]: lampMaterial({ color: 0xff2010, nits: 3000, channel: 'interior', base: 0x801010 }),
    [SLOTS.lampGreen]: lampMaterial({ color: 0x10ff60, nits: 3000, channel: 'interior', base: 0x106030 }),
    [SLOTS.flood]: lampMaterial({ color: 0xffd9a0, nits: 40000, channel: 'deck', base: 0xc8c8c0 }),
    [SLOTS.screen]: lampMaterial({
      color: 0xffffff,
      nits: 160,
      channel: 'screen',
      map: screenAtlas(),
      base: 0x050505,
    }),
    [BRIDGE_SLOTS.frame]: simpleMaterial({ color: 0x22262a, roughness: 0.5, ao, name: 'frame' }),
    [BRIDGE_SLOTS.floor]: simpleMaterial({ color: 0x3b3f42, roughness: 0.8, ao, name: 'floor' }),
    [BRIDGE_SLOTS.console]: simpleMaterial({ color: 0x2c3034, roughness: 0.55, ao, name: 'console' }),
    [BRIDGE_SLOTS.ceiling]: simpleMaterial({ color: 0xd9d8d2, roughness: 0.8, ao, name: 'ceiling' }),
    [BRIDGE_SLOTS.ceilingLight]: lampMaterial({
      color: 0xfff4e6,
      nits: 220,
      channel: 'screen',
      base: 0xeeeeee,
    }),
    windows: windowFacadeMaterial({
      pitch: 2.4,
      width: 1.1,
      height: 0.9,
      sill: 1.0,
      deckHeight: 2.8,
      frame: p.house,
      ao,
      ...p.windows,
    }),
    bronze: simpleMaterial({ color: 0xb08a55, roughness: 0.3, metalness: 1, name: 'bronze' }),
  };
}
