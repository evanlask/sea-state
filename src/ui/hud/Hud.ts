// The in-game HUD: what a skipper needs (heading, motion, helm, sails, conditions, alerts,
// fleet), drawn as DOM + inline SVG over the canvas. The app fills a HudModel each frame and
// calls update(); text refreshes at ~20 Hz with cached diffs while needles are smoothed and
// moved every frame with transforms only. Two layouts: powered (helm and engines) and
// sailing (sail plan and wind dial), chosen by whether the model carries a sailing block.

import './hud.css';
import type { HudMode } from '../../settings/schema';
import { toggle } from './dom';
import { DEFAULT_UNITS } from './format';
import type { HudModel } from './model';
import { PeakHold, RideMeter } from './motion';
import { AlertsView, HintsBar } from './widgets/Alerts';
import { CapsizeCard } from './widgets/CapsizeCard';
import { ConditionsPanel } from './widgets/ConditionsPanel';
import { FleetStrip, Radar } from './widgets/Fleet';
import { HeadingTape } from './widgets/HeadingTape';
import { MotionPanel } from './widgets/MotionPanel';
import { PropulsionPanel } from './widgets/PropulsionPanel';
import { SailPlan } from './widgets/SailPlan';
import { StatusBar } from './widgets/StatusBar';
import type { HudContext, HudViewSettings, Widget } from './widgets/widget';
import { WindDial } from './widgets/WindDial';

export type { HudViewSettings } from './widgets/widget';

export const DEFAULT_HUD_SETTINGS: HudViewSettings = {
  mode: 'full',
  scale: 1,
  nightDimming: 'auto',
  redNightTint: false,
  controlHints: true,
  units: DEFAULT_UNITS,
  radar: true,
};

const MODES: readonly HudMode[] = ['full', 'minimal', 'off'];
const WRITE_INTERVAL = 1 / 20;

export class Hud {
  readonly element: HTMLElement;
  private settings: HudViewSettings;
  private model: HudModel | null = null;
  private readonly peaks = { roll: new PeakHold(60), pitch: new PeakHold(60) };
  private readonly ride = new RideMeter();
  private readonly ctx: HudContext;
  private readonly shared: Widget[];
  private readonly powered: Widget[];
  private readonly sailing: Widget[];
  private readonly hints: HintsBar;
  private readonly sailArea: HTMLElement;
  private readonly radarRoot: HTMLElement;
  private time = 0;
  private sinceWrite = Infinity;
  private boatKey = '';

  constructor(parent: HTMLElement, settings: Partial<HudViewSettings> = {}) {
    this.settings = mergeSettings(DEFAULT_HUD_SETTINGS, settings);
    this.ctx = {
      units: this.settings.units,
      settings: this.settings,
      time: 0,
      peaks: this.peaks,
      ride: this.ride,
    };

    const status = new StatusBar();
    const fleet = new FleetStrip();
    const radar = new Radar();
    const tape = new HeadingTape();
    const conditions = new ConditionsPanel();
    const alerts = new AlertsView();
    const capsize = new CapsizeCard();
    const motion = new MotionPanel();
    const propulsion = new PropulsionPanel();
    const sail = new SailPlan();
    const wind = new WindDial();
    this.hints = new HintsBar();
    this.shared = [status, fleet, radar, tape, conditions, alerts, capsize, motion, this.hints];
    this.powered = [propulsion];
    this.sailing = [sail, wind];

    const root = document.createElement('div');
    root.className = 'hud';
    root.setAttribute('aria-label', 'Instruments');
    const area = (name: string, ...children: HTMLElement[]): HTMLElement => {
      const el = document.createElement('div');
      el.className = `hud-area hud-${name}`;
      el.append(...children);
      root.append(el);
      return el;
    };
    area('tl', status.root, fleet.root, radar.root);
    area('tc', tape.root);
    area('tr', conditions.root);
    area('c', alerts.root, capsize.root);
    area('bl', motion.root);
    this.sailArea = area('bc', sail.root, this.hints.root);
    area('br', propulsion.root, wind.root);
    radar.root.dataset.full = '';
    this.radarRoot = radar.root;
    fleet.root.dataset.full = '';
    this.element = root;
    this.applySettings();
    parent.append(root);
  }

  get mode(): HudMode {
    return this.settings.mode;
  }

  // The app calls this every frame (hidden behind menus); only a real change touches the DOM and
  // restarts the 20 Hz text write.
  setMode(mode: HudMode): void {
    if (mode === this.settings.mode) return;
    this.setSettings({ mode });
  }

  // H cycles Full → Minimal → Off.
  cycleMode(): HudMode {
    const next = MODES[(MODES.indexOf(this.settings.mode) + 1) % MODES.length];
    this.setMode(next);
    return next;
  }

  setSettings(patch: Partial<HudViewSettings>): void {
    this.settings = mergeSettings(this.settings, patch);
    this.ctx.settings = this.settings;
    this.ctx.units = this.settings.units;
    this.applySettings();
    this.sinceWrite = Infinity;
  }

  getSettings(): HudViewSettings {
    return this.settings;
  }

  setModel(model: HudModel): void {
    const first = this.model === null;
    this.model = model;
    if (first) this.applySettings();
  }

  update(model: HudModel, dt: number): void {
    const first = this.model === null;
    this.model = model;
    if (first) this.applySettings();
    this.frame(dt);
  }

  // Advances smoothing and the peak / ride trackers; call once per rendered frame.
  frame(dt: number): void {
    const m = this.model;
    if (!m) return;
    const step = Math.max(0, Math.min(0.25, dt));
    this.time += step;
    this.ctx.time = this.time;

    const key = `${m.boat.kind}:${m.boat.name}`;
    if (key !== this.boatKey) {
      this.boatKey = key;
      this.resetPeaks();
      this.sinceWrite = Infinity;
    }
    // Peaks keep tracking with the HUD off, so "max roll this session" stays true.
    this.peaks.roll.add(m.motion.roll, step);
    this.peaks.pitch.add(m.motion.pitch, step);
    this.ride.update(m.motion.verticalG, step);

    if (this.settings.mode === 'off') return;
    const sail = m.sailing !== null;
    this.applyNight(m);
    toggle(this.element, 'is-sailing', sail);
    toggle(this.element, 'is-powered', !sail);
    const active = sail ? this.sailing : m.propulsion ? this.powered : [];

    this.sinceWrite += step;
    if (this.sinceWrite >= WRITE_INTERVAL) {
      this.sinceWrite = 0;
      for (const w of this.shared) w.write(m, this.ctx);
      for (const w of active) w.write(m, this.ctx);
    }
    for (const w of this.shared) w.animate(m, step, this.ctx);
    for (const w of active) w.animate(m, step, this.ctx);
  }

  resetPeaks(): void {
    this.peaks.roll.reset();
    this.peaks.pitch.reset();
    this.ride.reset();
  }

  // Brings the control hints back for a while (e.g. when the player presses a help key).
  showHints(): void {
    this.hints.pulse(this.time);
  }

  dispose(): void {
    this.element.remove();
    this.model = null;
  }

  private applySettings(): void {
    const s = this.settings;
    const el = this.element;
    el.style.setProperty('--hud-scale', String(s.scale));
    this.radarRoot.hidden = !s.radar;
    // Nothing to show until the first model arrives (empty panels would flash while loading).
    el.hidden = s.mode === 'off' || this.model === null;
    toggle(el, 'is-minimal', s.mode === 'minimal');
    if (this.model) this.applyNight(this.model);
  }

  private applyNight(m: HudModel): void {
    const night = m.conditions.isNight;
    toggle(this.element, 'is-dim', night && this.settings.nightDimming === 'auto');
    toggle(this.element, 'is-red', night && this.settings.redNightTint);
    toggle(this.sailArea, 'has-sail', m.sailing !== null);
  }
}

function mergeSettings(base: HudViewSettings, patch: Partial<HudViewSettings>): HudViewSettings {
  return { ...base, ...patch, units: { ...base.units, ...patch.units } };
}
