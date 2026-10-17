// Propeller and engine models shared by the shaft lines, azipods and outboards.
//
// Propeller: a linearised open-water curve KT(J) = KT0·(1 − J/J0),
// KQ(J) = KQ0·(1 − J/J0q), sized by the calibration so full power gives the
// documented top speed, extended to all four quadrants with the usual
// β = atan2(Va, 0.7π·n·D) form:
//   T = C_T*(β)·½ρ·(Va² + (0.7πnD)²)·πD²/4,   Q = C_Q*(β)·½ρ·(…)·πD³/4
// Q1 (ahead, moving ahead) comes from the open-water line; the other quadrants
// are blended from it with a locked-propeller drag at β = ±90° and an astern
// efficiency (astern thrust ≈ 65% of ahead at the same torque).
//
// Engine: an order (−1..1) is turned into an RPM set-point through a load
// programme (ramp), a governor delivers torque up to the torque and power
// limits, and reversing needs the shaft (nearly) stopped first: a direct-drive
// 2-stroke stops on braking air and re-starts the other way, a gearbox
// declutches, an electric motor simply reverses.

import { RHO_SEAWATER } from '../../core/units';

const STEP = (5 * Math.PI) / 180;
const N_TABLE = 73; // −180°..180° in 5°

export interface PropellerCurve {
  diameter: number; // m
  kt0: number; // bollard KT
  j0: number; // J of zero thrust
  kq0: number;
  j0q: number; // J of zero torque
  asternThrust?: number; // C_T* astern / ahead at equal torque, default 0.65
}

const smooth = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class FourQuadrantPropeller {
  readonly curve: PropellerCurve;
  readonly diameter: number;
  private readonly ct = new Float64Array(N_TABLE);
  private readonly cq = new Float64Array(N_TABLE);
  // Last evaluation.
  thrust = 0; // N, + ahead
  torque = 0; // N·m absorbed (opposes positive rotation when > 0)
  advance = 0; // J (signed)

  constructor(curve: PropellerCurve) {
    this.curve = curve;
    this.diameter = curve.diameter;
    const a = curve.asternThrust ?? 0.65;
    const k = 0.7 * Math.PI;
    const ctQ1 = (beta: number): number => q1(beta, curve.kt0, curve.j0, -0.35);
    const cqQ1 = (beta: number): number => q1(beta, curve.kq0, curve.j0q, -0.055);
    const ctQ2 = (beta: number): number => q2(beta, curve.kt0, curve.j0, 0.35);
    const cqQ2 = (beta: number): number => q2(beta, curve.kq0, curve.j0q, 0.055);
    function q1(beta: number, c0: number, j0: number, at90: number): number {
      // Open-water line up to just past zero thrust, then toward the locked-prop value.
      const b1 = Math.atan((1.1 * j0) / k);
      const line = (b: number): number => {
        const J = k * Math.tan(b);
        return (c0 * (1 - J / j0) * 8) / (Math.PI * (J * J + k * k));
      };
      if (beta <= b1) return line(beta);
      return line(b1) + (at90 - line(b1)) * smooth((beta - b1) / (Math.PI / 2 - b1));
    }
    function q2(beta: number, c0: number, j0: number, atM90: number): number {
      // Moving astern with the propeller turning ahead: the line to J = −1, then locked-prop drag.
      const b1 = -Math.atan(1 / k);
      const line = (b: number): number => {
        const J = k * Math.tan(b);
        return (c0 * (1 - J / j0) * 8) / (Math.PI * (J * J + k * k));
      };
      if (beta >= b1) return line(beta);
      return line(b1) + (atM90 - line(b1)) * smooth((b1 - beta) / (b1 + Math.PI / 2));
    }
    for (let i = 0; i < N_TABLE; i++) {
      const beta = -Math.PI + i * STEP;
      let t: number;
      let q: number;
      if (beta >= 0 && beta <= Math.PI / 2) {
        t = ctQ1(beta);
        q = cqQ1(beta);
      } else if (beta < 0 && beta >= -Math.PI / 2) {
        t = ctQ2(beta);
        q = cqQ2(beta);
      } else if (beta < -Math.PI / 2) {
        // Turning astern, moving astern: Q1 mirrored, astern efficiency fading to 1 at ±90°.
        const m = beta + Math.PI;
        const w = smooth(m / (Math.PI / 2));
        t = -(a + (1 - a) * w) * ctQ1(m);
        q = -cqQ1(m);
      } else {
        // Turning astern, moving ahead (crash stop): Q2 mirrored.
        const m = beta - Math.PI;
        const w = smooth(-m / (Math.PI / 2));
        t = -(a + (1 - a) * w) * ctQ2(m);
        q = -cqQ2(m);
      }
      this.ct[i] = t;
      this.cq[i] = q;
    }
  }

  // n in rev/s (signed), va the advance speed along the shaft (+ ahead).
  evaluate(n: number, va: number, rho = RHO_SEAWATER): void {
    const D = this.diameter;
    const tip = 0.7 * Math.PI * n * D;
    const vr2 = va * va + tip * tip;
    this.advance = Math.abs(n) > 1e-6 ? va / (n * D) : 0;
    if (vr2 < 1e-10) {
      this.thrust = 0;
      this.torque = 0;
      return;
    }
    const beta = Math.atan2(va, tip);
    let f = (beta + Math.PI) / STEP;
    if (f < 0) f = 0;
    if (f > N_TABLE - 1) f = N_TABLE - 1;
    const i = Math.min(N_TABLE - 2, Math.floor(f));
    const u = f - i;
    const ct = this.ct[i]! + (this.ct[i + 1]! - this.ct[i]!) * u;
    const cq = this.cq[i]! + (this.cq[i + 1]! - this.cq[i]!) * u;
    const base = 0.5 * rho * vr2 * Math.PI * D * D * 0.25;
    this.thrust = ct * base;
    this.torque = cq * base * D;
  }
}

type ReversalKind = 'direct' | 'gearbox' | 'electric';

export interface EngineSpec {
  power: number; // W delivered to the shaft at rated rpm
  ratedRpm: number; // shaft rpm at full power
  idleRpm: number; // slowest running shaft rpm when engaged
  asternRpm: number; // fraction of rated rpm at full astern
  torqueFactor: number; // peak torque / rated torque (1 = 2-stroke, >1 high-revving)
  inertia: number; // shaft line incl. engine and entrained water, kg·m²
  rampTime: number; // realistic load programme Stop → Full, s
  reversal: ReversalKind;
  reversalDelay: number; // realistic restart time the other way, s
  brakeTorque: number; // braking air / clutch drag as a fraction of rated torque
}

// Shaft line: engine + propeller with RPM inertia.
export class Engine {
  readonly spec: EngineSpec;
  n = 0; // shaft speed, rev/s (signed)
  program = 0; // ramped order −1..1
  running = 0; // direction the engine is currently engaged/firing in: −1, 0, 1
  torque = 0; // engine torque delivered, N·m (signed)
  load = 0; // |power| / rated, 0..1
  private reversalTimer = 0;
  readonly ratedTorque: number;
  readonly ratedN: number;

  constructor(spec: EngineSpec) {
    this.spec = spec;
    this.ratedN = spec.ratedRpm / 60;
    this.ratedTorque = spec.power / (2 * Math.PI * this.ratedN);
  }

  prime(order: number): void {
    this.program = order;
    this.running = Math.sign(order);
    this.n = (order >= 0 ? order : order * this.spec.asternRpm) * this.ratedN;
  }

  reset(): void {
    this.n = 0;
    this.program = 0;
    this.running = 0;
    this.torque = 0;
    this.load = 0;
    this.reversalTimer = 0;
  }

  // Advances the shaft by dt with the propeller's absorbed torque from the
  // last evaluation. rampTime/reversalDelay override the spec (Arcade).
  step(
    order: number,
    propTorque: number,
    dt: number,
    rampTime: number,
    reversalDelay: number,
    speedCap = 1,
  ): void {
    const s = this.spec;
    const rampRate = rampTime > 0 ? 1 / rampTime : Infinity;
    const d = order - this.program;
    this.program += Math.abs(d) <= rampRate * dt ? d : Math.sign(d) * rampRate * dt;
    const p = this.program;
    const want = Math.abs(p) < 0.02 ? 0 : Math.sign(p);
    const nRated = this.ratedN;
    const target = (want >= 0 ? p : p * s.asternRpm) * nRated * speedCap;

    let q = 0;
    if (want !== 0 && (this.running === want || s.reversal === 'electric')) {
      this.running = want;
      // Governor: feed-forward of the propeller law plus proportional error.
      const ff = this.ratedTorque * (target / nRated) * Math.abs(target / nRated);
      const err = (target - this.n) / nRated;
      const cmd = ff + 6 * this.ratedTorque * err;
      const absN = Math.abs(this.n);
      const powerLimit = absN > 1e-3 ? s.power / (2 * Math.PI * absN) : Infinity;
      const limit = Math.min(this.ratedTorque * s.torqueFactor, powerLimit);
      // A fired engine cannot push against its own rotation (except electric).
      if (s.reversal === 'electric') q = Math.max(-limit, Math.min(limit, cmd));
      else q = want > 0 ? Math.max(0, Math.min(limit, cmd)) : Math.min(0, Math.max(-limit, cmd));
      this.reversalTimer = 0;
    } else if (want !== 0) {
      // Must stop before going the other way.
      if (Math.abs(this.n) > 0.08 * nRated) {
        q = -Math.sign(this.n) * s.brakeTorque * this.ratedTorque;
        this.reversalTimer = 0;
      } else {
        this.reversalTimer += dt;
        q =
          -Math.sign(this.n) *
          s.brakeTorque *
          this.ratedTorque *
          Math.min(1, Math.abs(this.n) / (0.02 * nRated));
        if (this.reversalTimer >= reversalDelay) this.running = want;
      }
    } else {
      // Stop: fuel off; an engaged gearbox idles the shaft down.
      if (s.reversal !== 'direct') this.running = 0;
      q = 0;
    }
    // Shaft friction (2% of rated torque), smoothed through zero.
    const friction = 0.02 * this.ratedTorque * Math.max(-1, Math.min(1, this.n / (0.05 * nRated)));
    const accel = (q - propTorque - friction) / (2 * Math.PI * s.inertia);
    const before = this.n;
    this.n += accel * dt;
    // No overshoot through zero from friction/brake alone.
    if (
      q * before <= 0 &&
      before !== 0 &&
      this.n * before < 0 &&
      Math.sign(propTorque) === Math.sign(before)
    ) {
      this.n = 0;
    }
    this.torque = q;
    this.load = Math.min(1, Math.abs(q * 2 * Math.PI * this.n) / s.power);
  }
}

// Sizes a linearised open-water curve so that at speed of advance va and
// shaft speed n the propeller gives `thrust` while absorbing `power`.
export function sizePropeller(
  diameter: number,
  n: number,
  va: number,
  thrust: number,
  power: number,
  rho = RHO_SEAWATER,
): PropellerCurve & { jDesign: number; efficiency: number } {
  const D = diameter;
  const J = va / (n * D);
  const ktD = thrust / (rho * n * n * D ** 4);
  const kqD = power / (2 * Math.PI * rho * n ** 3 * D ** 5);
  const j0 = J / 0.6;
  const j0q = 1.15 * j0;
  return {
    diameter: D,
    kt0: (ktD * j0) / (j0 - J),
    j0,
    kq0: (kqD * j0q) / (j0q - J),
    j0q,
    jDesign: J,
    efficiency: (J * ktD) / (2 * Math.PI * kqD),
  };
}
