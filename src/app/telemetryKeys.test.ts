// Every telemetry key the HUD, audio, light-signal and engineering-panel builders read must be one
// the simulation actually writes for that boat. Each boat runs briefly under way in the real
// SimWorld; the readers then get its telemetry through a proxy that records every lookup of a key
// the boat never wrote (a misspelt or missing key would otherwise read as a silent 0).

import { PerspectiveCamera } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { SimClock } from '../sim/astro/clock';
import { DEG } from '../sim/core/conventions';
import {
  BOAT_KINDS,
  type BoatKind,
  type BoatSnapshot,
  neutralControls,
  type SimConfig,
} from '../sim/world/protocol';
import { flatOcean, SimWorld } from '../sim/world/SimWorld';
import { telemetrySections } from '../ui/telemetry/TelemetryPanel';
import { AudioFrameBuilder, boatAudioState, engineRpmForAudio } from './audioFrame';
import { HudModelBuilder } from './hudModel';
import { autoSignals } from './lightSignals';
import { defaultScenario } from './Scenario';

// Keys documented as present only on boats that have the part (sim/world/telemetry.ts: "if it has
// one"); readers treat their absence as 0 on purpose.
const OPTIONAL = new Set(['deckWater', 'flooding', 'propEmersion']);

function written(kind: BoatKind): BoatSnapshot {
  const config: SimConfig = {
    seed: 1,
    physicsMode: 'arcade',
    boats: [{ id: 'player', kind, x: 0, z: 0, heading: 0 }],
    wind: { speed: 8, from: 45 * DEG, gustFactor: 1 },
    seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
    oceanQuality: 'low',
    wakes: false,
  };
  const world = new SimWorld(config, flatOcean);
  world.boat('player')?.prime(0.6); // engines already running (ships take minutes to spool up)
  const helm = { ...neutralControls(), throttle: 0.6, steer: 0.2 };
  let snapshot = world.advance({
    type: 'advance',
    targetTime: 0.5,
    controls: { player: helm },
    commands: [],
    probes: new Float64Array(),
  });
  snapshot = world.advance({
    type: 'advance',
    targetTime: 1,
    controls: { player: helm },
    commands: [],
    probes: new Float64Array(),
  });
  return snapshot.boats[0]!;
}

// The boat with its telemetry behind a recording proxy: reads of keys it lacks land in `missing`.
function recorded(boat: BoatSnapshot): { boat: BoatSnapshot; missing: Set<string> } {
  const missing = new Set<string>();
  const telemetry = new Proxy(boat.telemetry, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) missing.add(key);
      return Reflect.get(target, key);
    },
  });
  return { boat: { ...boat, telemetry }, missing };
}

function readAll(boat: BoatSnapshot): void {
  const camera = new PerspectiveCamera();
  new AudioFrameBuilder().build({
    camera,
    cameraMode: 'chase',
    playerKind: boat.kind,
    waterHeight: 0,
    choices: defaultScenario(),
    hs: 1,
    tp: 6,
    boats: [boat],
    simTime: 1,
  });
  const hud = new HudModelBuilder();
  for (let i = 0; i < 2; i++) {
    hud.build({
      boats: [boat],
      playerId: boat.id,
      dt: 1 / 60,
      choices: defaultScenario(),
      spectrum: null,
      clock: new SimClock({ date: '2026-07-15', timeOfDay: 12, longitude: 0 }),
      latitudeDeg: 45,
      longitudeDeg: 0,
      camera: 'Chase',
      device: 'keyboard',
      lights: { nav: true, deck: false, cabin: false, extra: false, signals: [] },
      alerts: [],
    });
  }
  autoSignals({ kind: boat.kind, speed: 1, telemetry: boat.telemetry, deckLights: true });
  telemetrySections(boat.kind, boat.telemetry);
}

describe('telemetry keys', () => {
  for (const kind of BOAT_KINDS) {
    it(`${kind}: every key the HUD, audio and panels read is written by the simulation`, () => {
      const { boat, missing } = recorded(written(kind));
      readAll(boat);
      const unwritten = [...missing].filter((key) => !OPTIONAL.has(key)).sort();
      expect(unwritten).toEqual([]);
    });
  }

  it('the engines report the rpm and load the engine sound needs', () => {
    for (const kind of ['cargo', 'cruise', 'crab', 'powerboat', 'pwc'] as const) {
      const t = written(kind).telemetry;
      expect(t['rpm'], kind).toBeGreaterThan(0);
      expect(t['load'], kind).toBeGreaterThan(0);
    }
  });
});

describe('engine sound mapping', () => {
  it("idles the crab boat's clutched diesel with the shaft stopped and reaches rated rpm with it", () => {
    expect(engineRpmForAudio('crab', { rpm: 0, maxRpm: 230 })).toBe(650);
    expect(engineRpmForAudio('crab', { rpm: 230, maxRpm: 230 })).toBe(1800);
    expect(engineRpmForAudio('cargo', { rpm: -60, maxRpm: 104 })).toBe(60); // direct drive, astern
  });

  it('feeds the sailboat its sail flogging and apparent wind', () => {
    const boat = written('sail');
    const state = boatAudioState({
      ...boat,
      telemetry: { ...boat.telemetry, 'sail.mainLuff': 0.2, 'sail.jibLuff': 0.7, 'sail.aws': 9 },
    });
    expect(state.luffing).toBe(0.7);
    expect(state.apparentWind).toBe(9);
    expect(state.rpm).toBe(0);
  });
});
