// Physics modes. Arcade (the default) keeps the boats' real top speeds, real
// floating and real capsizing, but compresses time for the controls: every
// control force (thrust, rudder, pods, thrusters) AND the matching horizontal
// resistance and damping are multiplied by a per-boat factor k, so a container
// ship speeds up, stops and turns in seconds instead of minutes while the
// balance (top speed, drift angle) is unchanged. The extra (k − 1) share acts
// at the CG height, so it adds no heel or trim. Realistic uses k = 1 with real
// rudder rates, engine load programmes and telegraph lags.

import type { BoatKind, PhysicsMode } from '../world/protocol';

export interface PhysicsTuning {
  mode: PhysicsMode;
  timeCompression: number; // k
  rudderRate: number | null; // rad/s; null keeps the boat's realistic rate
  engineRampTime: number | null; // s from Stop to Full; null keeps the boat's own
  reversalDelay: number | null; // s an engine needs to start the other way
  turnBoost: number; // extra steering force for tighter Arcade ship turns
  slamScale: number; // multiplies slamming forces
  windScale: number; // multiplies windage
  capsizeAssist: boolean; // gentle righting aid, off by default in both modes
}

// Arcade time-compression factor k per boat kind.
const ARCADE_TIME_COMPRESSION: Readonly<Record<BoatKind, number>> = {
  cargo: 10,
  cruise: 10,
  crab: 4,
  sail: 2,
  powerboat: 1.3,
  pwc: 1,
  hydro: 1,
};

const SHIPS: ReadonlySet<BoatKind> = new Set(['cargo', 'cruise', 'crab']);

export function physicsTuning(kind: BoatKind, mode: PhysicsMode, capsizeAssist = false): PhysicsTuning {
  if (mode === 'realistic') {
    return {
      mode,
      timeCompression: 1,
      rudderRate: null,
      engineRampTime: null,
      reversalDelay: null,
      turnBoost: 1,
      slamScale: 1,
      windScale: 1,
      capsizeAssist,
    };
  }
  const ship = SHIPS.has(kind);
  return {
    mode,
    timeCompression: ARCADE_TIME_COMPRESSION[kind],
    // Ships: hard over (35°) in ~3 s, engine Stop → Full in ~5 s.
    rudderRate: ship ? (35 / 3) * (Math.PI / 180) : null,
    engineRampTime: ship ? 5 : null,
    reversalDelay: ship ? 1 : null,
    // Tighter, quicker turns (~2 L tactical diameter, 90° in under 40 s for the ships).
    turnBoost: kind === 'cargo' || kind === 'cruise' ? 10 : kind === 'crab' ? 2.5 : 1,
    slamScale: 0.5,
    // The hydroplane flies: its own speed's air is its physics (drag, and the lift in hydroAero.ts).
    windScale: kind === 'hydro' ? 1 : 0.5,
    capsizeAssist,
  };
}

// Applies a horizontally time-compressed force: the real force at its real
// point, plus (k − 1) of its horizontal part at the same plan position but the
// CG's height, so the extra adds yaw moment only.
export interface ForceTarget {
  position: { x: number; y: number; z: number };
  addForceAtPointXYZ(fx: number, fy: number, fz: number, px: number, py: number, pz: number): void;
}

export function addCompressedForce(
  body: ForceTarget,
  k: number,
  fx: number,
  fy: number,
  fz: number,
  px: number,
  py: number,
  pz: number,
): void {
  body.addForceAtPointXYZ(fx, fy, fz, px, py, pz);
  if (k !== 1) {
    const e = k - 1;
    body.addForceAtPointXYZ(e * fx, 0, e * fz, px, body.position.y, pz);
  }
}
