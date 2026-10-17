// Fleet strip (left edge) and the optional mini radar / plotter under it. The strip lists
// every boat with bearing, range, speed and heading from the boat at the helm; the radar is
// head-up with range rings, a north mark, the true-wind arrow and each boat's course.

import { DEG } from '../../../sim/core/conventions';
import { NAUTICAL_MILE } from '../../../sim/core/units';
import { AttrSlot, build, deg, show, TextSlot, toggle } from '../dom';
import { formatBearing, formatRange, formatSpeed, type HudUnits } from '../format';
import { boatGlyph } from '../icons';
import type { FleetEntry, HudModel } from '../model';
import { approachAngle } from '../motion';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

interface FleetRow {
  root: HTMLElement;
  brg: TextSlot;
  rng: TextSlot;
  spd: TextSlot;
  hdg: TextSlot;
}

export class FleetStrip implements Widget {
  readonly root: HTMLElement;
  private readonly list: HTMLElement;
  private rows = new Map<string, FleetRow>();
  private idsKey = '';

  constructor() {
    const b = build(
      'hud-panel hud-fleet',
      `<div class="hud-title">Fleet</div>
      <div class="fl-head"><span></span><span>Boat</span><span>Brg</span><span>Rng</span><span>Spd</span><span>Hdg</span></div>
      <div class="fl-list" data-r="list"></div>`,
    );
    this.root = b.root;
    this.list = b.ref('list');
  }

  write(m: HudModel, ctx: HudContext): void {
    const fleet = m.fleet;
    show(this.root, fleet.length > 1);
    if (fleet.length < 2) return;
    const key = fleet.map((f) => `${f.id}:${f.kind}:${f.name}`).join('|');
    if (key !== this.idsKey) this.rebuild(fleet, key);
    const danger = new Set(m.alerts.filter((a) => a.id.startsWith('collision-')).map((a) => a.id.slice(10)));
    for (const f of fleet) {
      const row = this.rows.get(f.id);
      if (!row) continue;
      toggle(row.root, 'is-active', f.active);
      toggle(row.root, 'is-risk', danger.has(f.id));
      row.brg.set(f.active ? 'Helm' : formatBearing(f.bearing));
      row.rng.set(f.active ? '' : formatRange(f.range, ctx.units));
      row.spd.set(formatSpeed(f.speed, ctx.units.speed));
      row.hdg.set(formatBearing(f.heading));
    }
  }

  private rebuild(fleet: readonly FleetEntry[], key: string): void {
    this.idsKey = key;
    this.rows.clear();
    const els = fleet.map((f) => {
      const b = build(
        'fl-row',
        `<span class="fl-glyph">${boatGlyph(f.kind)}</span><span class="fl-name"></span>
        <span data-r="brg"></span><span data-r="rng"></span><span data-r="spd"></span><span data-r="hdg"></span>`,
      );
      const name = b.root.querySelector('.fl-name');
      if (name) name.textContent = f.name;
      this.rows.set(f.id, {
        root: b.root,
        brg: new TextSlot(b.ref('brg')),
        rng: new TextSlot(b.ref('rng')),
        spd: new TextSlot(b.ref('spd')),
        hdg: new TextSlot(b.ref('hdg')),
      });
      return b.root;
    });
    this.list.replaceChildren(...els);
  }

  animate(): void {}
}

// Radar range scales in the speed unit's distance (nm, mi or km): the smallest that keeps
// every contact inside the outer ring.
const RANGE_STEPS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32];
const RANGE_UNIT: Record<HudUnits['speed'], number> = { kn: NAUTICAL_MILE, mph: 1609.344, kmh: 1000 };

interface Blip {
  root: SVGGElement;
  pos: AttrSlot;
  glyph: AttrSlot;
}

export class Radar implements Widget {
  readonly root: HTMLElement;
  private readonly world: AttrSlot;
  private readonly blips: SVGGElement;
  private readonly rangeTxt: TextSlot;
  private readonly ringTxt: TextSlot;
  private readonly wind: AttrSlot;
  private readonly north: AttrSlot;
  private map = new Map<string, Blip>();
  private heading = Number.NaN;
  private scale = NAUTICAL_MILE;

  constructor() {
    const b = build(
      'hud-panel hud-radar',
      `<div class="hud-title">Plotter <span class="rd-range" data-r="range"></span></div>
      <svg class="rd-svg" viewBox="-108 -108 216 216" aria-hidden="true">
        <circle class="rd-face" r="100"/>
        <circle class="rd-ring" r="50"/><circle class="rd-ring" r="100"/>
        <path class="rd-cross" d="M 0 -100 V 100 M -100 0 H 100"/>
        <text class="rd-ring-txt" x="3" y="-53" data-r="ring"></text>
        <path class="rd-heading" d="M 0 0 V -100"/>
        <text class="rd-north" data-r="north" y="4">N</text>
        <g data-r="world">
          <g data-r="wind" class="rd-wind"><path d="M 0 -106 V -88 M -5 -95 L 0 -87 L 5 -95"/></g>
          <g data-r="blips"></g>
        </g>
        <path class="rd-own" d="M 0 -7 L 5 6 L 0 3 L -5 6 Z"/>
      </svg>`,
    );
    this.root = b.root;
    this.world = new AttrSlot(b.ref('world'), 'transform');
    this.blips = b.ref<SVGGElement>('blips');
    this.rangeTxt = new TextSlot(b.ref('range'));
    this.ringTxt = new TextSlot(b.ref('ring'));
    this.wind = new AttrSlot(b.ref('wind'), 'transform');
    this.north = new AttrSlot(b.ref('north'), 'transform');
  }

  write(m: HudModel, ctx: HudContext): void {
    const others = m.fleet.filter((f) => !f.active);
    show(this.root, ctx.settings.radar);
    if (!ctx.settings.radar) return;
    const far = others.reduce((max, f) => Math.max(max, f.range), 0);
    const unit = RANGE_UNIT[ctx.units.speed];
    const steps = ctx.units.speed === 'kmh' ? RANGE_STEPS.map((r) => r * 2) : RANGE_STEPS;
    const step = steps.find((r) => r * unit >= far * 1.1) ?? steps[steps.length - 1];
    this.scale = step * unit;
    this.rangeTxt.set(formatRange(this.scale, ctx.units));
    this.ringTxt.set(formatRange(this.scale / 2, ctx.units));
    this.wind.set(`rotate(${deg(m.conditions.windFrom)})`);

    const risk = new Set(m.alerts.filter((a) => a.id.startsWith('collision-')).map((a) => a.id.slice(10)));
    const seen = new Set<string>();
    for (const f of others) {
      seen.add(f.id);
      let blip = this.map.get(f.id);
      if (!blip) {
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.innerHTML =
          '<g><path class="rd-blip" d="M 0 -6 L 4 5 L -4 5 Z"/><path class="rd-vector" d="M 0 -6 V -16"/></g>';
        this.blips.append(g);
        const inner = g.firstElementChild as SVGGElement;
        blip = { root: g, pos: new AttrSlot(g, 'transform'), glyph: new AttrSlot(inner, 'transform') };
        this.map.set(f.id, blip);
      }
      const r = Math.min(104, (f.range / this.scale) * 100);
      const x = Math.sin(f.bearing) * r;
      const y = -Math.cos(f.bearing) * r;
      blip.pos.set(`translate(${x.toFixed(1)} ${y.toFixed(1)})`);
      blip.glyph.set(`rotate(${deg(f.heading)})`);
      toggle(blip.root, 'is-risk', risk.has(f.id));
    }
    for (const [id, blip] of this.map) {
      if (seen.has(id)) continue;
      blip.root.remove();
      this.map.delete(id);
    }
  }

  animate(m: HudModel, dt: number, ctx: HudContext): void {
    if (!ctx.settings.radar) return;
    this.heading = approachAngle(this.heading, m.motion.heading, dt, NEEDLE_TAU * 2);
    this.world.set(`rotate(${(-this.heading / DEG).toFixed(1)})`);
    // The N stays upright, riding round the inner edge of the scope.
    const x = -Math.sin(this.heading) * 88;
    const y = -Math.cos(this.heading) * 88;
    this.north.set(`translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  }
}
