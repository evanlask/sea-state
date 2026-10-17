// Per-frame input: turns keyboard, mouse and gamepad state into BoatControls,
// camera deltas and one-shot actions for the active context, following the
// bindings table. DOM listeners live in dom.ts; everything here runs in Node.

import type { BoatControls, PhysicsMode } from '../sim/world/protocol';
import {
  type AxisInput,
  type AxisSpec,
  axisSpec,
  stepLever,
  stepRate,
  stepSpring,
  Telegraph,
  TELEGRAPH_STOP,
  type TelegraphNotch,
} from './axes';
import {
  type ActionId,
  type AxisBinding,
  type Binding,
  bindingsFor,
  type ButtonActionId,
  type ButtonBinding,
  type ControlAxisId,
  isCameraAxis,
  type PadButtonBinding,
  type StickBinding,
} from './bindings';
import { type BoatContext, isBoatContext, type PollContext } from './contexts';
import {
  DEFAULT_PAD_SETTINGS,
  type GamepadLike,
  GamepadReader,
  type PadButton,
  type PadChange,
  type PadFrame,
  type PadSettings,
  Rumbler,
} from './gamepad';
import { KeyState, MouseState, parseChord } from './keyboard';

export type InputDevice = 'keyboard' | 'gamepad';

export interface CameraInput {
  lookX: number; // radians this frame, + right
  lookY: number; // radians this frame, + up (after invert-Y)
  orbitX: number;
  orbitY: number;
  zoom: number; // wheel notches this frame, + out
  zoomStep: boolean; // jump to the next preset distance (near → normal → far → near)
  next: boolean;
  prev: boolean;
  reset: boolean;
  photo: boolean; // toggle photo mode
  // Photo mode only (zero otherwise):
  moveX: number; // −1..1, + right
  moveY: number; // −1..1, + up
  moveZ: number; // −1..1, + forward
  aperture: number; // notches this frame, + opens (shallower focus)
  slowMotion: boolean; // cycle the simulation speed
}

export const NO_CAMERA_INPUT: Readonly<CameraInput> = {
  lookX: 0,
  lookY: 0,
  orbitX: 0,
  orbitY: 0,
  zoom: 0,
  zoomStep: false,
  next: false,
  prev: false,
  reset: false,
  photo: false,
  moveX: 0,
  moveY: 0,
  moveZ: 0,
  aperture: 0,
  slowMotion: false,
};

export interface MenuInput {
  x: number; // −1..1, + right
  y: number; // −1..1, + down
  fromKeyboard: boolean; // arrows contributed (text fields and sliders use them natively)
  accept: boolean; // gamepad A; Enter already activates natively
  back: boolean;
  tabPrev: boolean;
  tabNext: boolean;
}

interface TelegraphState {
  notch: number; // index into TELEGRAPH_NOTCHES
  info: TelegraphNotch;
  lever: number; // continuous lever position while a trigger sweeps it
}

export interface InputFrame {
  context: PollContext;
  controls: BoatControls;
  camera: CameraInput;
  menu: MenuInput;
  triggered: Set<ActionId>; // one-shot actions that fired this frame
  held: Set<ButtonActionId>; // button actions currently held (e.g. horn)
  telegraph: TelegraphState | null; // ship and cruise contexts only
  lastDevice: InputDevice;
}

export interface InputSettings extends PadSettings {
  mouseSensitivity: number; // rad per pixel
  stickLookSpeed: number; // rad/s at full deflection
  keyLookSpeed: number; // rad/s for arrow keys
  keyZoomSpeed: number; // notches/s for − / =
  invertY: boolean;
  rumble: boolean;
  rumbleIntensity: number;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  ...DEFAULT_PAD_SETTINGS,
  mouseSensitivity: 0.0025,
  stickLookSpeed: 2.5,
  keyLookSpeed: 1.5,
  keyZoomSpeed: 6,
  invertY: false,
  rumble: true,
  rumbleIntensity: 1,
};

export interface InputSources {
  getGamepads?: () => readonly (GamepadLike | null)[];
  // True while a text field (or similar) has focus, so typing doesn't steer.
  isUiFocused?: () => boolean;
}

interface HelmState {
  axes: Record<ControlAxisId, number>;
  telegraph: Telegraph;
}

const newHelm = (): HelmState => ({
  axes: { telegraph: 0, throttle: 0, steer: 0, thruster: 0, trim: 0, mainSheet: 0, jibSheet: 0 },
  telegraph: new Telegraph(),
});

const FALLBACK_SPEC = axisSpec('spring');

// getGamepads() throws a SecurityError where the Gamepad API is blocked (an embedding iframe without
// the permission); that must not take the frame loop down, so it reads as "no pads" from then on.
export function guardedGamepads(
  read: () => readonly (GamepadLike | null)[],
): () => readonly (GamepadLike | null)[] {
  let blocked = false;
  return () => {
    if (blocked) return [];
    try {
      return read();
    } catch {
      blocked = true;
      return [];
    }
  };
}

function defaultSources(): InputSources {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    getGamepads: nav?.getGamepads ? guardedGamepads(() => nav.getGamepads()) : undefined,
  };
}

export class InputManager {
  readonly keys = new KeyState();
  readonly mouse = new MouseState();
  readonly pads: GamepadReader;
  readonly rumbler: Rumbler;
  settings: InputSettings;
  sources: InputSources;
  private physicsMode: PhysicsMode = 'arcade';
  onPadChange: ((change: PadChange) => void) | null = null;
  lastDevice: InputDevice = 'keyboard';
  context: PollContext = 'menu';
  private helms = new Map<BoatContext, HelmState>();

  constructor(settings: Partial<InputSettings> = {}, sources: InputSources = defaultSources()) {
    this.settings = { ...DEFAULT_INPUT_SETTINGS, ...settings };
    this.sources = sources;
    this.pads = new GamepadReader(this.settings);
    this.rumbler = new Rumbler({ enabled: this.settings.rumble, intensity: this.settings.rumbleIntensity });
  }

  // Arcade helms centre themselves when let go; Realistic ones stay put (bindings' realisticSpecs).
  setPhysicsMode(mode: PhysicsMode): void {
    this.physicsMode = mode;
  }

  updateSettings(patch: Partial<InputSettings>): void {
    Object.assign(this.settings, patch);
    this.pads.settings = this.settings;
    this.rumbler.settings = { enabled: this.settings.rumble, intensity: this.settings.rumbleIntensity };
  }

  // Call when the player takes a different boat so levers start from rest.
  resetHelm(context?: BoatContext): void {
    if (context) this.helms.delete(context);
    else this.helms.clear();
  }

  rumble(strong: number, weak: number, durationMs: number): boolean {
    return this.rumbler.play(this.pads.current, strong, weak, durationMs);
  }

  // For the DOM glue: should this key's default browser action be suppressed?
  isBound(code: string, shift: boolean): boolean {
    return bindingsFor(this.context).some((binding) =>
      keyChords(binding).some((chord) => {
        const parsed = parseChord(chord);
        return parsed.code === code && (binding.kind !== 'button' || parsed.shift === shift);
      }),
    );
  }

  private helm(context: BoatContext): HelmState {
    let helm = this.helms.get(context);
    if (!helm) {
      helm = newHelm();
      this.helms.set(context, helm);
    }
    return helm;
  }

  // In photo mode pass the boat's helm class as `idleHelm`: its levers hold and its springs return
  // as if the player had let go, so the boat sails on while WASD flies the camera.
  poll(dt: number, context: PollContext, idleHelm?: BoatContext): InputFrame {
    this.context = context;
    const padList = this.sources.getGamepads?.() ?? [];
    for (const change of this.pads.diffConnections(padList)) this.onPadChange?.(change);
    const pad = this.pads.update(padList, dt);

    if (this.keys.hadInput || this.mouse.hadInput) this.lastDevice = 'keyboard';
    else if (pad.active) this.lastDevice = 'gamepad';

    const uiFocused = this.sources.isUiFocused?.() ?? false;
    // In-game, a focused text field swallows everything; in menus the pad and
    // Esc still work so the player can leave the field.
    const reader = new FrameReader(this.keys, pad, !uiFocused, context === 'menu' || !uiFocused);

    const frame: InputFrame = {
      context,
      controls: {
        throttle: 0,
        steer: 0,
        thruster: 0,
        trim: 0,
        mainSheet: 0,
        jibSheet: 0,
        brake: false,
        letFly: false,
      },
      camera: { ...NO_CAMERA_INPUT },
      menu: { x: 0, y: 0, fromKeyboard: false, accept: false, back: false, tabPrev: false, tabNext: false },
      triggered: new Set(),
      held: new Set(),
      telegraph: null,
      lastDevice: this.lastDevice,
    };

    const bindings = bindingsFor(context);
    for (const binding of bindings) {
      if (binding.kind !== 'button') continue;
      const keysLive = reader.keysLive || (uiFocused && binding.id === 'menuBack');
      if (reader.buttonFired(binding, keysLive)) frame.triggered.add(binding.id);
      if (reader.buttonHeld(binding, keysLive)) frame.held.add(binding.id);
    }

    if (isBoatContext(context)) this.applyHelm(context, bindings, reader, frame, dt);
    else if (context === 'photo' && idleHelm) {
      const handsOff = new FrameReader(this.keys, pad, false, false);
      this.applyHelm(idleHelm, bindingsFor(idleHelm), handsOff, frame, dt);
    }
    for (const binding of bindings) {
      if (binding.kind === 'stick') this.applyStick(binding, reader, frame, dt);
      else if (binding.kind === 'axis' && binding.id === 'zoom') {
        const keys = reader.axisInput(binding).digital;
        frame.camera.zoom = keys * this.settings.keyZoomSpeed * dt + (reader.keysLive ? this.mouse.wheel : 0);
        frame.camera.zoomStep = !!binding.padStep && reader.padFired(binding.padStep);
      } else if (binding.kind === 'axis' && binding.id === 'photoRise') {
        const input = reader.axisInput(binding);
        frame.camera.moveY = clampUnit(input.digital + input.analog);
      } else if (binding.kind === 'axis' && binding.id === 'photoAperture') {
        const input = reader.axisInput(binding);
        frame.camera.aperture = clampUnit(input.digital + input.analog) * this.settings.keyZoomSpeed * dt;
      }
    }

    const fired = (id: ActionId): boolean => frame.triggered.has(id);
    frame.camera.next = fired('cameraNext');
    frame.camera.prev = fired('cameraPrev');
    frame.camera.reset = fired('cameraReset');
    frame.camera.photo = fired('photoMode');
    frame.camera.slowMotion = fired('photoSlowMo');
    frame.menu.accept = context === 'menu' && pad.buttons.A.pressed;
    frame.menu.back = fired('menuBack');
    frame.menu.tabPrev = fired('menuTabPrev');
    frame.menu.tabNext = fired('menuTabNext');

    this.keys.endFrame();
    this.mouse.endFrame();
    return frame;
  }

  private applyHelm(
    context: BoatContext,
    bindings: readonly Binding[],
    reader: FrameReader,
    frame: InputFrame,
    dt: number,
  ): void {
    const helm = this.helm(context);
    const { controls, triggered, held } = frame;
    if (triggered.has('allStop')) helm.telegraph.set(TELEGRAPH_STOP);
    if (triggered.has('throttleOff')) helm.axes.throttle = 0;
    if (triggered.has('midships')) helm.axes.steer = 0;

    for (const binding of bindings) {
      if (binding.kind !== 'axis' || isCameraAxis(binding.id)) continue;
      const id = binding.id;
      const spec: AxisSpec =
        (this.physicsMode === 'realistic' ? binding.realisticSpecs?.[context] : undefined) ??
        binding.specs?.[context] ??
        FALLBACK_SPEC;
      const input = reader.axisInput(binding);
      if (spec.behaviour === 'notched') {
        for (const key of binding.keysPos) if (reader.keyPressed(key)) helm.telegraph.step(1);
        for (const key of binding.keysNeg) if (reader.keyPressed(key)) helm.telegraph.step(-1);
        helm.telegraph.update(input.analog, dt, spec.riseRate);
        helm.axes[id] = helm.telegraph.value;
      } else if (spec.behaviour === 'lever') {
        helm.axes[id] = stepLever(helm.axes[id], input, dt, spec);
      } else if (spec.behaviour === 'rate') {
        helm.axes[id] = stepRate(input, spec);
      } else {
        helm.axes[id] = stepSpring(helm.axes[id], input, dt, spec);
      }
    }

    const live = new Set(bindings.map((binding) => binding.id));
    const axis = (id: ControlAxisId): number => (live.has(id) ? helm.axes[id] : 0);
    controls.throttle = live.has('telegraph') ? axis('telegraph') : axis('throttle');
    controls.steer = axis('steer');
    controls.thruster = axis('thruster');
    controls.trim = axis('trim');
    controls.mainSheet = axis('mainSheet');
    controls.jibSheet = axis('jibSheet');
    controls.brake = held.has('brake') || held.has('allStop');
    controls.letFly = held.has('letFly');
    if (live.has('telegraph')) {
      frame.telegraph = {
        notch: helm.telegraph.notch,
        info: helm.telegraph.notchInfo,
        lever: helm.telegraph.position,
      };
    }
  }

  private applyStick(binding: StickBinding, reader: FrameReader, frame: InputFrame, dt: number): void {
    const s = this.settings;
    const keys = reader.stickKeys(binding);
    const stick = reader.stick(binding);
    if (binding.id === 'menuNavigate') {
      frame.menu.x = clampUnit(keys.x + stick.x);
      frame.menu.y = clampUnit(keys.y + stick.y);
      frame.menu.fromKeyboard = keys.x !== 0 || keys.y !== 0;
      return;
    }
    if (binding.id === 'photoMove') {
      frame.camera.moveX = clampUnit(keys.x + stick.x);
      frame.camera.moveZ = clampUnit(-(keys.y + stick.y)); // stick / W up is −y
      return;
    }
    const ySign = s.invertY ? 1 : -1; // screen/stick +y is down; camera +y is up
    const mouseLive = reader.keysLive;
    const lookX = (stick.x * s.stickLookSpeed + keys.x * s.keyLookSpeed) * dt;
    const lookY = (stick.y * s.stickLookSpeed + keys.y * s.keyLookSpeed) * dt * ySign;
    const m = s.mouseSensitivity;
    frame.camera.lookX = lookX + (mouseLive ? this.mouse.lookX * m : 0);
    frame.camera.lookY = lookY + (mouseLive ? this.mouse.lookY * m * ySign : 0);
    frame.camera.orbitX = lookX + (mouseLive ? this.mouse.orbitX * m : 0);
    frame.camera.orbitY = lookY + (mouseLive ? this.mouse.orbitY * m * ySign : 0);
  }
}

const clampUnit = (value: number): number => Math.max(-1, Math.min(1, value));

function keyChords(binding: Binding): readonly string[] {
  switch (binding.kind) {
    case 'button':
      return binding.keys;
    case 'axis':
      return [...binding.keysPos, ...binding.keysNeg];
    case 'stick':
      return [...binding.keysLeft, ...binding.keysRight, ...binding.keysUp, ...binding.keysDown];
  }
}

// Reads one frame of keyboard and pad state through the gating rules.
class FrameReader {
  private keyState: KeyState;
  private pad: PadFrame;
  readonly keysLive: boolean;
  private padLive: boolean;

  constructor(keys: KeyState, pad: PadFrame, keysLive: boolean, padLive: boolean) {
    this.keyState = keys;
    this.pad = pad;
    this.keysLive = keysLive;
    this.padLive = padLive;
  }

  keyPressed(chord: string): boolean {
    return this.keysLive && this.keyState.wasPressed(chord);
  }

  private keyHeld(chords: readonly string[]): boolean {
    return this.keysLive && chords.some((chord) => this.keyState.isHeld(chord));
  }

  buttonFired(binding: ButtonBinding, keysLive: boolean): boolean {
    if (keysLive && binding.keys.some((chord) => this.keyState.wasPressed(chord))) return true;
    return binding.pad.some((p) => this.padFired(p));
  }

  padFired({ button, mode }: PadButtonBinding): boolean {
    if (!this.padLive) return false;
    const tracker = this.pad.buttons[button];
    return mode === 'press' ? tracker.pressed : mode === 'tap' ? tracker.tapped : tracker.held;
  }

  buttonHeld(binding: ButtonBinding, keysLive: boolean): boolean {
    // Exact Shift match, so holding Shift+R does not also hold R's action.
    const exact = (chord: string): boolean =>
      this.keyState.isHeld(chord) && parseChord(chord).shift === this.keyState.shiftDown;
    if (keysLive && binding.keys.some(exact)) return true;
    if (!this.padLive) return false;
    return binding.pad.some(({ button, mode }) => mode === 'press' && this.pad.buttons[button].down);
  }

  // Triggers are analog; shoulder buttons behave like keys so springs ramp.
  private padInto(button: PadButton | undefined, sign: number, input: AxisInput): void {
    if (!button) return;
    if (button === 'RT' || button === 'LT')
      input.analog += sign * (button === 'RT' ? this.pad.rt : this.pad.lt);
    else if (this.pad.buttons[button].down) input.digital += sign;
  }

  axisInput(binding: AxisBinding): AxisInput {
    const input: AxisInput = {
      digital: (this.keyHeld(binding.keysPos) ? 1 : 0) - (this.keyHeld(binding.keysNeg) ? 1 : 0),
      analog: 0,
    };
    if (this.padLive) {
      if (binding.padAxis) {
        const stick = binding.padAxis[0] === 'L' ? this.pad.left : this.pad.right;
        input.analog = binding.padAxis[1] === 'X' ? stick.x : stick.y;
      }
      this.padInto(binding.padPos, 1, input);
      this.padInto(binding.padNeg, -1, input);
    }
    return { digital: clampUnit(input.digital), analog: clampUnit(input.analog) };
  }

  stickKeys(binding: StickBinding): { x: number; y: number } {
    return {
      x: (this.keyHeld(binding.keysRight) ? 1 : 0) - (this.keyHeld(binding.keysLeft) ? 1 : 0),
      y: (this.keyHeld(binding.keysDown) ? 1 : 0) - (this.keyHeld(binding.keysUp) ? 1 : 0),
    };
  }

  stick(binding: StickBinding): { x: number; y: number } {
    if (!this.padLive) return { x: 0, y: 0 };
    const stick = binding.padStick === 'left' ? this.pad.left : this.pad.right;
    let { x, y } = stick;
    if (binding.padDpad) {
      const b = this.pad.buttons;
      x += (b.DRight.down ? 1 : 0) - (b.DLeft.down ? 1 : 0);
      y += (b.DDown.down ? 1 : 0) - (b.DUp.down ? 1 : 0);
    }
    return { x, y };
  }
}
