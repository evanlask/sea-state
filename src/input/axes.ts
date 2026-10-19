// Axis integrators: how a held key becomes a helm value over time. Pure functions plus a small telegraph state machine, so the feel
// of each control is testable without a browser.

export type AxisBehaviour = 'spring' | 'lever' | 'notched' | 'rate';

export interface AxisSpec {
  behaviour: AxisBehaviour;
  // Spring: speed away from centre while a key is held. Lever: key speed.
  riseRate: number;
  // Spring only: speed back to centre once released (or when reversing).
  returnRate: number;
  min: number;
  max: number;
}

// Each step function takes one frame of key input for the axis: −1, 0 or 1.

export function axisSpec(behaviour: AxisBehaviour, overrides: Partial<AxisSpec> = {}): AxisSpec {
  return { behaviour, riseRate: 2, returnRate: 3, min: -1, max: 1, ...overrides };
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

function moveToward(value: number, target: number, maxDelta: number): number {
  if (Math.abs(target - value) <= maxDelta) return target;
  return value + Math.sign(target - value) * maxDelta;
}

// Returns to centre when released; keys ramp so a tap gives a gentle nudge.
export function stepSpring(value: number, input: number, dt: number, spec: AxisSpec): number {
  const target = clamp(input, spec.min, spec.max);
  const outward = target !== 0 && (value === 0 || Math.sign(target) === Math.sign(value));
  const rate = outward && Math.abs(target) > Math.abs(value) ? spec.riseRate : spec.returnRate;
  return moveToward(value, target, rate * dt);
}

// Stays where it is left: a held key moves it at a rate.
export function stepLever(value: number, input: number, dt: number, spec: AxisSpec): number {
  return clamp(value + input * spec.riseRate * dt, spec.min, spec.max);
}

// A rate command (sail sheets): the value is how fast to trim or ease, so it
// is simply whatever is held right now.
export function stepRate(input: number, spec: AxisSpec): number {
  return clamp(input, spec.min, spec.max);
}

export interface TelegraphNotch {
  name: string;
  short: string;
  value: number;
}

// Engine order telegraph, astern to ahead. Values are fractions of full power.
export const TELEGRAPH_NOTCHES: readonly TelegraphNotch[] = [
  { name: 'Full Astern', short: 'FULL AST', value: -1 },
  { name: 'Half Astern', short: 'HALF AST', value: -0.65 },
  { name: 'Slow Astern', short: 'SLOW AST', value: -0.4 },
  { name: 'Dead Slow Astern', short: 'D.SLOW AST', value: -0.2 },
  { name: 'Stop', short: 'STOP', value: 0 },
  { name: 'Dead Slow Ahead', short: 'D.SLOW AHD', value: 0.2 },
  { name: 'Slow Ahead', short: 'SLOW AHD', value: 0.4 },
  { name: 'Half Ahead', short: 'HALF AHD', value: 0.65 },
  { name: 'Full Ahead', short: 'FULL AHD', value: 1 },
];

export const TELEGRAPH_STOP = 4;

export function nearestNotch(value: number): number {
  let best = 0;
  for (let i = 1; i < TELEGRAPH_NOTCHES.length; i++) {
    if (Math.abs(TELEGRAPH_NOTCHES[i].value - value) < Math.abs(TELEGRAPH_NOTCHES[best].value - value))
      best = i;
  }
  return best;
}

// Keys step the handle one notch per press.
export class Telegraph {
  position = 0;
  notch = TELEGRAPH_STOP;

  get value(): number {
    return this.position;
  }

  get notchInfo(): TelegraphNotch {
    return TELEGRAPH_NOTCHES[this.notch];
  }

  set(index: number): void {
    this.notch = clamp(Math.round(index), 0, TELEGRAPH_NOTCHES.length - 1);
    this.position = TELEGRAPH_NOTCHES[this.notch].value;
  }

  step(delta: number): void {
    this.set(this.notch + delta);
  }
}
