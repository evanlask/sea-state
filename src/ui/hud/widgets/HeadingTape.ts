// Heading tape (top centre): a moving compass strip with the lubber line, a COG diamond so
// drift and leeway show, a true-wind "from" marker (much bigger when sailing) and a
// rate-of-turn bar in °/min like a ship's ROT indicator.

import { DEG, signedAngle } from '../../../sim/core/conventions';
import type { BoatKind } from '../../../sim/world/protocol';
import { build, StyleSlot, TextSlot, toggle } from '../dom';
import { formatBearing, formatRateOfTurn, windReading, joinReading } from '../format';
import type { HudModel } from '../model';
import { approach, approachAngle } from '../motion';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

const EM_PER_DEG = 0.26;
// Markers pin here when off the tape, inside the faded edges so they stay readable.
const HALF_SPAN = 50;

// Full-scale rate of turn, °/min: a laden ship turning 30°/min is turning hard.
const ROT_SCALE: Record<BoatKind, number> = {
  cargo: 40,
  cruise: 60,
  crab: 150,
  sail: 240,
  powerboat: 900,
  pwc: 1500,
  hydro: 3000,
};

const CARDINAL_LABELS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

function stripSvg(): string {
  const h = 13; // strip height in degree-units
  let ticks = '';
  let labels = '';
  for (let d = -180; d <= 540; d += 5) {
    const major = d % 10 === 0;
    ticks += `M ${d} 0 V ${major ? 3.4 : 2}`;
    const norm = ((d % 360) + 360) % 360;
    const cardinal = CARDINAL_LABELS[norm];
    if (cardinal) {
      const cls = norm % 90 === 0 ? 'tape-card' : 'tape-inter';
      labels += `<text x="${d}" y="9.4" class="${cls}">${cardinal}</text>`;
    } else if (norm % 30 === 0) {
      labels += `<text x="${d}" y="9" class="tape-num">${norm.toString().padStart(3, '0')}</text>`;
    }
  }
  const width = 720 * EM_PER_DEG;
  return `<svg class="tape-strip" data-r="strip" viewBox="-180 0 720 ${h}"
    style="width:${width}em;height:${h * EM_PER_DEG}em" aria-hidden="true">
    <path class="tape-ticks" d="${ticks}"/>${labels}</svg>`;
}

export class HeadingTape implements Widget {
  readonly root: HTMLElement;
  private readonly strip: StyleSlot;
  private readonly cog: StyleSlot;
  private readonly wind: StyleSlot;
  private readonly rot: StyleSlot;
  private readonly rotEl: HTMLElement;
  private readonly cogEl: HTMLElement;
  private readonly windEl: HTMLElement;
  private readonly hdgText: TextSlot;
  private readonly cogText: TextSlot;
  private readonly rotText: TextSlot;
  private readonly windText: TextSlot;
  private heading = Number.NaN;
  private cogAngle = Number.NaN;
  private windAngle = Number.NaN;
  private rotValue = 0;

  constructor() {
    const b = build(
      'hud-panel hud-tape',
      `<div class="tape-head">
        <span class="tape-hdg" data-r="hdg">000°</span><span class="hud-label">HDG °T</span>
      </div>
      <div class="tape-window">
        ${stripSvg()}
        <div class="tape-lubber"></div>
        <div class="tape-mark tape-cog" data-r="cog" title="Course over ground">
          <svg viewBox="-6 -6 12 12" aria-hidden="true"><path d="M 0 -5 L 4 0 L 0 5 L -4 0 Z"/></svg>
        </div>
        <div class="tape-mark tape-wind" data-r="wind" title="True wind from">
          <svg viewBox="-8 -12 16 16" aria-hidden="true"><path d="M -6 -11 L 6 -11 L 0 2 Z"/></svg>
        </div>
      </div>
      <div class="tape-rot" aria-hidden="true">
        <span class="rot-side rot-p">P</span>
        <div class="rot-bar"><div class="rot-fill" data-r="rot"></div><div class="rot-zero"></div></div>
        <span class="rot-side rot-s">S</span>
      </div>
      <div class="tape-foot">
        <span><i class="tape-key tape-key-cog"></i>COG <b data-r="cogTxt"></b></span>
        <span>ROT <b data-r="rotTxt"></b></span>
        <span title="True wind direction (from) and speed"><i class="tape-key tape-key-wind"></i>TWD <b data-r="windTxt"></b></span>
      </div>`,
    );
    this.root = b.root;
    this.strip = new StyleSlot(b.ref<SVGElement>('strip'), 'transform');
    this.cogEl = b.ref('cog');
    this.windEl = b.ref('wind');
    this.rotEl = b.ref('rot');
    this.cog = new StyleSlot(this.cogEl, 'transform');
    this.wind = new StyleSlot(this.windEl, 'transform');
    this.rot = new StyleSlot(this.rotEl, 'transform');
    this.hdgText = new TextSlot(b.ref('hdg'));
    this.cogText = new TextSlot(b.ref('cogTxt'));
    this.rotText = new TextSlot(b.ref('rotTxt'));
    this.windText = new TextSlot(b.ref('windTxt'));
  }

  write(m: HudModel, ctx: HudContext): void {
    this.hdgText.set(formatBearing(m.motion.heading));
    this.cogText.set(formatBearing(m.motion.cog));
    this.rotText.set(formatRateOfTurn(m.motion.rateOfTurn));
    const c = m.conditions;
    this.windText.set(
      `${formatBearing(c.windFrom)} ${joinReading(windReading(c.windSpeed, ctx.units.wind))}`,
    );
    toggle(this.root, 'is-sail', m.sailing !== null);
    toggle(this.rotEl, 'is-port', this.rotValue < 0);
  }

  animate(m: HudModel, dt: number): void {
    this.heading = approachAngle(this.heading, m.motion.heading, dt, NEEDLE_TAU);
    this.cogAngle = approachAngle(this.cogAngle, m.motion.cog, dt, NEEDLE_TAU * 2);
    this.windAngle = approachAngle(this.windAngle, m.conditions.windFrom, dt, NEEDLE_TAU * 3);
    const h = (((this.heading / DEG) % 360) + 360) % 360;
    this.strip.set(`translateX(${(-(h + 180) * EM_PER_DEG).toFixed(3)}em)`);
    this.place(this.cog, this.cogEl, this.cogAngle);
    this.place(this.wind, this.windEl, this.windAngle);
    const scale = ROT_SCALE[m.boat.kind];
    const target = Math.max(-1, Math.min(1, ((m.motion.rateOfTurn / DEG) * 60) / scale));
    this.rotValue = approach(this.rotValue, target, dt, NEEDLE_TAU * 2);
    this.rot.set(`scaleX(${this.rotValue.toFixed(3)})`);
  }

  private place(slot: StyleSlot, el: HTMLElement, angle: number): void {
    const rel = signedAngle(angle - this.heading) / DEG;
    const clamped = Math.max(-HALF_SPAN, Math.min(HALF_SPAN, rel));
    toggle(el, 'is-pinned', clamped !== rel);
    slot.set(`translateX(${(clamped * EM_PER_DEG).toFixed(3)}em)`);
  }
}
