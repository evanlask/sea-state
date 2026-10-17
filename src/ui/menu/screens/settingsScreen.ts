// Settings: one tab per settings section, every field generated from SETTINGS_TABS and bound
// live to the SettingsStore (each change is written straight away; the store re-detects the
// graphics preset, and subscribe() pushes values back into the controls).

import {
  APPLY_MODE_LABEL,
  type ApplyMode,
  applyModeOf,
  PRESET_APPLY_NOTE,
} from '../../../settings/applyMode';
import { PRESET_ORDER } from '../../../settings/presets';
import type { GraphicsPreset } from '../../../settings/schema';
import type { ReadonlySettings } from '../../../settings/store';
import { button, choice, type Control, field, h, section, slider, tabs, toggle } from '../dom';
import {
  choiceOptionsWith,
  getAtPath,
  resetTab,
  type SettingDescriptor,
  SETTINGS_TABS,
  writeSetting,
} from '../settingsFields';
import { frame, type MenuHost, type Screen } from './common';

const PRESET_LABELS: Record<GraphicsPreset, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
  custom: 'Custom',
};

const PRESET_HINTS: Record<GraphicsPreset, string> = {
  low: 'Integrated graphics and older laptops',
  medium: 'Mid-range laptops',
  high: 'Desktop GPUs',
  ultra: 'High-end GPUs; 4K-ready',
  custom: 'Your own mix',
};

// "Brief pause to apply" / "Applies next voyage" (nothing for settings that apply instantly).
function applyBadge(mode: ApplyMode): HTMLElement | null {
  if (mode === 'instant') return null;
  return h('span', { class: `menu-apply-badge menu-apply-${mode}`, text: APPLY_MODE_LABEL[mode] });
}

interface Bound {
  descriptor: SettingDescriptor;
  refresh(settings: ReadonlySettings): void;
}

function bindField(host: MenuHost, descriptor: SettingDescriptor): { element: HTMLElement; bound: Bound } {
  const store = host.settings;
  const current = (): unknown => getAtPath(store.get(), descriptor.path);
  const write = (value: unknown): void => {
    writeSetting(store, descriptor.path, value);
  };
  const { control } = descriptor;
  const holder = h('div', { class: 'menu-field-slot' });
  let refresh: (settings: ReadonlySettings) => void;
  if (control.kind === 'toggle') {
    const t = toggle(Boolean(current()), descriptor.label, write);
    holder.append(t.element);
    refresh = (settings) => t.set(Boolean(getAtPath(settings, descriptor.path)));
  } else if (control.kind === 'range') {
    const s = slider(Number(current()), { ...control, label: descriptor.label }, write);
    holder.append(s.element);
    refresh = (settings) => s.set(Number(getAtPath(settings, descriptor.path)));
  } else {
    // Rebuilt only when an off-list value (from a hand-edited save) appears or goes away.
    let key = '';
    let c: Control<string | number> | null = null;
    refresh = (settings) => {
      const value = getAtPath(settings, descriptor.path) as string | number;
      const options = choiceOptionsWith(descriptor, value);
      const nextKey = options.map((o) => o.value).join('|');
      if (nextKey !== key || !c) {
        const hadFocus = holder.contains(document.activeElement);
        key = nextKey;
        c = choice(options, value, write, descriptor.label);
        holder.replaceChildren(c.element);
        if (hadFocus) c.element.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      }
      c.set(value);
    };
    refresh(store.get());
  }
  const element = field(
    descriptor.label,
    holder,
    descriptor.description,
    descriptor.hint,
    applyBadge(applyModeOf(descriptor.path)),
  );
  element.dataset.path = descriptor.path;
  return { element, bound: { descriptor, refresh } };
}

export function createSettingsScreen(host: MenuHost): Screen {
  const store = host.settings;
  const f = frame({
    id: 'settings',
    title: 'Settings',
    kicker: 'Saved automatically',
    onBack: () => host.back(),
  });
  const bound: Bound[] = [];
  const presetButtons: { preset: GraphicsPreset; el: HTMLButtonElement }[] = [];

  const panels = SETTINGS_TABS.map((tab) => {
    const panel = h('div', { class: `menu-settings-tab menu-settings-${tab.section}` });
    if (tab.section === 'graphics') {
      const presets: GraphicsPreset[] = [...PRESET_ORDER, 'custom'];
      const row = h('div', {
        class: 'menu-preset-row',
        attrs: { role: 'radiogroup', 'aria-label': 'Quality preset' },
      });
      for (const preset of presets) {
        const el = button(
          [
            h('span', { class: 'menu-card-title', text: PRESET_LABELS[preset] }),
            h('span', { class: 'menu-card-sub', text: PRESET_HINTS[preset] }),
          ],
          () => {
            // 'custom' just keeps the current values; the store flips to it on any manual tweak.
            if (preset !== 'custom') store.update({ graphics: { preset } });
          },
          'menu-card menu-preset',
          { role: 'radio', 'aria-checked': 'false' },
        );
        if (preset === 'custom') el.setAttribute('aria-disabled', 'true');
        presetButtons.push({ preset, el });
        row.append(el);
      }
      panel.append(
        section('Quality preset', [
          row,
          h('p', {
            class: 'menu-note',
            text: 'Physics is identical at every level. Changing any option below switches to Custom.',
          }),
          h('div', { class: 'menu-apply-legend' }, [
            h('span', {}, ['Unmarked options apply instantly.']),
            h('span', {}, [applyBadge('rebuild'), 'Shaders rebuild: a short pause']),
            h('span', {}, [applyBadge('nextVoyage'), 'Takes effect when a voyage starts']),
          ]),
          h('p', { class: 'menu-note', text: PRESET_APPLY_NOTE }),
        ]),
      );
    }
    for (const group of tab.groups) {
      const fields = group.fields.map((descriptor) => {
        const { element, bound: b } = bindField(host, descriptor);
        bound.push(b);
        return element;
      });
      panel.append(section(group.title, [h('div', { class: 'menu-field-list' }, fields)]));
    }
    const reset = button(
      `Reset ${tab.title.toLowerCase()}`,
      () =>
        host.confirm({
          title: `Reset ${tab.title.toLowerCase()} settings?`,
          message: 'Every option on this tab goes back to its default.',
          confirmLabel: 'Reset',
          onConfirm: () => resetTab(store, tab),
        }),
      'menu-btn menu-btn-ghost menu-btn-small',
    );
    panel.append(h('div', { class: 'menu-reset-row' }, [reset]));
    return { label: tab.title, panel };
  });

  const tabStrip = tabs(panels);
  f.header.append(tabStrip.element);
  f.body.append(tabStrip.panels);

  const refresh = (settings: ReadonlySettings): void => {
    for (const b of bound) b.refresh(settings);
    for (const { preset, el } of presetButtons)
      el.setAttribute('aria-checked', String(settings.graphics.preset === preset));
  };
  let unsubscribe: (() => void) | null = null;

  return {
    id: 'settings',
    element: f.root,
    tabs: tabStrip,
    show() {
      refresh(store.get());
      unsubscribe ??= store.subscribe((settings) => refresh(settings));
    },
    initialFocus: () => f.header.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
    dispose() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
