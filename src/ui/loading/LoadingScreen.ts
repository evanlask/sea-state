// Startup and scenario loading screen. It takes over the inline boot screen from
// index.html (same gradient, title and swell), so the handover has no visual pop, and adds
// a segmented progress bar, the current step, time remaining, rotating tips and an error /
// retry state. Animations are CSS-only so they keep moving while the main thread compiles shaders.

import './loading.css';
import type { LoadingManager, LoadingSnapshot } from '../../app/loading/LoadingManager';
import { buildSegments, type Segment } from './segments';
import { TipRotator } from './tips';

export interface LoadingScreenOptions {
  tipIntervalMs?: number;
  random?: () => number;
}

const FADE_MS = 500;

export class LoadingScreen {
  readonly element: HTMLElement;
  private readonly step: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly eta: HTMLElement;
  private readonly errorBox: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly tips: TipRotator;
  private manager: LoadingManager | null = null;
  private unsubscribe: (() => void) | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private frame = 0;
  private segmentKey = '';
  private pending: LoadingSnapshot | null = null;
  private leaving = false;
  private resolveClosed: () => void = () => {};
  // Resolves once hide() has finished fading the screen out.
  readonly closed = new Promise<void>((resolve) => (this.resolveClosed = resolve));

  // Reuses the inline #boot element in place: the title and status line stay exactly where they were.
  static adoptBootScreen(boot: HTMLElement, options: LoadingScreenOptions = {}): LoadingScreen {
    return new LoadingScreen(boot, options);
  }

  // A fresh screen (e.g. scenario loading), faded in over whatever is behind it.
  static create(parent: HTMLElement, options: LoadingScreenOptions = {}): LoadingScreen {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="boot-swell"></div>
      <div class="boot-swell two"></div>
      <div><h1 class="boot-title" aria-label="Sea State">Sea~State</h1><div class="boot-status">Loading…</div></div>`;
    root.classList.add('is-entering');
    parent.append(root);
    const screen = new LoadingScreen(root, options);
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('is-entering')));
    return screen;
  }

  private constructor(root: HTMLElement, options: LoadingScreenOptions) {
    this.element = root;
    this.tips = new TipRotator(undefined, options.random);
    root.classList.add('loading-screen');
    // The step line alone is the live region; announcing tips and ETA ticks would be noise.
    root.removeAttribute('role');
    root.removeAttribute('aria-live');
    for (const swell of root.querySelectorAll('.boot-swell')) swell.classList.add('loading-swell');

    let status = root.querySelector<HTMLElement>('.boot-status');
    const center = status?.parentElement ?? root;
    center.classList.add('loading-center');
    if (!status) {
      status = document.createElement('div');
      status.className = 'boot-status';
      center.append(status);
    }
    this.step = status;
    this.step.classList.add('loading-step');
    this.step.setAttribute('role', 'status');
    this.step.setAttribute('aria-live', 'polite');

    // Absolutely positioned below the status line, so adding it doesn't re-centre the title.
    const extra = document.createElement('div');
    extra.className = 'loading-extra';
    extra.innerHTML = `
      <div class="loading-bar" role="progressbar" aria-label="Loading" aria-valuemin="0" aria-valuemax="100"
        aria-valuenow="0"></div>
      <div class="loading-eta" aria-hidden="true"></div>
      <div class="loading-error" role="alert" hidden>
        <span class="loading-error-text"></span>
        <button type="button" class="loading-button loading-retry">Retry</button>
      </div>
      <p class="loading-tip"></p>`;
    center.append(extra);
    const pick = <T extends HTMLElement>(selector: string): T => {
      const found = extra.querySelector<T>(selector);
      if (!found) throw new Error(`LoadingScreen markup is missing ${selector}`);
      return found;
    };
    this.bar = pick('.loading-bar');
    this.eta = pick('.loading-eta');
    this.errorBox = pick('.loading-error');
    this.errorText = pick('.loading-error-text');
    this.tip = pick('.loading-tip');

    pick('.loading-retry').addEventListener('click', () => this.manager?.retry());

    this.showTip();
    this.timers.push(setInterval(() => this.showTip(), options.tipIntervalMs ?? 7000));
    // Fade the new parts in after the first paint so the boot screen doesn't visibly change at once.
    requestAnimationFrame(() => extra.classList.add('is-visible'));
  }

  // Follows a manager's progress until detached or hidden.
  attach(manager: LoadingManager): this {
    this.detach();
    this.manager = manager;
    this.unsubscribe = manager.subscribe((snapshot) => this.schedule(snapshot));
    // The ETA counts down with time even when no task reports anything.
    this.timers.push(setInterval(() => this.schedule(manager.getSnapshot()), 250));
    return this;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.manager = null;
  }

  // BootUi-compatible: a manual status line for work that isn't a tracked task.
  setStatus(text: string): void {
    this.step.textContent = text;
  }

  // BootUi-compatible: fades out, then removes the element (see `closed`).
  hide(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.element.classList.add('boot-done', 'is-leaving');
    setTimeout(() => {
      this.dispose();
      this.resolveClosed();
    }, FADE_MS + 100);
  }

  dispose(): void {
    this.detach();
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    cancelAnimationFrame(this.frame);
    this.element.remove();
  }

  // Coalesce to one DOM update per frame however often progress is reported.
  private schedule(snapshot: LoadingSnapshot): void {
    const first = this.pending === null;
    this.pending = snapshot;
    if (first) {
      this.frame = requestAnimationFrame(() => {
        const latest = this.pending;
        this.pending = null;
        if (latest) this.render(latest);
      });
    }
  }

  private render(snapshot: LoadingSnapshot): void {
    if (snapshot.phase === 'idle') return;
    setText(this.step, snapshot.stepText);
    const percent = Math.round(snapshot.progress * 100);
    this.bar.setAttribute('aria-valuenow', String(percent));
    this.bar.setAttribute('aria-valuetext', `${percent}%, ${snapshot.stepText}`);
    this.renderSegments(buildSegments(snapshot.tasks));

    const failed = snapshot.phase === 'error';
    this.errorBox.hidden = !failed;
    this.element.classList.toggle('has-error', failed);
    if (failed) {
      const what = snapshot.failedTask?.label.toLowerCase() ?? 'loading';
      const reason =
        snapshot.error instanceof Error
          ? snapshot.error.message
          : typeof snapshot.error === 'string'
            ? snapshot.error
            : '';
      setText(this.errorText, `Something went wrong ${what}. ${reason}`.trim());
    }
    setText(this.eta, snapshot.etaText);
  }

  private renderSegments(segments: Segment[]): void {
    const key = segments.map((segment) => segment.kind).join(',');
    if (key !== this.segmentKey) {
      this.segmentKey = key;
      this.bar.replaceChildren(
        ...segments.map((segment) => {
          const element = document.createElement('div');
          element.className = 'loading-seg';
          element.dataset.kind = segment.kind;
          element.title = segment.label;
          const fill = document.createElement('div');
          fill.className = 'loading-seg-fill';
          element.append(fill);
          return element;
        }),
      );
    }
    segments.forEach((segment, index) => {
      const element = this.bar.children[index] as HTMLElement;
      element.style.flexGrow = String(Math.max(segment.share, 0.04));
      element.dataset.state = segment.state;
      element.classList.toggle('is-indeterminate', segment.indeterminate);
      (element.firstElementChild as HTMLElement).style.transform = `scaleX(${segment.fill.toFixed(4)})`;
    });
  }

  private showTip(): void {
    const tip = this.tips.next();
    if (!this.tip.textContent) {
      this.tip.textContent = tip.text;
      return;
    }
    this.tip.classList.add('is-changing');
    setTimeout(() => {
      this.tip.textContent = tip.text;
      this.tip.classList.remove('is-changing');
    }, 300);
  }
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
