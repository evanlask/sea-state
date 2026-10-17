// Top-left status block: the boat's name and type, and the lights and signals it is showing
// (navigation, deck, cabin, extras such as searchlights; fishing, NUC, RAM, anchor). Unlit lights are
// dimmed, switches the boat doesn't have are hidden; navigation lights left off after dark turn
// amber. The tooltips name the number key for each switch.

import type { BoatKind } from '../../../sim/world/protocol';
import { build, show, TextSlot, toggle } from '../dom';
import { boatGlyph, LIGHT_ICONS, SIGNAL_ICONS, SIGNAL_LABELS } from '../icons';
import type { HudModel, LightSignal } from '../model';
import type { HudContext, Widget } from './widget';

const BOAT_KIND_LABELS: Record<BoatKind, string> = {
  cargo: 'Container ship',
  cruise: 'Cruise ship',
  crab: 'Crab boat',
  sail: 'Sailboat',
  powerboat: 'Center console',
  pwc: 'Jet ski',
  hydro: 'Hydroplane',
};

const SIGNALS: readonly LightSignal[] = ['fishing', 'nuc', 'ram', 'anchor'];

export class StatusBar implements Widget {
  readonly root: HTMLElement;
  private readonly glyph: HTMLElement;
  private readonly name: TextSlot;
  private readonly kind: TextSlot;
  private readonly nav: HTMLElement;
  private readonly deck: HTMLElement;
  private readonly cabin: HTMLElement;
  private readonly extra: HTMLElement;
  private readonly extraLabel: TextSlot;
  private readonly signals: Record<LightSignal, HTMLElement>;
  private glyphKind = '';

  constructor() {
    const icon = (name: string, svg: string, label: string, title = label): string =>
      `<span class="st-light" data-r="${name}" title="${title}">${svg}<span data-r="${name}-label">${label}</span></span>`;
    const b = build(
      'hud-panel hud-status',
      `<div class="st-boat"><span data-r="glyph"></span><div><b data-r="name"></b><span data-r="kind"></span></div></div>
      <div class="st-lights" data-full>
        ${icon('nav', LIGHT_ICONS.nav, 'Nav', 'Navigation lights (1)')}${icon('deck', LIGHT_ICONS.deck, 'Deck', 'Deck and work lights (2)')}${icon('cabin', LIGHT_ICONS.cabin, 'Cabin', 'Cabin lights (3)')}${icon('extra', LIGHT_ICONS.extra, 'Extra', 'Extra lights (5)')}
        ${SIGNALS.map((s) => icon(s, SIGNAL_ICONS[s], SIGNAL_LABELS[s], `${SIGNAL_LABELS[s]} signal (4)`)).join('')}
      </div>`,
    );
    this.root = b.root;
    this.glyph = b.ref('glyph');
    this.name = new TextSlot(b.ref('name'));
    this.kind = new TextSlot(b.ref('kind'));
    this.nav = b.ref('nav');
    this.deck = b.ref('deck');
    this.cabin = b.ref('cabin');
    this.extra = b.ref('extra');
    this.extraLabel = new TextSlot(b.ref('extra-label'));
    this.signals = {
      fishing: b.ref('fishing'),
      nuc: b.ref('nuc'),
      ram: b.ref('ram'),
      anchor: b.ref('anchor'),
    };
  }

  write(m: HudModel, _ctx: HudContext): void {
    if (m.boat.kind !== this.glyphKind) {
      this.glyphKind = m.boat.kind;
      this.glyph.innerHTML = boatGlyph(m.boat.kind);
    }
    this.name.set(m.boat.name);
    this.kind.set(BOAT_KIND_LABELS[m.boat.kind]);
    const l = m.lights;
    toggle(this.nav, 'is-on', l.nav);
    toggle(this.nav, 'is-warn', !l.nav && m.conditions.isNight && m.boat.kind !== 'pwc');
    show(this.nav, m.boat.kind !== 'pwc' || l.nav);
    const fitted = l.fitted;
    toggle(this.deck, 'is-on', l.deck);
    show(this.deck, fitted?.deck ?? true);
    toggle(this.cabin, 'is-on', l.cabin);
    show(this.cabin, fitted?.cabin ?? true);
    toggle(this.extra, 'is-on', l.extra);
    show(this.extra, fitted ? fitted.extra !== null : true);
    this.extraLabel.set(fitted?.extra ?? 'Extra');
    for (const s of SIGNALS) {
      const on = l.signals.includes(s);
      show(this.signals[s], on);
      toggle(this.signals[s], 'is-on', on);
    }
  }

  animate(): void {}
}
