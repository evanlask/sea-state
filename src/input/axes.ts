// Axis integrators: how a digital key or an analog stick becomes a helm value
// over time. Pure functions plus a small telegraph state machine, so the feel
// of each control is testable without a browser.

export type AxisBehaviour = 'spring' | 'lever' | 'notched' | 'rate';

export interface AxisSpec {
  behaviour: AxisBehaviour;
  // Spring: speed away from centre while a key is held. Lever: key speed.
  // Notched: speed of the continuous (trigger) lever at full deflection.
  riseRate: number;
  // Spring only: speed back to centre once released (or when reversing).
  returnRate: number;
  // Lever only: speed at full analog deflection. Sticks drive levers as a
  // rate, otherwise the helm order would follow the stick back to centre.
  analogRate: number;
  min: number;
  max: number;
}

// One frame of raw input for an axis: keys give −1, 0 or 1; analog is the
// combined, dead-zoned gamepad value (0 when the pad is idle).
export interface AxisInput {
  digital: number;
  analog: number;
}

export function axisSpec(behaviour: AxisBehaviour, overrides: Partial<AxisSpec> = {}): AxisSpec {
  return { behaviour, riseRate: 2, returnRate: 3, analogRate: 1, min: -1, max: 1, ...overrides };
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

function moveToward(value: number, target: number, maxDelta: number): number {
  if (Math.abs(target - value) <= maxDelta) return target;
  return value + Math.sign(target - value) * maxDelta;
}

// Returns to centre when released; keys ramp so a tap gives a gentle nudge.
// An analog stick already springs back by itself, so it passes straight through.
export function stepSpring(value: number, input: AxisInput, dt: number, spec: AxisSpec): number {
  if (input.analog !== 0) return clamp(input.analog, spec.min, spec.max);
  const target = clamp(input.digital, spec.min, spec.max);
  const outward = target !== 0 && (value === 0 || Math.sign(target) === Math.sign(value));
  const rate = outward && Math.abs(target) > Math.abs(value) ? spec.riseRate : spec.returnRate;
  return moveToward(value, target, rate * dt);
}

// Stays where it is left: keys and analog both move it at a rate.
export function stepLever(value: number, input: AxisInput, dt: number, spec: AxisSpec): number {
  const velocity = input.digital * spec.riseRate + input.analog * spec.analogRate;
  return clamp(value + velocity * dt, spec.min, spec.max);
}

// A rate command (sail sheets): the value is how fast to trim or ease, so it
// is simply whatever is held right now.
export function stepRate(input: AxisInput, spec: AxisSpec): number {
  return clamp(input.analog !== 0 ? input.analog : input.digital, spec.min, spec.max);
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

// Keys step one notch per press; triggers sweep the lever continuously and it
// drops into the nearest notch when they are released, like a real handle.
export class Telegraph {
  position = 0;
  notch = TELEGRAPH_STOP;
  private sweeping = false;

  get value(): number {
    return this.position;
  }

  get notchInfo(): TelegraphNotch {
    return TELEGRAPH_NOTCHES[this.notch];
  }

  set(index: number): void {
    this.notch = clamp(Math.round(index), 0, TELEGRAPH_NOTCHES.length - 1);
    this.position = TELEGRAPH_NOTCHES[this.notch].value;
    this.sweeping = false;
  }

  step(delta: number): void {
    this.set(this.notch + delta);
  }

  update(analog: number, dt: number, rate: number): void {
    if (analog !== 0) {
      this.position = clamp(this.position + analog * rate * dt, -1, 1);
      this.notch = nearestNotch(this.position);
      this.sweeping = true;
    } else if (this.sweeping) {
      this.set(this.notch);
    }
  }
}
