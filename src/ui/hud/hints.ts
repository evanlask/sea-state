// Control hints for the HUD, read from the bindings table so they can never disagree with
// what the keys actually do.

import {
  type AxisBinding,
  type ButtonActionId,
  describeBindings,
  findBinding,
  keyName,
} from '../../input/bindings';
import { contextForBoat } from '../../input/contexts';
import type { BoatKind } from '../../sim/world/protocol';
import type { HintRow } from './model';

// Beyond the boat's own controls, only the few a newcomer needs first.
const GENERAL_HINTS = new Set(['cameraNext', 'hud', 'help']);

// The bindings are fixed, so each boat's rows are built once (the HUD model asks every frame).
const hintRows = new Map<BoatKind, readonly HintRow[]>();

export function hintRowsFor(kind: BoatKind): readonly HintRow[] {
  const cached = hintRows.get(kind);
  if (cached) return cached;
  const context = contextForBoat(kind);
  const rows = describeBindings(context)
    .filter((row) => row.group === context || GENERAL_HINTS.has(row.id))
    .map(({ label, keyboard }) => ({ label, keyboard }));
  hintRows.set(kind, rows);
  return rows;
}

export interface SheetKeys {
  trim: string;
  ease: string;
}

// Keys for "Trim in / Ease out" on the sail-plan diagram. Sheets bind trim to the positive
// direction (W / E).
export function sheetKeys(sheet: 'mainSheet' | 'jibSheet'): SheetKeys {
  const binding = findBinding(sheet);
  if (!binding || binding.kind !== 'axis') return { trim: '', ease: '' };
  const axis: AxisBinding = binding;
  return { trim: axis.keysPos.map(keyName).join(' / '), ease: axis.keysNeg.map(keyName).join(' / ') };
}

// The key for a one-shot action, for inline prompts like "reef [R]".
export function buttonKey(id: ButtonActionId): string {
  const binding = findBinding(id);
  if (!binding || binding.kind !== 'button') return '';
  return binding.keys.map(keyName).join(' / ');
}
