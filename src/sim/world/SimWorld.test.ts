import { describe, expect, it } from 'vite-plus/test';

import { signedAngle } from '../core/conventions';
import { transitionBlend } from '../ocean/h0';
import type { OceanSurface } from '../ocean/OceanSurface';
import { holdableWindAngle, MAX_WIND_ANGLE, MIN_WIND_ANGLE, sailableHeading } from './autopilot';
import {
  neutralControls,
  PROBE_STRIDE,
  type SimCommand,
  type SimConfig,
  type SimEvent,
  type WakeGrid,
} from './protocol';
import { LocalSimHost } from './SimHost';
import { flatOcean, MASTER_STEP, SimWorld, SPECTRUM_LEAD } from './SimWorld';

const DEG_ = Math.PI / 180;

const config: SimConfig = {
  seed: 1,
  physicsMode: 'arcade',
  boats: [{ id: 'a', kind: 'pwc', x: 10, z: -5, heading: 0 }],
  wind: { speed: 5, from: 0, gustFactor: 1 },
  seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
  oceanQuality: 'low',
};

describe('SimWorld', () => {
  it('advances in whole master steps up to the target time', () => {
    const world = new SimWorld(config);
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 0.1,
      controls: { a: neutralControls() },
      commands: [],
      probes: new Float64Array(),
    });
    expect(snapshot.steps).toBe(Math.floor(0.1 / MASTER_STEP + 1e-9));
    expect(snapshot.time).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(0.1 - snapshot.time).toBeLessThan(MASTER_STEP);
  });

  it('answers probe queries', () => {
    const world = new SimWorld(config);
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 0,
      controls: {},
      commands: [],
      probes: new Float64Array([0, 0, 5, 5]),
    });
    expect(snapshot.probes.length).toBe(2 * PROBE_STRIDE);
  });

  it('builds an FFT ocean and publishes its spectrum for the GPU', () => {
    const world = new SimWorld(config);
    expect(world.spectrum?.cascades.length).toBe(5);
    expect(world.spectrum?.significantHeight).toBeGreaterThan(0.2);
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 1,
      controls: {},
      commands: [],
      probes: new Float64Array([0, 0, 37, -12]),
    });
    const heights = [snapshot.probes[0], snapshot.probes[PROBE_STRIDE]];
    expect(heights.some((h) => Math.abs(h ?? 0) > 1e-4)).toBe(true);
  });

  it('spawns boats where the scenario asks', () => {
    const world = new SimWorld(config);
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 0,
      controls: {},
      commands: [],
      probes: new Float64Array(),
    });
    expect(snapshot.boats[0]?.position.x).toBe(10);
    expect(snapshot.boats[0]?.position.z).toBe(-5);
  });

  it('accepts an explicit ocean field', () => {
    const world = new SimWorld(config, flatOcean);
    expect(world.spectrum).toBeNull();
    const snapshot = world.advance({
      type: 'advance',
      targetTime: 0,
      controls: {},
      commands: [],
      probes: new Float64Array([1, 2]),
    });
    expect(snapshot.probes[0]).toBe(0);
    expect(snapshot.boats[0]?.position.z).toBe(-5);
  });
});

describe('LocalSimHost', () => {
  it('delivers snapshots synchronously', async () => {
    const host = new LocalSimHost();
    await host.init(config);
    const times: number[] = [];
    host.onSnapshot((snapshot) => times.push(snapshot.time));
    host.advance({ type: 'advance', targetTime: 1, controls: {}, commands: [], probes: new Float64Array() });
    expect(times).toHaveLength(1);
  });
});

const flatConfig = (
  boats: SimConfig['boats'],
  physicsMode: SimConfig['physicsMode'] = 'arcade',
): SimConfig => ({
  ...config,
  physicsMode,
  wind: { speed: 0, from: 0, gustFactor: 1 },
  boats,
});

// Advances in frame-sized requests (each request steps at most 60 master steps), collecting events.
function advance(world: SimWorld, targetTime: number, controls = {}, commands: SimCommand[] = []) {
  const events: SimEvent[] = [];
  let first = true;
  for (;;) {
    const t = Math.min(world.time + 0.25, targetTime);
    const s = world.advance({
      type: 'advance',
      targetTime: t,
      controls,
      commands: first ? commands : [],
      probes: new Float64Array(),
    });
    first = false;
    events.push(...s.events);
    if (t >= targetTime - 1e-9) return { ...s, events };
  }
}

describe('SimWorld boats', () => {
  it('floats the boats and drives the player from its helm, with telemetry', () => {
    const world = new SimWorld(
      flatConfig([{ id: 'player', kind: 'pwc', x: 0, z: 0, heading: 0 }]),
      flatOcean,
    );
    const helm = { ...neutralControls(), throttle: 1 };
    const s = advance(world, 3, { player: helm });
    const boat = s.boats[0]!;
    expect(Math.abs(boat.position.y)).toBeLessThan(0.4);
    expect(-boat.velocity.z).toBeGreaterThan(10); // heading north (−z)
    for (const key of [
      'speedThroughWater',
      'airborne',
      'rpm',
      'nozzle',
      'bucket',
      'avs',
      'cpuUs',
      'onPlane',
    ]) {
      expect(boat.telemetry[key]).toBeTypeOf('number');
    }
  });

  it('switches physics mode live', () => {
    const world = new SimWorld(
      flatConfig([{ id: 'player', kind: 'cargo', x: 0, z: 0, heading: 0 }]),
      flatOcean,
    );
    expect(world.boat('player')?.dyn.tuning.timeCompression).toBe(10);
    advance(world, 0.1, {}, [{ type: 'setPhysicsMode', mode: 'realistic' }]);
    expect(world.boat('player')?.dyn.tuning.timeCompression).toBe(1);
  });

  it('reports slams with the impact speed and recovers a capsized boat on command', () => {
    const world = new SimWorld(
      flatConfig([{ id: 'player', kind: 'pwc', x: 0, z: 0, heading: 0 }]),
      flatOcean,
    );
    const boat = world.boat('player')!;
    boat.dyn.body.position.y += 1.5;
    const s = advance(world, 1.5);
    const slam = s.events.find((e) => e.type === 'slam');
    expect(slam?.type).toBe('slam');
    if (slam?.type === 'slam') {
      expect(slam.strength).toBeGreaterThan(1);
      expect(slam.strength).toBeLessThan(10);
    }
    boat.dyn.placeAtRest(0, 0, 0, Math.PI * 0.95);
    const capsized = advance(world, 6);
    expect(capsized.events.some((e) => e.type === 'capsized')).toBe(true);
    expect(capsized.boats[0]?.telemetry['capsized']).toBe(1);
    const recovered = advance(world, 6.5, {}, [{ type: 'recover', boatId: 'player' }]);
    expect(recovered.events.some((e) => e.type === 'recovered')).toBe(true);
    expect(Math.abs(recovered.boats[0]?.telemetry['heel'] ?? 1)).toBeLessThan(0.05);
  });

  it('keeps boats from overlapping', () => {
    const world = new SimWorld(
      flatConfig([
        { id: 'player', kind: 'pwc', x: 0, z: 0, heading: 0 },
        { id: 'b', kind: 'pwc', x: 0.8, z: 0, heading: 0 },
      ]),
      flatOcean,
    );
    world.boat('b')!.setAutopilot({ mode: 'drift' });
    const s = advance(world, 1);
    const [a, b] = s.boats;
    const gap = Math.hypot(
      (a?.position.x ?? 0) - (b?.position.x ?? 0),
      (a?.position.z ?? 0) - (b?.position.z ?? 0),
    );
    expect(gap).toBeGreaterThan(1.1);
  });

  it('fleet boats follow the player on autopilot', () => {
    const world = new SimWorld(
      flatConfig([
        { id: 'player', kind: 'powerboat', x: 0, z: 0, heading: 0 },
        { id: 'f', kind: 'powerboat', x: 40, z: 0, heading: 0 },
      ]),
      flatOcean,
    );
    const helm = { ...neutralControls(), throttle: 0.6 };
    const s = advance(world, 30, { player: helm });
    const [player, follower] = s.boats;
    expect(follower?.telemetry['autopilot']).toBe(3);
    // Kept up: still close after 30 s at speed.
    expect(Math.abs((follower?.position.z ?? 0) - (player?.position.z ?? 0))).toBeLessThan(150);
    expect(-(follower?.velocity.z ?? 0)).toBeGreaterThan(5);
  }, 30_000);
});

describe('bow thrusters', () => {
  // Heading change (rad) after `seconds` at rest in calm water with the bow thruster hard to starboard.
  const thrusterTurn = (kind: 'cargo' | 'crab', mode: SimConfig['physicsMode'], seconds: number) => {
    const world = new SimWorld(flatConfig([{ id: 'player', kind, x: 0, z: 0, heading: 0 }], mode), flatOcean);
    advance(world, seconds, { player: { ...neutralControls(), thruster: 1 } });
    return signedAngle(
      world.boat('player')!.pilotState({ heading: 0, speed: 0, yawRate: 0, x: 0, z: 0 }).heading,
    );
  };

  it('turn the bow to starboard, and Arcade ships turn on them about three times as fast', () => {
    const realistic = thrusterTurn('cargo', 'realistic', 30);
    const arcade = thrusterTurn('cargo', 'arcade', 30);
    expect(realistic).toBeGreaterThan(0);
    expect(arcade).toBeGreaterThan(2.5 * realistic);
    // Arcade: about 0.5°/s for the container ship (90° in ~3 min); Realistic ~0.2°/s once spooled.
    expect(arcade / 30).toBeGreaterThan(0.4 * DEG_);
  }, 60_000);
});

describe('SimWorld live conditions', () => {
  const calm: SimConfig = { ...config, boats: [], wind: { speed: 5, from: 0.3, gustFactor: 1 } };
  const rough: SimConfig = { ...calm, wind: { speed: 15, from: 0.9, gustFactor: 1.3 } };
  const change = (to: SimConfig, sea = 4): SimCommand => ({
    type: 'setConditions',
    wind: to.wind,
    seaState: to.seaState,
    windTransition: 2,
    seaTransition: sea,
  });
  const heightAt = (world: SimWorld, t: number): number =>
    (world.oceanField as OceanSurface).displacementAt(13, -7, t, { x: 0, y: 0, z: 0 }).y;

  it('rebuilds the spectrum with the same phases as the next version, a little ahead', () => {
    const world = new SimWorld(calm);
    const before = world.spectrum!;
    world.spectrum = null;
    advance(world, 1, {}, [change(rough)]);
    const next = world.spectrum!;
    expect(next.version).toBe(before.version + 1);
    expect(next.activationTime).toBeCloseTo(SPECTRUM_LEAD, 9); // the command ran at t = 0
    expect(next.transitionDuration).toBe(4);
    expect(next.significantHeight).toBeGreaterThan(2 * before.significantHeight);
    // It names the wind it was built for (the renderer's foam follows the crossfade to it).
    expect(before.wind).toEqual(calm.wind);
    expect(next.wind).toEqual(rough.wind);
    // Same random phases: each mode's new amplitude is a positive multiple of its old one.
    let compared = 0;
    next.cascades.forEach((cascade, c) => {
      const old = before.cascades[c]!.h0;
      for (let i = 0; i < cascade.h0.length; i += 4) {
        const [ar, ai, br, bi] = [old[i]!, old[i + 1]!, cascade.h0[i]!, cascade.h0[i + 1]!];
        const a = Math.hypot(ar, ai);
        const b = Math.hypot(br, bi);
        if (a < 1e-6 || b < 1e-6) continue;
        expect(Math.abs(ar * bi - ai * br) / (a * b)).toBeLessThan(1e-4);
        expect(ar * br + ai * bi).toBeGreaterThan(0);
        compared++;
      }
    });
    expect(compared).toBeGreaterThan(1000);
  });

  it('crossfades the physics sea from the old spectrum to the new one', () => {
    const world = new SimWorld(calm);
    const old = new SimWorld(calm);
    const target = new SimWorld(rough);
    advance(world, 1, {}, [change(rough, 4)]);
    const start = SPECTRUM_LEAD;
    // Before the activation time the sea is still the old one…
    const early = start - 0.1;
    expect(heightAt(world, early)).toBeCloseTo(heightAt(old, early), 5);
    // …part-way it is the blend (on a 60 Hz sample time, where the CPU field is exact)…
    const mid = Math.round((start + 1.5) * 60) / 60;
    const w = transitionBlend(start, 4, mid);
    expect(w).toBeGreaterThan(0.1);
    expect(w).toBeLessThan(0.9);
    const blended = heightAt(old, mid) + (heightAt(target, mid) - heightAt(old, mid)) * w;
    expect(heightAt(world, mid)).toBeCloseTo(blended, 5);
    // …and afterwards it is exactly the new sea.
    const late = start + 4.5;
    expect(heightAt(world, late)).toBeCloseTo(heightAt(target, late), 5);
    const probe = (w: SimWorld): number =>
      w.advance({
        type: 'advance',
        targetTime: 6,
        controls: {},
        commands: [],
        probes: new Float64Array([3, 4]),
      }).probes[0]!;
    expect(probe(world)).toBeCloseTo(probe(target), 4);
  });

  it('blends the wind to the new one, the short way round', () => {
    const world = new SimWorld({ ...calm, wind: { speed: 5, from: 6, gustFactor: 1 } }, flatOcean);
    advance(world, 0.5, {}, [change({ ...rough, wind: { speed: 15, from: 0.2, gustFactor: 1.3 } })]);
    const mid = world.windNow;
    expect(mid.speed).toBeGreaterThan(5);
    expect(mid.speed).toBeLessThan(15);
    expect(mid.from).toBeGreaterThan(6); // veering through north, not back round through south
    advance(world, 3);
    expect(world.windNow.speed).toBe(15);
    expect(world.windNow.gustFactor).toBe(1.3);
  });
});

describe('SimWorld fleet changes', () => {
  const two = (): SimWorld =>
    new SimWorld(
      flatConfig([
        { id: 'player', kind: 'powerboat', x: 0, z: 0, heading: 0 },
        { id: 'fleet-1', kind: 'pwc', x: -40, z: 0, heading: 0 },
      ]),
      flatOcean,
    );
  const helm = { player: { ...neutralControls(), throttle: 0.6 } };

  it('spawns a boat that keeps station on the player, and ignores a duplicate id', () => {
    const world = two();
    const spawn: SimCommand = {
      type: 'spawnBoat',
      spawn: { id: 'fleet-2', kind: 'sail', x: 45, z: 0, heading: 0 },
    };
    const s = advance(world, 0.5, helm, [spawn, spawn]);
    expect(s.boats.map((b) => b.id)).toEqual(['player', 'fleet-1', 'fleet-2']);
    expect(world.boats).toHaveLength(3);
    const setting = world.boat('fleet-2')?.autopilot?.setting;
    expect(setting?.mode).toBe('follow');
    expect(setting?.offsetStarboard).toBeCloseTo(45, 0);
    expect(Math.abs(setting?.offsetForward ?? 99)).toBeLessThan(1);
    expect(world.wakes?.field.wakes).toHaveLength(3);
  });

  it('a boat joining a moving player starts at its speed', () => {
    const world = two();
    const before = advance(world, 6, helm);
    const playerSpeed = -(before.boats[0]?.velocity.z ?? 0);
    expect(playerSpeed).toBeGreaterThan(3);
    const s = advance(world, 6.1, helm, [
      { type: 'spawnBoat', spawn: { id: 'fleet-2', kind: 'powerboat', x: 45, z: -20, heading: 0 } },
    ]);
    const joined = s.boats.find((b) => b.id === 'fleet-2')!;
    expect(-joined.velocity.z).toBeGreaterThan(0.7 * playerSpeed);
  });

  it('follow without a station keeps station from where the boat is', () => {
    const world = two();
    advance(world, 2, helm);
    advance(world, 2.1, helm, [{ type: 'setAutopilot', boatId: 'fleet-1', autopilot: { mode: 'follow' } }]);
    const setting = world.boat('fleet-1')?.autopilot?.setting;
    expect(setting?.mode).toBe('follow');
    // Its current offset from the player, not a station on top of it.
    expect(Math.hypot(setting?.offsetForward ?? 0, setting?.offsetStarboard ?? 0)).toBeGreaterThan(10);
  });

  it('removes a boat with its wake grid, and the rest sail on', () => {
    const world = two();
    advance(world, 4, helm);
    const s = advance(world, 4.5, helm, [{ type: 'removeBoat', boatId: 'fleet-1' }]);
    expect(s.boats.map((b) => b.id)).toEqual(['player']);
    expect(world.boat('fleet-1')).toBeUndefined();
    expect(world.wakes?.field.wakes).toHaveLength(1);
    expect(world.wakes?.grid('fleet-1')).toBeUndefined();
    expect(-(s.boats[0]?.velocity.z ?? 0)).toBeGreaterThan(3);
    // Removing it again, or a boat that never existed, is harmless.
    advance(world, 5, helm, [
      { type: 'removeBoat', boatId: 'fleet-1' },
      { type: 'removeBoat', boatId: 'nobody' },
    ]);
    expect(world.boats).toHaveLength(1);
  });

  it('tells the renderer to free a removed boat’s wake grid, once', () => {
    const world = two();
    advance(world, 1, helm);
    const first = world.advance({
      type: 'advance',
      targetTime: 1.1,
      controls: helm,
      commands: [{ type: 'removeBoat', boatId: 'fleet-1' }],
      probes: new Float64Array(),
    });
    expect(first.wakes?.find((g) => g.boatId === 'fleet-1')?.height).toHaveLength(0);
    const second = world.advance({
      type: 'advance',
      targetTime: 1.2,
      controls: helm,
      commands: [],
      probes: new Float64Array(),
    });
    expect(second.wakes?.some((g) => g.boatId === 'fleet-1')).toBe(false);
  });

  it('publishes wake grids into the buffers the renderer sent back', () => {
    const world = two();
    const request = (targetTime: number, spent?: ArrayBuffer[]) =>
      world.advance({
        type: 'advance',
        targetTime,
        controls: helm,
        commands: [],
        probes: new Float64Array(),
        spent,
      });
    // Under way, until a snapshot carries grids.
    let spent: ArrayBuffer[] = [];
    for (let t = 2; spent.length === 0 && t < 4; t += 0.1) {
      const grids = request(t).wakes ?? [];
      spent = grids.filter((g) => g.height.length > 0).map((g) => g.height.buffer as ArrayBuffer);
    }
    expect(spent.length).toBeGreaterThan(0);
    const returned = [...spent];
    let reused: WakeGrid[] = [];
    for (let t = 4; reused.length === 0 && t < 6; t += 0.1) {
      reused = (request(t, spent.splice(0)).wakes ?? []).filter((g) => g.height.length > 0);
    }
    expect(reused.length).toBeGreaterThan(0);
    expect(reused.every((g) => returned.includes(g.height.buffer as ArrayBuffer))).toBe(true);
  });

  it('keeps a spawned boat from overlapping the one it lands on', () => {
    const world = two();
    world.boat('fleet-1')!.setAutopilot({ mode: 'drift' });
    const s = advance(world, 1, {}, [
      { type: 'spawnBoat', spawn: { id: 'fleet-2', kind: 'pwc', x: -39.2, z: 0, heading: 0 } },
      { type: 'setAutopilot', boatId: 'fleet-2', autopilot: { mode: 'drift' } },
    ]);
    const a = s.boats.find((b) => b.id === 'fleet-1')!;
    const b = s.boats.find((b) => b.id === 'fleet-2')!;
    expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeGreaterThan(1.1);
  });

  it('boats following a removed player hold their course instead', () => {
    const world = two();
    advance(world, 1, helm, [{ type: 'removeBoat', boatId: 'player' }]);
    expect(world.boat('fleet-1')?.autopilot?.setting.mode).toBe('hold');
    const s = advance(world, 2);
    expect(s.boats.every((b) => Number.isFinite(b.position.x))).toBe(true);
  });

  // The App takes the helm of fleet-1 (the boat it leaves holds its course).
  const takeHelmOfFleet1: SimCommand[] = [
    { type: 'setAutopilot', boatId: 'player', autopilot: { mode: 'hold' } },
    { type: 'setAutopilot', boatId: 'fleet-1', autopilot: null },
  ];
  const helmFleet1 = { 'fleet-1': { ...neutralControls(), throttle: 0.6 } };

  it('leads the fleet from the helm boat: the one the controls are for', () => {
    const world = two();
    expect(world.leaderId).toBe('player');
    advance(world, 0.5, helmFleet1, takeHelmOfFleet1);
    expect(world.leaderId).toBe('fleet-1');
    advance(world, 1, helmFleet1, [{ type: 'removeBoat', boatId: 'player' }]);
    expect(world.leaderId).toBe('fleet-1');
    // An empty controls record (no helm this frame) keeps the last helm boat.
    advance(world, 1.1, {});
    expect(world.leaderId).toBe('fleet-1');
  });

  it('a boat added after the player is removed keeps station on the helm boat', () => {
    const world = two();
    advance(world, 6, helmFleet1, takeHelmOfFleet1);
    advance(world, 6.5, helmFleet1, [{ type: 'removeBoat', boatId: 'player' }]);
    const leader = world.boat('fleet-1')!.pilotState({ heading: 0, speed: 0, yawRate: 0, x: 0, z: 0 });
    expect(leader.speed).toBeGreaterThan(3);
    const spawn = { id: 'fleet-2', kind: 'powerboat' as const, x: leader.x + 40, z: leader.z, heading: 0 };
    const s = advance(world, 7, helmFleet1, [{ type: 'spawnBoat', spawn }]);
    const setting = world.boat('fleet-2')?.autopilot?.setting;
    expect(setting?.mode).toBe('follow');
    expect(setting?.targetId).toBe('fleet-1');
    expect(setting?.offsetStarboard).toBeCloseTo(40, 0);
    // It joined at the leader's speed and keeps up with it instead of drifting.
    expect(-(s.boats.find((b) => b.id === 'fleet-2')?.velocity.z ?? 0)).toBeGreaterThan(0.7 * leader.speed);
    const later = advance(world, 25, helmFleet1);
    const a = later.boats.find((b) => b.id === 'fleet-1')!;
    const b = later.boats.find((b) => b.id === 'fleet-2')!;
    expect(Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)).toBeLessThan(120);
    expect(-b.velocity.z).toBeGreaterThan(3);
  }, 30_000);

  it('a spawned boat keeps station on the leader it was given', () => {
    const world = two();
    advance(world, 0.5, helm, [
      {
        type: 'spawnBoat',
        spawn: { id: 'fleet-2', kind: 'pwc', x: -40, z: 30, heading: 0 },
        leaderId: 'fleet-1',
      },
    ]);
    const setting = world.boat('fleet-2')?.autopilot?.setting;
    expect(setting?.targetId).toBe('fleet-1');
    expect(setting?.offsetForward).toBeCloseTo(-30, 0);
  });

  it('followers of a removed boat re-target the helm boat from where they are', () => {
    const world = new SimWorld(
      flatConfig([
        { id: 'player', kind: 'powerboat', x: 0, z: 0, heading: 0 },
        { id: 'fleet-1', kind: 'pwc', x: -40, z: 0, heading: 0 },
        { id: 'fleet-2', kind: 'pwc', x: 40, z: 0, heading: 0 },
      ]),
      flatOcean,
    );
    expect(world.boat('fleet-2')?.autopilot?.setting.targetId).toBe('player');
    advance(world, 0.5, helmFleet1, takeHelmOfFleet1);
    advance(world, 1, helmFleet1, [{ type: 'removeBoat', boatId: 'player' }]);
    const setting = world.boat('fleet-2')?.autopilot?.setting;
    expect(setting?.mode).toBe('follow');
    expect(setting?.targetId).toBe('fleet-1');
    // Its station is where it was relative to the new leader: ~80 m to starboard.
    expect(setting?.offsetStarboard).toBeGreaterThan(70);
  });
});

describe('collision events', () => {
  it('reports an impact once, with the impulse and a contact point between the hulls', () => {
    const world = new SimWorld(
      flatConfig([
        { id: 'player', kind: 'pwc', x: 0, z: 0, heading: 0 },
        { id: 'b', kind: 'pwc', x: 0, z: -14, heading: Math.PI / 2 },
      ]),
      flatOcean,
    );
    world.boat('b')!.setAutopilot({ mode: 'drift' });
    const helm = { ...neutralControls(), throttle: 1 };
    const s = advance(world, 4, { player: helm });
    const hits = s.events.filter((e) => e.type === 'collision');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.length).toBeLessThanOrEqual(3); // one impact, not a report per step of contact
    const hit = hits[0]!;
    if (hit.type !== 'collision') throw new Error('unreachable');
    expect([hit.boatId, hit.otherId].sort()).toEqual(['b', 'player']);
    expect(hit.speed).toBeGreaterThan(2);
    expect(hit.impulse).toBeGreaterThan(100); // N·s: a few hundred kg changing speed by metres per second
    expect(hit.z).toBeLessThan(-8);
    expect(hit.z).toBeGreaterThan(-16);
    expect(Math.abs(hit.x)).toBeLessThan(2);
  });

  it('stays quiet for boats lying apart', () => {
    const world = new SimWorld(
      flatConfig([
        { id: 'player', kind: 'pwc', x: 0, z: 0, heading: 0 },
        { id: 'b', kind: 'pwc', x: 20, z: 0, heading: 0 },
      ]),
      flatOcean,
    );
    world.boat('b')!.setAutopilot({ mode: 'drift' });
    expect(advance(world, 2).events.some((e) => e.type === 'collision')).toBe(false);
  });
});

describe('sailboat wind-angle autopilot', () => {
  it('holds a true wind angle on its tack with the sails auto-trimmed, through a mode change', () => {
    const world = new SimWorld(
      {
        ...config,
        wind: { speed: 7, from: 0, gustFactor: 1 },
        boats: [{ id: 'player', kind: 'sail', x: 0, z: 0, heading: Math.PI / 2 }],
        wakes: false,
      },
      flatOcean,
    );
    const twa = -60 * DEG_; // wind from port: heading 060°
    world.command({ type: 'setAutopilot', boatId: 'player', autopilot: { mode: 'windAngle', twa } });
    let t = advance(world, 15).boats[0]!.telemetry;
    expect(t['autopilot']).toBe(5);
    expect(t['sail.autoTrim']).toBe(1);
    expect(Math.abs((t['sail.twa'] ?? 0) - twa)).toBeLessThan(5 * DEG_);
    expect(t['speedThroughWater']).toBeGreaterThan(3);
    // Realistic resets auto-trim to manual, except while the autopilot is holding the angle.
    t = advance(world, 35, {}, [{ type: 'setPhysicsMode', mode: 'realistic' }]).boats[0]!.telemetry;
    expect(t['sail.autoTrim']).toBe(1);
    expect(Math.abs((t['sail.twa'] ?? 0) - twa)).toBeLessThan(6 * DEG_);
    expect(t['speedThroughWater']).toBeGreaterThan(3);
  });

  it('keeps a requested angle out of irons, on the same tack', () => {
    expect(holdableWindAngle(10 * DEG_)).toBeCloseTo(MIN_WIND_ANGLE);
    expect(holdableWindAngle(-5 * DEG_)).toBeCloseTo(-MIN_WIND_ANGLE);
    expect(holdableWindAngle(-179 * DEG_)).toBeCloseTo(-MAX_WIND_ANGLE);
    expect(holdableWindAngle(-90 * DEG_)).toBeCloseTo(-90 * DEG_);
  });

  it('keeps a sailboat holding or following a course out of irons and off a dead run, on its tack', () => {
    // Wind from the north. Head to wind from 300° (wind on the starboard bow) and from 60° (port).
    const near = (a: number, b: number): void => expect(signedAngle(a - b)).toBeCloseTo(0);
    near(sailableHeading(0, 0, 300 * DEG_), -MIN_WIND_ANGLE);
    near(sailableHeading(0, 0, 60 * DEG_), MIN_WIND_ANGLE);
    // Dead downwind from 200° (starboard gybe): held 10° short of the run on that gybe.
    near(sailableHeading(0, Math.PI, 200 * DEG_), -MAX_WIND_ANGLE);
    // A reach is sailable as asked.
    near(sailableHeading(0, 90 * DEG_, 300 * DEG_), 90 * DEG_);
  });
});

describe('spawn setup', () => {
  // Wind from the north, a sailboat heading west: the wind on its starboard beam.
  const spawnWorld = (mode: 'arcade' | 'realistic'): SimWorld =>
    new SimWorld(
      {
        ...config,
        physicsMode: mode,
        wakes: false,
        boats: [
          {
            id: 's',
            kind: 'sail',
            x: 0,
            z: 0,
            heading: 270 * DEG_,
            speed: 2,
            sail: { reef: 2, furl: 2 / 3, mainSheet: 35 * DEG_, jibSheet: 30 * DEG_ },
          },
        ],
      },
      flatOcean,
    );

  for (const mode of ['arcade', 'realistic'] as const) {
    it(`(${mode}) starts the sailboat with way on, reefed, furled and sheeted out to leeward`, () => {
      const t = spawnWorld(mode).advance({
        type: 'advance',
        targetTime: MASTER_STEP,
        controls: { s: neutralControls() },
        commands: [],
        probes: new Float64Array(),
      }).boats[0]!.telemetry;
      // Already set, not animating toward it: the HUD and the reef / furl keys start from here.
      expect(t['sail.reef']).toBe(2);
      expect(t['sail.reefProgress']).toBe(2);
      expect(t['sail.jibFurl']).toBeCloseTo(2 / 3);
      expect(t['sail.mainSheet']).toBeCloseTo(35 * DEG_, 1);
      // Wind from starboard: the boom is out to port. Auto-trim as the mode has it.
      expect(t['sail.boomAngle']).toBeLessThan(-20 * DEG_);
      expect(t['sail.autoTrim']).toBe(mode === 'arcade' ? 1 : 0);
      expect(t['speedThroughWater']).toBeGreaterThan(1.8);
    });
  }
});
