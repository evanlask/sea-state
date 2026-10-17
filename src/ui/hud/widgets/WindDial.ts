// Sailing wind instrument (bottom right): a classic bow-up dial with the AWA needle (yellow)
// and TWA needle (blue), port red / starboard green close-hauled sectors, the shaded no-go
// zone round the bow and the gybe zone round the stern, and markers at the polar's best
// upwind and downwind VMG angles.

import { DEG } from '../../../sim/core/conventions';
import { AttrSlot, build, deg, range, sectorPath, TextSlot, ticksPath, toggle } from '../dom';
import { formatSide, windReading } from '../format';
import type { HudModel } from '../model';
import { approachAngle } from '../motion';
import { GYBE_ZONE_HALF_ANGLE, isGybeZone, isNoGo, NO_GO_HALF_ANGLE } from '../sailing';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

function labels(): string {
  return [30, 60, 90, 120, 150, -30, -60, -90, -120, -150]
    .map((d) => {
      const a = d * DEG;
      return `<text class="wd-txt" x="${(70 * Math.sin(a)).toFixed(1)}" y="${(-70 * Math.cos(a) + 3.5).toFixed(1)}">${Math.abs(d)}</text>`;
    })
    .join('');
}

// Inward-pointing triangle on the rim at a dial angle.
const marker = (d: number): string => {
  const a = d * DEG;
  const x = 99 * Math.sin(a);
  const y = -99 * Math.cos(a);
  return `<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${d})" d="M 0 6 L -5 -3 L 5 -3 Z"/>`;
};

export class WindDial implements Widget {
  readonly root: HTMLElement;
  private readonly awaNeedle: AttrSlot;
  private readonly twaNeedle: AttrSlot;
  private readonly vmgGroup: SVGGElement;
  private readonly centreAwa: TextSlot;
  private readonly aws: TextSlot;
  private readonly awsUnit: TextSlot;
  private readonly awaTxt: TextSlot;
  private readonly awaSide: TextSlot;
  private readonly twsTxt: TextSlot;
  private readonly twaTxt: TextSlot;
  private readonly vmgTxt: TextSlot;
  private awa = Number.NaN;
  private twa = Number.NaN;
  private vmgKey = '';

  constructor() {
    const ng = NO_GO_HALF_ANGLE / DEG;
    const gz = GYBE_ZONE_HALF_ANGLE / DEG;
    const b = build(
      'hud-panel hud-wind',
      `<div class="hud-title">Wind</div>
      <div class="wd-dial">
        <svg class="wd-svg" viewBox="-110 -110 220 220" aria-hidden="true">
          <circle class="wd-face" r="104"/>
          <path class="wd-nogo" d="${sectorPath(24, 92, -ng, ng)}"/>
          <path class="wd-gybe" d="${sectorPath(24, 92, 180 - gz, 180 + gz)}"/>
          <path class="wd-band port" d="${sectorPath(84, 92, -60, -20)}"/>
          <path class="wd-band stbd" d="${sectorPath(84, 92, 20, 60)}"/>
          <path class="wd-tick" d="${ticksPath(84, 92, range(0, 350, 10))}"/>
          <path class="wd-tick major" d="${ticksPath(80, 94, range(0, 330, 30))}"/>
          ${labels()}
          <text class="wd-zone" x="0" y="-44">NO GO</text>
          <text class="wd-zone gybe" x="0" y="52">GYBE</text>
          <path class="wd-bow" d="M 0 -104 l -6 9 h 12 z"/>
          <g class="wd-vmg" data-r="vmg"></g>
          <g class="wd-needle wd-twa" data-r="twa"><path d="M -2 -10 L -1.2 -78 L 0 -86 L 1.2 -78 L 2 -10 Z"/></g>
          <g class="wd-needle wd-awa" data-r="awa"><path d="M -3.4 -12 L -1.6 -86 L 0 -97 L 1.6 -86 L 3.4 -12 Z"/></g>
          <circle class="wd-hub" r="27"/>
        </svg>
        <div class="wd-centre"><b data-r="aws">0</b><span data-r="awsUnit">kn</span><span class="wd-awa-txt" data-r="awa-txt"></span></div>
      </div>
      <div class="wd-read">
        <div class="wd-app"><span class="hud-label">App</span><b data-r="awaTxt2"></b><span data-r="awaSide"></span></div>
        <div class="wd-true"><span class="hud-label">True</span><b data-r="tws"></b><span data-r="twaTxt"></span></div>
        <div class="wd-vmgtxt"><span class="hud-label">Best VMG</span><span data-r="vmgTxt"></span></div>
      </div>`,
    );
    this.root = b.root;
    this.awaNeedle = new AttrSlot(b.ref('awa'), 'transform');
    this.twaNeedle = new AttrSlot(b.ref('twa'), 'transform');
    this.aws = new TextSlot(b.ref('aws'));
    this.awsUnit = new TextSlot(b.ref('awsUnit'));
    this.awaTxt = new TextSlot(b.ref('awaTxt2'));
    this.awaSide = new TextSlot(b.ref('awaSide'));
    this.twsTxt = new TextSlot(b.ref('tws'));
    this.twaTxt = new TextSlot(b.ref('twaTxt'));
    this.vmgTxt = new TextSlot(b.ref('vmgTxt'));
    this.vmgGroup = b.ref<SVGGElement>('vmg');
    this.centreAwa = new TextSlot(b.ref('awa-txt'));
  }

  write(m: HudModel, ctx: HudContext): void {
    const s = m.sailing;
    if (!s) return;
    const aws = windReading(s.aws, ctx.units.wind);
    this.aws.set(aws.value);
    this.awsUnit.set(aws.unit ? `${aws.unit} AWS` : 'AWS');
    this.centreAwa.set(formatSide(s.awa));
    this.awaSide.set(formatSide(s.awa));
    this.awaTxt.set(`${aws.value}${aws.unit ? ` ${aws.unit}` : ''}`);
    const tws = windReading(s.tws, ctx.units.wind);
    this.twsTxt.set(`${tws.value}${tws.unit ? ` ${tws.unit}` : ''}`);
    this.twaTxt.set(formatSide(s.twa));
    this.vmgTxt.set(`▲ ${Math.round(s.bestUpwindTwa / DEG)}°  ▼ ${Math.round(s.bestDownwindTwa / DEG)}°`);
    toggle(this.root, 'is-nogo', isNoGo(s.twa));
    toggle(this.root, 'is-gybe', isGybeZone(s.twa) || s.gybeDanger);

    const key = `${s.bestUpwindTwa.toFixed(3)}:${s.bestDownwindTwa.toFixed(3)}`;
    if (key !== this.vmgKey) {
      this.vmgKey = key;
      const up = s.bestUpwindTwa / DEG;
      const down = s.bestDownwindTwa / DEG;
      this.vmgGroup.innerHTML = [up, -up, down, -down].map(marker).join('');
    }
  }

  animate(m: HudModel, dt: number): void {
    const s = m.sailing;
    if (!s) return;
    this.awa = approachAngle(this.awa, s.awa, dt, NEEDLE_TAU * 1.5);
    this.twa = approachAngle(this.twa, s.twa, dt, NEEDLE_TAU * 2);
    this.awaNeedle.set(`rotate(${deg(this.awa)})`);
    this.twaNeedle.set(`rotate(${deg(this.twa)})`);
  }
}
