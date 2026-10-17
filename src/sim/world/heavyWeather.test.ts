import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../core/attitude';
import { DEG, signedAngle } from '../core/conventions';
import { getWeatherPreset } from '../weather/presets';
import { type BoatKind, neutralControls, type SimConfig } from './protocol';
import { SimWorld } from './SimWorld';

// The real FFT ocean and wind of a weather preset, every boat drifting
// beam-on to the wind (and the sea). Returns the ids that capsized.
function capsizes(
  weather: string,
  kinds: readonly BoatKind[],
  seconds: number,
  stopWhen?: string[],
): Set<string> {
  const p = getWeatherPreset(weather);
  const config: SimConfig = {
    seed: 11,
    physicsMode: 'arcade',
    boats: kinds.map((kind, i) => ({ id: kind, kind, x: i * 600, z: 0, heading: p.windFrom + Math.PI / 2 })),
    wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
    seaState: p.seaState,
    oceanQuality: 'low',
  };
  const world = new SimWorld(config);
  for (const b of world.boats) b.setAutopilot({ mode: 'drift' });
  const out = new Set<string>();
  for (let t = 1; t <= seconds; t++) {
    const s = world.advance({
      type: 'advance',
      targetTime: t,
      controls: {},
      commands: [],
      probes: new Float64Array(),
    });
    for (const e of s.events) if (e.type === 'capsized') out.add(e.boatId);
    if (stopWhen && stopWhen.every((id) => out.has(id)) && t >= 20) break;
  }
  return out;
}

describe('heavy weather (FFT ocean, lying beam-on, drifting)', () => {
  it('Hurricane Category 3: the container ship never capsizes; the center console and jet ski do', () => {
    const capsized = capsizes('hurricane-3', ['cargo', 'powerboat', 'pwc'], 60, ['powerboat', 'pwc']);
    expect(capsized.has('cargo')).toBe(false);
    expect(capsized.has('powerboat')).toBe(true);
    expect(capsized.has('pwc')).toBe(true);
  }, 90_000);

  it('Breezy: no boat capsizes', () => {
    const capsized = capsizes('breezy', ['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc'], 20);
    expect([...capsized]).toEqual([]);
  }, 90_000);
});

// The cruise ship in Realistic, alone in the preset's sea: under way at about service speed (engines
// primed, full ahead, a helm holding `rel` off the wind) or drifting with the engines stopped. Worst heel
// (deg) after the first 20 s, and whether it capsized.
function cruiseHeel(weather: string, rel: number, underWay: boolean, seconds: number) {
  const p = getWeatherPreset(weather);
  const heading = p.windFrom + rel;
  const world = new SimWorld({
    seed: 1,
    physicsMode: 'realistic',
    boats: [{ id: 'ship', kind: 'cruise', x: 0, z: 0, heading, speed: underWay ? 10.5 : 0 }],
    wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
    seaState: p.seaState,
    oceanQuality: 'low',
    wakes: false,
  });
  const ship = world.boats[0]!;
  ship.setAutopilot(null);
  if (underWay) ship.prime(1);
  const att = { heading: 0, pitch: 0, roll: 0 };
  let maxHeel = 0;
  let capsized = false;
  for (let t = 0.5; t <= seconds; t += 0.5) {
    attitudeFromQuat(ship.dyn.body.orientation, att);
    const c = neutralControls();
    c.throttle = 1;
    const yaw = ship.telemetry['yawRate'] ?? 0;
    c.steer = Math.max(-1, Math.min(1, 2.5 * signedAngle(heading - att.heading - 25 * yaw)));
    const s = world.advance({
      type: 'advance',
      targetTime: t,
      controls: underWay ? { ship: c } : {},
      commands: [],
      probes: new Float64Array(),
    });
    capsized ||= s.events.some((e) => e.type === 'capsized');
    attitudeFromQuat(s.boats[0]!.orientation, att);
    if (t > 20) maxHeel = Math.max(maxHeel, Math.abs(att.roll) / DEG);
  }
  return { maxHeel, capsized };
}

describe('the cruise ship rides out heavy weather (Realistic)', () => {
  it('Storm, under way beam-on to the seas with her fin stabilisers: heel under 20°', () => {
    const r = cruiseHeel('storm', Math.PI / 2, true, 90);
    expect(r.capsized).toBe(false);
    expect(r.maxHeel).toBeLessThan(20);
  }, 60_000);

  it('Hurricane Category 3, under way head to the seas: heel under 15°', () => {
    const r = cruiseHeel('hurricane-3', 0, true, 90);
    expect(r.maxHeel).toBeLessThan(15);
  }, 60_000);

  it('Hurricane Category 5, drifting beam-on: never capsizes, heel under 60°', () => {
    const r = cruiseHeel('hurricane-5', Math.PI / 2, false, 120);
    expect(r.capsized).toBe(false);
    expect(r.maxHeel).toBeLessThan(60);
  }, 60_000);
});
