// Fits the sun/moon's cascaded shadows to the boats in view. Pure TS (no three.js).
//
// CSMShadowNode covers the view frustum out to `maxFar` (view depth), with the last cascade fading
// out over its final quarter, and puts each cascade's light camera `lightMargin` metres toward the
// light from its slice. A fixed 600 m / 300 m suits small boats but clips the big ships: from the
// chase camera a container ship's bow is ~430 m deep, its shadow at a low sun reaches hundreds of
// metres further (into the fade, then past maxFar), the drone hovers 535–700 m above them, and a
// 60 m superstructure at a 10° sun sits 350 m toward the light from its shadow, beyond the margin.
// So each frame the shadow distance stretches to the farthest visible shadow footprint of the
// helm boat (and of fleet boats starting within the normal range), in coarse steps so the
// cascades don't shimmer, and the light margin and depth range grow with caster height / sin(sun
// elevation). Small boats never need more than the base distance, so they keep the crisp default.

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

// A boat as a shadow caster: a vertical cylinder from its waterline up to its highest point.
export interface ShadowCaster {
  x: number; // m, world, centre at the waterline
  y: number;
  z: number;
  radius: number; // m, horizontal (half the diagonal of length × beam)
  height: number; // m, highest point above the waterline
  helm?: boolean; // the player's boat: always fitted
}

// The rendering camera: unit basis vectors (world) and the frustum half-angle tangents.
export interface ShadowView {
  position: Vec3Like;
  forward: Vec3Like;
  right: Vec3Like;
  up: Vec3Like;
  tanHalfV: number;
  tanHalfH: number;
}

export interface ShadowFitOptions {
  baseFar: number; // m, the quality's shadow distance (also the minimum)
  maxFar: number; // m, the most the distance may stretch to
  maxShadowLength: number; // m, longest shadow fitted (sun near the horizon)
  baseMargin: number; // m, light margin with no tall casters
}

export const SHADOW_FIT_DEFAULTS: Omit<ShadowFitOptions, 'baseFar'> = {
  maxFar: 6000,
  maxShadowLength: 1500,
  baseMargin: 300,
};

// CSMShadowNode (fade on) fades the last cascade out over the last quarter of maxFar.
export const SHADOW_FADE_START = 0.75;
// Shadow distances step in multiples of this (m), so the cascades rarely resize.
const SHADOW_FAR_STEP = 100;
const MIN_SIN_ELEVATION = Math.sin((2 * Math.PI) / 180);
const HEIGHT_PAD = 8; // m, above the model's highest point: heel, heave, masts swinging
const DEPTH_PAD = 15; // m

const dot = (a: Vec3Like, b: Vec3Like): number => a.x * b.x + a.y * b.y + a.z * b.z;

// Horizontal offset (m) from a caster's base to the shadow of its top on the water (the shadow
// points away from the light), its length clamped to maxLength. toLight: unit vector toward the
// light. Zero with the light at or below the horizon.
export function shadowOffset(height: number, toLight: Vec3Like, maxLength: number): { x: number; z: number } {
  const horizontal = Math.hypot(toLight.x, toLight.z);
  if (toLight.y <= 0 || horizontal < 1e-9) return { x: 0, z: 0 };
  const length = Math.min(maxLength, (height * horizontal) / toLight.y);
  return { x: (-toLight.x / horizontal) * length, z: (-toLight.z / horizontal) * length };
}

// Is a sphere (centre c, radius r) at least partly inside the view frustum (no far plane)?
export function sphereInView(view: ShadowView, c: Vec3Like, r: number): boolean {
  const d = { x: c.x - view.position.x, y: c.y - view.position.y, z: c.z - view.position.z };
  const depth = dot(d, view.forward);
  const x = dot(d, view.right);
  const y = dot(d, view.up);
  if (depth < -r) return false;
  const kh = Math.hypot(1, view.tanHalfH);
  const kv = Math.hypot(1, view.tanHalfV);
  return Math.abs(x) - depth * view.tanHalfH <= r * kh && Math.abs(y) - depth * view.tanHalfV <= r * kv;
}

// Nearest and farthest view depth (m) of a caster's hull and its shadow footprint on the water,
// or null when none of it is in view. The footprint is the hull's disk swept along the shadow
// offset, so its extreme depths are at the two ends.
export function footprintDepthRange(
  view: ShadowView,
  toLight: Vec3Like,
  caster: ShadowCaster,
  maxShadowLength: number,
): { near: number; far: number } | null {
  const height = caster.height + HEIGHT_PAD;
  const offset = shadowOffset(height, toLight, maxShadowLength);
  const f = view.forward;
  const flat = Math.hypot(f.x, f.z); // a horizontal disk's depth reach per metre of radius
  const base = { x: caster.x, y: caster.y, z: caster.z };
  const tip = { x: caster.x + offset.x, y: caster.y, z: caster.z + offset.z };
  const length = Math.hypot(offset.x, offset.z);
  // The whole hull + shadow lies inside one sphere around its middle.
  const middle = { x: base.x + offset.x / 2, y: base.y + height / 2, z: base.z + offset.z / 2 };
  if (!sphereInView(view, middle, Math.hypot(length / 2 + caster.radius, height / 2))) return null;
  const depth = (p: Vec3Like): number =>
    (p.x - view.position.x) * f.x + (p.y - view.position.y) * f.y + (p.z - view.position.z) * f.z;
  const reach = caster.radius * flat;
  const vertical = height * f.y; // the hull's top is deeper than its base when looking up
  const baseDepth = depth(base);
  const tipDepth = depth(tip);
  return {
    near: Math.min(baseDepth + Math.min(0, vertical), tipDepth) - reach,
    far: Math.max(baseDepth + Math.max(0, vertical), tipDepth) + reach,
  };
}

// The shadow distance (CSM maxFar, m) that keeps every fitted footprint ahead of the last
// cascade's fade: the helm boat always, fleet boats whose footprint starts within the base
// distance's full-strength range (further ones never had a shadow to cut off). Unquantised.
export function fitShadowFar(
  view: ShadowView,
  toLight: Vec3Like,
  casters: readonly ShadowCaster[],
  options: ShadowFitOptions,
): number {
  if (toLight.y <= 0) return options.baseFar;
  let far = 0;
  const fullRange = options.baseFar * SHADOW_FADE_START;
  for (const caster of casters) {
    const range = footprintDepthRange(view, toLight, caster, options.maxShadowLength);
    if (!range || range.far <= 0) continue;
    if (!caster.helm && range.near > fullRange) continue;
    far = Math.max(far, range.far);
  }
  const needed = (far + DEPTH_PAD) / SHADOW_FADE_START;
  return Math.min(options.maxFar, Math.max(options.baseFar, needed));
}

// Steps the shadow distance: grows at once to the next multiple of `step`; shrinks only once the
// need has dropped two steps below, so the cascades don't resize back and forth.
export function quantizeShadowFar(needed: number, current: number, step = SHADOW_FAR_STEP): number {
  const target = Math.ceil(needed / step - 1e-9) * step;
  if (target >= current) return target;
  return target <= current - 2 * step ? target : current;
}

// How far toward the light (m) each cascade's light camera stands behind its view slice, so the
// tallest caster still shadows receivers at the slice's edge: the top of a caster of height h sits
// h / sin(elevation) toward the light from its shadow. Stepped to 100 m.
export function shadowLightMargin(
  tallest: number,
  toLight: Vec3Like,
  baseMargin: number,
  maxShadowLength: number,
): number {
  const height = tallest + HEIGHT_PAD;
  const sin = Math.max(MIN_SIN_ELEVATION, toLight.y);
  // Along the light ray: no further than the longest shadow fitted (plus the height itself).
  const reach = Math.min(height / sin, Math.hypot(maxShadowLength, height));
  return Math.max(baseMargin, Math.ceil((reach + 30) / 100) * 100);
}

// A cascade light camera's far plane (m): its margin plus the largest depth a view-frustum slice
// out to maxFar can span along any direction (the far plane's diagonal or apex-to-corner), plus slack.
export function cascadeDepthRange(
  margin: number,
  maxFar: number,
  tanHalfV: number,
  tanHalfH: number,
): number {
  const diagonal = Math.hypot(tanHalfV, tanHalfH);
  const span = Math.max(2 * diagonal, Math.hypot(1, diagonal));
  return Math.ceil(margin + maxFar * span + 100);
}

// Per-cascade depth bias (normalised orthographic depth) and normal bias (m). The base values hold
// at the base distance; both grow with the cascades' texel size (∝ maxFar), and the depth bias is
// re-expressed for the cascade's depth range so stretching it doesn't change the bias in metres.
export const DEPTH_BIAS_METRES = 0.032; // cascade 0 at the base distance (×(i + 1) further out)
export const NORMAL_BIAS = 0.02; // m at the base distance

export function cascadeBias(
  index: number,
  maxFar: number,
  baseFar: number,
  near: number,
  far: number,
): { bias: number; normalBias: number } {
  const scale = Math.max(1, maxFar / baseFar);
  return {
    bias: -(DEPTH_BIAS_METRES * (index + 1) * scale) / Math.max(1, far - near),
    normalBias: NORMAL_BIAS * scale,
  };
}
