// Tiny DOM helpers for the menus: an element factory plus a few reusable controls (segmented
// choice, slider, toggle). No framework; every control exposes set() so screens can refresh
// values from the store without rebuilding the DOM (which would lose gamepad focus).

type Child = Node | string | null | undefined | false;

export interface ElementProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, handler as EventListener);
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function button(
  label: string | readonly Child[],
  onClick: () => void,
  className = 'menu-btn',
  attrs: ElementProps['attrs'] = {},
): HTMLButtonElement {
  const children = typeof label === 'string' ? [label] : label;
  return h(
    'button',
    { class: className, attrs: { type: 'button', ...attrs }, on: { click: onClick } },
    children,
  );
}

let uid = 0;
const nextId = (prefix: string): string => `${prefix}-${++uid}`;

// ---------------------------------------------------------------------------------------------
// Controls

export interface Control<T> {
  readonly element: HTMLElement;
  set(value: T): void;
}

export interface ChoiceOption<T> {
  value: T;
  label: string;
  title?: string;
}

// A row of radio-like buttons. Better than <select> for gamepads: every option is focusable.
export function choice<T>(
  options: readonly ChoiceOption<T>[],
  value: T,
  onChange: (value: T) => void,
  label?: string,
): Control<T> {
  const group = h('div', { class: 'menu-choice', attrs: { role: 'radiogroup', 'aria-label': label } });
  const buttons = options.map((option) => {
    const el = button(option.label, () => onChange(option.value), 'menu-choice-btn', {
      role: 'radio',
      title: option.title,
    });
    group.append(el);
    return el;
  });
  const set = (current: T): void => {
    options.forEach((option, i) =>
      buttons[i]!.setAttribute('aria-checked', String(option.value === current)),
    );
  };
  set(value);
  return { element: group, set };
}

export interface SliderOptions {
  min: number;
  max: number;
  step: number;
  label: string;
  format: (value: number) => string;
  // 'input' fires while dragging; 'change' only on release (for expensive consumers).
  live?: boolean;
}

export interface SliderControl extends Control<number> {
  readonly input: HTMLInputElement;
}

export function slider(
  value: number,
  options: SliderOptions,
  onChange: (value: number) => void,
): SliderControl {
  const id = nextId('slider');
  const readout = h('output', { class: 'menu-slider-value', attrs: { for: id } });
  const input = h('input', {
    class: 'menu-slider',
    attrs: {
      id,
      type: 'range',
      min: options.min,
      max: options.max,
      step: options.step,
      'aria-label': options.label,
    },
  });
  const sync = (v: number): void => {
    readout.textContent = options.format(v);
    input.setAttribute('aria-valuetext', options.format(v));
    const t = options.max > options.min ? (v - options.min) / (options.max - options.min) : 0;
    input.style.setProperty('--fill', `${Math.min(1, Math.max(0, t)) * 100}%`);
  };
  input.addEventListener('input', () => {
    sync(Number(input.value));
    if (options.live !== false) onChange(Number(input.value));
  });
  input.addEventListener('change', () => {
    if (options.live === false) onChange(Number(input.value));
  });
  const set = (v: number): void => {
    // Don't fight the user's drag with a stale echo.
    if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
    sync(v);
  };
  set(value);
  return { element: h('div', { class: 'menu-slider-wrap' }, [input, readout]), input, set };
}

export function toggle(value: boolean, label: string, onChange: (value: boolean) => void): Control<boolean> {
  const el = button(
    [h('span', { class: 'menu-toggle-knob' })],
    () => onChange(el.getAttribute('aria-checked') !== 'true'),
    'menu-toggle',
    {
      role: 'switch',
      'aria-label': label,
    },
  );
  const text = h('span', { class: 'menu-toggle-text' });
  el.append(text);
  const set = (v: boolean): void => {
    el.setAttribute('aria-checked', String(v));
    text.textContent = v ? 'On' : 'Off';
  };
  set(value);
  return { element: el, set };
}

// A labelled row: label + description on the left, the control on the right.
export function field(
  label: string,
  control: HTMLElement,
  description?: string,
  hint?: string,
  badge?: HTMLElement | null,
): HTMLElement {
  return h('div', { class: 'menu-field' }, [
    h('div', { class: 'menu-field-text' }, [
      h('div', { class: 'menu-field-label' }, [label, badge ?? null]),
      description ? h('div', { class: 'menu-field-desc', text: description }) : null,
      hint ? h('div', { class: 'menu-field-hint', text: hint }) : null,
    ]),
    h('div', { class: 'menu-field-control' }, [control]),
  ]);
}

export function section(title: string, children: readonly Child[], className = ''): HTMLElement {
  return h('section', { class: `menu-section ${className}`.trim() }, [
    h('h3', { class: 'menu-section-title', text: title }),
    ...children,
  ]);
}

// ---------------------------------------------------------------------------------------------
// Tabs (LB / RB and Page Up / Down switch them via the controller)

export interface Tabs {
  readonly element: HTMLElement; // the tab strip
  readonly panels: HTMLElement; // container holding the panels
  readonly index: number;
  select(index: number, focusTab?: boolean): void;
  step(delta: number): void;
}

export function tabs(
  items: readonly { label: string; panel: HTMLElement }[],
  onSelect?: (index: number) => void,
): Tabs {
  const strip = h('div', { class: 'menu-tabs', attrs: { role: 'tablist' } });
  const panels = h('div', { class: 'menu-tab-panels' });
  let current = 0;
  const buttons = items.map((item, i) => {
    const id = nextId('tab');
    const el = button(item.label, () => api.select(i), 'menu-tab', { role: 'tab', id });
    item.panel.setAttribute('role', 'tabpanel');
    item.panel.setAttribute('aria-labelledby', id);
    item.panel.classList.add('menu-tab-panel');
    strip.append(el);
    panels.append(item.panel);
    return el;
  });
  strip.append(h('span', { class: 'menu-tabs-hint', attrs: { 'aria-hidden': 'true' } }));
  const api: Tabs = {
    element: strip,
    panels,
    get index() {
      return current;
    },
    select(index: number, focusTab = false) {
      current = (index + items.length) % items.length;
      buttons.forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === current));
        items[i]!.panel.hidden = i !== current;
      });
      panels.scrollTop = 0;
      if (focusTab) buttons[current]!.focus();
      onSelect?.(current);
    },
    step(delta: number) {
      api.select(current + delta, true);
    },
  };
  api.select(0);
  return api;
}
