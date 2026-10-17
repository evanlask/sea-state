// Small DOM helpers for the HUD: markup with named refs, and setters that remember the last
// value so the 20 Hz update only touches the DOM when something visibly changed.

export interface Built {
  root: HTMLElement;
  ref: <T extends Element = HTMLElement>(name: string) => T;
}

// Builds markup and returns a lookup for its [data-r] elements. Templates are static
// strings owned by the HUD, never user data, so innerHTML is safe here.
export function build(className: string, html: string, tag: keyof HTMLElementTagNameMap = 'div'): Built {
  const root = document.createElement(tag);
  root.className = className;
  root.innerHTML = html;
  const refs = new Map<string, Element>();
  for (const el of root.querySelectorAll('[data-r]')) refs.set(el.getAttribute('data-r') ?? '', el);
  return {
    root,
    ref: <T extends Element = HTMLElement>(name: string): T => {
      const el = refs.get(name);
      if (!el) throw new Error(`HUD markup is missing [data-r="${name}"] in .${className}`);
      return el as T;
    },
  };
}

export class TextSlot {
  private readonly el: Element;
  private last: string | null = null;

  constructor(el: Element) {
    this.el = el;
  }

  set(text: string): void {
    if (text === this.last) return;
    this.last = text;
    this.el.textContent = text;
  }
}

export class AttrSlot {
  private readonly el: Element;
  private readonly name: string;
  private last: string | null = null;

  constructor(el: Element, name: string) {
    this.el = el;
    this.name = name;
  }

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.el.setAttribute(this.name, value);
  }
}

// Inline style property (transform, width, …); compositor-only properties stay cheap.
export class StyleSlot {
  private readonly el: HTMLElement | SVGElement;
  private readonly prop: string;
  private last: string | null = null;

  constructor(el: HTMLElement | SVGElement, prop: string) {
    this.el = el;
    this.prop = prop;
  }

  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.el.style.setProperty(this.prop, value);
  }
}

export class ClassSlot {
  private readonly el: Element;
  private last: string | null = null;
  private readonly prefix: string;

  // Manages one class out of a family, e.g. 'is-' + 'calm' | 'lively' | 'violent'.
  constructor(el: Element, prefix = 'is-') {
    this.el = el;
    this.prefix = prefix;
  }

  set(name: string | null): void {
    if (name === this.last) return;
    if (this.last) this.el.classList.remove(this.prefix + this.last);
    if (name) this.el.classList.add(this.prefix + name);
    this.last = name;
  }
}

export function toggle(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

export function show(el: HTMLElement | SVGElement, visible: boolean): void {
  const hidden = !visible;
  if (el instanceof HTMLElement) {
    if (el.hidden !== hidden) el.hidden = hidden;
  } else if ((el.style.display === 'none') !== hidden) {
    el.style.display = hidden ? 'none' : '';
  }
}

// SVG arc path on a circle, angles in degrees clockwise from 12 o'clock.
export function arcPath(r: number, fromDeg: number, toDeg: number): string {
  const a0 = (Math.min(fromDeg, toDeg) * Math.PI) / 180;
  const a1 = (Math.max(fromDeg, toDeg) * Math.PI) / 180;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (a: number): string => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  return `M ${p(a0)} A ${r} ${r} 0 ${large} 1 ${p(a1)}`;
}

// Filled ring sector between two radii.
export function sectorPath(r0: number, r1: number, fromDeg: number, toDeg: number): string {
  const a0 = (Math.min(fromDeg, toDeg) * Math.PI) / 180;
  const a1 = (Math.max(fromDeg, toDeg) * Math.PI) / 180;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const p = (r: number, a: number): string =>
    `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
  return (
    `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} ` +
    `L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
  );
}

// Tick marks around a dial as one path.
export function ticksPath(r0: number, r1: number, degrees: readonly number[]): string {
  return degrees
    .map((d) => {
      const a = (d * Math.PI) / 180;
      const s = Math.sin(a);
      const c = Math.cos(a);
      return `M ${(r0 * s).toFixed(2)} ${(-r0 * c).toFixed(2)} L ${(r1 * s).toFixed(2)} ${(-r1 * c).toFixed(2)}`;
    })
    .join(' ');
}

export function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(v);
  return out;
}

// Degrees for SVG, rounded so attribute diffs aren't defeated by float noise.
export const deg = (rad: number): number => Math.round(((rad * 180) / Math.PI) * 10) / 10;
