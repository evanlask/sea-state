// The Unlimited hydroplane: three-point riding, its flying hull and blow-over, its
// turbine, steering, and how little sea it takes. Its own tests because it is unlike the others: it
// is fast (top speed in a minute and a half of sim time), it has to start under way in its running
// attitude (dropped level into the water at 200 mph it is launched and blows over), and the sea
// matters more than the helm.

import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { qRotate, vec3 } from '../core/math';
import { MPH } from '../core/units';
import type { BoatDynamics } from '../physics/BoatDynamics';
import { interpolate } from '../physics/resistance';
import { IrregularSea } from '../physics/seas';
import { physicsTuning } from '../physics/tuning';
import { AiryWave, flatWater, waterSample, type WaterSample, type WaterSampler } from '../physics/water';
import { UniformWind } from '../physics/windage';
import { neutralControls, type PhysicsMode, type SimEvent } from '../world/protocol';
import { WorldBoat } from '../world/WorldBoat';
import { CALIBRATION } from './calibration/index';
import { createBoatDynamics } from './drivetrains';
import { BOAT_SPECS } from './specs/index';

const DT = 1 / 120;
const spec = BOAT_SPECS.hydro;
const TOP = spec.propulsion.topSpeed;
const CRUISE = spec.propulsion.serviceSpeed!; // 160 mph
const att = { heading: 0, pitch: 0, roll: 0 };
const up = vec3();
const UP = vec3(0, 1, 0);

const boat = (mode: PhysicsMode): BoatDynamics => createBoatDynamics('hydro', physicsTuning('hydro', mode));

// Running at `speed` in its running attitude (the calibration's), turbine spooled to `order`.
function underWay(mode: PhysicsMode, speed: number, order = 1): BoatDynamics {
  const d = boat(mode);
  const cal = CALIBRATION.hydro;
  d.placeUnderWay(
    0,
    0,
    0,
    speed,
    interpolate(cal.speeds, cal.sinkage, speed),
    interpolate(cal.speeds, cal.trim, speed),
  );
  d.prime(order);
  return d;
}

// Tilt of the deck from level (0 upright, π upside down).
const tilt = (d: BoatDynamics): number => {
  qRotate(up, d.body.orientation, UP);
  return Math.acos(Math.max(-1, Math.min(1, up.y)));
};
const speedOf = (d: BoatDynamics): number => Math.hypot(d.body.velocity.x, d.body.velocity.z);

// Throttle that holds `target` (m/s), full below it.
const holding = (d: BoatDynamics, target: number): number =>
  Math.max(0, Math.min(1, 0.6 + (target - speedOf(d)) * 0.3));

interface Run {
  plane: number; // s from rest until on the plane (wetted area below a fifth of its resting wetted area)
  hundred: number; // s from rest to 100 mph
  final: number; // m/s after the run
  pitch: [number, number]; // over the last 20 s, rad
  maxTilt: number;
  wetted: number; // m², at the end
  aeroShare: number; // of the weight, at the end
  propImmersion: number;
}

// Full throttle from rest on flat water for `seconds`.
function fromRest(mode: PhysicsMode, seconds: number): Run {
  const d = boat(mode);
  const c = { ...neutralControls(), throttle: 1 };
  const tel: Record<string, number> = {};
  const rest = d.model.design.wettedArea;
  let plane = Infinity;
  let hundred = Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  let maxTilt = 0;
  for (let i = 0; i < seconds / DT; i++) {
    const t = (i + 1) * DT;
    d.step(DT, flatWater, null, i * DT, c);
    d.writeTelemetry(tel);
    if (plane === Infinity && tel['wettedArea']! < 0.2 * rest) plane = t;
    if (hundred === Infinity && speedOf(d) >= 100 * MPH) hundred = t;
    maxTilt = Math.max(maxTilt, tilt(d));
    if (t > seconds - 20) {
      lo = Math.min(lo, tel['trim']!);
      hi = Math.max(hi, tel['trim']!);
    }
  }
  return {
    plane,
    hundred,
    final: speedOf(d),
    pitch: [lo, hi],
    maxTilt,
    wetted: tel['wettedArea']!,
    aeroShare: tel['aeroLiftShare']!,
    propImmersion: 1 - tel['propEmersion']!,
  };
}

const runs = new Map<PhysicsMode, Run>();
const run = (mode: PhysicsMode): Run => {
  let r = runs.get(mode);
  if (!r) runs.set(mode, (r = fromRest(mode, 90)));
  return r;
};

describe('hydroplane: flat out on flat water', () => {
  for (const mode of ['realistic', 'arcade'] as const) {
    it(`${mode}: from rest it settles within ±5% of 200 mph, without blowing over`, () => {
      const r = run(mode);
      expect(Math.abs(r.final / TOP - 1)).toBeLessThan(0.05);
      expect(r.maxTilt).toBeLessThan(5 * DEG);
    }, 30_000);

    it(`${mode}: on the plane in 4–9 s, 0–100 mph in 7–13 s (the turbine spooling up included)`, () => {
      const r = run(mode);
      expect(r.plane).toBeGreaterThan(4);
      expect(r.plane).toBeLessThan(9);
      expect(r.hundred).toBeGreaterThan(7);
      expect(r.hundred).toBeLessThan(13);
    }, 30_000);

    it(`${mode}: at speed it rides on three points, its hull flying`, () => {
      const r = run(mode);
      // Steady at its running trim, a degree or two bow up.
      expect(r.pitch[0]).toBeGreaterThan(1 * DEG);
      expect(r.pitch[1]).toBeLessThan(3 * DEG);
      expect(r.pitch[1] - r.pitch[0]).toBeLessThan(0.3 * DEG);
      // Only the sponson pads, fins and the partly immersed propeller in the water: under 1 m² of
      // ~26 m² wetted at rest, with the air carrying about half the weight.
      expect(r.wetted).toBeLessThan(1);
      expect(r.aeroShare).toBeGreaterThan(0.35);
      expect(r.aeroShare).toBeLessThan(0.7);
      expect(r.propImmersion).toBeGreaterThan(0.3);
      expect(r.propImmersion).toBeLessThan(0.8);
    }, 30_000);
  }

  it('at rest on its idle the propeller is in the water (nine tenths of the disc), not sticking out', () => {
    const d = boat('realistic');
    const tel: Record<string, number> = {};
    for (let i = 0; i < 10 / DT; i++) d.step(DT, flatWater, null, i * DT, neutralControls());
    d.writeTelemetry(tel);
    expect(tel['propEmersion']).toBeLessThan(0.15);
    expect(speedOf(d)).toBeLessThan(4); // the idle only creeps it along
  });

  it('the turbine spools: a second after the throttle opens it gives under half power, full by 4 s', () => {
    const d = boat('realistic');
    const c = { ...neutralControls(), throttle: 1 };
    const tel: Record<string, number> = {};
    const gas = (seconds: number): number => {
      for (let i = 0; i < seconds / DT; i++) d.step(DT, flatWater, null, 0, c);
      d.writeTelemetry(tel);
      return tel['gasGenerator']!;
    };
    expect(gas(1)).toBeLessThan(0.5);
    expect(gas(3)).toBeGreaterThan(0.99);
  });

  it('off the throttle at 160 mph it settles onto its hull and its drag stops it: under 60 mph within 20 s', () => {
    const d = underWay('realistic', CRUISE);
    const c = neutralControls();
    for (let i = 0; i < 6 / DT; i++) d.step(DT, flatWater, null, i * DT, c);
    // ~0.4 g at first: no brakes, but no thrust and all that drag.
    expect(speedOf(d)).toBeLessThan(CRUISE - 12);
    for (let i = 0; i < 14 / DT; i++) d.step(DT, flatWater, null, 6 + i * DT, c);
    expect(speedOf(d)).toBeLessThan(60 * MPH);
    expect(tilt(d)).toBeLessThan(5 * DEG);
  });
});

// A bow-up kick (rad/s) at top speed, then `seconds` with the throttle held: the worst tilt.
function kicked(mode: PhysicsMode, kick: number, seconds = 6): number {
  const d = underWay(mode, TOP);
  const c = { ...neutralControls(), throttle: 1 };
  for (let i = 0; i < 2 / DT; i++) d.step(DT, flatWater, null, i * DT, c);
  const axis = vec3();
  qRotate(axis, d.body.orientation, vec3(1, 0, 0));
  d.body.angularVelocity.x += axis.x * kick;
  d.body.angularVelocity.y += axis.y * kick;
  d.body.angularVelocity.z += axis.z * kick;
  let worst = 0;
  for (let i = 0; i < seconds / DT; i++) {
    d.step(DT, flatWater, null, 2 + i * DT, c);
    worst = Math.max(worst, tilt(d));
  }
  return worst;
}

describe('hydroplane: blow-over', () => {
  for (const mode of ['realistic', 'arcade'] as const) {
    it(`${mode}: at 200 mph a bow-up kick of a bounce dies out; a hard one lifts the bow past its limit and it flips over backwards`, () => {
      expect(kicked(mode, 0.1)).toBeLessThan(5 * DEG);
      expect(kicked(mode, 0.8)).toBeLessThan(5 * DEG);
      expect(kicked(mode, 2.2)).toBeGreaterThan(150 * DEG);
    });
  }

  it('the same kick at 100 mph does not: the air has a third of the grip', () => {
    const d = underWay('realistic', 100 * MPH, 0.5);
    const c = { ...neutralControls(), throttle: 0.5 };
    for (let i = 0; i < 2 / DT; i++) d.step(DT, flatWater, null, i * DT, c);
    d.body.angularVelocity.x += 1.6;
    let worst = 0;
    for (let i = 0; i < 6 / DT; i++) {
      d.step(DT, flatWater, null, 2 + i * DT, c);
      worst = Math.max(worst, tilt(d));
    }
    expect(worst).toBeLessThan(10 * DEG);
  });
});

describe('hydroplane: turning', () => {
  for (const mode of ['realistic', 'arcade'] as const) {
    for (const steer of [-1, 1]) {
      it(`${mode}: hard ${steer < 0 ? 'left' : 'right'} at 160 mph it skids round at 6–30°/s without rolling over, and straightens when let go`, () => {
        const d = underWay(mode, CRUISE, 0.8);
        const c = { ...neutralControls(), throttle: 0.8 };
        const tel: Record<string, number> = {};
        for (let i = 0; i < 2 / DT; i++) d.step(DT, flatWater, null, i * DT, c);
        c.steer = steer;
        let yaw = 0;
        let n = 0;
        let worstRoll = 0;
        for (let i = 0; i < 8 / DT; i++) {
          d.step(DT, flatWater, null, 2 + i * DT, c);
          d.writeTelemetry(tel);
          worstRoll = Math.max(worstRoll, Math.abs(tel['heel']!));
          if (i * DT > 2) {
            yaw += tel['yawRate']!;
            n++;
          }
        }
        const rate = (yaw / n) * Math.sign(steer);
        expect(rate).toBeGreaterThan(6 * DEG);
        expect(rate).toBeLessThan(30 * DEG);
        expect(worstRoll).toBeLessThan(20 * DEG);
        c.steer = 0;
        for (let i = 0; i < 4 / DT; i++) d.step(DT, flatWater, null, 10 + i * DT, c);
        d.writeTelemetry(tel);
        expect(Math.abs(tel['yawRate']!)).toBeLessThan(3 * DEG);
        expect(tilt(d)).toBeLessThan(5 * DEG);
      });
    }
  }

  // Under way at `mph` on the throttle that holds it, then `steer` held for 8 s: the mean sideways
  // g over the last 6 s and the worst tilt.
  function turn(mph: number, throttle: number, steer: number): { g: number; tilt: number } {
    const d = underWay('realistic', mph * MPH, throttle);
    const c = { ...neutralControls(), throttle };
    const tel: Record<string, number> = {};
    for (let i = 0; i < 2 / DT; i++) d.step(DT, flatWater, null, i * DT, c);
    c.steer = steer;
    let g = 0;
    let n = 0;
    let worst = 0;
    for (let i = 0; i < 8 / DT; i++) {
      d.step(DT, flatWater, null, 2 + i * DT, c);
      worst = Math.max(worst, tilt(d));
      if (i * DT > 2) {
        d.writeTelemetry(tel);
        g += Math.abs(tel['yawRate']! * speedOf(d)) / 9.81;
        n++;
      }
    }
    return { g: g / n, tilt: worst };
  }

  it('turns best to the left, on the skid fin and the chine of its right sponson (over 2 g at 160 mph); to the right it skids wide', () => {
    const left = turn(160, 0.8, -1);
    const right = turn(160, 0.8, 1);
    expect(left.g).toBeGreaterThan(2);
    expect(left.tilt).toBeLessThan(10 * DEG);
    expect(right.tilt).toBeLessThan(10 * DEG);
    expect(right.g).toBeLessThan(0.7 * left.g);
    expect(turn(140, 0.6, -1).g).toBeGreaterThan(1.15 * turn(140, 0.6, 1).g);
  });

  it('at 180–200 mph half helm either way is safe; full lock to the left trips it over', () => {
    expect(turn(180, 0.85, -1).tilt).toBeGreaterThan(150 * DEG);
    expect(turn(200, 1, -0.5).tilt).toBeLessThan(10 * DEG);
    expect(turn(200, 1, 0.5).tilt).toBeLessThan(10 * DEG);
    expect(turn(200, 1, -1).tilt).toBeGreaterThan(150 * DEG);
  });
});

// Flat water, then from `z0` on (the boat runs toward −z) a regular wave train fading in over 60 m.
class WavesAhead implements WaterSampler {
  private readonly wave: AiryWave;
  private readonly w = waterSample();
  private readonly z0: number;

  constructor(amplitude: number, wavelength: number, z0: number) {
    this.z0 = z0;
    // Travelling toward +z: head seas.
    this.wave = new AiryWave({ amplitude, wavelength, directionX: 0, directionZ: 1 });
  }

  sample(x: number, y: number, z: number, t: number, out: WaterSample): WaterSample {
    flatWater.sample(x, y, z, t, out);
    const f = Math.min(1, Math.max(0, (this.z0 - z) / 60));
    if (f <= 0) return out;
    const w = this.wave.sample(x, y, z, t, this.w);
    out.height += f * (w.height - out.height);
    out.pressureHead += f * (w.pressureHead - out.pressureHead);
    out.velocityX = f * w.velocityX;
    out.velocityY = f * w.velocityY;
    out.velocityZ = f * w.velocityZ;
    return out;
  }
}

// Into a head sea of 2 m waves (Breezy's height) at `speed`, holding it: the worst tilt in 15 s.
function intoWaves(mode: PhysicsMode, speed: number): number {
  const d = underWay(mode, speed, 0.6);
  const water = new WavesAhead(1, 40, -50);
  const c = { ...neutralControls(), throttle: 0.6 };
  let worst = 0;
  for (let i = 0; i < 15 / DT; i++) {
    c.throttle = holding(d, speed);
    d.step(DT, water, null, i * DT, c);
    worst = Math.max(worst, tilt(d));
  }
  return worst;
}

describe('hydroplane: the sea', () => {
  for (const mode of ['realistic', 'arcade'] as const) {
    it(`${mode}: into 2 m head seas at 160 mph it is launched and thrown over; at 30 mph it rides them`, () => {
      expect(intoWaves(mode, 72)).toBeGreaterThan(90 * DEG); // past its vanishing stability (88°)
      expect(intoWaves(mode, 13.4)).toBeLessThan(20 * DEG);
    });
  }

  it('in a Fair chop (Hs 0.4 m, Tp 3 s), trying for 160 mph, it bounces but stays upright', () => {
    for (const seed of [1, 2]) {
      const sea = new IrregularSea({ hs: 0.38, tp: 3.1, towards: 0, seed, components: 32 });
      const b = new WorldBoat('h', 'hydro', sea, 'realistic');
      b.place(0, 0, 0, 0);
      const wind = new UniformWind(4, Math.PI);
      const events: SimEvent[] = [];
      for (let i = 0; i < 60 / DT; i++) {
        b.controls = { ...neutralControls(), throttle: holding(b.dyn, CRUISE) };
        b.step(DT, i * DT, wind, events);
      }
      expect(events.some((e) => e.type === 'capsized')).toBe(false);
      expect(tilt(b.dyn)).toBeLessThan(45 * DEG);
      // The chop costs it a lot of speed: the propeller is out of the water a good part of the time.
      expect(speedOf(b.dyn)).toBeGreaterThan(40);
    }
  }, 30_000);

  it('upside down it floats high (sealed hull and capsule), taking water only through its intake', () => {
    const sea = new IrregularSea({ hs: 0.01, tp: 5, towards: 0 });
    const b = new WorldBoat('h', 'hydro', sea, 'realistic');
    b.place(0, 0, 0, 0);
    b.dyn.placeAtRest(0, 0, 0, 175 * DEG);
    const wind = new UniformWind(0, 0);
    const events: SimEvent[] = [];
    for (let i = 0; i < 60 / DT; i++) b.step(DT, i * DT, wind, events);
    expect(events.some((e) => e.type === 'capsized')).toBe(true);
    expect(events.some((e) => e.type === 'sunk')).toBe(false);
    expect(Math.abs(attitudeFromQuat(b.dyn.body.orientation, att).roll)).toBeGreaterThan(150 * DEG);
    // Still riding high: the origin no more than its depth under the surface.
    expect(b.dyn.body.getOrigin(vec3()).y).toBeGreaterThan(-spec.dimensions.depth);
  }, 30_000);
});
