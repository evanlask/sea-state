// Reusable helm instruments for the propulsion panels: engine order telegraph, rudder /
// steering angle indicator, centre-zero bar (bow thruster), tachometer and level bars.
// Each owns its smoothing; write() sets text, animate() moves needles.

import { TELEGRAPH_NOTCHES } from '../../../input/axes';
import { DEG } from '../../../sim/core/conventions';
import {
  arcPath,
  AttrSlot,
  build,
  ClassSlot,
  deg,
  range,
  sectorPath,
  StyleSlot,
  TextSlot,
  ticksPath,
  toggle,
} from '../dom';
import { formatSide } from '../format';
import { approach } from '../motion';
import { NEEDLE_TAU } from './widget';

const STOP_INDEX = TELEGRAPH_NOTCHES.findIndex((n) => n.value === 0);

// Fractional notch position of a lever value, so bars line up with the (unevenly spaced) notches.
function notchPosition(value: number): number {
  const notches = TELEGRAPH_NOTCHES;
  if (value <= notches[0].value) return 0;
  for (let i = 0; i < notches.length - 1; i++) {
    const a = notches[i].value;
    const b = notches[i + 1].value;
    if (value <= b) return i + (value - a) / (b - a);
  }
  return notches.length - 1;
}

// Row height in the telegraph's own (smaller) font size; bars and the lever use the same em.
const ROW_EM = 1.62;

export class TelegraphView {
  readonly root: HTMLElement;
  private readonly rows: HTMLElement[];
  private readonly ahead: StyleSlot;
  private readonly astern: StyleSlot;
  private readonly lever: StyleSlot;
  private order = -1;
  private response = 0;
  private leverPos = STOP_INDEX;

  constructor() {
    const half = STOP_INDEX;
    const rows = [...TELEGRAPH_NOTCHES]
      .map((n, i) => ({ n, i }))
      .reverse()
      .map(
        ({ n, i }) =>
          `<div class="tg-row ${i > half ? 'is-ahead' : i < half ? 'is-astern' : 'is-stop'}" data-i="${i}">${n.short}</div>`,
      )
      .join('');
    const b = build(
      'tg',
      `<div class="hud-label tg-title">Telegraph</div>
      <div class="tg-scale" style="--tg-row:${ROW_EM}em">
        <div class="tg-track">
          <i class="tg-fill tg-fill-ahead" data-r="ahead"></i><i class="tg-fill tg-fill-astern" data-r="astern"></i>
        </div>
        <div class="tg-rows">${rows}</div>
        <div class="tg-lever" data-r="lever"><svg viewBox="0 0 10 10" aria-hidden="true"><path d="M 9 1 L 1 5 L 9 9 Z"/></svg></div>
      </div>`,
    );
    this.root = b.root;
    this.rows = [...b.root.querySelectorAll<HTMLElement>('.tg-row')].sort(
      (x, y) => Number(x.dataset.i) - Number(y.dataset.i),
    );
    this.ahead = new StyleSlot(b.ref('ahead'), 'transform');
    this.astern = new StyleSlot(b.ref('astern'), 'transform');
    this.lever = new StyleSlot(b.ref('lever'), 'transform');
  }

  write(notch: number): void {
    if (notch !== this.order) {
      this.rows[this.order]?.classList.remove('is-order');
      this.rows[notch]?.classList.add('is-order');
      this.order = notch;
    }
  }

  animate(lever: number, response: number, dt: number): void {
    this.response = approach(this.response, response, dt, NEEDLE_TAU * 2);
    this.leverPos = approach(this.leverPos, notchPosition(lever), dt, NEEDLE_TAU);
    const pos = notchPosition(this.response) - STOP_INDEX;
    const half = TELEGRAPH_NOTCHES.length - 1 - STOP_INDEX;
    this.ahead.set(`scaleY(${Math.max(0, pos / half).toFixed(3)})`);
    this.astern.set(`scaleY(${Math.max(0, -pos / STOP_INDEX).toFixed(3)})`);
    // Rows run top (full ahead) to bottom; STOP sits at index `half` from the top.
    this.lever.set(`translateY(${((STOP_INDEX - this.leverPos) * ROW_EM).toFixed(3)}em)`);
  }
}

// Ordered vs actual angle on an arc, port red / starboard green, like a bridge rudder
// indicator. The dial opens the scale up: full helm sits 70° off the top.
export class AngleGauge {
  readonly root: HTMLElement;
  private readonly needle: AttrSlot;
  private readonly order: AttrSlot;
  private readonly orderEl: SVGElement;
  private readonly text: TextSlot;
  private readonly sub: TextSlot;
  private readonly maxRad: number;
  private readonly withOrder: boolean;
  private actual = 0;
  private ordered = 0;

  constructor(label: string, maxDeg: number, withOrder: boolean) {
    this.maxRad = maxDeg * DEG;
    const k = 70 / maxDeg;
    const step = maxDeg > 20 ? 5 : 2.5;
    const minor = range(-maxDeg, maxDeg, step).map((d) => d * k);
    const top = Math.floor(maxDeg / 10) * 10;
    const labelled = range(-top, top, 10).filter((d) => d !== 0);
    const labels = labelled
      .map((d) => {
        const a = d * k * DEG;
        return `<text class="ag-txt" x="${(64 * Math.sin(a)).toFixed(1)}" y="${(-64 * Math.cos(a) + 3).toFixed(1)}">${Math.abs(d)}</text>`;
      })
      .join('');
    const b = build(
      'ag',
      `<svg class="ag-svg" viewBox="-100 -96 200 104" aria-hidden="true">
        <path class="ag-band port" d="${sectorPath(76, 84, -70, 0)}"/>
        <path class="ag-band stbd" d="${sectorPath(76, 84, 0, 70)}"/>
        <path class="ag-tick" d="${ticksPath(70, 76, minor)}"/>
        <path class="ag-tick major" d="${ticksPath(66, 76, [0, ...labelled.map((d) => d * k)])}"/>
        ${labels}
        <g data-r="order" class="ag-order"${withOrder ? '' : ' style="display:none"'}>
          <path d="M 0 -86 l -5 -8 h 10 z"/>
        </g>
        <g data-r="needle" class="ag-needle"><path d="M -2.6 0 L -1 -74 L 0 -79 L 1 -74 L 2.6 0 Z"/></g>
        <circle class="ag-hub" r="6"/>
      </svg>
      <div class="ag-read"><span class="hud-label">${label}</span><b data-r="txt">0°</b><span data-r="sub"></span></div>`,
    );
    this.root = b.root;
    this.needle = new AttrSlot(b.ref('needle'), 'transform');
    this.orderEl = b.ref<SVGElement>('order');
    this.order = new AttrSlot(this.orderEl, 'transform');
    this.text = new TextSlot(b.ref('txt'));
    this.sub = new TextSlot(b.ref('sub'));
    this.withOrder = withOrder;
  }

  write(actual: number, ordered: number | null): void {
    this.text.set(formatSide(actual));
    if (this.withOrder && ordered !== null) this.sub.set(`order ${formatSide(ordered)}`);
    else this.sub.set('');
    toggle(this.root, 'is-hard', Math.abs(actual) >= this.maxRad * 0.97);
  }

  animate(actual: number, ordered: number, dt: number): void {
    this.actual = approach(this.actual, actual, dt, NEEDLE_TAU);
    this.ordered = approach(this.ordered, ordered, dt, NEEDLE_TAU);
    const k = 70 / (this.maxRad / DEG);
    this.needle.set(`rotate(${(deg(clampAbs(this.actual, this.maxRad * 1.05)) * k).toFixed(1)})`);
    this.order.set(`rotate(${(deg(clampAbs(this.ordered, this.maxRad * 1.05)) * k).toFixed(1)})`);
  }
}

// Centre-zero horizontal bar: bow thrusters, port red / starboard green.
export class CentreBar {
  readonly root: HTMLElement;
  private readonly fill: StyleSlot;
  private readonly fillClass: ClassSlot;
  private readonly text: TextSlot;
  private value = 0;

  constructor(label: string) {
    const b = build(
      'cbar',
      `<div class="cbar-head"><span class="hud-label">${label}</span><b data-r="txt">0%</b></div>
      <div class="cbar-row"><span class="side-p">P</span>
        <div class="cbar-track"><i class="cbar-fill" data-r="fill"></i><i class="cbar-zero"></i></div>
        <span class="side-s">S</span></div>`,
    );
    this.root = b.root;
    const fillEl = b.ref('fill');
    this.fill = new StyleSlot(fillEl, 'transform');
    this.fillClass = new ClassSlot(fillEl);
    this.text = new TextSlot(b.ref('txt'));
  }

  write(value: number, available = true, note = 'ineffective'): void {
    const pct = Math.round(Math.abs(value) * 100);
    this.text.set(
      pct === 0
        ? available
          ? 'Off'
          : note
        : `${pct}% ${value > 0 ? 'S' : 'P'}${available ? '' : ` · ${note}`}`,
    );
    toggle(this.root, 'is-unavailable', !available);
  }

  animate(value: number, dt: number): void {
    this.value = approach(this.value, value, dt, NEEDLE_TAU);
    this.fill.set(`scaleX(${this.value.toFixed(3)})`);
    this.fillClass.set(this.value < 0 ? 'port' : 'stbd');
  }
}

// Round tachometer over 270°, red line in the top 10%. Options: a unit other than rpm (the
// hydroplane's N1 dial reads in %) and an order marker on the rim (where the lever is asking the
// needle to go: the turbine's spool lag shows as the gap between them).
export interface TachOptions {
  unit?: string;
  order?: boolean;
}

export class Tach {
  readonly root: HTMLElement;
  private readonly needle: AttrSlot;
  private readonly order: AttrSlot | null = null;
  private readonly rpmTxt: TextSlot;
  private readonly subTxt: TextSlot;
  private rpm = 0;
  private ordered = 0;
  private maxRpm: number;

  constructor(label: string, maxRpm: number, options: TachOptions = {}) {
    this.maxRpm = maxRpm;
    const majorStep = niceStep(maxRpm / 6);
    const marks = range(0, maxRpm, majorStep);
    const toDeg = (rpm: number): number => -135 + (rpm / maxRpm) * 270;
    const thousands = options.unit === undefined && maxRpm > 2000;
    const labels = marks
      .map((r) => {
        const a = toDeg(r) * DEG;
        const t = thousands ? r / 1000 : r;
        return `<text class="tach-txt" x="${(58 * Math.sin(a)).toFixed(1)}" y="${(-58 * Math.cos(a) + 3.5).toFixed(1)}">${t}</text>`;
      })
      .join('');
    const unit = options.unit ?? (thousands ? 'rpm ×1000' : 'rpm');
    const b = build(
      'tach',
      `<svg class="tach-svg" viewBox="-90 -90 180 160" aria-hidden="true">
        <path class="tach-arc" d="${arcPath(76, -135, 135)}"/>
        <path class="tach-red" d="${sectorPath(72, 80, toDeg(maxRpm * 0.9), 135)}"/>
        <path class="tach-tick" d="${ticksPath(70, 80, marks.map(toDeg))}"/>
        <path class="tach-tick minor" d="${ticksPath(74, 80, range(0, maxRpm, majorStep / 2).map(toDeg))}"/>
        ${labels}
        ${options.order ? '<g data-r="order" class="tach-order"><path d="M 0 -82 l -5 -8 h 10 z"/></g>' : ''}
        <g data-r="needle" class="tach-needle"><path d="M -2.4 8 L -0.8 -70 L 0 -74 L 0.8 -70 L 2.4 8 Z"/></g>
        <circle class="tach-hub" r="5"/>
        <text class="tach-unit" x="0" y="30">${unit}</text>
      </svg>
      <div class="tach-read"><span class="hud-label">${label}</span><b data-r="rpm">0</b><span data-r="sub"></span></div>`,
    );
    this.root = b.root;
    this.needle = new AttrSlot(b.ref('needle'), 'transform');
    if (options.order) this.order = new AttrSlot(b.ref('order'), 'transform');
    this.rpmTxt = new TextSlot(b.ref('rpm'));
    this.subTxt = new TextSlot(b.ref('sub'));
  }

  write(rpm: number, sub = ''): void {
    this.rpmTxt.set(Math.round(Math.abs(rpm)).toString());
    this.subTxt.set(sub);
    toggle(this.root, 'is-red', Math.abs(rpm) >= this.maxRpm * 0.9);
  }

  // `order`: where the order marker points (same units), when the dial has one.
  animate(rpm: number, dt: number, order = 0): void {
    this.rpm = approach(this.rpm, Math.abs(rpm), dt, NEEDLE_TAU);
    const d = -135 + Math.min(1.04, this.rpm / this.maxRpm) * 270;
    this.needle.set(`rotate(${d.toFixed(1)})`);
    if (this.order) {
      this.ordered = approach(this.ordered, Math.abs(order), dt, NEEDLE_TAU);
      this.order.set(`rotate(${(-135 + Math.min(1.04, this.ordered / this.maxRpm) * 270).toFixed(1)})`);
    }
  }
}

// Horizontal 0..1 level bar with a label and percentage (engine load, pod thrust, trim).
export class LevelBar {
  readonly root: HTMLElement;
  private readonly fill: StyleSlot;
  private readonly fillEl: HTMLElement;
  private readonly text: TextSlot;
  private value = 0;

  constructor(label: string, className = '') {
    const b = build(
      `lbar ${className}`,
      `<div class="lbar-head"><span class="hud-label">${label}</span><b data-r="txt">0%</b></div>
      <div class="hud-bar"><i class="hud-bar-fill" data-r="fill"></i></div>`,
    );
    this.root = b.root;
    this.fillEl = b.ref('fill');
    this.fill = new StyleSlot(this.fillEl, 'transform');
    this.text = new TextSlot(b.ref('txt'));
  }

  write(text: string, warn = false): void {
    this.text.set(text);
    toggle(this.root, 'is-warn', warn);
  }

  animate(value: number, dt: number): void {
    this.value = approach(this.value, value, dt, NEEDLE_TAU * 1.5);
    this.fill.set(`scaleX(${Math.max(0, Math.min(1, this.value)).toFixed(3)})`);
  }
}

// Vertical signed lever (-1 reverse .. 1 ahead) for outboard throttles.
export class ThrottleLever {
  readonly root: HTMLElement;
  private readonly ahead: StyleSlot;
  private readonly astern: StyleSlot;
  private readonly text: TextSlot;
  private value = 0;

  private readonly zero: string;

  // `zero`: what it reads at 0 (N for neutral; the hydroplane's power lever reads Idle).
  constructor(label: string, zero = 'N') {
    this.zero = zero;
    const b = build(
      'tl',
      `<div class="tl-track"><i class="tl-fill tl-ahead" data-r="ahead"></i><i class="tl-fill tl-astern" data-r="astern"></i><i class="tl-zero"></i></div>
      <span class="hud-label">${label}</span><b data-r="txt">N</b>`,
    );
    this.root = b.root;
    this.ahead = new StyleSlot(b.ref('ahead'), 'transform');
    this.astern = new StyleSlot(b.ref('astern'), 'transform');
    this.text = new TextSlot(b.ref('txt'));
  }

  write(value: number): void {
    const pct = Math.round(Math.abs(value) * 100);
    this.text.set(pct === 0 ? this.zero : value > 0 ? `${pct}%` : `R ${pct}%`);
  }

  animate(value: number, dt: number): void {
    this.value = approach(this.value, value, dt, NEEDLE_TAU);
    this.ahead.set(`scaleY(${Math.max(0, this.value).toFixed(3)})`);
    this.astern.set(`scaleY(${Math.max(0, -this.value).toFixed(3)})`);
  }
}

// 1, 2, 2.5 or 5 × 10^n: round dial steps.
function niceStep(raw: number): number {
  const base = 10 ** Math.floor(Math.log10(raw));
  const f = raw / base;
  return base * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10);
}

const clampAbs = (v: number, max: number): number => Math.max(-max, Math.min(max, v));
