// Gamepad reading on plain objects shaped like the Gamepad API, so polling,
// dead zones and edge/hold detection run (and are tested) without a browser.
// Assumes the W3C "standard" mapping, which Chrome, Safari and Firefox expose
// for Xbox, PlayStation and most Switch-style pads.

import { clamp } from './axes';

interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

interface DualRumbleParams {
  duration: number; // ms
  startDelay?: number; // ms
  strongMagnitude: number; // 0..1, low-frequency motor
  weakMagnitude: number; // 0..1, high-frequency motor
}

interface HapticActuatorLike {
  playEffect?: (type: 'dual-rumble', params: DualRumbleParams) => Promise<unknown>;
}

export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly GamepadButtonLike[];
  readonly axes: readonly number[];
  readonly vibrationActuator?: HapticActuatorLike | null;
}

// Standard-mapping button indices.
export const PAD_BUTTONS = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  View: 8,
  Start: 9,
  L3: 10,
  R3: 11,
  DUp: 12,
  DDown: 13,
  DLeft: 14,
  DRight: 15,
  Home: 16,
} as const;

export type PadButton = keyof typeof PAD_BUTTONS;

const PAD_BUTTON_NAMES = Object.keys(PAD_BUTTONS) as PadButton[];

export type PadAxis = 'LX' | 'LY' | 'RX' | 'RY';

export interface Stick {
  x: number;
  y: number;
}

export interface PadSettings {
  stickDeadZone: number; // radial, 0..1
  stickOuterZone: number; // magnitude treated as full deflection
  triggerThreshold: number; // analog trigger values below this read as 0
  triggerPressThreshold: number; // trigger counts as a digital press above this
  holdTime: number; // s, for "hold" bindings
}

export const DEFAULT_PAD_SETTINGS: PadSettings = {
  stickDeadZone: 0.15,
  stickOuterZone: 0.95,
  triggerThreshold: 0.08,
  triggerPressThreshold: 0.5,
  holdTime: 0.8,
};

// Radial (not per-axis) so diagonals are not snapped to the axes, rescaled so
// output starts at 0 at the dead-zone edge instead of jumping to 0.15.
export function radialDeadZone(x: number, y: number, inner: number, outer = 1): Stick {
  const magnitude = Math.hypot(x, y);
  if (magnitude <= inner || magnitude === 0) return { x: 0, y: 0 };
  const scaled = clamp((magnitude - inner) / Math.max(outer - inner, 1e-6), 0, 1);
  return { x: (x / magnitude) * scaled, y: (y / magnitude) * scaled };
}

// Triggers rest slightly above 0 on worn pads; ignore that and rescale.
export function triggerValue(raw: number, threshold: number): number {
  if (raw <= threshold) return 0;
  return clamp((raw - threshold) / (1 - threshold), 0, 1);
}

// Per-button edge and hold detection. A "tap" fires on release when the hold
// threshold was not reached, which lets one button carry a tap and a hold action.
export class ButtonTracker {
  down = false;
  heldFor = 0;
  pressed = false; // went down this frame
  released = false; // went up this frame
  tapped = false; // released before the hold threshold
  held = false; // crossed the hold threshold this frame
  private holdFired = false;

  update(isDown: boolean, dt: number, holdTime: number): void {
    this.pressed = isDown && !this.down;
    this.released = !isDown && this.down;
    this.tapped = this.released && !this.holdFired;
    this.held = false;
    if (this.pressed) {
      this.heldFor = 0;
      this.holdFired = false;
    } else if (isDown) {
      this.heldFor += dt;
    }
    if (isDown && !this.holdFired && this.heldFor >= holdTime) {
      this.held = true;
      this.holdFired = true;
    }
    if (!isDown) this.heldFor = 0;
    this.down = isDown;
  }

  reset(): void {
    this.down = this.pressed = this.released = this.tapped = this.held = this.holdFired = false;
    this.heldFor = 0;
  }
}

export interface PadFrame {
  connected: boolean;
  id: string;
  buttons: Readonly<Record<PadButton, ButtonTracker>>;
  left: Stick; // dead-zoned; y is +down as in the Gamepad API
  right: Stick;
  lt: number; // 0..1 after threshold
  rt: number;
  active: boolean; // the player touched the pad this frame
}

export type PadChange = { type: 'connected' | 'disconnected'; id: string; index: number };

function isUsed(pad: GamepadLike, settings: PadSettings): boolean {
  if (pad.buttons.some((button) => button.pressed)) return true;
  return pad.axes.some((axis) => Math.abs(axis) > settings.stickDeadZone * 2);
}

// Tracks the one pad driving the player boat: the last one that was used.
export class GamepadReader {
  settings: PadSettings;
  current: GamepadLike | null = null;
  private trackers = Object.fromEntries(
    PAD_BUTTON_NAMES.map((name) => [name, new ButtonTracker()]),
  ) as Record<PadButton, ButtonTracker>;
  private known = new Map<number, string>();

  constructor(settings: PadSettings = DEFAULT_PAD_SETTINGS) {
    this.settings = settings;
  }

  // Compares the connected set with the previous poll; Chrome reports pads
  // only after a button press, so this also covers late "connections".
  diffConnections(pads: readonly (GamepadLike | null)[]): PadChange[] {
    const changes: PadChange[] = [];
    const seen = new Set<number>();
    for (const pad of pads) {
      if (!pad?.connected) continue;
      seen.add(pad.index);
      if (this.known.get(pad.index) !== pad.id) {
        this.known.set(pad.index, pad.id);
        changes.push({ type: 'connected', id: pad.id, index: pad.index });
      }
    }
    for (const [index, id] of this.known) {
      if (!seen.has(index)) {
        this.known.delete(index);
        changes.push({ type: 'disconnected', id, index });
      }
    }
    return changes;
  }

  private choose(pads: readonly (GamepadLike | null)[]): GamepadLike | null {
    const live = pads.filter((pad): pad is GamepadLike => !!pad?.connected);
    const used = live.find((pad) => pad.index !== this.current?.index && isUsed(pad, this.settings));
    if (used) return used;
    const same = live.find((pad) => pad.index === this.current?.index);
    return same ?? live.find((pad) => pad.mapping === 'standard') ?? live[0] ?? null;
  }

  update(pads: readonly (GamepadLike | null)[], dt: number): PadFrame {
    const pad = this.choose(pads);
    if (pad?.index !== this.current?.index)
      for (const tracker of Object.values(this.trackers)) tracker.reset();
    this.current = pad;
    const s = this.settings;
    const axis = (i: number): number => pad?.axes[i] ?? 0;
    const raw = (i: number): number => pad?.buttons[i]?.value ?? 0;
    const left = radialDeadZone(axis(0), axis(1), s.stickDeadZone, s.stickOuterZone);
    const right = radialDeadZone(axis(2), axis(3), s.stickDeadZone, s.stickOuterZone);
    const lt = triggerValue(raw(PAD_BUTTONS.LT), s.triggerThreshold);
    const rt = triggerValue(raw(PAD_BUTTONS.RT), s.triggerThreshold);
    let active = left.x !== 0 || left.y !== 0 || right.x !== 0 || right.y !== 0 || lt > 0 || rt > 0;
    for (const name of PAD_BUTTON_NAMES) {
      const index = PAD_BUTTONS[name];
      const button = pad?.buttons[index];
      const isTrigger = name === 'LT' || name === 'RT';
      const down = !!button && (isTrigger ? button.value >= s.triggerPressThreshold : button.pressed);
      this.trackers[name].update(down, dt, s.holdTime);
      if (down) active = true;
    }
    return {
      connected: !!pad,
      id: pad?.id ?? '',
      buttons: this.trackers,
      left,
      right,
      lt,
      rt,
      active,
    };
  }
}

export interface RumbleSettings {
  enabled: boolean;
  intensity: number; // 0..1 scale on both motors
}

export function canRumble(pad: GamepadLike | null | undefined): boolean {
  return typeof pad?.vibrationActuator?.playEffect === 'function';
}

// Dual-rumble exists in Chrome and macOS Safari; Firefox has no
// vibrationActuator, so this quietly does nothing there.
export class Rumbler {
  settings: RumbleSettings;

  constructor(settings: RumbleSettings = { enabled: true, intensity: 1 }) {
    this.settings = settings;
  }

  play(pad: GamepadLike | null | undefined, strong: number, weak: number, durationMs: number): boolean {
    if (!this.settings.enabled || !canRumble(pad)) return false;
    const scale = clamp(this.settings.intensity, 0, 1);
    const params: DualRumbleParams = {
      duration: Math.max(0, durationMs),
      startDelay: 0,
      strongMagnitude: clamp(strong * scale, 0, 1),
      weakMagnitude: clamp(weak * scale, 0, 1),
    };
    try {
      const result = pad?.vibrationActuator?.playEffect?.('dual-rumble', params);
      // A newer effect pre-empts the old one and rejects its promise; harmless.
      if (result) void result.catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }
}
