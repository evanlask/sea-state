// Per-frame input: turns keyboard and mouse state into BoatControls,
// camera deltas and one-shot actions for the active context, following the
// bindings table. DOM listeners live in dom.ts; everything here runs in Node.

import type { BoatControls, PhysicsMode } from '../sim/world/protocol';
import {
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
  type VectorBinding,
} from './bindings';
import { type BoatContext, isBoatContext, type PollContext } from './contexts';
import { KeyState, MouseState, parseChord } from './keyboard';

export interface CameraInput {
  lookX: number; // radians this frame, + right
  lookY: number; // radians this frame, + up (after invert-Y)
  orbitX: number;
  orbitY: number;
  zoom: number; // wheel notches this frame, + out
  next: boolean;
  prev: boolean;
  reset: boolean;
  photo: boolean; // toggle photo mode
  // Photo mode only (zero otherwise):
  moveX: number; // −1..1, + right
  moveY: number; // −1..1, + up
  moveZ: number; // −1..1, + forward
  slowMotion: boolean; // cycle the simulation speed
}

export const NO_CAMERA_INPUT: Readonly<CameraInput> = {
  lookX: 0,
  lookY: 0,
  orbitX: 0,
  orbitY: 0,
  zoom: 0,
  next: false,
  prev: false,
  reset: false,
  photo: false,
  moveX: 0,
  moveY: 0,
  moveZ: 0,
  slowMotion: false,
};

export interface MenuInput {
  x: number; // −1..1, + right
  y: number; // −1..1, + down
  fromKeyboard: boolean; // arrows contributed (text fields and sliders use them natively)
  back: boolean;
  tabPrev: boolean;
  tabNext: boolean;
}

interface TelegraphState {
  notch: number; // index into TELEGRAPH_NOTCHES
  info: TelegraphNotch;
}

export interface InputFrame {
  context: PollContext;
  controls: BoatControls;
  camera: CameraInput;
  menu: MenuInput;
  triggered: Set<ActionId>; // one-shot actions that fired this frame
  held: Set<ButtonActionId>; // button actions currently held (e.g. horn)
  telegraph: TelegraphState | null; // ship and cruise contexts only
}

export interface InputSettings {
  mouseSensitivity: number; // rad per pixel
  keyLookSpeed: number; // rad/s for arrow keys
  keyZoomSpeed: number; // notches/s for − / =
  invertY: boolean;
}

export const DEFAULT_INPUT_SETTINGS: InputSettings = {
  mouseSensitivity: 0.0025,
  keyLookSpeed: 1.5,
  keyZoomSpeed: 6,
  invertY: false,
};

export interface InputSources {
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

export class InputManager {
  readonly keys = new KeyState();
  readonly mouse = new MouseState();
  settings: InputSettings;
  sources: InputSources;
  private physicsMode: PhysicsMode = 'arcade';
  context: PollContext = 'menu';
  private helms = new Map<BoatContext, HelmState>();

  constructor(settings: Partial<InputSettings> = {}, sources: InputSources = {}) {
    this.settings = { ...DEFAULT_INPUT_SETTINGS, ...settings };
    this.sources = sources;
  }

  // Arcade helms centre themselves when let go; Realistic ones stay put (bindings' realisticSpecs).
  setPhysicsMode(mode: PhysicsMode): void {
    this.physicsMode = mode;
  }

  updateSettings(patch: Partial<InputSettings>): void {
    Object.assign(this.settings, patch);
  }

  // Call when the player takes a different boat so levers start from rest.
  resetHelm(context?: BoatContext): void {
    if (context) this.helms.delete(context);
    else this.helms.clear();
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
    const uiFocused = this.sources.isUiFocused?.() ?? false;
    // A focused text field swallows every key except Esc in menus, so the player can leave it.
    const reader = new FrameReader(this.keys, !uiFocused);

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
      menu: { x: 0, y: 0, fromKeyboard: false, back: false, tabPrev: false, tabNext: false },
      triggered: new Set(),
      held: new Set(),
      telegraph: null,
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
      const handsOff = new FrameReader(this.keys, false);
      this.applyHelm(idleHelm, bindingsFor(idleHelm), handsOff, frame, dt);
    }
    for (const binding of bindings) {
      if (binding.kind === 'vector') this.applyVector(binding, reader, frame, dt);
      else if (binding.kind === 'axis' && binding.id === 'zoom') {
        const keys = reader.axisInput(binding);
        frame.camera.zoom = keys * this.settings.keyZoomSpeed * dt + (reader.keysLive ? this.mouse.wheel : 0);
      } else if (binding.kind === 'axis' && binding.id === 'photoRise') {
        frame.camera.moveY = reader.axisInput(binding);
      }
    }

    const fired = (id: ActionId): boolean => frame.triggered.has(id);
    frame.camera.next = fired('cameraNext');
    frame.camera.prev = fired('cameraPrev');
    frame.camera.reset = fired('cameraReset');
    frame.camera.photo = fired('photoMode');
    frame.camera.slowMotion = fired('photoSlowMo');
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
      };
    }
  }

  private applyVector(binding: VectorBinding, reader: FrameReader, frame: InputFrame, dt: number): void {
    const s = this.settings;
    const keys = reader.vectorKeys(binding);
    if (binding.id === 'menuNavigate') {
      frame.menu.x = keys.x;
      frame.menu.y = keys.y;
      frame.menu.fromKeyboard = keys.x !== 0 || keys.y !== 0;
      return;
    }
    if (binding.id === 'photoMove') {
      frame.camera.moveX = keys.x;
      frame.camera.moveZ = -keys.y; // W (up) is −y
      return;
    }
    const ySign = s.invertY ? 1 : -1; // screen +y is down; camera +y is up
    const mouseLive = reader.keysLive;
    const lookX = keys.x * s.keyLookSpeed * dt;
    const lookY = keys.y * s.keyLookSpeed * dt * ySign;
    const m = s.mouseSensitivity;
    frame.camera.lookX = lookX + (mouseLive ? this.mouse.lookX * m : 0);
    frame.camera.lookY = lookY + (mouseLive ? this.mouse.lookY * m * ySign : 0);
    frame.camera.orbitX = lookX + (mouseLive ? this.mouse.orbitX * m : 0);
    frame.camera.orbitY = lookY + (mouseLive ? this.mouse.orbitY * m * ySign : 0);
  }
}

function keyChords(binding: Binding): readonly string[] {
  switch (binding.kind) {
    case 'button':
      return binding.keys;
    case 'axis':
      return [...binding.keysPos, ...binding.keysNeg];
    case 'vector':
      return [...binding.keysLeft, ...binding.keysRight, ...binding.keysUp, ...binding.keysDown];
  }
}

// Reads one frame of keyboard state through the gating rules.
class FrameReader {
  private keyState: KeyState;
  readonly keysLive: boolean;

  constructor(keys: KeyState, keysLive: boolean) {
    this.keyState = keys;
    this.keysLive = keysLive;
  }

  keyPressed(chord: string): boolean {
    return this.keysLive && this.keyState.wasPressed(chord);
  }

  private keyHeld(chords: readonly string[]): boolean {
    return this.keysLive && chords.some((chord) => this.keyState.isHeld(chord));
  }

  buttonFired(binding: ButtonBinding, keysLive: boolean): boolean {
    return keysLive && binding.keys.some((chord) => this.keyState.wasPressed(chord));
  }

  buttonHeld(binding: ButtonBinding, keysLive: boolean): boolean {
    // Exact Shift match, so holding Shift+R does not also hold R's action.
    const exact = (chord: string): boolean =>
      this.keyState.isHeld(chord) && parseChord(chord).shift === this.keyState.shiftDown;
    return keysLive && binding.keys.some(exact);
  }

  // −1, 0 or 1.
  axisInput(binding: AxisBinding): number {
    return (this.keyHeld(binding.keysPos) ? 1 : 0) - (this.keyHeld(binding.keysNeg) ? 1 : 0);
  }

  vectorKeys(binding: VectorBinding): { x: number; y: number } {
    return {
      x: (this.keyHeld(binding.keysRight) ? 1 : 0) - (this.keyHeld(binding.keysLeft) ? 1 : 0),
      y: (this.keyHeld(binding.keysDown) ? 1 : 0) - (this.keyHeld(binding.keysUp) ? 1 : 0),
    };
  }
}
