import { describe, expect, it } from 'vite-plus/test';

import type { GamepadLike } from './gamepad';
import { guardedGamepads, InputManager } from './InputManager';
import { isBrowserShortcut, isTextEntry, KeyState, MouseState } from './keyboard';

interface MutablePad extends GamepadLike {
  buttons: { pressed: boolean; value: number }[];
  axes: number[];
}

function makePad(): MutablePad {
  return {
    id: 'pad',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    axes: [0, 0, 0, 0],
  };
}

function setup(pads: (GamepadLike | null)[] = [], focused = false) {
  const state = { focused };
  const input = new InputManager({}, { getGamepads: () => pads, isUiFocused: () => state.focused });
  const press = (code: string, shift = false) => input.keys.keyDown(code, false, shift);
  const release = (code: string) => input.keys.keyUp(code, false);
  return { input, press, release, state };
}

const DT = 1 / 60;

describe('InputManager keyboard', () => {
  it('steps the ship telegraph one notch per press, ignoring repeats', () => {
    const { input, press, release } = setup();
    press('KeyW');
    input.keys.keyDown('KeyW', true, false);
    let frame = input.poll(DT, 'ship');
    expect(frame.telegraph?.info.name).toBe('Dead Slow Ahead');
    expect(frame.controls.throttle).toBeCloseTo(0.2);
    frame = input.poll(DT, 'ship'); // still held, no new edge
    expect(frame.telegraph?.notch).toBe(5);
    release('KeyW');
    press('KeyW');
    frame = input.poll(DT, 'ship');
    expect(frame.telegraph?.info.name).toBe('Slow Ahead');
  });

  it('lets fly on the sailboat while Space is held', () => {
    const { input, press, release } = setup();
    press('Space');
    expect(input.poll(DT, 'sail').controls.letFly).toBe(true);
    expect(input.poll(DT, 'sail').controls.letFly).toBe(true);
    release('Space');
    expect(input.poll(DT, 'sail').controls.letFly).toBe(false);
    press('Space');
    expect(input.poll(DT, 'powerboat').controls).toMatchObject({ letFly: false, brake: true });
  });

  it('all stop returns the telegraph to Stop and brakes while held', () => {
    const { input, press } = setup();
    press('KeyW');
    input.poll(DT, 'ship');
    press('Space');
    const frame = input.poll(DT, 'ship');
    expect(frame.telegraph?.info.name).toBe('Stop');
    expect(frame.controls.brake).toBe(true);
    expect(frame.triggered.has('allStop')).toBe(true);
  });

  it('hydroplane: a power lever with no reverse, Space snaps it to idle, Q / E trim the wing', () => {
    const { input, press, release } = setup();
    press('KeyS');
    for (let i = 0; i < 30; i++) input.poll(DT, 'hydro');
    expect(input.poll(DT, 'hydro').controls.throttle).toBe(0); // no astern
    release('KeyS');
    press('KeyW');
    let frame = input.poll(DT, 'hydro');
    for (let i = 0; i < 59; i++) frame = input.poll(DT, 'hydro');
    expect(frame.controls.throttle).toBeCloseTo(0.8, 1); // 0.8 a second
    release('KeyW');
    expect(input.poll(DT, 'hydro').controls.throttle).toBeCloseTo(0.8, 1); // stays set
    press('Space');
    frame = input.poll(DT, 'hydro');
    expect(frame.triggered.has('throttleOff')).toBe(true);
    expect(frame.controls.throttle).toBe(0);
    expect(frame.controls.brake).toBe(false);
    release('Space');
    press('KeyE');
    expect(input.poll(DT, 'hydro').controls.trim).toBe(1);
    release('KeyE');
    press('KeyQ');
    expect(input.poll(DT, 'hydro').controls.trim).toBe(-1);
  });

  it('in Realistic keeps the ship helm order and centres it with midships', () => {
    const { input, press, release } = setup();
    input.setPhysicsMode('realistic');
    press('KeyD');
    for (let i = 0; i < 60; i++) input.poll(DT, 'ship');
    release('KeyD');
    let frame = input.poll(DT, 'ship');
    expect(frame.controls.steer).toBeGreaterThan(0.5);
    frame = input.poll(1, 'ship');
    expect(frame.controls.steer).toBeGreaterThan(0.5);
    press('KeyX');
    frame = input.poll(DT, 'ship');
    expect(frame.controls.steer).toBe(0);
  });

  it('in Arcade springs every helm back to centre, ships included', () => {
    const { input, press, release } = setup();
    press('KeyD');
    for (let i = 0; i < 60; i++) input.poll(DT, 'ship');
    release('KeyD');
    let frame = input.poll(DT, 'ship');
    for (let i = 0; i < 10; i++) frame = input.poll(0.2, 'ship');
    expect(frame.controls.steer).toBe(0);
  });

  it('in Realistic small-craft steering stays where it is left; X centres it', () => {
    const { input, press, release } = setup();
    input.setPhysicsMode('realistic');
    press('KeyA');
    for (let i = 0; i < 5; i++) input.poll(0.1, 'pwc');
    release('KeyA');
    let frame = input.poll(1, 'pwc');
    expect(frame.controls.steer).toBeLessThan(-0.5);
    press('KeyX');
    frame = input.poll(DT, 'pwc');
    expect(frame.controls.steer).toBe(0);
  });

  it('springs small-craft steering back to centre', () => {
    const { input, press, release } = setup();
    press('KeyA');
    let frame = input.poll(0.1, 'pwc');
    expect(frame.controls.steer).toBeLessThan(0);
    release('KeyA');
    for (let i = 0; i < 10; i++) frame = input.poll(0.1, 'pwc');
    expect(frame.controls.steer).toBe(0);
  });

  it('drives sail sheets as rates and fires sail commands', () => {
    const { input, press } = setup();
    press('KeyW');
    press('KeyQ');
    press('KeyR');
    let frame = input.poll(DT, 'sail');
    expect(frame.controls.mainSheet).toBe(1);
    expect(frame.controls.jibSheet).toBe(-1);
    expect(frame.controls.throttle).toBe(0);
    expect(frame.triggered.has('reefIn')).toBe(true);
    press('KeyR', true);
    input.keys.keyUp('KeyR', true);
    press('KeyR', true);
    frame = input.poll(DT, 'sail');
    expect(frame.triggered.has('reefOut')).toBe(true);
    expect(frame.triggered.has('reefIn')).toBe(false);
  });

  it('separates Tab and Shift+Tab', () => {
    const { input, press, release } = setup();
    press('Tab');
    expect(input.poll(DT, 'ship').triggered.has('nextBoat')).toBe(true);
    release('Tab');
    press('Tab', true);
    const frame = input.poll(DT, 'ship');
    expect(frame.triggered.has('prevBoat')).toBe(true);
    expect(frame.triggered.has('nextBoat')).toBe(false);
  });

  it('reports horn as held', () => {
    const { input, press } = setup();
    press('KeyB');
    expect(input.poll(DT, 'cruise').held.has('horn')).toBe(true);
  });

  it('ignores game keys while a text field has focus, except Esc in menus', () => {
    const { input, press, state } = setup([], true);
    press('KeyW');
    press('KeyH');
    let frame = input.poll(DT, 'ship');
    expect(frame.telegraph?.notch).toBe(4);
    expect(frame.triggered.size).toBe(0);
    press('Escape');
    frame = input.poll(DT, 'menu');
    expect(frame.menu.back).toBe(true);
    state.focused = false;
  });

  it('turns mouse movement into look and orbit', () => {
    const { input } = setup();
    input.mouse.move(100, 0, true);
    let frame = input.poll(DT, 'ship');
    expect(frame.camera.lookX).toBeCloseTo(0.25);
    expect(frame.lastDevice).toBe('keyboard');
    input.mouse.dragging = true;
    input.mouse.move(0, 40, false);
    input.mouse.scroll(100, 0);
    frame = input.poll(DT, 'ship');
    expect(frame.camera.orbitY).toBeCloseTo(-0.1);
    expect(frame.camera.lookX).toBe(0);
    expect(frame.camera.zoom).toBeCloseTo(1);
  });

  it('marks bound keys so the DOM glue can prevent defaults', () => {
    const { input } = setup();
    input.poll(DT, 'ship');
    expect(input.isBound('Tab', false)).toBe(true);
    expect(input.isBound('Space', false)).toBe(true);
    expect(input.isBound('KeyJ', false)).toBe(false);
  });
});

describe('InputManager gamepad', () => {
  it('sweeps the telegraph with RT and snaps when released', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    pad.buttons[7] = { pressed: true, value: 1 };
    let frame = input.poll(0.25, 'ship');
    frame = input.poll(0.25, 'ship'); // lever 0.4
    expect(frame.lastDevice).toBe('gamepad');
    expect(frame.telegraph?.lever).toBeCloseTo(0.4);
    pad.buttons[7] = { pressed: false, value: 0.3 };
    frame = input.poll(0.05, 'ship');
    pad.buttons[7] = { pressed: false, value: 0 };
    frame = input.poll(DT, 'ship');
    expect(frame.telegraph?.info.name).toBe('Slow Ahead');
    expect(frame.controls.throttle).toBe(0.4);
  });

  it('springs the jet ski throttle with the trigger', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    pad.buttons[7] = { pressed: true, value: 1 };
    expect(input.poll(DT, 'pwc').controls.throttle).toBe(1);
    pad.buttons[7] = { pressed: false, value: 0 };
    let frame = input.poll(DT, 'pwc');
    for (let i = 0; i < 30; i++) frame = input.poll(DT, 'pwc');
    expect(frame.controls.throttle).toBe(0);
  });

  it('steers with the left stick through the dead zone', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    pad.axes[0] = 0.1;
    expect(input.poll(DT, 'powerboat').controls.steer).toBe(0);
    pad.axes[0] = -1;
    expect(input.poll(DT, 'powerboat').controls.steer).toBe(-1);
  });

  it('separates View tap (HUD) from View hold (recover), and Y tap (camera) from hold (zoom step)', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    pad.buttons[8] = { pressed: true, value: 1 };
    input.poll(0.1, 'ship');
    pad.buttons[8] = { pressed: false, value: 0 };
    let frame = input.poll(0.1, 'ship');
    expect(frame.triggered.has('hud')).toBe(true);
    expect(frame.triggered.has('recover')).toBe(false);

    pad.buttons[8] = { pressed: true, value: 1 };
    const fired: string[] = [];
    for (let i = 0; i < 10; i++) for (const id of input.poll(0.1, 'ship').triggered) fired.push(id);
    pad.buttons[8] = { pressed: false, value: 0 };
    for (const id of input.poll(0.1, 'ship').triggered) fired.push(id);
    expect(fired).toEqual(['recover']);

    pad.buttons[3] = { pressed: true, value: 1 };
    let steps = 0;
    for (let i = 0; i < 12; i++) {
      const camera = input.poll(0.1, 'ship').camera;
      if (camera.zoomStep) steps++;
      expect(camera.prev).toBe(false);
    }
    pad.buttons[3] = { pressed: false, value: 0 };
    frame = input.poll(0.1, 'ship');
    expect(steps).toBe(1);
    expect(frame.camera.next).toBe(false);
    pad.buttons[3] = { pressed: true, value: 1 };
    input.poll(0.1, 'ship');
    pad.buttons[3] = { pressed: false, value: 0 };
    expect(input.poll(0.1, 'ship').camera).toMatchObject({ next: true, zoomStep: false });
  });

  it('clicking the steering stick centres the helm; on the sailboat holding it toggles auto-trim', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    const click = (seconds: number, context: 'sail' | 'powerboat'): string[] => {
      const fired: string[] = [];
      pad.buttons[10] = { pressed: true, value: 1 };
      for (let t = 0; t < seconds; t += 0.1) fired.push(...input.poll(0.1, context).triggered);
      pad.buttons[10] = { pressed: false, value: 0 };
      fired.push(...input.poll(0.1, context).triggered);
      return fired;
    };
    expect(click(0.1, 'sail')).toEqual(['midships']);
    expect(click(1, 'sail')).toEqual(['autoTrim']);
    expect(click(0.1, 'powerboat')).toEqual(['midships']);
  });

  it('feeds menu navigation and accept from the pad only in menus', () => {
    const pad = makePad();
    const { input } = setup([pad]);
    pad.buttons[13] = { pressed: true, value: 1 };
    pad.buttons[0] = { pressed: true, value: 1 };
    let frame = input.poll(DT, 'menu');
    expect(frame.menu.y).toBe(1);
    expect(frame.menu.accept).toBe(true);
    expect(frame.triggered.has('horn')).toBe(false);
    pad.buttons[0] = { pressed: false, value: 0 };
    input.poll(DT, 'ship');
    pad.buttons[0] = { pressed: true, value: 1 };
    frame = input.poll(DT, 'ship');
    expect(frame.triggered.has('horn')).toBe(true);
    expect(frame.menu.accept).toBe(false);
  });

  it('reports pads appearing after the first button press', () => {
    const pads: (GamepadLike | null)[] = [];
    const { input } = setup(pads);
    const changes: string[] = [];
    input.onPadChange = (change) => changes.push(change.type);
    input.poll(DT, 'ship');
    pads.push(makePad());
    input.poll(DT, 'ship');
    pads.pop();
    input.poll(DT, 'ship');
    expect(changes).toEqual(['connected', 'disconnected']);
  });
});

describe('KeyState', () => {
  it('clears on blur so keys do not stick', () => {
    const keys = new KeyState();
    keys.keyDown('KeyW', false, false);
    keys.clear();
    expect(keys.isDown('KeyW')).toBe(false);
  });
});

describe('guardedGamepads', () => {
  it('reads as no pads once the Gamepad API throws, without throwing again', () => {
    let calls = 0;
    const read = guardedGamepads(() => {
      calls++;
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(read()).toEqual([]);
    expect(read()).toEqual([]);
    expect(calls).toBe(1);
  });

  it('passes the pads through while it works', () => {
    const pads = [null];
    expect(guardedGamepads(() => pads)()).toBe(pads);
  });
});

describe('MouseState', () => {
  it('only orbits while right-dragging', () => {
    const mouse = new MouseState();
    mouse.move(10, 10, false);
    expect(mouse.orbitX).toBe(0);
    expect(mouse.hadInput).toBe(false);
  });

  it('stops orbiting once a lost mouseup is covered by release()', () => {
    const mouse = new MouseState();
    mouse.dragging = true;
    mouse.release();
    mouse.move(10, 10, false);
    expect(mouse.orbitX).toBe(0);
  });
});

describe('isTextEntry', () => {
  it('recognises text fields but not buttons or sliders', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'input', type: 'range' })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON' })).toBe(false);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('InputManager photo mode', () => {
  it('flies the camera with WASD and Q / E instead of steering', () => {
    const { input, press } = setup();
    press('KeyW');
    press('KeyD');
    press('KeyE');
    const frame = input.poll(DT, 'photo', 'powerboat');
    expect(frame.camera).toMatchObject({ moveZ: 1, moveX: 1, moveY: 1 });
    expect(frame.controls.throttle).toBe(0);
    expect(frame.controls.steer).toBe(0);
  });

  it('keeps the helm where it was in photo mode (Realistic: every helm holds)', () => {
    const { input, press, release } = setup();
    input.setPhysicsMode('realistic');
    press('KeyW');
    input.poll(DT, 'ship');
    release('KeyW');
    press('KeyD');
    for (let i = 0; i < 60; i++) input.poll(DT, 'ship');
    release('KeyD');
    let frame = input.poll(DT, 'photo', 'ship');
    for (let i = 0; i < 60; i++) frame = input.poll(DT, 'photo', 'ship');
    expect(frame.telegraph?.info.name).toBe('Dead Slow Ahead');
    expect(frame.controls.steer).toBeGreaterThan(0.5);

    press('KeyA');
    for (let i = 0; i < 10; i++) input.poll(0.1, 'pwc');
    release('KeyA');
    for (let i = 0; i < 20; i++) frame = input.poll(0.1, 'photo', 'pwc');
    expect(frame.controls.steer).toBeLessThan(-0.5);
  });

  it('toggles photo mode and slow motion; the wheel still arrives as zoom notches', () => {
    const { input, press, release } = setup();
    press('KeyK');
    expect(input.poll(DT, 'ship').camera.photo).toBe(true);
    release('KeyK');
    press('KeyT');
    expect(input.poll(DT, 'photo', 'ship').camera.slowMotion).toBe(true);
    input.mouse.wheel = 2;
    expect(input.poll(DT, 'photo', 'ship').camera.zoom).toBe(2);
  });
});

describe('browser shortcuts', () => {
  it('leaves Ctrl, Cmd and Alt chords to the browser, not Shift', () => {
    expect(isBrowserShortcut({ metaKey: true })).toBe(true);
    expect(isBrowserShortcut({ ctrlKey: true })).toBe(true);
    expect(isBrowserShortcut({ altKey: true })).toBe(true);
    expect(isBrowserShortcut({})).toBe(false);
    expect(isBrowserShortcut({ ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
  });
});
