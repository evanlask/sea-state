// The audio engine's per-frame input. Plain structural types so the app can pass its own vectors
// (three.js Vector3 or sim Vec3) without conversion; nothing here is retained between frames.

import type { BoatKind } from '../sim/world/protocol';
import type { TurbineInput } from './turbine';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ListenerPose {
  position: Vec3Like; // world m
  forward: Vec3Like; // unit, where the camera looks
  up: Vec3Like; // unit
  velocity?: Vec3Like; // m/s; derived from position when omitted
}

export interface AudioEnvironment {
  enclosed: number; // 0..1, helm inside a closed bridge or cabin
  underwater: number; // 0..1, camera below the surface
}

export interface WindAudio {
  speed: number; // m/s at the listener (mean, or instantaneous if the caller has gusts)
  from?: number; // radians, meteorological "from"; pans the howl to windward
  gustFactor?: number; // peak gust / mean; >1 adds procedural gusts
}

export interface SeaAudio {
  hs: number; // significant wave height, m
  tp?: number; // peak period, s
}

export interface RainAudio {
  intensity: number; // 0..1
  deck: number; // 0..1, hard surface around the listener (deck, roof) vs open water
}

export interface BoatAudioState {
  id: string;
  kind: BoatKind;
  position: Vec3Like;
  velocity: Vec3Like;
  rpm: number; // engine (or pod) shaft rpm; ignored for the sailboat
  load: number; // 0..1 engine load
  speedThroughWater: number; // m/s
  luffing?: number; // 0..1 sailboat sail flogging
  airborne?: number; // 0..1 jet drive out of the water
  apparentWind?: number; // m/s at the rig
  motion?: number; // rad/s angular speed (roll/pitch), drives creaks
  turbine?: TurbineInput; // a gas turbine's state (the hydroplane), with its propeller's thrust
}

export interface AudioFrame {
  listener: ListenerPose;
  environment?: AudioEnvironment;
  wind: WindAudio;
  sea: SeaAudio;
  rain?: RainAudio;
  boats: readonly BoatAudioState[];
  simTime?: number; // lets thunder subtract time already elapsed since the flash
  aircraft?: readonly { position: Vec3Like; velocity: Vec3Like }[]; // jets high overhead (world m, m/s)
}
