// Transient alerts (centre) and the camera label + control hints (bottom centre).
// Alerts slide in when their id first appears, stay while the model keeps them (info ones
// fade after a few seconds), and fade out once cleared. Hints show after the boat or camera
// changes, then fade away.

import { build, show, TextSlot, toggle } from '../dom';
import type { HudAlert, HudModel } from '../model';
import type { HudContext, Widget } from './widget';

const INFO_SECONDS = 8;
const LEAVE_SECONDS = 0.6;
// Two at once: more than that is a wall of text in a storm, and the worst comes first anyway.
const MAX_ALERTS = 2;

const ALERT_GLYPH = {
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>',
  danger:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 2h8l6 6v8l-6 6H8l-6-6V8z"/><path d="M12 7v6M12 16.5v.5"/></svg>',
} as const;

interface AlertEntry {
  el: HTMLElement;
  text: TextSlot;
  detail: TextSlot;
  detailEl: HTMLElement;
  severity: HudAlert['severity'];
  shownAt: number;
  leftAt: number | null;
}

export class AlertsView implements Widget {
  readonly root: HTMLElement;
  private entries = new Map<string, AlertEntry>();

  constructor() {
    this.root = build('hud-alerts', '').root;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'assertive');
  }

  write(m: HudModel, ctx: HudContext): void {
    const now = ctx.time;
    const live = new Set<string>();
    const shown: HTMLElement[] = [];
    // The model comes most urgent first; the first MAX_ALERTS still on screen show. An info alert
    // that has had its few seconds stays live (so it doesn't come back) but hidden, freeing its slot.
    for (const alert of m.alerts) {
      let entry = this.entries.get(alert.id);
      const expired =
        entry && entry.severity === alert.severity && alert.severity === 'info'
          ? now - entry.shownAt - INFO_SECONDS
          : -1;
      if (expired > LEAVE_SECONDS) {
        live.add(alert.id);
        if (entry) show(entry.el, false);
        continue;
      }
      if (shown.length >= MAX_ALERTS) continue;
      live.add(alert.id);
      if (!entry || entry.severity !== alert.severity) {
        entry?.el.remove();
        const b = build(
          `hud-alert is-${alert.severity} is-entering`,
          `${ALERT_GLYPH[alert.severity]}<span class="al-body"><span class="al-text" data-r="text"></span><span class="al-detail" data-r="detail"></span></span>`,
        );
        entry = {
          el: b.root,
          text: new TextSlot(b.ref('text')),
          detail: new TextSlot(b.ref('detail')),
          detailEl: b.ref('detail'),
          severity: alert.severity,
          shownAt: now,
          leftAt: null,
        };
        this.entries.set(alert.id, entry);
        this.root.append(entry.el);
        const el = entry.el;
        requestAnimationFrame(() => el.classList.remove('is-entering'));
      }
      entry.leftAt = null;
      toggle(entry.el, 'is-leaving', false);
      entry.text.set(alert.text);
      entry.detail.set(alert.detail ?? '');
      show(entry.detailEl, !!alert.detail);
      toggle(entry.el, 'is-expired', expired > 0);
      shown.push(entry.el);
    }
    // Keep the DOM order matching the model's (severity-sorted) order.
    let prev: HTMLElement | null = null;
    for (const el of shown) {
      const expected: Element | null = prev ? prev.nextElementSibling : this.root.firstElementChild;
      if (expected !== el) {
        if (prev) prev.after(el);
        else this.root.prepend(el);
      }
      prev = el;
    }
    for (const [id, entry] of this.entries) {
      if (live.has(id)) continue;
      if (entry.leftAt === null) {
        entry.leftAt = now;
        entry.el.classList.add('is-leaving');
      } else if (now - entry.leftAt > LEAVE_SECONDS) {
        entry.el.remove();
        this.entries.delete(id);
      }
    }
  }

  animate(): void {}
}

const HINT_SECONDS = 10;
const CAMERA_SECONDS = 4;
const MAX_HINTS = 8;

export class HintsBar implements Widget {
  readonly root: HTMLElement;
  private readonly camera: TextSlot;
  private readonly cameraEl: HTMLElement;
  private readonly hints: HTMLElement;
  private hintKey = '';
  private cameraKey = '';
  private hintsAt = -Infinity;
  private cameraAt = -Infinity;

  constructor() {
    const b = build(
      'hud-foot',
      `<div class="ft-camera" data-r="cam"><span class="hud-label">Camera</span><b data-r="camTxt"></b></div>
      <div class="ft-hints" data-r="hints"></div>`,
    );
    this.root = b.root;
    this.cameraEl = b.ref('cam');
    this.camera = new TextSlot(b.ref('camTxt'));
    this.hints = b.ref('hints');
  }

  // Shows the hints again on demand (e.g. from a help key) without a context change.
  pulse(time: number): void {
    this.hintsAt = time;
    this.cameraAt = time;
  }

  write(m: HudModel, ctx: HudContext): void {
    const now = ctx.time;
    if (m.camera !== this.cameraKey) {
      this.cameraKey = m.camera;
      this.cameraAt = now;
    }
    this.camera.set(m.camera);
    toggle(this.cameraEl, 'is-faded', now - this.cameraAt > CAMERA_SECONDS);

    // Rows with no key bound ('—') are noise here.
    const rows = m.controls.hints.filter((row) => row.keyboard && row.keyboard !== '—').slice(0, MAX_HINTS);
    const key = `${m.boat.kind}|${rows.map((r) => r.label).join(',')}`;
    if (key !== this.hintKey) {
      this.hintKey = key;
      this.hintsAt = now;
      this.hints.replaceChildren(
        ...rows.map((row) => {
          const chip = document.createElement('span');
          chip.className = 'hint';
          const kbd = document.createElement('kbd');
          kbd.textContent = row.keyboard;
          chip.append(kbd, row.label);
          return chip;
        }),
      );
    }
    show(this.hints, ctx.settings.controlHints);
    toggle(this.hints, 'is-faded', now - this.hintsAt > HINT_SECONDS);
  }

  animate(): void {}
}
