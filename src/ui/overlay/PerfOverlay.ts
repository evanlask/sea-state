// F3 performance overlay: a small monospace panel, separate from the skipper's HUD. The
// app feeds it once per frame (cheap: numbers only); the DOM updates at ~4 Hz.

import './perf-overlay.css';
import { PerfStats, formatReadout } from './perfStats';

export interface PerfFrameInput {
  // rAF timestamp in ms; defaults to performance.now().
  now?: number;
  simStepMs?: number;
  // Fixed sim steps run for this frame.
  simSteps?: number;
  // Only when the 'timestamp-query' feature is available.
  gpuMs?: number | null;
  // e.g. renderer.info.render from three's WebGPURenderer, read after render().
  renderInfo?: { drawCalls: number; triangles: number };
  // The render scale and the drawing buffer it gives.
  resolution?: { scale: number; width: number; height: number; dynamic: boolean };
}

interface ChromeMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export class PerfOverlay {
  readonly element: HTMLElement;
  private readonly text: HTMLElement;
  private readonly stats = new PerfStats();
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(parent: HTMLElement = document.body, options: { updateHz?: number } = {}) {
    this.intervalMs = 1000 / (options.updateHz ?? 4);
    this.element = document.createElement('div');
    this.element.className = 'perf-overlay';
    this.element.hidden = true;
    // Developer readout; screen readers get nothing useful from a 4 Hz number stream.
    this.element.setAttribute('aria-hidden', 'true');
    this.text = document.createElement('pre');
    this.element.append(this.text);
    parent.append(this.element);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  toggle(force?: boolean): void {
    const show = force ?? !this.visible;
    if (show === this.visible) return;
    this.element.hidden = !show;
    if (show) {
      // Stale samples from before it was hidden would skew the first readout.
      this.stats.reset();
      this.timer = setInterval(() => this.update(), this.intervalMs);
    } else if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Per-frame feed. Does nothing while hidden.
  frame(input: PerfFrameInput = {}): void {
    if (this.element.hidden) return;
    const now = input.now ?? performance.now();
    this.stats.frame(now);
    if (input.simStepMs !== undefined) this.stats.sim(now, input.simStepMs, input.simSteps ?? 1);
    if (input.gpuMs !== undefined && input.gpuMs !== null) this.stats.gpu(now, input.gpuMs);
    if (input.renderInfo) this.stats.render(input.renderInfo.drawCalls, input.renderInfo.triangles);
    if (input.resolution) this.stats.resolution(input.resolution);
  }

  // F3 toggles the overlay. Returns a function that removes the listener.
  installHotkey(target: Window = window): () => void {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code !== 'F3' || event.repeat) return;
      // F3 is "find next" in some browsers.
      event.preventDefault();
      this.toggle();
    };
    target.addEventListener('keydown', onKey);
    return () => target.removeEventListener('keydown', onKey);
  }

  dispose(): void {
    this.toggle(false);
    this.element.remove();
  }

  private update(): void {
    // Chrome-only and imprecise by design, but enough to spot a leak.
    const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
    if (memory) this.stats.heap(memory.usedJSHeapSize, memory.jsHeapSizeLimit);
    this.text.textContent = formatReadout(this.stats.read(performance.now())).join('\n');
  }
}
