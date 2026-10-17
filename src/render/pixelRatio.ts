// Calls `onChange` whenever the window's devicePixelRatio changes: browser zoom, or the window moving
// to a display of another density. The canvas' CSS size usually stays the same through that, so the
// ResizeObserver on its container never fires and the drawing buffer would keep the old density
// (blurry on the sharper display, wasteful on the other). Returns the function that stops watching.
//
// A `(resolution: Ndppx)` media query only matches the current ratio, so it changes exactly when the
// ratio does; each change re-arms it for the new ratio.

interface PixelRatioWindow {
  devicePixelRatio: number;
  matchMedia?: (query: string) => {
    addEventListener(type: 'change', listener: () => void, options?: { once: boolean }): void;
    removeEventListener(type: 'change', listener: () => void): void;
  };
}

export function watchPixelRatio(win: PixelRatioWindow, onChange: () => void): () => void {
  let stop: (() => void) | null = null;
  let stopped = false;
  const arm = (): void => {
    if (stopped || typeof win.matchMedia !== 'function') return;
    const query = win.matchMedia(`(resolution: ${win.devicePixelRatio}dppx)`);
    const changed = (): void => {
      onChange();
      arm();
    };
    query.addEventListener('change', changed, { once: true });
    stop = () => query.removeEventListener('change', changed);
  };
  arm();
  return () => {
    stopped = true;
    stop?.();
    stop = null;
  };
}
