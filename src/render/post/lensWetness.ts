// What wets the camera lens (external cameras) or the bridge windows (helm view of a ship with a
// wheelhouse), as numbers the drop simulation (lensDrops) takes in (pure, Node-testable):
//
//   rain       only reaches glass that faces into it (the drops' apparent motion toward the camera)
//   slams      hard slams near the camera land on the glass as splashes
//   green water  water coming aboard over a hull camera's mount splashes it
//   spray      a camera close to the water in a blow collects blown spume (fine beads) and is
//              washed by waves and bow spray (random splashes)

export type LensMode = 'lens' | 'window' | 'none';

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// Share of the falling rain that lands on the glass for a given facing: dot(camera forward,
// −apparent drop direction), 1 when the drops fly straight at the glass, 0 when they fall across
// it, −1 when the glass faces away from them.
export function rainExposure(mode: LensMode, facing: number): number {
  if (mode === 'none') return 0;
  const f = Math.max(-1, Math.min(1, facing));
  // Windows are vertical and sheltered by the roof overhang; a lens hood keeps some off too.
  const base = mode === 'window' ? 0.08 : 0.18;
  return base + (1 - base) * clamp01(f * 1.25 + 0.15);
}

export interface SprayHit {
  distance: number; // m from the camera
  strength: number; // slam impact speed, m/s (≈ 1 slap … 8 hard slam)
}

// Splash strength (0..1) from slams: a hard slam a few metres away soaks the lens; beyond ~25 m
// (and for light slaps) nothing reaches it.
export function sprayImpulse(hits: readonly SprayHit[]): number {
  let total = 0;
  for (const hit of hits) {
    const reach = 4 + 2.5 * Math.max(0, hit.strength); // m the sheet carries
    const falloff = clamp01(1 - Math.max(0, hit.distance) / reach);
    total += falloff * falloff * clamp01((hit.strength - 1) / 5) * 0.5;
  }
  return Math.min(1, total);
}

export interface AmbientSpray {
  spume: number; // 0..1 fine spray blown onto the glass
  wash: number; // 0..1 waves washing over it
}

// Steady spray for a camera near the water: blown spume above a near gale, and waves washing over
// a camera within a metre or so of the surface.
export function ambientSpray(heightAboveWater: number, windSpeed: number): AmbientSpray {
  const h = Math.max(0, heightAboveWater);
  const near = clamp01(1 - h / 6);
  return {
    spume: clamp01((windSpeed - 14) / 14) * near,
    wash: clamp01(1 - h / 1.2),
  };
}

// Bow spray reaching a camera `distance` m from the bow (0..1, from the bow spray's intensity):
// a hull camera at the stem is in it; a few metres off it misses.
export function bowSprayWash(intensity: number, distance: number): number {
  return clamp01(intensity) * clamp01(1 - Math.max(0, distance) / 5) ** 2;
}

// Green water: the rise in the deck reservoir (0..1 of its capacity) since the last splash, seen by
// a camera `distance` m from the boat's centre on a hull `length` m long and `height` m above the
// water. Returns a splash strength (0 while too little has come aboard to reach the camera, or for
// a camera high above the deck).
const GREEN_WATER_MIN_RISE = 0.02;
const GREEN_WATER_MAX_HEIGHT = 8; // m above the water
export function greenWaterSplash(rise: number, distance: number, length: number, height: number): number {
  if (rise < GREEN_WATER_MIN_RISE || height > GREEN_WATER_MAX_HEIGHT) return 0;
  const near = clamp01(1 - Math.max(0, distance) / (0.6 * length + 3));
  return clamp01(rise * 6) * near;
}

export interface LensSprayInputs {
  mode: LensMode;
  heightAboveWater: number; // m, of the camera
  windSpeed: number; // m/s
  slams: readonly SprayHit[];
  bowSpray: number; // 0..1 the helm boat's bow spray intensity
  distanceToBow: number; // m
  greenWater: number; // splash strength from greenWaterSplash
}

export interface LensSpray {
  spume: number; // 0..1
  wash: number; // 0..1
  splashes: number[]; // strengths landing this frame
}

// Everything but the rain that lands on the glass this frame. Bridge windows sit high, behind the
// house front: only slams close by and green water reach them, never spume, waves or bow spray.
export function lensSpray(input: LensSprayInputs, out: LensSpray): LensSpray {
  out.splashes.length = 0;
  out.spume = 0;
  out.wash = 0;
  if (input.mode === 'none') return out;
  const slam = sprayImpulse(input.slams);
  if (slam > 0.02) out.splashes.push(slam);
  if (input.greenWater > 0) out.splashes.push(input.greenWater);
  if (input.mode === 'window') return out;
  const ambient = ambientSpray(input.heightAboveWater, input.windSpeed);
  out.spume = ambient.spume;
  out.wash = Math.max(ambient.wash, bowSprayWash(input.bowSpray, input.distanceToBow));
  return out;
}

// Which glass the camera looks through: the bridge windows from the helm of a boat with a
// wheelhouse (beyond `windowDistance` m, so the console and frames stay dry), the lens of every
// external camera, and nothing from an open helm (the eye of a rider or a helmsman in the open).
export interface LensView {
  mode: LensMode;
  windowDistance: number; // m; 0 = the whole frame
}

const WHEELHOUSE_WINDOW: Readonly<Record<string, number>> = { cargo: 4, cruise: 4, crab: 2.4 };

// A person's eyes in the open (the bridge wings) get no droplets either.
const OPEN_EYE_MODES: ReadonlySet<string> = new Set(['bridge-port', 'bridge-starboard']);

export function lensViewFor(cameraMode: string, boatKind: string | undefined): LensView {
  if (OPEN_EYE_MODES.has(cameraMode)) return { mode: 'none', windowDistance: 0 };
  if (cameraMode !== 'helm') return { mode: 'lens', windowDistance: 0 };
  const glass = boatKind === undefined ? undefined : WHEELHOUSE_WINDOW[boatKind];
  return glass === undefined
    ? { mode: 'none', windowDistance: 0 }
    : { mode: 'window', windowDistance: glass };
}
