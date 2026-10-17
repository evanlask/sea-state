// Conditions panel (top right): wind relative to the boat with speed, gusts and the Beaufort
// force; sea state with the Douglas description; swell; weather and visibility; nearby
// lightning; local time with sunrise / sunset, and the moon at night. In Minimal mode only
// the wind row stays, as the compact wind panel.

import { AttrSlot, build, deg, show, TextSlot, toggle } from '../dom';
import {
  beaufortLabel,
  cardinal,
  douglasName,
  formatBearing,
  formatClock,
  formatLength,
  formatRange,
  formatSeconds,
  formatVisibility,
  joinReading,
  moonPhaseName,
  windReading,
} from '../format';
import { BOLT_ICON, moonPath, SUNRISE_ICON, SUNSET_ICON, SWELL_ICON, WAVE_ICON, weatherIcon } from '../icons';
import type { HudModel } from '../model';
import { approachAngle } from '../motion';
import { type HudContext, NEEDLE_TAU, type Widget } from './widget';

export class ConditionsPanel implements Widget {
  readonly root: HTMLElement;
  private readonly arrow: AttrSlot;
  private readonly wind: TextSlot;
  private readonly windUnit: TextSlot;
  private readonly gust: TextSlot;
  private readonly force: TextSlot;
  private readonly windFrom: TextSlot;
  private readonly sea: TextSlot;
  private readonly seaSub: TextSlot;
  private readonly swellRow: HTMLElement;
  private readonly swell: TextSlot;
  private readonly wxIcon: HTMLElement;
  private readonly wx: TextSlot;
  private readonly visibility: TextSlot;
  private readonly visEl: HTMLElement;
  private readonly boltRow: HTMLElement;
  private readonly bolt: TextSlot;
  private readonly time: TextSlot;
  private readonly sunrise: TextSlot;
  private readonly sunset: TextSlot;
  private readonly sunTimes: HTMLElement;
  private readonly polarEl: HTMLElement;
  private readonly polar: TextSlot;
  private readonly moonRow: HTMLElement;
  private readonly moonLit: AttrSlot;
  private readonly moon: TextSlot;
  private iconKey = '';
  private rel = Number.NaN;

  constructor() {
    const b = build(
      'hud-panel hud-cond',
      `<div class="cd-head">
        <span class="hud-title">Conditions</span>
        <span class="cd-time"><b data-r="time">00:00</b>
          <span class="cd-sun" data-r="sunTimes">${SUNRISE_ICON}<span data-r="sunrise"></span>${SUNSET_ICON}<span data-r="sunset"></span></span><span class="cd-sun" data-r="polar" hidden></span></span>
      </div>
      <div class="cd-row cd-wind">
        <svg class="cd-rose" viewBox="-30 -30 60 60" aria-hidden="true">
          <circle class="cd-rose-ring" r="27"/>
          <path class="cd-rose-boat" d="M 0 -12 C 5 -6 6 2 5 11 H -5 C -6 2 -5 -6 0 -12 Z"/>
          <g data-r="arrow" class="cd-rose-arrow"><path d="M 0 -28 V -15 M -5 -20 L 0 -13 L 5 -20"/></g>
        </svg>
        <div class="cd-text">
          <div class="cd-main"><b data-r="wind">0</b><span data-r="windUnit">kn</span><span class="cd-gust" data-r="gust"></span></div>
          <div class="cd-force" data-r="force"></div>
          <div class="cd-sub" data-r="windFrom"></div>
        </div>
      </div>
      <div class="cd-row" data-full>${WAVE_ICON}<div class="cd-text"><div class="cd-line"><span class="hud-label">Sea</span><b data-r="sea"></b></div><div class="cd-sub" data-r="seaSub"></div></div></div>
      <div class="cd-row" data-full data-r="swellRow">${SWELL_ICON}<div class="cd-text"><div class="cd-line"><span class="hud-label">Swell</span><b data-r="swell"></b></div></div></div>
      <div class="cd-row" data-full><span data-r="wxIcon"></span><div class="cd-text"><div class="cd-line"><b data-r="wx"></b></div><div class="cd-sub" data-r="vis"></div></div></div>
      <div class="cd-row cd-bolt" data-full data-r="boltRow">${BOLT_ICON}<div class="cd-text"><div class="cd-line"><b data-r="bolt"></b></div></div></div>
      <div class="cd-row cd-moon" data-full data-r="moonRow">
        <svg class="hud-icon" viewBox="-12 -12 24 24" aria-hidden="true"><circle class="i-moon-dark" r="9"/><path class="i-moon-lit" data-r="moonLit"/></svg>
        <div class="cd-text"><div class="cd-line"><b data-r="moon"></b></div></div>
      </div>`,
    );
    this.root = b.root;
    this.arrow = new AttrSlot(b.ref('arrow'), 'transform');
    this.wind = new TextSlot(b.ref('wind'));
    this.windUnit = new TextSlot(b.ref('windUnit'));
    this.gust = new TextSlot(b.ref('gust'));
    this.force = new TextSlot(b.ref('force'));
    this.windFrom = new TextSlot(b.ref('windFrom'));
    this.sea = new TextSlot(b.ref('sea'));
    this.seaSub = new TextSlot(b.ref('seaSub'));
    this.swellRow = b.ref('swellRow');
    this.swell = new TextSlot(b.ref('swell'));
    this.wxIcon = b.ref('wxIcon');
    this.wx = new TextSlot(b.ref('wx'));
    this.visEl = b.ref('vis');
    this.visibility = new TextSlot(this.visEl);
    this.boltRow = b.ref('boltRow');
    this.bolt = new TextSlot(b.ref('bolt'));
    this.time = new TextSlot(b.ref('time'));
    this.sunrise = new TextSlot(b.ref('sunrise'));
    this.sunset = new TextSlot(b.ref('sunset'));
    this.sunTimes = b.ref('sunTimes');
    this.polarEl = b.ref('polar');
    this.polar = new TextSlot(this.polarEl);
    this.moonRow = b.ref('moonRow');
    this.moonLit = new AttrSlot(b.ref('moonLit'), 'd');
    this.moon = new TextSlot(b.ref('moon'));
  }

  write(m: HudModel, ctx: HudContext): void {
    const c = m.conditions;
    const u = ctx.units;
    const w = windReading(c.windSpeed, u.wind);
    this.wind.set(w.value);
    this.windUnit.set(w.unit);
    const gust = windReading(c.windGust, u.wind);
    this.gust.set(c.windGust > c.windSpeed * 1.1 ? `gust ${joinReading(gust)}` : '');
    this.force.set(beaufortLabel(c.beaufort, c.beaufortName));
    this.windFrom.set(`from ${formatBearing(c.windFrom)} ${cardinal(c.windFrom)}`);
    toggle(this.root, 'is-gale', c.beaufort >= 8);

    this.sea.set(`${formatLength(c.hs, u.length)} · ${formatSeconds(c.tp)} · ${formatBearing(c.waveFrom)}`);
    this.seaSub.set(`${douglasName(c.douglas, c.douglasName)} — Douglas ${Math.round(c.douglas)}`);
    show(this.swellRow, c.swell !== null);
    if (c.swell) {
      this.swell.set(
        `${formatLength(c.swell.height, u.length)} · ${formatSeconds(c.swell.period)} · ${formatBearing(c.swell.from)}`,
      );
    }

    const key = `${c.weather.icon}:${c.isNight}`;
    if (key !== this.iconKey) {
      this.iconKey = key;
      this.wxIcon.innerHTML = weatherIcon(c.weather.icon, c.isNight);
    }
    this.wx.set(c.weather.summary);
    this.visibility.set(`Visibility ${formatVisibility(c.visibility, u)}`);
    toggle(this.visEl, 'is-poor', c.visibility < 2000);

    show(this.boltRow, c.lightningDistance !== null);
    if (c.lightningDistance !== null) this.bolt.set(`Thunderstorm ${formatRange(c.lightningDistance, u)}`);
    toggle(this.boltRow, 'is-near', (c.lightningDistance ?? Infinity) < 5000);

    this.time.set(formatClock(c.localTime));
    this.sunrise.set(c.sunrise === null ? '—' : formatClock(c.sunrise));
    this.sunset.set(c.sunset === null ? '—' : formatClock(c.sunset));
    // Midnight sun or polar night: no sunrise and sunset to show, so say which.
    show(this.sunTimes, c.polar === null);
    show(this.polarEl, c.polar !== null);
    this.polar.set(c.polar === 'polar-day' ? 'Midnight sun' : c.polar === 'polar-night' ? 'Polar night' : '');
    show(this.moonRow, c.isNight && c.moon !== null);
    if (c.isNight && c.moon) {
      this.moonLit.set(moonPath(c.moon.phase, 9));
      this.moon.set(`${moonPhaseName(c.moon.phase)} · ${Math.round(c.moon.fraction * 100)}%`);
    }
  }

  animate(m: HudModel, dt: number): void {
    // Arrow sits on the side the wind comes from, pointing at the boat.
    this.rel = approachAngle(this.rel, m.conditions.windFrom - m.motion.heading, dt, NEEDLE_TAU * 3);
    this.arrow.set(`rotate(${deg(this.rel)})`);
  }
}
