import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../sim/core/conventions';
import { type Vec3, vec3 } from '../sim/core/math';
import {
  CC115_RIG,
  genoaClew,
  genoaPlan,
  MAIN_HEADBOARD,
  mainCutChord,
  mainPlan,
  reefDepth,
} from '../sim/sail/rig';
import { SAIL_KEYS as K } from '../sim/sail/telemetry';
import { SailCloth } from './SailCloth';
import { sailFrame, sailFramesFromTelemetry } from './sailFrames';

const rig = CC115_RIG;

// Telemetry for a boat sailing in a breeze: boom β, genoa γ, reef and furl as given.
function telemetry(reef: number, furl: number, beta = -20 * DEG, gamma = -12 * DEG): Record<string, number> {
  const plan = genoaPlan(rig, furl);
  const clew = genoaClew(vec3(), rig, plan, gamma);
  const air = { x: -4, y: 0, z: 9 }; // from starboard, so the sails set to port
  return {
    [K.boomAngle]: beta,
    [K.jibAngle]: gamma,
    [K.reefProgress]: reef,
    [K.jibFurl]: furl,
    [K.jibClewX]: clew.x,
    [K.jibClewY]: clew.y,
    [K.jibClewZ]: clew.z,
    [K.mainAwX]: air.x,
    [K.mainAwY]: air.y,
    [K.mainAwZ]: air.z,
    [K.jibAwX]: air.x,
    [K.jibAwY]: air.y,
    [K.jibAwZ]: air.z,
    [K.mainFill]: 1,
    [K.jibFill]: 1,
    [K.mainForce]: 3000 * (1 - reef / 6),
    [K.jibForce]: 3000 * (1 - furl),
  };
}

function settle(reef: number, furl: number, seconds = 2): { main: SailCloth; jib: SailCloth } {
  const main = new SailCloth('main', 'high');
  const jib = new SailCloth('jib', 'high');
  const mf = sailFrame();
  const jf = sailFrame();
  const t = telemetry(reef, furl);
  sailFramesFromTelemetry(t, vec3(0, -9.81, 0), mf, jf);
  for (let f = 0; f < seconds * 60; f++) {
    main.update(1 / 60, mf, f / 60);
    jib.update(1 / 60, jf, f / 60);
  }
  return { main, jib };
}

const at = (a: Float64Array, i: number): Vec3 => ({ x: a[3 * i]!, y: a[3 * i + 1]!, z: a[3 * i + 2]! });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

// The rest shape flattened into its own sail plane (camber removed): area, and the centroid along the
// luff from the tack (up) and perpendicular to it toward the clew (out).
function flatOutline(sail: SailCloth): { area: number; up: number; out: number } {
  const r = sail.cloth.rest;
  const tack = at(r, 0);
  const luff = sub(at(r, (sail.rows - 1) * sail.cols), tack);
  const l = len(luff);
  const lu = { x: luff.x / l, y: luff.y / l, z: luff.z / l };
  const c = sub(at(r, sail.cols - 1), tack);
  const along = dot(c, lu);
  const m0 = { x: c.x - along * lu.x, y: c.y - along * lu.y, z: c.z - along * lu.z };
  const ml = len(m0);
  const m = { x: m0.x / ml, y: m0.y / ml, z: m0.z / ml };
  const flat = (i: number): [number, number] => {
    const v = sub(at(r, i), tack);
    return [dot(v, m), dot(v, lu)];
  };
  let area = 0;
  let up = 0;
  let out = 0;
  const tri = sail.triangles;
  for (let k = 0; k < tri.length; k += 3) {
    const [ax, ay] = flat(tri[k]!);
    const [bx, by] = flat(tri[k + 1]!);
    const [cx, cy] = flat(tri[k + 2]!);
    const a = 0.5 * Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
    area += a;
    out += (a * (ax + bx + cx)) / 3;
    up += (a * (ay + by + cy)) / 3;
  }
  return { area, up: up / area, out: out / area };
}

function pinnedSet(sail: SailCloth): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < sail.cloth.count; i++) if (sail.cloth.pinned[i]) set.add(i);
  return set;
}

describe('sail cut on the cloth', () => {
  it('the genoa is a triangle pointed at the head, with the measured area and centroid', () => {
    const { jib } = settle(0, 0, 0.5);
    const { cols, rows } = jib;
    const head = genoaPlan(rig, 0).head;
    const top = (rows - 1) * cols;
    // Every head-row particle is pinned at the head, in the rest shape and the cloth.
    for (let q = 0; q < cols; q++) {
      expect(len(sub(at(jib.positions, top + q), head))).toBeLessThan(1e-9);
      expect(len(sub(at(jib.cloth.rest, top + q), head))).toBeLessThan(1e-9);
    }
    // Pinned: the luff on the forestay, the head and the clew; the foot and leech are free.
    const expected = new Set<number>();
    for (let r = 0; r < rows; r++) expected.add(r * cols);
    for (let q = 0; q < cols; q++) expected.add(top + q);
    expected.add(cols - 1);
    expect(pinnedSet(jib)).toEqual(expected);
    const flat = flatOutline(jib);
    const plan = genoaPlan(rig, 0);
    expect(flat.area / rig.genoaArea).toBeCloseTo(1, 2);
    expect(flat.up / (plan.luffLength + plan.along) / (1 / 3)).toBeCloseTo(1, 2);
    expect(flat.out / (plan.lp / 3)).toBeCloseTo(1, 2);
    // LP: the clew is the genoa's LP from the luff, overlapping the mast.
    expect(flat.out * 3).toBeCloseTo(plan.lp, 2);
    expect(plan.lp).toBeGreaterThan(rig.J);
  });

  it('the main has a ~15 cm headboard, a roached leech and the measured area and centroid', () => {
    const { main } = settle(0, 0, 0.5);
    const { cols, rows } = main;
    const r = main.cloth.rest;
    const top = (rows - 1) * cols;
    expect(len(sub(at(r, top + cols - 1), at(r, top)))).toBeCloseTo(MAIN_HEADBOARD, 2);
    expect(main.chords[rows - 1]).toBeCloseTo(MAIN_HEADBOARD, 6);
    // The leech is the cut: each row's chord is the cut chord at its height.
    for (let row = 0; row < rows; row++)
      expect(main.chords[row]).toBeCloseTo(mainCutChord(rig, row / (rows - 1)), 6);
    // Pinned: luff on the mast track, foot on the boom and the headboard; the leech is free.
    const expected = new Set<number>();
    for (let row = 0; row < rows; row++) expected.add(row * cols);
    for (let q = 0; q < cols; q++) expected.add(q).add(top + q);
    expect(pinnedSet(main)).toEqual(expected);
    const flat = flatOutline(main);
    const plan = mainPlan(rig, 0);
    // A polygon through the grid's leech points cuts the curve's chords: within 1%.
    expect(Math.abs(flat.area / rig.mainArea - 1)).toBeLessThan(0.01);
    expect(Math.abs(flat.up / plan.ceHeight - 1)).toBeLessThan(0.04);
    expect(Math.abs(flat.out / plan.ceAft - 1)).toBeLessThan(0.04);
  });

  it('reefing lowers the head and keeps the top of the cut; furling keeps the genoa pointed', () => {
    for (const [reef, furl] of [
      [1, 1 / 3],
      [2, 2 / 3],
      [3, 0.9],
    ] as const) {
      const { main, jib } = settle(reef, furl);
      const d = reefDepth(rig, reef);
      const s0 = d / rig.P;
      const headIndex = (main.rows - 1) * main.cols;
      expect(main.positions[3 * headIndex + 1]).toBeCloseTo(rig.boomY + rig.P - d, 9);
      for (let row = 0; row < main.rows; row++) {
        const s = s0 + (row / (main.rows - 1)) * (1 - s0);
        expect(main.chords[row]).toBeCloseTo(mainCutChord(rig, s), 6);
      }
      // The reefed area is the cut above the reef.
      let cut = 0;
      for (let i = 0; i < 1000; i++)
        cut += (mainCutChord(rig, s0 + ((i + 0.5) / 1000) * (1 - s0)) * (rig.P - d)) / 1000;
      expect(Math.abs(flatOutline(main).area / cut - 1)).toBeLessThan(0.01);
      expect(Math.abs(flatOutline(jib).area / genoaPlan(rig, furl).area - 1)).toBeLessThan(0.01);
      expect(jib.chords[jib.rows - 1]).toBeLessThan(1e-9);
      for (const s of [main, jib]) {
        expect(s.positions.every(Number.isFinite)).toBe(true);
        expect(s.cloth.resets).toBe(0);
      }
    }
  });

  it('weighs each particle by its share of the area', () => {
    const { main, jib } = settle(0, 0, 0.1);
    let mainMass = 0;
    let jibMass = 0;
    for (let i = 0; i < main.cloth.count; i++) mainMass += main.cloth.mass[i]!;
    for (let i = 0; i < jib.cloth.count; i++) jibMass += jib.cloth.mass[i]!;
    // Dacron at ~0.3 kg/m² (the rest shape's camber adds a few %); the slivers at the head stay light.
    expect(mainMass / rig.mainArea).toBeGreaterThan(0.3);
    expect(mainMass / rig.mainArea).toBeLessThan(0.36);
    expect(jibMass / rig.genoaArea).toBeGreaterThan(0.26);
    expect(jibMass / rig.genoaArea).toBeLessThan(0.32);
    const near = jib.cloth.mass[(jib.rows - 2) * jib.cols + 1]!;
    const foot = jib.cloth.mass[jib.cols + 1]!;
    expect(near).toBeLessThan(foot / 4);
  });

  it('a coarse, rarely stepped pair (a distant boat) stays finite in hurricane air', () => {
    const main = new SailCloth('main', 'low');
    const jib = new SailCloth('jib', 'low');
    const mf = sailFrame();
    const jf = sailFrame();
    const t = telemetry(3, 0.67);
    for (const k of [K.mainAwX, K.jibAwX]) t[k] = -30;
    for (const k of [K.mainAwZ, K.jibAwZ]) t[k] = 60;
    t[K.mainForce] = t[K.jibForce] = 60_000;
    sailFramesFromTelemetry(t, vec3(0, -9.81, 0), mf, jf);
    for (let f = 0; f < 90; f++) {
      main.update(1 / 15, mf, f / 15, 4);
      jib.update(1 / 15, jf, f / 15, 4);
    }
    for (const s of [main, jib]) {
      expect(s.positions.every(Number.isFinite)).toBe(true);
      expect(s.cloth.resets).toBe(0);
    }
  });

  it('the roached main and the pointed genoa sit still in a steady breeze (no leech flutter)', () => {
    const main = new SailCloth('main', 'high');
    const jib = new SailCloth('jib', 'high');
    const mf = sailFrame();
    const jf = sailFrame();
    sailFramesFromTelemetry(telemetry(0, 0), vec3(0, -9.81, 0), mf, jf);
    // Mean frame-to-frame change of velocity of the free particles once set: jitter, not slow breathing.
    const jitter = [0, 0];
    const prev = [new Float64Array(main.positions), new Float64Array(jib.positions)];
    const prev2 = [new Float64Array(main.positions), new Float64Array(jib.positions)];
    let frames = 0;
    for (let f = 0; f < 240; f++) {
      main.update(1 / 60, mf, f / 60);
      jib.update(1 / 60, jf, f / 60);
      [main, jib].forEach((s, k) => {
        const p = s.positions;
        if (f >= 120) {
          let sum = 0;
          let n = 0;
          for (let i = 0; i < s.cloth.count; i++) {
            if (s.cloth.pinned[i]) continue;
            let d2 = 0;
            for (let d = 3 * i; d < 3 * i + 3; d++) d2 += (p[d]! - 2 * prev[k]![d]! + prev2[k]![d]!) ** 2;
            sum += Math.sqrt(d2);
            n++;
          }
          jitter[k] = jitter[k]! + sum / n;
        }
        prev2[k]!.set(prev[k]!);
        prev[k]!.set(p);
      });
      if (f >= 120) frames++;
    }
    // m per frame²: a limit well below visible buzzing.
    expect(jitter[0]! / frames).toBeLessThan(1.5e-3);
    expect(jitter[1]! / frames).toBeLessThan(5e-4);
  });
});
