// Sailing layout, bottom centre: the sail-plan diagram, the main sailing instrument. A
// top-down hull with the true (blue) and apparent (yellow) wind, the boom and jib at their
// current angles with dashed ghosts at the ideal sheeting angle, sails coloured by trim
// (luffing / good / stalled), big "Trim in ◀ / Ease out ▶" prompts with the key to press,
// animated telltales, the reef / furl state and the point-of-sail label above.

import { DEG, signedAngle } from '../../../sim/core/conventions';
import {
  AttrSlot,
  build,
  ClassSlot,
  deg,
  sectorPath,
  show,
  StyleSlot,
  TextSlot,
  ticksPath,
  toggle,
  range,
} from '../dom';
import { formatPercent, formatSide, joinReading, windReading } from '../format';
import { sheetKeys } from '../hints';
import type { HudModel, TrimState } from '../model';
import { approach, approachAngle } from '../motion';
import {
  GYBE_ZONE_HALF_ANGLE,
  isGybeZone,
  isNoGo,
  manoeuvreHint,
  NO_GO_HALF_ANGLE,
  POINT_OF_SAIL_LABEL,
  tackOf,
  trimAdvice,
} from '../sailing';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

const MAST_Y = -19;
const TACK_Y = -80;
const BOOM_LEN = 70;
const JIB_LEN = 74;

const HULL =
  'M 0 -84 C 16 -66 28 -36 29 -4 C 30 26 26 52 20 78 L -20 78 C -26 52 -30 26 -29 -4 C -28 -36 -16 -66 0 -84 Z';

const TRIM_LABEL: Record<TrimState, string> = { luffing: 'Luffing', optimal: 'Good', stalled: 'Stalled' };

interface SailView {
  group: AttrSlot;
  ghost: AttrSlot;
  shape: AttrSlot;
  cls: ClassSlot;
  angle: number;
  ghostAngle: number;
  shapeKey: number;
  length: number;
}

function sailMarkup(name: string, pivotY: number, length: number): string {
  return `<g class="sp-ghost" data-r="${name}Ghost"><path d="M 0 0 V ${length}" transform="translate(0 ${pivotY})"/></g>
    <g class="sp-sail sp-${name}" data-r="${name}"><path class="sp-cloth" data-r="${name}Shape" transform="translate(0 ${pivotY})"/>
      ${name === 'main' ? `<path class="sp-boom" d="M 0 0 V ${length}" transform="translate(0 ${pivotY})"/>` : ''}</g>`;
}

// A telltale streamer; the CSS animation and its amplitude come from the flow class.
function telltale(name: string, label: string): string {
  return `<div class="tt" data-r="${name}"><svg viewBox="0 0 60 16" aria-hidden="true"><path class="tt-thread" d="M 2 8 L 8 8"/>
    <g class="tt-flag"><path d="M 8 8 C 20 5, 34 11, 56 8"/></g></svg><span>${label}</span></div>`;
}

export class SailPlan implements Widget {
  readonly root: HTMLElement;
  private readonly pos: TextSlot;
  private readonly tack: TextSlot;
  private readonly hint: TextSlot;
  private readonly hintEl: HTMLElement;
  private readonly hintClass: ClassSlot;
  private readonly trueArrow: AttrSlot;
  private readonly appArrow: AttrSlot;
  private readonly main: SailView;
  private readonly jib: SailView;
  private readonly jibEl: SVGElement;
  private readonly rows: Record<
    'main' | 'jib',
    {
      trim: HTMLElement;
      ease: HTMLElement;
      state: TextSlot;
      stateCls: ClassSlot;
      trimKey: TextSlot;
      easeKey: TextSlot;
    }
  >;
  private readonly tts: Record<'jibWindward' | 'jibLeeward' | 'mainLeech', ClassSlot>;
  private readonly reefPips: HTMLElement[];
  private readonly furl: TextSlot;
  private readonly auto: HTMLElement;
  private readonly trueTxt: TextSlot;
  private readonly appTxt: TextSlot;
  private readonly panel: HTMLElement;
  private readonly flowSpeed: StyleSlot;
  private twa = Number.NaN;
  private awa = Number.NaN;

  constructor() {
    const b = build(
      'hud-sail',
      `<div class="sp-head">
        <div class="sp-pos" data-r="pos"></div>
        <div class="sp-tack" data-r="tack"></div>
        <div class="sp-hint" data-r="hint"></div>
      </div>
      <div class="hud-panel sp-panel" data-r="panel">
        <div class="sp-state">
          <span class="hud-label">Reef</span><span class="sp-pips"><i></i><i></i><i></i></span>
          <span class="hud-label">Jib</span><b data-r="furl"></b>
          <span class="hud-badge is-accent sp-auto" data-r="auto" hidden>Auto trim</span>
        </div>
        <div class="sp-body">
          <div class="sp-side sp-left">
            <div class="sp-btn is-trim" data-r="jibTrim"><span class="sp-arrow">◀</span><span>Trim jib</span><kbd data-r="jibTrimKey"></kbd></div>
            <div class="sp-btn is-trim" data-r="mainTrim"><span class="sp-arrow">◀</span><span>Trim main</span><kbd data-r="mainTrimKey"></kbd></div>
          </div>
          <svg class="sp-svg" viewBox="-110 -110 220 220" aria-hidden="true">
            <circle class="sp-ring" r="100"/>
            <path class="sp-ticks" d="${ticksPath(95, 100, range(0, 330, 30))}"/>
            <path class="sp-nogo" d="${sectorPath(84, 100, -NO_GO_HALF_ANGLE / DEG, NO_GO_HALF_ANGLE / DEG)}"/>
            <path class="sp-gybe" d="${sectorPath(84, 100, 180 - GYBE_ZONE_HALF_ANGLE / DEG, 180 + GYBE_ZONE_HALF_ANGLE / DEG)}"/>
            <path class="sp-hull" d="${HULL}"/>
            <path class="sp-deck" d="M -14 44 H 14 L 12 70 H -12 Z"/>
            ${sailMarkup('jib', TACK_Y, JIB_LEN)}
            ${sailMarkup('main', MAST_Y, BOOM_LEN)}
            <circle class="sp-mast" cy="${MAST_Y}" r="3.2"/>
            <g class="sp-wind sp-true" data-r="true"><path d="M 0 -108 V -82 M -7 -91 L 0 -80 L 7 -91"/></g>
            <g class="sp-wind sp-app" data-r="app"><path d="M 0 -108 V -78 M -8 -88 L 0 -76 L 8 -88"/></g>
          </svg>
          <div class="sp-side sp-right">
            <div class="sp-btn is-ease" data-r="jibEase"><kbd data-r="jibEaseKey"></kbd><span>Ease jib</span><span class="sp-arrow">▶</span></div>
            <div class="sp-btn is-ease" data-r="mainEase"><kbd data-r="mainEaseKey"></kbd><span>Ease main</span><span class="sp-arrow">▶</span></div>
          </div>
        </div>
        <div class="sp-trims">
          <span class="hud-label">Main</span><b data-r="mainState"></b>
          <span class="hud-label">Jib</span><b data-r="jibState"></b>
        </div>
        <div class="sp-foot">
          <div class="sp-legend">
            <span class="sp-key-true"><i></i>True <b data-r="trueTxt"></b></span>
            <span class="sp-key-app"><i></i>Apparent <b data-r="appTxt"></b></span>
          </div>
          <div class="sp-tts" data-r="tts">
            ${telltale('jibWindward', 'Jib windward')}${telltale('jibLeeward', 'Jib leeward')}${telltale('mainLeech', 'Main leech')}
          </div>
        </div>
      </div>`,
    );
    this.root = b.root;
    this.panel = b.ref('panel');
    this.pos = new TextSlot(b.ref('pos'));
    this.tack = new TextSlot(b.ref('tack'));
    this.hintEl = b.ref('hint');
    this.hint = new TextSlot(this.hintEl);
    this.hintClass = new ClassSlot(this.hintEl);
    this.trueArrow = new AttrSlot(b.ref('true'), 'transform');
    this.appArrow = new AttrSlot(b.ref('app'), 'transform');
    const sail = (name: 'main' | 'jib', length: number): SailView => ({
      group: new AttrSlot(b.ref(name), 'transform'),
      ghost: new AttrSlot(b.ref(`${name}Ghost`), 'transform'),
      shape: new AttrSlot(b.ref(`${name}Shape`), 'd'),
      cls: new ClassSlot(b.ref(name)),
      angle: Number.NaN,
      ghostAngle: Number.NaN,
      shapeKey: Number.NaN,
      length,
    });
    this.main = sail('main', BOOM_LEN);
    this.jib = sail('jib', JIB_LEN);
    this.jibEl = b.ref<SVGElement>('jib');
    const row = (name: 'main' | 'jib') => ({
      trim: b.ref(`${name}Trim`),
      ease: b.ref(`${name}Ease`),
      state: new TextSlot(b.ref(`${name}State`)),
      stateCls: new ClassSlot(b.ref(`${name}State`)),
      trimKey: new TextSlot(b.ref(`${name}TrimKey`)),
      easeKey: new TextSlot(b.ref(`${name}EaseKey`)),
    });
    this.rows = { main: row('main'), jib: row('jib') };
    this.tts = {
      jibWindward: new ClassSlot(b.ref('jibWindward')),
      jibLeeward: new ClassSlot(b.ref('jibLeeward')),
      mainLeech: new ClassSlot(b.ref('mainLeech')),
    };
    this.flowSpeed = new StyleSlot(b.ref('tts'), '--tt-speed');
    this.reefPips = [...b.root.querySelectorAll<HTMLElement>('.sp-pips i')];
    this.furl = new TextSlot(b.ref('furl'));
    this.auto = b.ref('auto');
    this.trueTxt = new TextSlot(b.ref('trueTxt'));
    this.appTxt = new TextSlot(b.ref('appTxt'));
  }

  write(m: HudModel, ctx: HudContext): void {
    const s = m.sailing;
    if (!s) return;
    this.pos.set(POINT_OF_SAIL_LABEL[s.pointOfSail]);
    this.tack.set(
      s.pointOfSail === 'in-irons'
        ? 'Head to wind'
        : `${tackOf(s.twa) === 'starboard' ? 'Starboard' : 'Port'} tack`,
    );
    const hint = manoeuvreHint(s);
    show(this.hintEl, hint !== null);
    if (hint) {
      this.hint.set(hint.text);
      this.hintClass.set(hint.tone);
    }
    toggle(this.root, 'is-irons', s.inIrons);
    toggle(this.root, 'is-gybe', s.gybeDanger || isGybeZone(s.twa));
    toggle(this.root, 'is-nogo', isNoGo(s.twa));

    this.reefPips.forEach((pip, i) => toggle(pip, 'is-on', i < s.reef));
    this.furl.set(
      s.jibFurl >= 0.98 ? 'Furled' : s.jibFurl <= 0.02 ? 'Full' : `${formatPercent(s.jibFurl)} furled`,
    );
    show(this.auto, s.autoTrim);
    toggle(this.panel, 'is-auto', s.autoTrim);
    show(this.jibEl, s.jibFurl < 0.98);

    const device = m.controls.device;
    // In irons no sheet will help; the hint says to bear away instead.
    const quiet = s.autoTrim || s.inIrons;
    this.writeRow('main', s.mainTrim, sheetKeys('mainSheet', device), quiet);
    this.writeRow('jib', s.jibFurl >= 0.98 ? null : s.jibTrim, sheetKeys('jibSheet', device), quiet);
    this.main.cls.set(s.mainTrim);
    this.jib.cls.set(s.jibTrim);

    const tt = s.telltales;
    this.tts.jibWindward.set(flowClass(tt.jibWindward));
    this.tts.jibLeeward.set(flowClass(tt.jibLeeward));
    this.tts.mainLeech.set(flowClass(tt.mainLeech));
    // Streamers flick faster in a stronger apparent wind.
    this.flowSpeed.set(`${Math.max(0.18, 0.9 - s.aws * 0.04).toFixed(2)}s`);

    const w = ctx.units.wind;
    this.trueTxt.set(`${joinReading(windReading(s.tws, w))} · ${formatSide(s.twa)}`);
    this.appTxt.set(`${joinReading(windReading(s.aws, w))} · ${formatSide(s.awa)}`);
  }

  private writeRow(
    name: 'main' | 'jib',
    state: TrimState | null,
    keys: { trim: string; ease: string },
    quiet: boolean,
  ): void {
    const r = this.rows[name];
    const advice = state ? trimAdvice(state) : 'hold';
    toggle(r.trim, 'is-active', advice === 'trim' && !quiet);
    toggle(r.ease, 'is-active', advice === 'ease' && !quiet);
    r.trimKey.set(keys.trim);
    r.easeKey.set(keys.ease);
    r.state.set(state ? TRIM_LABEL[state] : 'Furled');
    r.stateCls.set(state);
  }

  animate(m: HudModel, dt: number): void {
    const s = m.sailing;
    if (!s) return;
    this.twa = approachAngle(this.twa, s.twa, dt, NEEDLE_TAU * 2);
    this.awa = approachAngle(this.awa, s.awa, dt, NEEDLE_TAU * 2);
    this.trueArrow.set(`rotate(${deg(this.twa)})`);
    this.appArrow.set(`rotate(${deg(this.awa)})`);
    this.animateSail(this.main, s.boomAngle, s.idealBoomAngle, s.mainTrim, s.awa, dt, 13, MAST_Y);
    const furled = 1 - Math.min(1, s.jibFurl) * 0.85;
    this.jib.length = JIB_LEN * furled;
    this.animateSail(this.jib, s.jibAngle, s.idealJibAngle, s.jibTrim, s.awa, dt, 10, TACK_Y);
  }

  private animateSail(
    v: SailView,
    angle: number,
    ideal: number,
    trim: TrimState,
    awa: number,
    dt: number,
    belly: number,
    pivotY: number,
  ): void {
    v.angle = approach(v.angle, angle, dt, NEEDLE_TAU);
    v.ghostAngle = approach(v.ghostAngle, ideal, dt, NEEDLE_TAU * 3);
    // Positive angle puts the clew to starboard; SVG rotates clockwise, so negate.
    v.group.set(`rotate(${(-deg(v.angle)).toFixed(1)} 0 ${pivotY})`);
    v.ghost.set(`rotate(${(-deg(v.ghostAngle)).toFixed(1)} 0 ${pivotY})`);
    // The cloth bellies to leeward: the side the sail is on, or away from the wind at 0°.
    const side = Math.abs(v.angle) > 0.5 * DEG ? Math.sign(v.angle) : signedAngle(awa) >= 0 ? -1 : 1;
    // A luffing sail loses its shape.
    const depth = belly * side * (trim === 'luffing' ? 0.35 : 1);
    const len = v.length;
    const key = Math.round(depth * 10) * 10_000 + Math.round(len * 10);
    if (key !== v.shapeKey) {
      v.shapeKey = key;
      v.shape.set(
        `M 0 0 C ${(depth * 0.9).toFixed(1)} ${(len * 0.25).toFixed(1)}, ${(depth * 1.05).toFixed(1)} ${(len * 0.6).toFixed(1)}, 0 ${len.toFixed(1)} Z`,
      );
    }
  }
}

function flowClass(flow: number): string {
  if (flow < 0) return 'stall';
  if (flow < 0.35) return 'flutter';
  if (flow < 0.75) return 'lift';
  return 'flow';
}
