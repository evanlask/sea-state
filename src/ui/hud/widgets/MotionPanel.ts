// Boat motion cluster (bottom left): big speed, the attitude gauge and the ride meter. The
// gauge shows a stern-on boat that rolls against a pitching horizon, the roll scale with the
// boat's own red danger zone (from its GZ curve), 60 s peak-hold markers and the session max;
// sailing adds the fast-heel band, performance numbers and the reef advice.

import { DEG } from '../../../sim/core/conventions';
import { msToKnots } from '../../../sim/core/units';
import {
  arcPath,
  AttrSlot,
  build,
  ClassSlot,
  deg,
  range,
  sectorPath,
  show,
  StyleSlot,
  TextSlot,
  ticksPath,
  toggle,
} from '../dom';
import { formatDegrees, formatSide, formatSpeed, speedReading } from '../format';
import { buttonKey } from '../hints';
import type { HudModel } from '../model';
import { approach } from '../motion';
import { FAST_HEEL_BAND, reefAdvice } from '../sailing';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

const PITCH_UNITS = 2.6; // SVG units per degree of pitch
const SCALE_LIMIT = 135; // degrees of roll the arc shows either side
const DISC_R = 60;
const ARC_R0 = 67;
const ARC_R1 = 75;

let gaugeCount = 0;

function ladder(): string {
  let out = '';
  for (const p of [-30, -20, -15, -10, -5, 5, 10, 15, 20, 30]) {
    const y = -p * PITCH_UNITS;
    const w = p % 10 === 0 ? 18 : 9;
    out += `<path class="att-rung" d="M ${-w} ${y} H ${w}"/>`;
    if (p % 10 === 0) {
      out += `<text class="att-rung-txt" x="${w + 4}" y="${y + 2.8}">${Math.abs(p)}</text>`;
    }
  }
  return out;
}

function scale(): string {
  const minor = range(-SCALE_LIMIT, SCALE_LIMIT, 5).filter((d) => d % 15 !== 0);
  const major = range(-SCALE_LIMIT, SCALE_LIMIT, 15);
  const labels = [-90, -60, -30, 30, 60, 90]
    .map((d) => {
      const a = d * DEG;
      return `<text class="att-scale-txt" x="${(85 * Math.sin(a)).toFixed(1)}" y="${(-85 * Math.cos(a) + 3).toFixed(1)}">${Math.abs(d)}</text>`;
    })
    .join('');
  return `<path class="att-arc" d="${arcPath(ARC_R0, -SCALE_LIMIT, SCALE_LIMIT)}"/>
    <path class="att-tick" d="${ticksPath(ARC_R0, ARC_R0 + 4, minor)}"/>
    <path class="att-tick major" d="${ticksPath(ARC_R0, ARC_R1 + 2, major)}"/>${labels}
    <text class="att-side-txt port" x="-90" y="-62">P</text>
    <text class="att-side-txt stbd" x="90" y="-62">S</text>`;
}

export class MotionPanel implements Widget {
  readonly root: HTMLElement;
  private readonly boat: AttrSlot;
  private readonly sea: AttrSlot;
  private readonly peakHi: AttrSlot;
  private readonly peakLo: AttrSlot;
  private readonly pitchMark: AttrSlot;
  private readonly pitchHi: AttrSlot;
  private readonly pitchLo: AttrSlot;
  private readonly danger: AttrSlot;
  private readonly capsize: AttrSlot;
  private readonly fast: SVGElement;
  private readonly speedVal: TextSlot;
  private readonly speedUnit: TextSlot;
  private readonly rollTxt: TextSlot;
  private readonly pitchTxt: TextSlot;
  private readonly peakTxt: TextSlot;
  private readonly maxTxt: TextSlot;
  private readonly plane: HTMLElement;
  private readonly air: HTMLElement;
  private readonly rideTxt: TextSlot;
  private readonly rideG: TextSlot;
  private readonly rideClass: ClassSlot;
  private readonly ridePtr: StyleSlot;
  private readonly slamsTxt: TextSlot;
  private readonly slamFlash: HTMLElement;
  private readonly perf: HTMLElement;
  private readonly pctTxt: TextSlot;
  private readonly tgtTxt: TextSlot;
  private readonly pctFill: StyleSlot;
  private readonly vmgTxt: TextSlot;
  private readonly reefEl: HTMLElement;
  private readonly reefTxt: TextSlot;
  private readonly reefClass: ClassSlot;
  private readonly rollClass: ClassSlot;
  private roll = 0;
  private pitch = 0;
  private ridePos = 0;
  private lastSlams = -1;
  private zoneKey = '';

  constructor() {
    const id = `hud-att-clip-${++gaugeCount}`;
    const b = build(
      'hud-panel hud-motion',
      `<div class="mo-gauge">
        <svg class="att" viewBox="-100 -100 200 200" aria-hidden="true">
          <defs><clipPath id="${id}"><circle r="${DISC_R}"/></clipPath></defs>
          <g clip-path="url(#${id})">
            <g data-r="sea">
              <rect class="att-sky" x="-120" y="-240" width="240" height="240"/>
              <rect class="att-sea" x="-120" y="0" width="240" height="240"/>
              <path class="att-horizon" d="M -120 0 H 120"/>
              ${ladder()}
            </g>
          </g>
          <circle class="att-rim" r="${DISC_R}"/>
          ${scale()}
          <path class="att-fast" data-r="fast" d="${sectorPath(ARC_R0, ARC_R1, FAST_HEEL_BAND[0] / DEG, FAST_HEEL_BAND[1] / DEG)} ${sectorPath(ARC_R0, ARC_R1, -FAST_HEEL_BAND[1] / DEG, -FAST_HEEL_BAND[0] / DEG)}"/>
          <path class="att-danger" data-r="danger"/>
          <path class="att-capsize" data-r="capsize"/>
          <g class="att-pitch-scale">
            <path class="att-tick" d="M 52 -26 V 26 M 49 0 H 55"/>
            <path class="att-pitch-peak" data-r="pitchHi" d="M 55 0 l 5 -3 v 6 z"/>
            <path class="att-pitch-peak" data-r="pitchLo" d="M 55 0 l 5 -3 v 6 z"/>
            <path class="att-pitch-now" data-r="pitchMark" d="M 49 0 l -5 -3.5 v 7 z"/>
          </g>
          <path class="att-peak" data-r="peakHi" d="M 0 ${-ARC_R1 - 1} l -3.5 -6 h 7 z"/>
          <path class="att-peak" data-r="peakLo" d="M 0 ${-ARC_R1 - 1} l -3.5 -6 h 7 z"/>
          <g data-r="boat" class="att-boat">
            <path class="att-mast" d="M 0 -4 V ${-ARC_R0 + 3}"/>
            <path class="att-pointer" d="M 0 ${-ARC_R0 + 1} l -4.5 7 h 9 z"/>
            <path class="att-hull" d="M -30 -6 H 30 L 22 6 Q 0 14 -22 6 Z"/>
            <path class="att-keel" d="M -3 10 L -2 22 H 2 L 3 10"/>
          </g>
        </svg>
        <div class="mo-readouts">
          <div class="mo-roll" data-r="rollBox"><span class="hud-label">Roll</span><b data-r="roll">0°</b></div>
          <div><span class="hud-label">Pitch</span><b data-r="pitch">0°</b></div>
        </div>
        <div class="mo-peaks"><span data-r="peak"></span><span data-r="max"></span></div>
      </div>
      <div class="mo-side">
        <div class="mo-speed"><b data-r="speed">0.0</b><span data-r="unit">kn</span></div>
        <div class="hud-label">Speed over ground</div>
        <div class="mo-badges">
          <span class="hud-badge is-good" data-r="plane" hidden>On plane</span>
          <span class="hud-badge is-warn" data-r="air" hidden>Airborne</span>
        </div>
        <div class="mo-perf" data-r="perf" hidden>
          <div class="mo-perf-row"><span class="hud-label">Polar</span><b data-r="pct">0%</b><span data-r="tgt"></span></div>
          <div class="hud-bar mo-perf-bar"><div class="hud-bar-fill" data-r="pctFill"></div><i class="mo-perf-100"></i></div>
          <div class="mo-perf-row"><span class="hud-label">VMG</span><b data-r="vmg">0.0</b></div>
        </div>
        <div class="mo-reef" data-r="reef" hidden><span data-r="reefTxt"></span></div>
        <div class="mo-ride" data-r="ride">
          <div class="mo-ride-head"><span class="hud-label">Ride</span><b data-r="rideTxt">Calm</b><span data-r="rideG"></span></div>
          <div class="ride-bar"><i class="seg calm"></i><i class="seg lively"></i><i class="seg violent"></i>
            <div class="ride-track" data-r="ridePtr"><i class="ride-ptr"></i></div></div>
          <div class="mo-slams"><span class="hud-label">Slams</span><b data-r="slams">0</b><i class="slam-flash" data-r="flash"></i></div>
        </div>
      </div>`,
    );
    this.root = b.root;
    this.boat = new AttrSlot(b.ref('boat'), 'transform');
    this.sea = new AttrSlot(b.ref('sea'), 'transform');
    this.peakHi = new AttrSlot(b.ref('peakHi'), 'transform');
    this.peakLo = new AttrSlot(b.ref('peakLo'), 'transform');
    this.pitchMark = new AttrSlot(b.ref('pitchMark'), 'transform');
    this.pitchHi = new AttrSlot(b.ref('pitchHi'), 'transform');
    this.pitchLo = new AttrSlot(b.ref('pitchLo'), 'transform');
    this.danger = new AttrSlot(b.ref('danger'), 'd');
    this.capsize = new AttrSlot(b.ref('capsize'), 'd');
    this.fast = b.ref<SVGElement>('fast');
    this.speedVal = new TextSlot(b.ref('speed'));
    this.speedUnit = new TextSlot(b.ref('unit'));
    this.rollTxt = new TextSlot(b.ref('roll'));
    this.rollClass = new ClassSlot(b.ref('rollBox'));
    this.pitchTxt = new TextSlot(b.ref('pitch'));
    this.peakTxt = new TextSlot(b.ref('peak'));
    this.maxTxt = new TextSlot(b.ref('max'));
    this.plane = b.ref('plane');
    this.air = b.ref('air');
    this.rideTxt = new TextSlot(b.ref('rideTxt'));
    this.rideG = new TextSlot(b.ref('rideG'));
    this.rideClass = new ClassSlot(b.ref('ride'));
    this.ridePtr = new StyleSlot(b.ref('ridePtr'), 'transform');
    this.slamsTxt = new TextSlot(b.ref('slams'));
    this.slamFlash = b.ref('flash');
    this.perf = b.ref('perf');
    this.pctTxt = new TextSlot(b.ref('pct'));
    this.tgtTxt = new TextSlot(b.ref('tgt'));
    this.pctFill = new StyleSlot(b.ref('pctFill'), 'transform');
    this.vmgTxt = new TextSlot(b.ref('vmg'));
    this.reefEl = b.ref('reef');
    this.reefTxt = new TextSlot(b.ref('reefTxt'));
    this.reefClass = new ClassSlot(this.reefEl);
  }

  write(m: HudModel, ctx: HudContext): void {
    const sail = m.sailing;
    toggle(this.root, 'is-sail', sail !== null);
    show(this.fast, sail !== null);
    const speed = speedReading(m.motion.speed, ctx.units.speed);
    this.speedVal.set(speed.value);
    this.speedUnit.set(speed.unit);

    const { roll, pitch } = m.motion;
    const heel = Math.abs(roll);
    const { dangerHeel, avs } = m.boat.stability;
    this.rollTxt.set(formatSide(roll));
    this.rollClass.set(heel >= dangerHeel ? 'danger' : heel >= dangerHeel * 0.75 ? 'warn' : null);
    const pitchDeg = pitch / DEG;
    this.pitchTxt.set(
      `${Math.abs(pitchDeg).toFixed(1)}° ${pitchDeg > 0.05 ? '▲' : pitchDeg < -0.05 ? '▼' : ''}`.trim(),
    );
    const { roll: rp } = ctx.peaks;
    this.peakTxt.set(`60 s  P ${formatDegrees(-rp.low)} · S ${formatDegrees(rp.high)}`);
    this.maxTxt.set(`Session max ${formatDegrees(rp.sessionMaxAbs)}`);

    // Danger zone only rebuilds when the boat (its stability) changes.
    const key = `${dangerHeel.toFixed(4)}:${avs.toFixed(4)}`;
    if (key !== this.zoneKey) {
      this.zoneKey = key;
      const d0 = Math.min(dangerHeel / DEG, SCALE_LIMIT);
      const d1 = Math.min(avs / DEG, SCALE_LIMIT);
      this.danger.set(
        d1 > d0 ? `${sectorPath(ARC_R0, ARC_R1, d0, d1)} ${sectorPath(ARC_R0, ARC_R1, -d1, -d0)}` : '',
      );
      this.capsize.set(
        d1 < SCALE_LIMIT
          ? `${sectorPath(ARC_R0, ARC_R1, d1, SCALE_LIMIT)} ${sectorPath(ARC_R0, ARC_R1, -SCALE_LIMIT, -d1)}`
          : '',
      );
    }

    const kind = m.boat.kind;
    show(this.plane, (kind === 'powerboat' || kind === 'pwc') && m.motion.onPlane && !m.motion.airborne);
    show(this.air, m.motion.airborne);

    const level = ctx.ride.level;
    this.rideClass.set(level);
    this.rideTxt.set(level === 'calm' ? 'Calm' : level === 'lively' ? 'Lively' : 'Violent');
    this.rideG.set(`${ctx.ride.envelope.toFixed(2)} g`);
    this.slamsTxt.set(String(m.motion.slams));
    if (this.lastSlams >= 0 && m.motion.slams > this.lastSlams) {
      // Restart the flash animation.
      this.slamFlash.classList.remove('is-on');
      void this.slamFlash.offsetWidth;
      this.slamFlash.classList.add('is-on');
    }
    this.lastSlams = m.motion.slams;

    show(this.perf, sail !== null);
    if (!sail) {
      show(this.reefEl, false);
      return;
    }
    this.pctTxt.set(`${Math.round(sail.targetPct * 100)}%`);
    this.tgtTxt.set(`of ${formatSpeed(sail.targetSpeed, ctx.units.speed)}`);
    this.pctFill.set(`scaleX(${Math.max(0, Math.min(1.2, sail.targetPct) / 1.2).toFixed(3)})`);
    const vmg = speedReading(Math.abs(sail.vmg), ctx.units.speed);
    this.vmgTxt.set(`${vmg.value} ${vmg.unit} ${sail.vmg >= 0 ? '▲ upwind' : '▼ downwind'}`);
    const advice = reefAdvice(sail.tws, sail.heel, sail.reef);
    const device = m.controls.device;
    show(this.reefEl, advice.overpowered || advice.shakeOut);
    if (advice.overpowered && sail.reef < 3) {
      this.reefClass.set('warn');
      this.reefTxt.set(`Overpowered — reef  [${buttonKey('reefIn', device)}]`);
    } else if (advice.overpowered) {
      this.reefClass.set('danger');
      this.reefTxt.set('Too much wind — roll up the jib, steer away from the wind');
    } else if (advice.shakeOut) {
      this.reefClass.set('info');
      this.reefTxt.set(
        `Under-canvassed (${Math.round(msToKnots(sail.tws))} kn) — shake out  [${buttonKey('reefOut', device)}]`,
      );
    }
  }

  animate(m: HudModel, dt: number, ctx: HudContext): void {
    this.roll = approach(this.roll, m.motion.roll, dt, NEEDLE_TAU);
    this.pitch = approach(this.pitch, m.motion.pitch, dt, NEEDLE_TAU);
    this.boat.set(`rotate(${deg(this.roll)})`);
    const pitchY = clampPitch(this.pitch / DEG) * PITCH_UNITS;
    this.sea.set(`translate(0 ${pitchY.toFixed(1)})`);
    this.pitchMark.set(`translate(0 ${(-clampScale(this.pitch / DEG)).toFixed(1)})`);
    const { roll: rp, pitch: pp } = ctx.peaks;
    this.peakHi.set(`rotate(${deg(Math.min(rp.high, SCALE_LIMIT * DEG))})`);
    this.peakLo.set(`rotate(${deg(Math.max(rp.low, -SCALE_LIMIT * DEG))})`);
    this.pitchHi.set(`translate(0 ${(-clampScale(pp.high / DEG)).toFixed(1)})`);
    this.pitchLo.set(`translate(0 ${(-clampScale(pp.low / DEG)).toFixed(1)})`);
    this.ridePos = approach(this.ridePos, Math.min(1, ctx.ride.envelope / 0.8), dt, NEEDLE_TAU * 2);
    this.ridePtr.set(`translateX(${(this.ridePos * 100).toFixed(1)}%)`);
  }
}

// The horizon disc only shows ±30° of pitch before it would leave the gauge.
const clampPitch = (d: number): number => Math.max(-30, Math.min(30, d));
// The side pitch scale spans ±26 units for ±20°.
const clampScale = (d: number): number => Math.max(-20, Math.min(20, d)) * 1.3;
