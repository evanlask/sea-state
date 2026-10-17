// Hard-over turns on flat water for the planing small craft. The jet ski and
// the center console bank into the turn and neither capsizes nor spins out. A
// hard-over turn makes them slide, and the slide bleeds their speed: the jet
// ski's turn tightens as it slows. Let go of the helm and they straighten,
// level and pick up speed again.

import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../core/attitude';
import { physicsTuning } from '../physics/tuning';
import { flatWater } from '../physics/water';
import { neutralControls, type PhysicsMode } from '../world/protocol';
import { createBoatDynamics } from './drivetrains';
import { BOAT_SPECS } from './specs/index';

const DEG = Math.PI / 180;
const DT = 1 / 120;

type Craft = 'pwc' | 'powerboat';

interface Sample {
  t: number; // s since the helm went over (or, after the release, since it was centred)
  speed: number; // through the water, m/s
  yawRate: number; // deg/s, + starboard
  roll: number; // deg, + starboard down
  heading: number; // rad, unwrapped, from the start of the turn
  x: number;
  z: number;
}

// Runs straight at `throttle` from `v0` for `settle` s, puts the helm hard to
// starboard for `turn` s, then centres it for `release` s.
function hardOver(
  kind: Craft,
  mode: PhysicsMode,
  throttle: number,
  v0: number,
  settle: number,
  turn: number,
  release: number,
) {
  const d = createBoatDynamics(kind, physicsTuning(kind, mode));
  d.body.velocity.z = -v0;
  d.prime(throttle);
  const c = { ...neutralControls(), throttle };
  const tel: Record<string, number> = {};
  const att = { heading: 0, pitch: 0, roll: 0 };
  let time = 0;
  const step = (): void => {
    d.step(DT, flatWater, null, time, c);
    time += DT;
  };
  for (let i = 0; i < settle / DT; i++) step();
  d.writeTelemetry(tel);
  const startSpeed = tel['speedThroughWater']!;
  const turning: Sample[] = [];
  const after: Sample[] = [];
  let heading = attitudeFromQuat(d.body.orientation, att).heading;
  let unwrapped = 0;
  const sample = (t: number, out: Sample[]): void => {
    attitudeFromQuat(d.body.orientation, att);
    d.writeTelemetry(tel);
    let dh = att.heading - heading;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    unwrapped += dh;
    heading = att.heading;
    out.push({
      t,
      speed: tel['speedThroughWater']!,
      yawRate: tel['yawRate']! / DEG,
      roll: att.roll / DEG,
      heading: unwrapped,
      x: d.body.position.x,
      z: d.body.position.z,
    });
  };
  c.steer = 1;
  for (let i = 1; i <= turn / DT; i++) {
    step();
    sample(i * DT, turning);
  }
  c.steer = 0;
  for (let i = 1; i <= release / DT; i++) {
    step();
    sample(i * DT, after);
  }
  return { startSpeed, turning, after };
}

const between = (s: readonly Sample[], from: number, to: number): Sample[] =>
  s.filter((x) => x.t >= from && x.t <= to);
const mean = (s: readonly Sample[], k: keyof Sample): number => s.reduce((a, x) => a + x[k], 0) / s.length;
const at = (s: readonly Sample[], t: number): Sample => s.find((x) => x.t >= t - DT / 2)!;
const maxAbsRoll = (s: readonly Sample[]): number => Math.max(...s.map((x) => Math.abs(x.roll)));

// Largest extent of the track over its last full circle of heading.
function circleDiameter(s: readonly Sample[]): number {
  const last = s[s.length - 1]!.heading;
  const lap = s.filter((x) => x.heading >= last - 2 * Math.PI);
  expect(last - lap[0]!.heading).toBeGreaterThan(2 * Math.PI - 0.1);
  const xs = lap.map((x) => x.x);
  const zs = lap.map((x) => x.z);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
}

describe('hard-over turns at top speed', () => {
  for (const mode of ['arcade', 'realistic'] as const) {
    // Full throttle at top speed, 8 s hard over, then 4 s with the helm centred (run once each).
    const runs = new Map<Craft, ReturnType<typeof hardOver>>();
    const top = (kind: Craft) => {
      let r = runs.get(kind);
      if (!r) runs.set(kind, (r = hardOver(kind, mode, 1, BOAT_SPECS[kind].propulsion.topSpeed, 5, 8, 4)));
      return r;
    };

    it(`jet ski (${mode}): banks 5–40° into the turn at 12–60°/s, never past 60°; let go and it straightens`, () => {
      const r = top('pwc');
      const turn = between(r.turning, 1, 8);
      expect(maxAbsRoll(r.turning)).toBeLessThan(60);
      expect(mean(turn, 'roll')).toBeGreaterThan(5);
      expect(mean(turn, 'roll')).toBeLessThan(40);
      expect(mean(turn, 'yawRate')).toBeGreaterThan(12);
      expect(mean(turn, 'yawRate')).toBeLessThan(60);
      const end = r.after[r.after.length - 1]!;
      expect(Math.abs(end.roll)).toBeLessThan(5);
      expect(Math.abs(end.yawRate)).toBeLessThan(3);
    });

    it(`center console (${mode}): banks in 2–15° and turns at 12–60°/s without spinning out`, () => {
      const r = top('powerboat');
      const turn = between(r.turning, 1, 8);
      expect(maxAbsRoll(r.turning)).toBeLessThan(60);
      expect(mean(turn, 'roll')).toBeGreaterThan(2);
      expect(mean(turn, 'roll')).toBeLessThan(15);
      expect(mean(turn, 'yawRate')).toBeGreaterThan(12);
      expect(mean(turn, 'yawRate')).toBeLessThan(60);
      const end = r.after[r.after.length - 1]!;
      expect(Math.abs(end.roll)).toBeLessThan(5);
      expect(Math.abs(end.yawRate)).toBeLessThan(3);
    });

    it(`jet ski (${mode}): the slide bleeds 58 kn to 8–15 m/s within 3 s, then it turns at 35–60°/s`, () => {
      const r = top('pwc');
      const v3 = at(r.turning, 3).speed;
      expect(v3).toBeGreaterThan(8);
      expect(v3).toBeLessThan(15);
      const slow = between(r.turning, 3, 8);
      expect(mean(slow, 'yawRate')).toBeGreaterThan(35);
      expect(mean(slow, 'yawRate')).toBeLessThan(60);
      // A sustained full-lock turn costs at least 40% of the speed.
      expect(Math.max(...slow.map((x) => x.speed))).toBeLessThan(0.6 * r.startSpeed);
    });

    it(`jet ski (${mode}): let go after the slide and it straightens, levels and accelerates back to speed`, () => {
      const r = top('pwc');
      const end = r.after[r.after.length - 1]!;
      // The stern swings back as the slide unwinds, but the turn stops within a few degrees.
      expect(Math.abs(end.heading - at(r.turning, 8).heading)).toBeLessThan(30 * DEG);
      expect(Math.abs(end.yawRate)).toBeLessThan(3);
      expect(Math.abs(end.roll)).toBeLessThan(5);
      expect(end.speed).toBeGreaterThan(0.85 * r.startSpeed);
    });

    it(`center console (${mode}): bleeds speed in the turn too, but less than the jet ski`, () => {
      const boat = top('powerboat');
      const ski = top('pwc');
      const kept = (r: ReturnType<typeof top>, t: number) => at(r.turning, t).speed / r.startSpeed;
      expect(kept(boat, 8)).toBeLessThan(0.7);
      expect(kept(boat, 3)).toBeGreaterThan(kept(ski, 3));
      expect(boat.after[boat.after.length - 1]!.speed).toBeGreaterThan(at(boat.turning, 8).speed);
    });

    it(`jet ski (${mode}): full lock at part throttle (30 kn cruise) circles within 5 boat lengths`, () => {
      const r = hardOver('pwc', mode, 0.3, 15, 8, 18, 0);
      expect(r.startSpeed).toBeGreaterThan(13);
      expect(r.startSpeed).toBeLessThan(18);
      expect(maxAbsRoll(r.turning)).toBeLessThan(60);
      expect(circleDiameter(r.turning)).toBeLessThan(5 * BOAT_SPECS.pwc.dimensions.loa);
    });
  }
});
