// The Unlimited hydroplane in the world: its fleet autopilot (hold, circle, follow at
// the leader's speed, whether that is a center console at 30 kn or another hydroplane at 150 mph),
// and the kill switch that stops its turbine after a capsize until Recover.

import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../core/attitude';
import { DEG } from '../core/conventions';
import { qRotate, vec3 } from '../core/math';
import { MPH } from '../core/units';
import { getWeatherPreset } from '../weather/presets';
import { HYDRO_PILOT } from './autopilot';
import { neutralControls, type SimCommand, type SimConfig, type Snapshot } from './protocol';
import { flatOcean, SimWorld } from './SimWorld';

const KN = 0.5144;
const UP = vec3(0, 1, 0);
const up = vec3();

const world = (boats: SimConfig['boats']): SimWorld =>
  new SimWorld(
    {
      seed: 1,
      physicsMode: 'arcade',
      boats,
      wind: { speed: 0, from: 0, gustFactor: 1 },
      seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
      oceanQuality: 'low',
      wakes: false,
    },
    flatOcean,
  );

interface Track {
  last: Snapshot;
  maxTilt: Record<string, number>;
  capsized: boolean;
}

// On to `t` in frame-sized requests, `controls` held, tracking each boat's worst tilt.
function run(
  w: SimWorld,
  t: number,
  controls: Record<string, ReturnType<typeof neutralControls>> = {},
  commands: SimCommand[] = [],
  track: Track = { last: null as unknown as Snapshot, maxTilt: {}, capsized: false },
): Track {
  let first = true;
  while (w.time < t - 1e-9) {
    const s = w.advance({
      type: 'advance',
      targetTime: Math.min(t, w.time + 0.25),
      controls,
      commands: first ? commands : [],
      probes: new Float64Array(),
    });
    first = false;
    for (const b of s.boats) {
      const q = b.orientation;
      qRotate(up, { x: q.x, y: q.y, z: q.z, w: q.w }, UP);
      const tilt = Math.acos(Math.max(-1, Math.min(1, up.y)));
      track.maxTilt[b.id] = Math.max(track.maxTilt[b.id] ?? 0, tilt);
    }
    if (s.events.some((e) => e.type === 'capsized')) track.capsized = true;
    track.last = s;
  }
  return track;
}

const speedOf = (s: Snapshot, id: string): number => {
  const b = s.boats.find((x) => x.id === id)!;
  return Math.hypot(b.velocity.x, b.velocity.z);
};

describe('hydroplane autopilot', () => {
  it('hold: from rest it settles at its 70 kn fleet cruise on the course it was given', () => {
    const w = world([{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: 0 }]);
    w.boat('h')!.setAutopilot({ mode: 'hold', heading: 30 * DEG });
    const tr = run(w, 60);
    const b = tr.last.boats[0]!;
    const speed = speedOf(tr.last, 'h');
    const heading = attitudeFromQuat(b.orientation).heading;
    expect(speed / KN).toBeGreaterThan(65);
    expect(speed / KN).toBeLessThan(75);
    expect(Math.abs(heading - 30 * DEG)).toBeLessThan(2 * DEG);
    expect(tr.capsized).toBe(false);
  }, 60_000);

  it('holds a set speed, up to its 160 mph cap', () => {
    for (const [kn, expected] of [
      [40, 40],
      [200, HYDRO_PILOT.maxSpeed / KN],
    ] as const) {
      const w = world([{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: 0 }]);
      w.boat('h')!.setAutopilot({ mode: 'hold', heading: 0, speed: kn * KN });
      const tr = run(w, 70);
      expect(speedOf(tr.last, 'h') / KN, `${kn} kn`).toBeCloseTo(expected, -0.5);
      expect(tr.maxTilt['h']!).toBeLessThan(5 * DEG);
    }
  }, 120_000);

  it('circle: a wide, steady circle at about 60 kn', () => {
    const w = world([{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: 0 }]);
    w.boat('h')!.setAutopilot({ mode: 'circle' });
    run(w, 40);
    let tr = run(w, 40);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let t = 41; t <= 100; t += 1) {
      tr = run(w, t, {}, [], tr);
      const b = tr.last.boats[0]!;
      xs.push(b.position.x);
      zs.push(b.position.z);
    }
    const speed = speedOf(tr.last, 'h');
    // The circle's centre from the track's extent (a minute is more than one lap).
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    const rs = xs.map((x, i) => Math.hypot(x - cx, zs[i]! - cz));
    expect(speed / KN).toBeGreaterThan(55);
    expect(speed / KN).toBeLessThan(65);
    expect(Math.min(...rs)).toBeGreaterThan(250);
    expect(Math.max(...rs)).toBeLessThan(600);
    expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(120);
    expect(tr.maxTilt['h']!).toBeLessThan(5 * DEG);
  }, 60_000);

  it('follows a center console at 30 kn from a line abreast', () => {
    const w = world([
      { id: 'p', kind: 'powerboat', x: 0, z: 0, heading: 0 },
      { id: 'h', kind: 'hydro', x: 50, z: 0, heading: 0 },
    ]);
    const helm = { ...neutralControls(), throttle: 1 };
    const tr = run(w, 60, { p: helm });
    const p = tr.last.boats.find((b) => b.id === 'p')!;
    const h = tr.last.boats.find((b) => b.id === 'h')!;
    expect(speedOf(tr.last, 'p') / KN).toBeGreaterThan(40);
    expect(Math.abs(speedOf(tr.last, 'h') - speedOf(tr.last, 'p'))).toBeLessThan(3 * KN);
    // On station: still abeam, within a few lengths of where it started.
    expect(Math.abs(h.position.x - p.position.x - 50)).toBeLessThan(15);
    expect(Math.abs(h.position.z - p.position.z)).toBeLessThan(40);
    expect(tr.maxTilt['h']!).toBeLessThan(5 * DEG);
  }, 60_000);

  it('follows another hydroplane at up to 160 mph, through its turns', () => {
    const w = world([
      { id: 'p', kind: 'hydro', x: 0, z: 0, heading: 0 },
      { id: 'h', kind: 'hydro', x: 50, z: 0, heading: 0 },
    ]);
    const helm = { ...neutralControls(), throttle: 0.7 };
    let tr = run(w, 50, { p: helm });
    // The leader runs at ~170 mph; the follower keeps to its cap close behind.
    expect(speedOf(tr.last, 'p') / MPH).toBeGreaterThan(165);
    expect(Math.abs(speedOf(tr.last, 'h') - HYDRO_PILOT.maxSpeed) / MPH).toBeLessThan(5);
    // The leader turns 60°-odd at speed, then runs straight: the follower turns after it, upright.
    tr = run(w, 70, { p: { ...helm, steer: -0.6 } }, [], tr);
    tr = run(w, 90, { p: helm }, [], tr);
    const p = tr.last.boats.find((b) => b.id === 'p')!;
    const h = tr.last.boats.find((b) => b.id === 'h')!;
    const heading = (b: typeof p): number => attitudeFromQuat(b.orientation).heading;
    expect(Math.abs(heading(p) - heading(h))).toBeLessThan(10 * DEG);
    expect(Math.hypot(h.position.x - p.position.x, h.position.z - p.position.z)).toBeLessThan(1000);
    expect(tr.capsized).toBe(false);
    expect(tr.maxTilt['h']!).toBeLessThan(10 * DEG);
  }, 90_000);
});

describe('hydroplane flat out in a Glassy Calm', () => {
  // The real FFT sea of the preset (its 0.3 m swell and the ripples on it), the power lever full and
  // the wheel left alone for a minute: it must reach its top speed and run straight, never blow over.
  // One seed per mode: the sea is the same statistical swell whichever seed, and each run is ~9 s.
  for (const mode of ['arcade', 'realistic'] as const) {
    for (const seed of [1]) {
      it(`${mode}, seed ${seed}: 190+ mph, on course within 3°, the bow within 6°, upright`, () => {
        const p = getWeatherPreset('glassy-calm');
        const w = new SimWorld({
          seed,
          physicsMode: mode,
          boats: [{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: p.windFrom }],
          wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
          seaState: p.seaState,
          oceanQuality: 'low',
          wakes: false,
        });
        const helm = { h: { ...neutralControls(), throttle: 1 } };
        let top = 0;
        let pitch = 0;
        let off = 0;
        let capsized = false;
        while (w.time < 60 - 1e-9) {
          const s = w.advance({
            type: 'advance',
            targetTime: Math.min(60, w.time + 0.25),
            controls: helm,
            commands: [],
            probes: new Float64Array(),
          });
          const b = s.boats[0]!;
          const a = attitudeFromQuat(b.orientation);
          top = Math.max(top, Math.hypot(b.velocity.x, b.velocity.z));
          pitch = Math.max(pitch, Math.abs(a.pitch));
          off = Math.max(
            off,
            Math.abs(Math.atan2(Math.sin(a.heading - p.windFrom), Math.cos(a.heading - p.windFrom))),
          );
          if (b.telemetry['capsized']! > 0.5 || s.events.some((e) => e.type === 'capsized')) capsized = true;
        }
        expect(capsized).toBe(false);
        expect(top / MPH).toBeGreaterThan(190);
        expect(pitch).toBeLessThan(6 * DEG);
        expect(off).toBeLessThan(3 * DEG);
      }, 120_000);
    }
  }
});

describe('hydroplane kill switch', () => {
  it('a capsize cuts the turbine (it ran on upside down); Recover relights it', () => {
    const w = world([{ id: 'h', kind: 'hydro', x: 0, z: 0, heading: 0 }]);
    const boat = w.boat('h')!;
    boat.dyn.placeAtRest(0, 0, 0, Math.PI, 0.4);
    const open = { h: { ...neutralControls(), throttle: 1 } };
    let tr = run(w, 1, open);
    expect(tr.capsized).toBe(true);
    let t = tr.last.boats[0]!.telemetry;
    expect(t['killSwitch']).toBe(1);
    // Throttle held open upside down: the gas generator winds down, nothing turns, no thrust.
    tr = run(w, 30, open, [], tr);
    t = tr.last.boats[0]!.telemetry;
    expect(t['gasGenerator']).toBe(0);
    expect(t['n1']).toBe(0);
    expect(t['thrust']).toBe(0);
    expect(t['rpm']).toBeLessThan(500);
    // Recover: upright, relit at idle, and it drives again.
    tr = run(w, 30.5, {}, [{ type: 'recover', boatId: 'h' }], tr);
    t = tr.last.boats[0]!.telemetry;
    expect(t['killSwitch']).toBe(0);
    expect(t['capsized']).toBe(0);
    tr = run(w, 36, open, [], tr);
    t = tr.last.boats[0]!.telemetry;
    expect(t['n1']).toBeGreaterThan(0.95);
    expect(t['thrust']).toBeGreaterThan(5000);
    expect(speedOf(tr.last, 'h')).toBeGreaterThan(5);
  }, 60_000);
});

describe('collisions at 200 mph', () => {
  // A hydroplane under way at 200 mph from 300 m off, at a boat lying stopped (drifting) on `heading`;
  // or two of them meeting head-on. Each master step moves it 0.75 m: the pair is swept.
  function ram(kind: 'pwc' | 'powerboat' | 'hydro', heading: number, headOn = false) {
    const w = world([
      { id: 'h', kind: 'hydro', x: 0, z: 300, heading: 0 },
      { id: 'o', kind, x: 0, z: 0, heading },
    ]);
    w.boat('h')!.underWay(200 * MPH, 1);
    w.boat('o')!.setAutopilot({ mode: 'drift' });
    if (headOn) w.boat('o')!.underWay(200 * MPH, 1);
    const helm = { h: { ...neutralControls(), throttle: 1 } };
    let speed = 0;
    let s: Snapshot | null = null;
    for (let i = 0; i < 45; i++) {
      s = w.advance({
        type: 'advance',
        targetTime: w.time + 0.1,
        controls: helm,
        commands: [],
        probes: new Float64Array(),
      });
      for (const e of s.events) if (e.type === 'collision') speed = Math.max(speed, e.speed);
    }
    const z = (id: string): number => s!.boats.find((b) => b.id === id)!.position.z;
    return { speed, h: z('h'), o: z('o') };
  }

  it('meeting head-on, two hydroplanes collide at their closing speed instead of passing through', () => {
    const r = ram('hydro', Math.PI, true);
    expect(r.speed).toBeGreaterThan(160);
    expect(r.h).toBeGreaterThan(r.o); // still on their own sides
  }, 30_000);

  it('rammed broadside at 200 mph, a center console stops it on the near side', () => {
    const r = ram('powerboat', Math.PI / 2);
    expect(r.speed).toBeGreaterThan(80);
    expect(r.h).toBeGreaterThan(r.o);
  }, 30_000);

  it('a jet ski struck broadside is hit at full speed, not tunnelled through unnoticed', () => {
    expect(ram('pwc', Math.PI / 2).speed).toBeGreaterThan(80);
  }, 30_000);
});
