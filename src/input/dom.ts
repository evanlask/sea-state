// DOM event glue: feeds keyboard, mouse and gamepad-connection events into an
// InputManager. Kept thin so the logic stays testable without a browser.

import type { PadChange } from './gamepad';
import type { InputManager } from './InputManager';
import { isBrowserShortcut, isTextEntry } from './keyboard';

export interface DomInputOptions {
  // The canvas: wheel, right-drag and pointer lock apply here.
  target: HTMLElement;
  // Click the canvas to enter pointer lock (helm free-look).
  pointerLockOnClick?: boolean;
  // Losing pointer lock (Esc in the browser) should pause the game.
  onPointerLockLost?: () => void;
  onPadChange?: (change: PadChange) => void;
}

export function attachInputListeners(input: InputManager, options: DomInputOptions): () => void {
  const { target } = options;
  const controller = new AbortController();
  const signal = controller.signal;
  const active = (): Element | null => document.activeElement;

  input.sources.isUiFocused ??= () => isTextEntry(active() as HTMLElement | null);
  if (options.onPadChange) input.onPadChange = options.onPadChange;

  window.addEventListener(
    'keydown',
    (event) => {
      if (isTextEntry(event.target as HTMLElement | null) && event.code !== 'Escape') return;
      // Shortcuts belong to the browser: no action, no preventDefault. Cmd also lets go of the helm
      // keys, since macOS drops the keyups of keys released while Cmd is down.
      if (isBrowserShortcut(event)) {
        if (event.key === 'Meta') input.keys.clear();
        return;
      }
      input.keys.keyDown(event.code, event.repeat, event.shiftKey);
      // Keep Tab, Space, F1, Backspace, arrows… from scrolling or navigating
      // in-game; menus keep native Tab and Enter behaviour.
      if (input.context !== 'menu' && input.isBound(event.code, event.shiftKey)) event.preventDefault();
    },
    { signal },
  );
  window.addEventListener('keyup', (event) => input.keys.keyUp(event.code, event.shiftKey), { signal });
  const releaseAll = (): void => {
    input.keys.clear();
    input.mouse.release();
  };
  window.addEventListener('blur', releaseAll, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) releaseAll();
    },
    { signal },
  );

  window.addEventListener(
    'mousemove',
    (event) => input.mouse.move(event.movementX, event.movementY, document.pointerLockElement === target),
    { signal },
  );
  target.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 2) input.mouse.dragging = true;
      else if (event.button === 0 && options.pointerLockOnClick && document.pointerLockElement !== target) {
        // Chrome returns a promise that rejects if the request is too soon after an exit.
        const request = target.requestPointerLock() as Promise<void> | undefined;
        if (request) void request.catch(() => undefined);
      }
    },
    { signal },
  );
  window.addEventListener(
    'mouseup',
    (event) => {
      if (event.button === 2) input.mouse.dragging = false;
    },
    { signal },
  );
  target.addEventListener('contextmenu', (event) => event.preventDefault(), { signal });
  target.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      input.mouse.scroll(event.deltaY, event.deltaMode);
    },
    { signal, passive: false },
  );

  let wasLocked = false;
  document.addEventListener(
    'pointerlockchange',
    () => {
      const locked = document.pointerLockElement === target;
      if (wasLocked && !locked) options.onPointerLockLost?.();
      wasLocked = locked;
    },
    { signal },
  );

  // Polling getGamepads() finds pads (and InputManager diffs connections), but
  // some browsers only expose pads once a gamepad listener exists.
  window.addEventListener('gamepadconnected', () => undefined, { signal });

  return () => controller.abort();
}
