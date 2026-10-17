// The jet ski rider going overboard when the ski capsizes: he slips off the seat into the water beside
// the hull, then sinks slowly, drifting and tumbling, relaxing into a limp pose, until he's deeper than
// the water lets anyone see (then he's gone and nothing updates him). Recover puts him back on the seat.
//
//   seated ──capsize──▶ falling ──reaches the surface──▶ sinking ──below GONE_DEPTH──▶ gone
//      ▲                                                                                │
//      └──────────────────────────────────── reset (recovered) ─────────────────────────┘
//
// After a reset the capsized flag must read upright once before it can throw him off again, so a stale
// snapshot from before the recovery doesn't. Pure numbers (world metres, y up), so it runs in tests; the
// skinned rider applies it in overboardRider.ts.

export type OverboardPhase = 'seated' | 'falling' | 'sinking' | 'gone';

export const OVERBOARD = {
  hop: 0.6, // m/s up as he slips off the seat
  throwOut: 1.2, // m/s away from the hull while falling
  carry: 0.5, // share of the boat's velocity he keeps
  gravity: 9.81, // m/s²
  maxFall: 1.2, // s: a fall that hasn't reached the surface (the boat was airborne) gives up
  entry: 0.3, // m: the hips this far under the surface end the fall
  sinkSpeed: 0.4, // m/s, the steady sink
  waterDrag: 1.5, // 1/s: the vertical speed's approach to the sink speed
  driftDrag: 0.5, // 1/s: the horizontal speed's approach to the drift
  drift: 0.08, // m/s: what's left of the carried speed once it's bled off (the current)
  goneDepth: 30, // m under the surface: well beyond the water's visibility, so he's out of view
  limpTime: 1.8, // s to relax from the riding pose into the limp one
  tumbleStart: 0.35, // rad/s, as he hits the water
  tumbleSettle: 0.1, // rad/s, the slow turn he keeps while sinking
  tumbleDecay: 0.5, // 1/s
};

interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface OverboardState {
  phase: OverboardPhase;
  armed: boolean; // a capsized flag may throw him off (not until it has read upright after a reset)
  time: number; // s since he went over
  phaseTime: number; // s in the current phase
  position: V3; // his hips, world
  velocity: V3; // m/s
  surface: number; // the water level he sinks from, world y
  drift: V3; // the steady drift, m/s (horizontal)
  axis: V3; // tumble axis, unit
}

export function createOverboard(): OverboardState {
  return {
    phase: 'seated',
    armed: true,
    time: 0,
    phaseTime: 0,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    surface: 0,
    drift: { x: 0, y: 0, z: 0 },
    axis: { x: 1, y: 0, z: 0 },
  };
}

// Whether the boat's capsized flag throws him off this frame (and arms it again once it reads upright).
export function wantsDetach(s: OverboardState, capsized: boolean): boolean {
  if (s.phase !== 'seated') return false;
  if (!capsized) {
    s.armed = true;
    return false;
  }
  return s.armed;
}

export interface DetachInput {
  hips: V3; // world position of his hips as he lets go
  boatVelocity: V3; // m/s
  away: { x: number; z: number }; // horizontal direction off the hull (any length; zero is fine)
  surface: number; // water level, world y
  seed: number; // 0..1, picks the tumble axis
}

export function detach(s: OverboardState, d: DetachInput): void {
  const len = Math.hypot(d.away.x, d.away.z);
  const ax = len > 1e-6 ? d.away.x / len : 1;
  const az = len > 1e-6 ? d.away.z / len : 0;
  const o = OVERBOARD;
  s.phase = d.hips.y > d.surface - o.entry ? 'falling' : 'sinking';
  s.time = 0;
  s.phaseTime = 0;
  s.position = { ...d.hips };
  s.velocity = {
    x: d.boatVelocity.x * o.carry + ax * o.throwOut,
    y: s.phase === 'falling' ? o.hop : Math.min(0, d.boatVelocity.y * o.carry),
    z: d.boatVelocity.z * o.carry + az * o.throwOut,
  };
  s.surface = d.surface;
  // Drifts on the way the boat was going (or off the hull when it was still).
  const vx = d.boatVelocity.x;
  const vz = d.boatVelocity.z;
  const speed = Math.hypot(vx, vz);
  s.drift =
    speed > 0.1
      ? { x: (vx / speed) * o.drift, y: 0, z: (vz / speed) * o.drift }
      : { x: ax * o.drift, y: 0, z: az * o.drift };
  // Mostly about a horizontal axis (head over heels and side over side), a little about the vertical.
  const a = d.seed * Math.PI * 2;
  const ay = 0.35;
  const n = Math.hypot(1, ay);
  s.axis = { x: Math.cos(a) / n, y: ay / n, z: Math.sin(a) / n };
}

export function resetOverboard(s: OverboardState): void {
  s.phase = 'seated';
  s.armed = false;
  s.time = 0;
  s.phaseTime = 0;
}

// Frame-rate independent approach of a speed to its target.
const toward = (v: number, target: number, rate: number, dt: number): number =>
  target + (v - target) * Math.exp(-rate * dt);

// Advances him by dt; returns the phase he's in after it.
export function stepOverboard(s: OverboardState, dt: number): OverboardPhase {
  if (s.phase === 'seated' || s.phase === 'gone' || dt <= 0) return s.phase;
  const o = OVERBOARD;
  s.time += dt;
  s.phaseTime += dt;
  const v = s.velocity;
  if (s.phase === 'falling') {
    v.y -= o.gravity * dt;
  } else {
    v.x = toward(v.x, s.drift.x, o.driftDrag, dt);
    v.z = toward(v.z, s.drift.z, o.driftDrag, dt);
    v.y = toward(v.y, -o.sinkSpeed, o.waterDrag, dt);
  }
  s.position.x += v.x * dt;
  s.position.y += v.y * dt;
  s.position.z += v.z * dt;
  if (s.phase === 'falling' && (s.position.y < s.surface - o.entry || s.phaseTime > o.maxFall)) {
    s.phase = 'sinking';
    s.phaseTime = 0;
    // The water takes most of the fall's speed at once.
    v.y *= 0.3;
    v.x *= 0.5;
    v.z *= 0.5;
  } else if (s.phase === 'sinking' && depth(s) > o.goneDepth) {
    s.phase = 'gone';
    s.phaseTime = 0;
  }
  return s.phase;
}

// Metres under the water level he went in at.
export const depth = (s: OverboardState): number => s.surface - s.position.y;

// 0 (riding pose) → 1 (limp), eased, over limpTime from going over.
export function limpWeight(s: OverboardState): number {
  if (s.phase === 'seated') return 0;
  const t = Math.min(1, s.time / OVERBOARD.limpTime);
  return t * t * (3 - 2 * t);
}

// The tumble's angular speed, rad/s: brisk as he hits the water, settling to a slow turn.
export function tumbleRate(s: OverboardState): number {
  if (s.phase === 'seated' || s.phase === 'gone') return 0;
  const o = OVERBOARD;
  return o.tumbleSettle + (o.tumbleStart - o.tumbleSettle) * Math.exp(-o.tumbleDecay * s.time);
}

// The limbs' slow sway in the water, −1..1 (a long, uneven period so it doesn't look mechanical).
export function limbSway(s: OverboardState): number {
  return 0.7 * Math.sin(s.time * 0.9) + 0.3 * Math.sin(s.time * 2.3 + 1);
}
