// Keyboard state fed by DOM events. Keys are KeyboardEvent.code values, so the
// layout is positional (WASD stays WASD on AZERTY). A chord may carry a
// "Shift+" prefix, e.g. 'Shift+Slash' for "?".

export interface KeyChord {
  code: string;
  shift: boolean;
}

export function parseChord(chord: string): KeyChord {
  return chord.startsWith('Shift+') ? { code: chord.slice(6), shift: true } : { code: chord, shift: false };
}

export class KeyState {
  private down = new Set<string>();
  private edges: KeyChord[] = [];
  private shift = false;

  keyDown(code: string, repeat: boolean, shift: boolean): void {
    this.shift = shift;
    // Auto-repeat would step the telegraph several notches per press.
    if (repeat || this.down.has(code)) return;
    this.down.add(code);
    this.edges.push({ code, shift });
  }

  keyUp(code: string, shift: boolean): void {
    this.shift = shift;
    this.down.delete(code);
  }

  // Window blur loses keyups; forget everything so nothing sticks on.
  clear(): void {
    this.down.clear();
    this.edges = [];
    this.shift = false;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  get shiftDown(): boolean {
    return this.shift;
  }

  get anyDown(): boolean {
    return this.down.size > 0;
  }

  // Press edges match the Shift state exactly, so 'KeyR' and 'Shift+KeyR' can
  // be different actions.
  wasPressed(chord: string): boolean {
    const want = parseChord(chord);
    return this.edges.some((edge) => edge.code === want.code && edge.shift === want.shift);
  }

  // Held state ignores Shift, so steering does not stop when Shift is pressed.
  isHeld(chord: string): boolean {
    return this.down.has(parseChord(chord).code);
  }

  get hadInput(): boolean {
    return this.edges.length > 0;
  }

  endFrame(): void {
    this.edges = [];
  }
}

export interface ModifierState {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

// A browser or OS shortcut (Ctrl, Cmd or Alt held): the game leaves it alone, so Cmd/Ctrl+R still
// reloads, Cmd/Ctrl+L reaches the address bar and Cmd+1–5 switch tabs without flipping a light.
// Shift alone is the game's own modifier (Shift+R, Shift+Tab).
export function isBrowserShortcut(event: ModifierState): boolean {
  return !!(event.ctrlKey || event.metaKey || event.altKey);
}

export interface FocusTargetLike {
  tagName?: string;
  type?: string;
  isContentEditable?: boolean;
}

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file']);

// Where typing must not steer the boat.
export function isTextEntry(target: FocusTargetLike | null | undefined): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
}

// Mouse deltas accumulated between polls.
export class MouseState {
  lookX = 0;
  lookY = 0;
  orbitX = 0;
  orbitY = 0;
  wheel = 0;
  dragging = false;
  hadInput = false;

  move(dx: number, dy: number, pointerLocked: boolean): void {
    if (pointerLocked) {
      this.lookX += dx;
      this.lookY += dy;
    } else if (this.dragging) {
      this.orbitX += dx;
      this.orbitY += dy;
    } else {
      return;
    }
    this.hadInput = true;
  }

  // Browsers report pixels, lines or pages; normalise to wheel "notches".
  scroll(deltaY: number, deltaMode: number): void {
    const pixels = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
    this.wheel += pixels / 100;
    this.hadInput = true;
  }

  // Window blur or a hidden tab can swallow the mouseup that ends a right-drag.
  release(): void {
    this.dragging = false;
  }

  endFrame(): void {
    this.lookX = this.lookY = this.orbitX = this.orbitY = this.wheel = 0;
    this.hadInput = false;
  }
}
