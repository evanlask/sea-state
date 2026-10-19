// Uniforms shared by every boat material: the frame's pre-exposure (emissive
// surfaces are authored in cd/m² and must be pre-exposed like the sky and
// lights), how dark it is (bridge lighting dims for night vision), the light
// switches the game or lab toggles, and how wet the boats are.

import { type N, tsl } from '../../tsl';

const { uniform } = tsl;

export interface BoatEnvironment {
  preExposure: N; // Exposure.preExposure
  night: N; // 0 = day … 1 = full night (dims the bridge lighting, raises cabin occupancy)
  interior: N; // 0..1 accommodation/cabin/wheelhouse lights
  deck: N; // 0..1 deck floodlights (lens glow; real lights are driven by BoatVisual)
  wetness: N; // 0..1 rain and spray on the boats (wetness.ts): darker, glossier decks, streaky walls
}

export const boatEnvironment: BoatEnvironment = {
  preExposure: uniform(1),
  night: uniform(0),
  interior: uniform(1),
  deck: uniform(0),
  wetness: uniform(0),
};

export interface BoatEnvironmentState {
  preExposure: number;
  night: number;
  interior: number;
  deck: number;
  wetness: number;
}

export function setBoatEnvironment(state: Partial<BoatEnvironmentState>): void {
  for (const key of ['preExposure', 'night', 'interior', 'deck', 'wetness'] as const) {
    const value = state[key];
    if (value !== undefined) boatEnvironment[key].value = value;
  }
}

// Night factor from the sun's elevation (radians): 0 above +4°, 1 below −8°.
export function nightFactor(sunElevation: number): number {
  const deg = (sunElevation * 180) / Math.PI;
  const t = Math.min(1, Math.max(0, (4 - deg) / 12));
  return t * t * (3 - 2 * t);
}
