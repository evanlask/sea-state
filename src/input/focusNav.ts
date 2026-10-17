// Gamepad menu navigation. pickNext() is the pure geometry: the nearest
// focusable element in a direction, preferring ones in the same row or column.
// FocusNavigator is the thin DOM glue that moves focus and clicks.

import type { MenuInput } from './InputManager';

export type NavDirection = 'up' | 'down' | 'left' | 'right';

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Sideways offset counts this much more than forward distance, so "down"
// prefers the item directly below over a nearer one off to the side.
const PERPENDICULAR_WEIGHT = 2.5;

// Gap between two intervals (0 if they overlap).
const gap = (a0: number, a1: number, b0: number, b1: number): number => Math.max(0, b0 - a1, a0 - b1);

export function pickNext(rects: readonly RectLike[], currentIndex: number, direction: NavDirection): number {
  if (rects.length === 0) return -1;
  if (currentIndex < 0 || currentIndex >= rects.length) {
    // Nothing focused yet: start in reading order.
    let best = 0;
    for (let i = 1; i < rects.length; i++) {
      const r = rects[i];
      const b = rects[best];
      if (r.top < b.top - 1 || (Math.abs(r.top - b.top) <= 1 && r.left < b.left)) best = i;
    }
    return best;
  }
  const from = rects[currentIndex];
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'right' || direction === 'down' ? 1 : -1;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === currentIndex) continue;
    const r = rects[i];
    const dx = r.left + r.width / 2 - cx;
    const dy = r.top + r.height / 2 - cy;
    const along = (horizontal ? dx : dy) * sign;
    if (along <= 1) continue; // behind or level with the current item
    const across = horizontal
      ? gap(from.top, from.top + from.height, r.top, r.top + r.height)
      : gap(from.left, from.left + from.width, r.left, r.left + r.width);
    // Items sharing the row/column ("in beam") win over diagonal ones.
    const score = across === 0 ? along : Math.hypot(along, across * PERPENDICULAR_WEIGHT) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function directionOf(x: number, y: number, threshold = 0.5): NavDirection | null {
  if (Math.max(Math.abs(x), Math.abs(y)) < threshold) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up';
}

// Hold-to-repeat timing: move at once, wait, then repeat steadily.
export class RepeatTimer {
  private direction: NavDirection | null = null;
  private wait = 0;
  readonly initialDelay: number;
  readonly interval: number;

  constructor(initialDelay = 0.4, interval = 0.12) {
    this.initialDelay = initialDelay;
    this.interval = interval;
  }

  update(direction: NavDirection | null, dt: number): NavDirection | null {
    if (direction !== this.direction) {
      this.direction = direction;
      this.wait = this.initialDelay;
      return direction;
    }
    if (!direction) return null;
    this.wait -= dt;
    if (this.wait > 0) return null;
    this.wait += this.interval;
    return direction;
  }
}

export interface FocusNavigatorOptions {
  onBack?: () => void;
  onTabPrev?: () => void;
  onTabNext?: () => void;
  selector?: string;
}

const DEFAULT_SELECTOR = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

// Controls that use the arrow keys themselves.
function ownsArrows(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return true;
  return (
    element instanceof HTMLInputElement && !['button', 'checkbox', 'submit', 'reset'].includes(element.type)
  );
}

export class FocusNavigator {
  container: HTMLElement;
  private options: FocusNavigatorOptions;
  private repeat = new RepeatTimer();

  constructor(container: HTMLElement, options: FocusNavigatorOptions = {}) {
    this.container = container;
    this.options = options;
  }

  focusables(): HTMLElement[] {
    const nodes = this.container.querySelectorAll<HTMLElement>(this.options.selector ?? DEFAULT_SELECTOR);
    return [...nodes].filter(
      (el) =>
        !el.hasAttribute('disabled') &&
        el.getAttribute('aria-hidden') !== 'true' &&
        el.getClientRects().length > 0,
    );
  }

  move(direction: NavDirection): void {
    const items = this.focusables();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = pickNext(
      items.map((el) => el.getBoundingClientRect()),
      current,
      direction,
    );
    if (next >= 0 && next !== current) {
      items[next].focus();
      items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  // Call each frame with the 'menu' context's input.
  update(menu: MenuInput, dt: number): void {
    const active = document.activeElement;
    const arrowsNative = menu.fromKeyboard && ownsArrows(active);
    const direction = this.repeat.update(arrowsNative ? null : directionOf(menu.x, menu.y), dt);
    if (direction) this.move(direction);
    if (menu.accept) {
      if (active instanceof HTMLElement && this.container.contains(active)) active.click();
      else this.move('down');
    }
    if (menu.back) this.options.onBack?.();
    if (menu.tabPrev) this.options.onTabPrev?.();
    if (menu.tabNext) this.options.onTabNext?.();
  }
}
