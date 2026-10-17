// Capsize card (centre, under the alerts): while the helm boat is over or sunk, how the voyage went
// (time afloat, worst roll, slams) and how to recover. Rebuilt only when its content changes.

import { build, show } from '../dom';
import type { HudModel } from '../model';
import type { Widget } from './widget';

export class CapsizeCard implements Widget {
  readonly root: HTMLElement;
  private key = '';

  constructor() {
    this.root = build('hud-capsize', '').root;
    this.root.setAttribute('role', 'status');
    show(this.root, false);
  }

  write(m: HudModel): void {
    const card = m.capsize ?? null;
    show(this.root, card !== null);
    const key = card ? JSON.stringify(card) : '';
    if (!card || key === this.key) return;
    this.key = key;
    const title = document.createElement('div');
    title.className = 'cap-title';
    title.textContent = card.title;
    const rows = document.createElement('dl');
    for (const row of card.rows) {
      const dt = document.createElement('dt');
      dt.textContent = row.label;
      const dd = document.createElement('dd');
      dd.textContent = row.value;
      rows.append(dt, dd);
    }
    const hint = document.createElement('div');
    hint.className = 'cap-hint';
    hint.textContent = card.hint;
    this.root.replaceChildren(title, rows, hint);
  }

  animate(): void {}
}
