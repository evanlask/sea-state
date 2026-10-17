// Shared screen plumbing: the screen interface, the host API screens use to navigate and emit,
// and the framed glass panel every screen sits in.

import type { SettingsStore } from '../../../settings/store';
import type { BoatKind } from '../../../sim/world/protocol';
import { button, h, type Tabs } from '../dom';
import type { Conditions, ScenarioSetup, SurvivalResult } from '../setup';

export type ScreenId = 'main' | 'setup' | 'pause' | 'conditions' | 'fleet' | 'settings' | 'help';

export const SCREEN_IDS: readonly ScreenId[] = [
  'main',
  'setup',
  'pause',
  'conditions',
  'fleet',
  'settings',
  'help',
];

export interface FleetEntry {
  id: string;
  kind: BoatKind;
  name?: string; // defaults to the boat card name
  helm: boolean; // the boat the player is steering
  autopilot?: FleetAutopilot; // what it does while nobody helms it
}

export type FleetAutopilot = 'follow' | 'hold' | 'circle' | 'drift' | 'windAngle';

export interface MenuEventMap {
  start: ScenarioSetup; // Sail (new) or Continue (last setup)
  resume: undefined;
  conditions: Conditions; // pause-menu live change
  fleetAdd: BoatKind;
  fleetRemove: string; // FleetEntry.id
  takeHelm: string; // FleetEntry.id
  fleetAutopilot: { id: string; mode: FleetAutopilot };
  recover: undefined; // right (or refloat) the boat at the helm, then resume
  quit: undefined; // back to the main menu, confirmed
  screen: { screen: ScreenId | null; previous: ScreenId | null };
}

export interface MenuState {
  setup: ScenarioSetup; // the setup screen's working draft
  lastSetup: ScenarioSetup | null;
  conditions: Conditions; // what's running now (pause menu)
  fleet: FleetEntry[];
  survival: SurvivalResult[];
  helmDown: boolean; // the boat at the helm is capsized or sunk (pause menu offers Recover first)
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface MenuHost {
  readonly settings: SettingsStore;
  readonly state: MenuState;
  open(id: ScreenId): void;
  back(): void;
  emit<K extends keyof MenuEventMap>(type: K, payload: MenuEventMap[K]): void;
  confirm(options: ConfirmOptions): void;
}

export interface Screen {
  readonly id: ScreenId;
  readonly element: HTMLElement;
  readonly tabs?: Tabs;
  show?(): void; // refresh from state just before it's displayed
  initialFocus?(): HTMLElement | null;
  dispose?(): void;
}

export interface Frame {
  root: HTMLElement;
  header: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  backButton: HTMLButtonElement;
}

// Glass panel with a header (kicker, title, back), a scrolling body and a footer.
export function frame(options: {
  id: ScreenId;
  title: string;
  kicker?: string;
  size?: 'narrow' | 'wide';
  onBack: () => void;
  backLabel?: string;
}): Frame {
  const backButton = button(
    [
      h('span', { class: 'menu-glyph menu-glyph-back', attrs: { 'aria-hidden': 'true' } }),
      options.backLabel ?? 'Back',
    ],
    options.onBack,
    'menu-btn menu-btn-ghost menu-back',
  );
  const titleId = `menu-title-${options.id}`;
  const header = h('header', { class: 'menu-panel-header' }, [
    h('div', { class: 'menu-panel-titles' }, [
      options.kicker ? h('div', { class: 'menu-kicker', text: options.kicker }) : null,
      h('h2', { class: 'menu-title', text: options.title, attrs: { id: titleId } }),
    ]),
  ]);
  const body = h('div', { class: 'menu-panel-body' });
  const footer = h('footer', { class: 'menu-panel-footer' }, [backButton]);
  const root = h(
    'div',
    {
      class: `menu-screen menu-screen-${options.id}`,
      attrs: { role: 'dialog', 'aria-labelledby': titleId, 'data-screen': options.id },
    },
    [h('div', { class: `menu-panel menu-panel-${options.size ?? 'wide'}` }, [header, body, footer])],
  );
  return { root, header, body, footer, backButton };
}
