// Help-screen control tables, generated from the bindings table via describeBindings() so the
// help can never drift from what the keys actually do.

import { type BindingRow, describeBindings } from '../../input/bindings';
import type { InputContext, PollContext } from '../../input/contexts';

export interface HelpTable {
  group: InputContext;
  title: string;
  rows: BindingRow[];
}

const GROUP_TITLES: Record<InputContext, string> = {
  ship: 'Helm · container ship & crab boat',
  cruise: 'Helm · cruise ship',
  powerboat: 'Helm · center console',
  pwc: 'Helm · jet ski',
  hydro: 'Helm · hydroplane',
  sail: 'Helm · sailboat',
  camera: 'Camera',
  photo: 'Photo mode',
  global: 'Everywhere',
  menu: 'Menus',
};

// One table per binding group, in describeBindings' order (boat, camera, global).
export function buildHelpTables(context: PollContext): HelpTable[] {
  const tables: HelpTable[] = [];
  for (const row of describeBindings(context)) {
    let table = tables.find((t) => t.group === row.group);
    if (!table) {
      table = { group: row.group, title: GROUP_TITLES[row.group], rows: [] };
      tables.push(table);
    }
    table.rows.push(row);
  }
  return tables;
}

// Split "Shift+R / F1" style text into key-cap tokens, keeping separators as plain text.
export interface KeyToken {
  text: string;
  cap: boolean;
}

export function keyTokens(text: string): KeyToken[] {
  if (text === '—') return [{ text, cap: false }];
  const tokens: KeyToken[] = [];
  const chunks = text.split(/( \/ | · |, )/);
  for (const chunk of chunks) {
    if (!chunk) continue;
    const separator = chunk.trim();
    if (chunk === ' / ' || chunk === ' · ' || chunk === ', ') {
      tokens.push({ text: separator, cap: false });
      continue;
    }
    // "↑ ↓ ← →" is four keys; "Left stick X" is one control.
    const words = chunk.split(' ');
    if (words.length > 1 && words.every((w) => w.length <= 1)) {
      for (const word of words) tokens.push({ text: word, cap: true });
    } else tokens.push({ text: chunk, cap: true });
  }
  return tokens;
}
