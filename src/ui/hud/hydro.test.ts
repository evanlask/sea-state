// The hydroplane's alerts: the bow climbing toward a blow-over at speed, racing in a
// chop, and its HUD panel's turbine readout.

import { describe, expect, it } from 'vite-plus/test';

import { propulsionFromTelemetry } from '../../app/hudModel';
import { DEG } from '../../sim/core/conventions';
import { MPH } from '../../sim/core/units';
import { neutralControls } from '../../sim/world/protocol';
import { flatOcean, SimWorld } from '../../sim/world/SimWorld';
import {
  type AlertInput,
  ALERT_THRESHOLDS,
  bowHighPitch,
  chopSafeSpeed,
  effectiveChop,
  evaluateAlerts,
} from './alerts';
import type { TurbinePropulsion } from './model';
import { turbineState } from './widgets/PropulsionPanel';

const base: AlertInput = {
  kind: 'hydro',
  speed: 160 * MPH,
  heading: 0,
  cog: 0,
  roll: 0,
  pitch: 2 * DEG,
  stability: { dangerHeel: 60 * DEG, avs: 88 * DEG },
  hs: 0.3,
  tp: 11,
  isNight: false,
  navLights: true,
};
const ids = (input: Partial<AlertInput>, previous?: ReadonlySet<string>): string[] =>
  evaluateAlerts({ ...base, ...input }, previous).map((a) => a.id);

describe('hydroplane alerts', () => {
  it('the bow-high line falls with speed, toward the running trim', () => {
    expect(bowHighPitch(40)).toBeNull();
    expect(bowHighPitch(45)! / DEG).toBeCloseTo(5);
    expect(bowHighPitch(89)! / DEG).toBeCloseTo(3.2);
    expect(bowHighPitch(71.5)!).toBeLessThan(bowHighPitch(50)!);
  });

  it('quiet on its running trim in a glassy calm at 160 mph', () => {
    expect(ids({})).toEqual([]);
  });

  it('bow high, then blowing over, as the bow climbs at speed; nothing at 60 mph', () => {
    expect(ids({ pitch: 4.5 * DEG })).toEqual(['bow-high']);
    const over = evaluateAlerts({ ...base, pitch: 7.5 * DEG });
    expect(over.map((a) => a.id)).toEqual(['blow-over']);
    expect(over[0]).toMatchObject({
      severity: 'danger',
      detail: 'Space cuts the power; Q trims the wing down',
    });
    expect(evaluateAlerts({ ...base, pitch: 7.5 * DEG, device: 'gamepad' })[0]?.detail).toBe(
      'B cuts the power; LB trims the wing down',
    );
    expect(ids({ speed: 60 * MPH, pitch: 8 * DEG })).toEqual([]);
    // Held a little below the line once up.
    expect(ids({ pitch: 3.6 * DEG }, new Set(['bow-high']))).toEqual(['bow-high']);
    expect(ids({ pitch: 3.6 * DEG })).toEqual([]);
  });

  it('long swell is not chop; a Fair chop at racing speed is', () => {
    expect(effectiveChop(0.3, 11)).toBeLessThan(ALERT_THRESHOLDS.hydro.chopFloor);
    expect(effectiveChop(0.38, 3.1)).toBeCloseTo(0.38);
    expect(chopSafeSpeed(0.1)).toBe(Infinity);
    expect(chopSafeSpeed(0.4)).toBeCloseTo(48);
    expect(chopSafeSpeed(2) / MPH).toBeLessThan(40); // the sea test: 2 m head seas only at ~30 mph
    const fair = { hs: 0.38, tp: 3.1 };
    const alert = evaluateAlerts({ ...base, ...fair, units: { speed: 'mph', length: 'm', wind: 'kn' } });
    expect(alert.map((a) => a.id)).toEqual(['hydro-chop']);
    expect(alert[0]?.detail).toBe('Off a crest the bow lifts and it flies: keep under 110 mph');
    expect(ids({ ...fair, speed: 90 * MPH })).toEqual([]);
  });

  it('warns of a hard turn flat out', () => {
    const rudder = { angle: -10 * DEG, max: 17 * DEG };
    expect(ids({ speed: 190 * MPH, rudder })).toEqual(['hydro-turn']);
    expect(ids({ speed: 150 * MPH, rudder })).toEqual([]);
    expect(ids({ speed: 190 * MPH, rudder: { angle: 5 * DEG, max: 17 * DEG } })).toEqual([]);
  });

  it('only the hydroplane gets them', () => {
    expect(ids({ kind: 'powerboat', pitch: 9 * DEG, hs: 0.38, tp: 3.1 })).toEqual([]);
  });
});

describe('hydroplane HUD panel', () => {
  it('reads the turbine, the propeller, the wing and the rudder from the sim, the needle lagging the lever', () => {
    const world = new SimWorld(
      {
        seed: 1,
        physicsMode: 'arcade',
        boats: [{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: 0 }],
        wind: { speed: 0, from: 0, gustFactor: 1 },
        seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
        oceanQuality: 'low',
        wakes: false,
      },
      flatOcean,
    );
    const s = world.advance({
      type: 'advance',
      targetTime: 1,
      controls: { h: { ...neutralControls(), throttle: 1, steer: 0.5 } },
      commands: [],
      probes: new Float64Array(),
    });
    const p = propulsionFromTelemetry('hydro', s.boats[0]!.telemetry) as TurbinePropulsion;
    expect(p.type).toBe('turbine');
    expect(p.powerLever).toBe(1);
    expect(p.n1Order).toBeCloseTo(1);
    expect(p.n1).toBeGreaterThan(0.6);
    expect(p.n1).toBeLessThan(0.97); // a second in: still spooling
    expect(turbineState(p).text).toBe('Spooling up');
    expect(p.propRpm).toBeGreaterThan(0);
    expect(p.maxRpm).toBe(9500);
    expect(p.wingAngle / DEG).toBeCloseTo(-3);
    expect(p.rudder).toBeGreaterThan(0);
    expect(p.rudderMax / DEG).toBeCloseTo(17);
    expect(p.killed).toBe(false);
  });

  it('names the turbine’s state', () => {
    const p: TurbinePropulsion = {
      type: 'turbine',
      powerLever: 0.5,
      n1: 0.9,
      n1Order: 0.9,
      power: 0.5,
      propRpm: 7000,
      maxRpm: 9500,
      wingAngle: 0,
      wingTrim: 0.2,
      rudder: 0,
      rudderMax: 0.17,
      turnG: 0,
      killed: false,
    };
    expect(turbineState(p)).toEqual({ text: 'On power', tone: 'good' });
    expect(turbineState({ ...p, n1Order: 0.6, powerLever: 0 }).text).toBe('Spooling down');
    expect(turbineState({ ...p, n1: 0.6, n1Order: 0.6, powerLever: 0 }).text).toBe('Idle');
    expect(turbineState({ ...p, killed: true })).toEqual({ text: 'Fuel cut', tone: 'danger' });
  });
});
