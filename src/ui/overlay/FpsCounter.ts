// Player-facing FPS counter (Graphics → FPS counter): a small glass chip tucked under the HUD's
// conditions panel (or in the top-right corner when that panel is hidden), separate from the F3
// developer overlay. The app feeds it each rendered frame's rAF timestamp;
// the text only changes a few times a second, and only when the shown number does.

import './fps-counter.css';
import { FpsMeter, formatFps } from './fpsMeter';

export class FpsCounter {
  readonly element: HTMLElement;
  private readonly meter = new FpsMeter();
  private readonly parent: HTMLElement;
  // Follows the conditions panel's height (it changes with the boat, the weather and the HUD scale).
  private readonly observer = new ResizeObserver(() => this.place());
  private anchor: Element | null = null;
  private enabled: boolean;
  private showing = false;
  private text = '';

  constructor(parent: HTMLElement, options: { enabled: boolean; scale: number }) {
    this.parent = parent;
    this.enabled = options.enabled;
    this.element = document.createElement('div');
    this.element.className = 'fps-counter';
    this.element.hidden = true;
    // A number stream that changes four times a second is noise to a screen reader.
    this.element.setAttribute('aria-hidden', 'true');
    this.setScale(options.scale);
    parent.append(this.element);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.show(false);
  }

  // Follows the HUD scale setting.
  setScale(scale: number): void {
    this.element.style.setProperty('--hud-scale', String(scale));
  }

  // Per rendered frame. `active` is false while menus, the main-menu backdrop or photo mode are up.
  frame(nowMs: number, active: boolean): void {
    const show = this.enabled && active;
    this.show(show);
    if (!show) return;
    const fps = this.meter.frame(nowMs);
    if (fps !== null) this.write(formatFps(fps));
  }

  dispose(): void {
    this.show(false);
    this.observer.disconnect();
    this.element.remove();
  }

  private show(show: boolean): void {
    if (show === this.showing) return;
    this.showing = show;
    this.element.hidden = !show;
    this.observer.disconnect();
    // The HUD is built after this, so the panel is looked up when the chip appears.
    this.anchor = show ? this.parent.querySelector('.hud-tr') : null;
    if (this.anchor) this.observer.observe(this.anchor);
    this.place();
    // Frames from before it was hidden would skew the first reading.
    this.meter.reset();
    if (show) this.write(formatFps(null));
  }

  // Just below the conditions panel; the corner when the HUD is off.
  private place(): void {
    const panel = this.anchor?.getBoundingClientRect();
    const top =
      panel && panel.height > 0 ? `${panel.bottom - this.parent.getBoundingClientRect().top}px` : '';
    this.element.style.setProperty('--fps-top', top);
  }

  private write(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.element.textContent = text;
  }
}
