// MenuController: owns the menu screens over the live 3D view, a navigation stack (main → setup,
// pause → settings, …), the confirm dialog, typed events, and gamepad navigation through
// FocusNavigator. Call update() each frame with the 'menu' context's MenuInput while open.

import './menu.css';
import { directionOf, FocusNavigator, type NavDirection, RepeatTimer } from '../../input/focusNav';
import type { MenuInput } from '../../input/InputManager';
import type { SettingsStore, StorageLike } from '../../settings/store';
import { button, h } from './dom';
import {
  type ConfirmOptions,
  type FleetEntry,
  type MenuEventMap,
  type MenuHost,
  type MenuState,
  type Screen,
  type ScreenId,
} from './screens/common';
import { createHelpScreen } from './screens/helpScreens';
import { createMainScreen, createPauseScreen } from './screens/mainScreens';
import { createConditionsScreen, createFleetScreen } from './screens/pauseScreens';
import { createSettingsScreen } from './screens/settingsScreen';
import { createSetupScreen } from './screens/setupScreen';
import {
  type Conditions,
  conditionsOf,
  defaultSetup,
  loadLastSetup,
  sanitizeSetup,
  saveLastSetup,
  type ScenarioSetup,
  type SurvivalResult,
} from './setup';

export type { FleetAutopilot } from './screens/common';
export type { FleetEntry, MenuEventMap, ScreenId };

export interface MenuControllerOptions {
  settings: SettingsStore;
  // Persists the last started scenario for "Continue"; null = don't persist. Default: none.
  storage?: StorageLike | null;
  // Starting point for the setup screen (e.g. a deep-linked scenario). Default: last or defaults.
  initialSetup?: ScenarioSetup;
  // Listen for Esc / Page Up / Page Down directly. Leave off when an InputManager drives update(),
  // which already maps those keys to MenuInput.
  keyboard?: boolean;
}

type Listener<K extends keyof MenuEventMap> = (payload: MenuEventMap[K]) => void;

const FACTORIES: Record<ScreenId, (host: MenuHost) => Screen> = {
  main: createMainScreen,
  setup: createSetupScreen,
  pause: createPauseScreen,
  conditions: createConditionsScreen,
  fleet: createFleetScreen,
  settings: createSettingsScreen,
  help: createHelpScreen,
};

const FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export class MenuController {
  readonly element: HTMLElement;
  private readonly settings: SettingsStore;
  private readonly storage: StorageLike | null;
  private readonly state: MenuState;
  private readonly screens = new Map<ScreenId, Screen>();
  private readonly listeners = new Map<keyof MenuEventMap, Set<(payload: never) => void>>();
  private readonly navigator: FocusNavigator;
  private readonly sliderRepeat = new RepeatTimer(0.3, 0.06);
  private readonly host: MenuHost;
  private stack: ScreenId[] = [];
  private dialog: { element: HTMLElement; restore: HTMLElement | null } | null = null;
  private readonly abort = new AbortController();

  constructor(parent: HTMLElement, options: MenuControllerOptions) {
    this.settings = options.settings;
    this.storage = options.storage ?? null;
    const lastSetup = loadLastSetup(this.storage);
    const setup = sanitizeSetup(options.initialSetup ?? lastSetup ?? defaultSetup());
    this.state = {
      setup,
      lastSetup,
      conditions: conditionsOf(setup),
      fleet: [],
      survival: [],
      helmDown: false,
    };

    this.element = h('div', { class: 'menu-root', attrs: { hidden: true, 'data-input': 'keyboard' } });
    parent.append(this.element);
    this.navigator = new FocusNavigator(this.element, {
      onBack: () => this.back(),
      onTabPrev: () => this.stepTab(-1),
      onTabNext: () => this.stepTab(1),
    });

    // Screens call back into the controller through this narrow interface.
    this.host = {
      settings: this.settings,
      state: this.state,
      open: (id) => this.open(id),
      back: () => this.back(),
      emit: (type, payload) => this.emit(type, payload),
      confirm: (o) => this.confirm(o),
    };

    const signal = this.abort.signal;
    // Mouse use hides the gamepad focus ring style; keyboard Tab keeps native :focus-visible.
    this.element.addEventListener('pointerdown', () => this.setInputMode('pointer'), { signal });
    this.element.addEventListener('keydown', () => this.setInputMode('keyboard'), { signal });
    if (options.keyboard) {
      window.addEventListener(
        'keydown',
        (event) => {
          if (this.element.hidden) return;
          if (event.code === 'Escape') this.back();
          else if (event.code === 'PageUp') this.stepTab(-1);
          else if (event.code === 'PageDown') this.stepTab(1);
          else return;
          event.preventDefault();
        },
        { signal },
      );
    }
  }

  // --- Events -------------------------------------------------------------------------------

  on<K extends keyof MenuEventMap>(type: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (payload: never) => void);
    return () => {
      set.delete(listener as (payload: never) => void);
    };
  }

  private emit<K extends keyof MenuEventMap>(type: K, payload: MenuEventMap[K]): void {
    if (type === 'start') this.rememberStart(payload as ScenarioSetup);
    for (const listener of this.listeners.get(type) ?? []) (listener as Listener<K>)(payload);
  }

  private rememberStart(setup: ScenarioSetup): void {
    this.state.lastSetup = structuredClone(setup);
    this.state.conditions = conditionsOf(setup);
    saveLastSetup(this.storage, setup);
  }

  // --- Navigation ---------------------------------------------------------------------------

  get current(): ScreenId | null {
    return this.stack.at(-1) ?? null;
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  // Resets the stack to a root screen: 'main' at boot or after quitting, 'pause' in game.
  showMain(): void {
    this.reset('main');
  }

  showPause(options: { helmDown?: boolean } = {}): void {
    this.state.helmDown = options.helmDown ?? false;
    this.reset('pause');
  }

  // Pushes a screen (e.g. open('help') from a hotkey in game opens Help alone).
  open(id: ScreenId): void {
    const previous = this.current;
    if (previous === id) return;
    this.stack.push(id);
    this.display(previous);
  }

  // Esc / B. Closes a dialog, pops a screen, or resumes from the pause root.
  back(): void {
    if (this.dialog) {
      this.closeDialog();
      return;
    }
    const top = this.current;
    if (!top || top === 'main') return;
    if (top === 'pause' && this.stack.length === 1) {
      this.emit('resume', undefined);
      return;
    }
    this.stack.pop();
    this.display(top);
  }

  // Hides everything (e.g. when the game starts or resumes).
  hide(): void {
    const previous = this.current;
    this.closeDialog();
    this.stack = [];
    this.display(previous);
  }

  private reset(root: ScreenId): void {
    const previous = this.current;
    this.closeDialog();
    this.stack = [root];
    this.display(previous);
  }

  private screen(id: ScreenId): Screen {
    let screen = this.screens.get(id);
    if (!screen) {
      screen = FACTORIES[id](this.host);
      this.screens.set(id, screen);
      this.element.append(screen.element);
    }
    return screen;
  }

  private display(previous: ScreenId | null): void {
    const id = this.current;
    for (const [key, screen] of this.screens) screen.element.hidden = key !== id;
    this.element.hidden = id === null;
    this.element.dataset.screen = id ?? '';
    // The pause menu darkens the game more than the main menu, which shows off the ocean.
    this.element.classList.toggle('is-ingame', this.stack[0] === 'pause');
    if (id) {
      const screen = this.screen(id);
      screen.element.hidden = false;
      screen.show?.();
      this.navigator.container = screen.element;
      // Returning to a screen restores focus where it was; a new one focuses its default.
      const target =
        (screen.element.contains(document.activeElement) ? null : screen.initialFocus?.()) ?? null;
      (target ?? this.firstFocusable(screen.element))?.focus({ preventScroll: true });
    }
    if (previous !== id) this.emit('screen', { screen: id, previous });
  }

  private firstFocusable(root: HTMLElement): HTMLElement | null {
    return (
      [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
        (el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0,
      ) ?? null
    );
  }

  private stepTab(delta: number): void {
    if (this.dialog) return;
    const id = this.current;
    if (id) this.screens.get(id)?.tabs?.step(delta);
  }

  // --- Confirm dialog -----------------------------------------------------------------------

  confirm(options: ConfirmOptions): void {
    this.closeDialog();
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const cancel = button('Cancel', () => this.closeDialog(), 'menu-btn menu-btn-ghost');
    const ok = button(
      options.confirmLabel,
      () => {
        this.closeDialog();
        options.onConfirm();
      },
      'menu-btn menu-btn-primary',
    );
    const element = h('div', { class: 'menu-dialog-layer' }, [
      h(
        'div',
        {
          class: 'menu-dialog',
          attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': options.title },
        },
        [
          h('h2', { class: 'menu-dialog-title', text: options.title }),
          h('p', { class: 'menu-prose', text: options.message }),
          h('div', { class: 'menu-dialog-actions' }, [cancel, ok]),
        ],
      ),
    ]);
    for (const screen of this.screens.values()) screen.element.inert = true;
    this.element.append(element);
    this.dialog = { element, restore };
    this.navigator.container = element;
    cancel.focus();
  }

  private closeDialog(): void {
    if (!this.dialog) return;
    const { element, restore } = this.dialog;
    this.dialog = null;
    element.remove();
    for (const screen of this.screens.values()) screen.element.inert = false;
    const id = this.current;
    if (id) this.navigator.container = this.screen(id).element;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }

  // --- State from the game ------------------------------------------------------------------

  // The boats currently in the water (pause → Fleet). Call whenever the fleet changes.
  setFleet(fleet: readonly FleetEntry[]): void {
    this.state.fleet = fleet.map((entry) => ({ ...entry }));
    this.refreshIfShowing('fleet');
  }

  // What's running now, for pause → Conditions (also set automatically on 'start').
  setConditions(conditions: Conditions): void {
    this.state.conditions = structuredClone(conditions);
    this.refreshIfShowing('conditions');
  }

  setLastSetup(setup: ScenarioSetup | null): void {
    this.state.lastSetup = setup ? sanitizeSetup(setup) : null;
    this.refreshIfShowing('main');
  }

  // Live changes to the running voyage carry over to Continue (and are saved for next time).
  updateLastSetup(patch: Partial<ScenarioSetup>): void {
    const last = this.state.lastSetup;
    if (!last) return;
    const next = sanitizeSetup({ ...last, ...structuredClone(patch) });
    this.state.lastSetup = next;
    saveLastSetup(this.storage, next);
  }

  setSurvivalResults(results: readonly SurvivalResult[]): void {
    this.state.survival = results.map((r) => ({ ...r }));
    this.refreshIfShowing('setup');
  }

  // A copy of the setup screen's current draft.
  getSetup(): ScenarioSetup {
    return structuredClone(this.state.setup);
  }

  setSetup(setup: ScenarioSetup): void {
    this.state.setup = sanitizeSetup(setup);
    this.refreshIfShowing('setup');
  }

  private refreshIfShowing(id: ScreenId): void {
    if (this.current !== id || this.dialog) return;
    const screen = this.screens.get(id);
    if (!screen) return;
    // Re-rendering can replace the focused element; keep focus at the same position.
    const before = this.navigator.focusables();
    const index = before.indexOf(document.activeElement as HTMLElement);
    screen.show?.();
    if (index >= 0 && !screen.element.contains(document.activeElement)) {
      const after = this.navigator.focusables();
      after[Math.min(index, after.length - 1)]?.focus({ preventScroll: true });
    }
  }

  // --- Per-frame gamepad input --------------------------------------------------------------

  update(menu: MenuInput, dt: number): void {
    if (this.element.hidden) return;
    const padActive = menu.accept || ((menu.x !== 0 || menu.y !== 0) && !menu.fromKeyboard);
    if (padActive) this.setInputMode('gamepad');
    const active = document.activeElement;
    // Left / right on a focused slider adjusts it instead of moving focus (the keyboard's
    // arrows already do this natively).
    if (active instanceof HTMLInputElement && active.type === 'range' && !menu.fromKeyboard) {
      const dir = directionOf(menu.x, menu.y);
      const horizontal = dir === 'left' || dir === 'right' ? dir : null;
      const step = this.sliderRepeat.update(horizontal, dt);
      if (step) this.nudgeSlider(active, step);
      if (horizontal) {
        this.navigator.update({ ...menu, x: 0, y: 0 }, dt);
        return;
      }
    } else this.sliderRepeat.update(null, dt);
    this.navigator.update(menu, dt);
  }

  private nudgeSlider(input: HTMLInputElement, direction: NavDirection): void {
    if (direction === 'left') input.stepDown();
    else input.stepUp();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private setInputMode(mode: 'gamepad' | 'keyboard' | 'pointer'): void {
    if (this.element.dataset.input !== mode) this.element.dataset.input = mode;
  }

  dispose(): void {
    this.abort.abort();
    for (const screen of this.screens.values()) screen.dispose?.();
    this.screens.clear();
    this.listeners.clear();
    this.element.remove();
  }
}
