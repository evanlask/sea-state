// Builds the per-frame AudioFrame from the camera, the scenario and the interpolated boats.
// Objects are reused frame to frame (the engine copies what it needs).

import { Vector3, type PerspectiveCamera } from 'three/webgpu';

import { BOAT_AUDIO } from '../audio/boatProfiles';
import type { AudioFrame, BoatAudioState } from '../audio/types';
import type { SceneWeather } from '../render/SeaScene';
import { velocityToFromDirection } from '../sim/core/conventions';
import { SAIL_KEYS } from '../sim/sail/telemetry';
import type { BoatKind, BoatSnapshot } from '../sim/world/protocol';
import { type ScenarioChoices, sceneWeatherFor, windFor } from './scenarioConfig';

// Helm views inside a closed bridge or wheelhouse muffle the outside world.
const ENCLOSED_HELM: Readonly<Record<BoatKind, number>> = {
  cargo: 1,
  cruise: 1,
  crab: 0.85,
  sail: 0,
  powerboat: 0,
  pwc: 0,
  hydro: 0.5, // the cabover's closed canopy
};

// The engine note's rpm from the boat's telemetry (keys: sim/world/telemetry.ts). Ships and pods
// report shaft rpm: the cargo ship's slow-speed diesel drives its propeller directly (and stops at
// Stop), while the crab boat's geared, clutched diesel idles with the shaft stopped and reaches its
// rated crank speed with the shaft. The center console's outboards and the jet ski report crank rpm,
// the hydroplane its propeller's (its turbine's speeds come separately: boatAudioState).
export function engineRpmForAudio(kind: BoatKind, t: Readonly<Record<string, number>>): number {
  const rpm = Math.abs(t['rpm'] ?? 0);
  if (kind !== 'crab') return rpm;
  const engine = BOAT_AUDIO.crab.engine;
  const shaftMax = t['maxRpm'] ?? 0;
  if (!engine || shaftMax <= 0) return rpm;
  return engine.idleRpm + (engine.maxRpm - engine.idleRpm) * Math.min(1, rpm / shaftMax);
}

// One boat's audio state from its (interpolated) snapshot. Pure; `out` is reused. Engine keys are
// read only for boats with an engine, sail keys only for the sailboat.
export function boatAudioState(boat: BoatSnapshot, out?: BoatAudioState): BoatAudioState {
  const t = boat.telemetry;
  const profile = BOAT_AUDIO[boat.kind];
  const state = out ?? ({} as BoatAudioState);
  state.id = boat.id;
  state.kind = boat.kind;
  state.position = boat.position;
  state.velocity = boat.velocity;
  const powered = profile.engine !== null || profile.turbine !== undefined;
  state.rpm = powered ? engineRpmForAudio(boat.kind, t) : 0;
  state.load = powered ? Math.abs(t['load'] ?? 0) : 0;
  if (profile.turbine) {
    // The hydroplane's gas turbine and propeller (sim/physics/propulsion/surfaceProp.ts).
    const turbine = (state.turbine ??= {
      n1: 0,
      power: 0,
      turbineRpm: 0,
      propRpm: 0,
      thrust: 0,
      propEmersion: 0,
    });
    turbine.n1 = t['n1'] ?? 0;
    turbine.power = t['gasGenerator'] ?? 0;
    turbine.turbineRpm = t['turbineRpm'] ?? 0;
    turbine.propRpm = state.rpm;
    turbine.thrust = t['thrust'] ?? 0;
    turbine.propEmersion = t['propEmersion'] ?? 0;
  }
  state.speedThroughWater = t['speedThroughWater'] ?? Math.hypot(boat.velocity.x, boat.velocity.z);
  // The louder of the two sails flogging, and the apparent wind at the masthead.
  state.luffing = profile.rigging ? Math.max(t[SAIL_KEYS.mainLuff] ?? 0, t[SAIL_KEYS.jibLuff] ?? 0) : 0;
  state.apparentWind = profile.rigging ? (t[SAIL_KEYS.aws] ?? 0) : 0;
  state.airborne = t['airborne'] ?? 0;
  state.motion = Math.hypot(boat.angularVelocity.x, boat.angularVelocity.z);
  return state;
}

const forward = new Vector3();
const up = new Vector3();

export class AudioFrameBuilder {
  private frame: AudioFrame = {
    listener: { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
    environment: { enclosed: 0, underwater: 0 },
    wind: { speed: 0, from: 0, gustFactor: 1 },
    sea: { hs: 0, tp: 0 },
    rain: { intensity: 0, deck: 0 },
    boats: [],
  };
  private boats: BoatAudioState[] = [];

  build(options: {
    camera: PerspectiveCamera;
    cameraMode: string;
    playerKind: BoatKind;
    waterHeight: number;
    choices: ScenarioChoices;
    weather?: SceneWeather; // the renderer's (blending) weather; wind and rain follow it when given
    hs: number;
    tp: number;
    boats: readonly BoatSnapshot[];
    simTime: number;
    aircraft?: AudioFrame['aircraft']; // jets overhead (render/contrails)
  }): AudioFrame {
    const { camera, choices } = options;
    const frame = this.frame;
    const listener = frame.listener;
    listener.position = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
    camera.getWorldDirection(forward);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    listener.forward = { x: forward.x, y: forward.y, z: forward.z };
    listener.up = { x: up.x, y: up.y, z: up.z };

    const helm = options.cameraMode === 'helm';
    frame.environment = {
      enclosed: helm ? ENCLOSED_HELM[options.playerKind] : 0,
      underwater: camera.position.y < options.waterHeight - 0.05 ? 1 : 0,
    };
    const wind = windFor(choices);
    const weather = options.weather;
    frame.wind = weather
      ? {
          speed: Math.hypot(weather.windVelocity.x, weather.windVelocity.z),
          from: velocityToFromDirection(weather.windVelocity.x, weather.windVelocity.z),
          gustFactor: wind.gustFactor,
        }
      : { speed: wind.speed, from: wind.from, gustFactor: wind.gustFactor };
    frame.sea = { hs: options.hs, tp: options.tp };
    // Rain drums on the deck when you're aboard, hisses on the water when you're not.
    frame.rain = { intensity: (weather ?? sceneWeatherFor(choices)).precipitation, deck: helm ? 1 : 0 };
    frame.simTime = options.simTime;
    frame.aircraft = options.aircraft ?? [];

    this.boats.length = options.boats.length;
    options.boats.forEach((boat, i) => {
      this.boats[i] = boatAudioState(boat, this.boats[i]);
    });
    frame.boats = this.boats;
    return frame;
  }
}
