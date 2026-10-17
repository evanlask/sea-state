// align.json for a drop-in boat model (public/models/<kind>/align.json): how to turn the model's
// own frame into the body frame (x starboard, y up with 0 at the design waterline, bow −Z, origin
// on the centreline midway along the length). Pure math, so it is tested without a renderer.
//
//   p_body = scale · R · p_model + position
//
// R takes the model's bow and up axes onto −Z and +Y, then applies any extra rotation. The scale
// fits the rotated length to the LOA, and the position centres the model fore-and-aft and
// athwartships and sinks it to its draft.

import { Euler, Matrix4, Quaternion, Vector3 } from 'three/webgpu';

import type { LightKind, LightMountSpec } from '../kit/BoatVisual';

type Axis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z';

export interface BoatAlignSpec {
  forward?: Axis; // model axis the bow points along (default −Z, the body frame's)
  up?: Axis; // model up axis (default +Y; Z-up exports use '+Z')
  rotation?: [number, number, number]; // extra XYZ Euler rotation after forward/up, degrees
  loa?: number; // m: scale so the rotated length equals this (default the boat's LOA)
  scale?: number; // explicit uniform scale, model units → m; overrides loa
  draft?: number; // m from the model's lowest point up to the waterline (default the overall draft)
  waterline?: number; // or: waterline height in model units, after rotation; overrides draft
  offset?: [number, number, number]; // m, a final body-frame nudge
  eye?: [number, number, number]; // helm eye, body frame, m
  maskTop?: number; // m above the waterline the water mask reaches (default the freeboard)
  lights?: LightMountSpec[]; // body frame; nodes named light:<kind> or light:<mount> add to these
}

export interface AlignDefaults {
  loa: number;
  draft: number;
}

export interface Bounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface AlignTransform {
  quaternion: Quaternion;
  scale: number;
  position: Vector3;
}

const AXES: Record<Axis, [number, number, number]> = {
  '+X': [1, 0, 0],
  '-X': [-1, 0, 0],
  '+Y': [0, 1, 0],
  '-Y': [0, -1, 0],
  '+Z': [0, 0, 1],
  '-Z': [0, 0, -1],
};

const DEG = Math.PI / 180;

function isAxis(value: unknown): value is Axis {
  return typeof value === 'string' && value in AXES;
}

// Model → body rotation (before scaling).
export function alignRotation(spec: BoatAlignSpec): Quaternion {
  const forward = new Vector3(...AXES[spec.forward ?? '-Z']);
  const up = new Vector3(...AXES[spec.up ?? '+Y']);
  if (Math.abs(forward.dot(up)) > 0.5) throw new Error(`align.json: forward and up are the same axis`);
  // Body axes in model coordinates: starboard = bow × up, aft = −bow. The rotation maps them onto
  // +X, +Y, +Z, so it is the transpose of the basis matrix with them as columns.
  const starboard = new Vector3().crossVectors(forward, up);
  const aft = forward.clone().negate();
  const basis = new Matrix4().makeBasis(starboard, up, aft).transpose();
  const q = new Quaternion().setFromRotationMatrix(basis);
  if (spec.rotation) {
    const [x, y, z] = spec.rotation;
    q.premultiply(new Quaternion().setFromEuler(new Euler(x * DEG, y * DEG, z * DEG, 'XYZ')));
  }
  return q;
}

// `rotated` is the model's bounding box after alignRotation, in model units.
export function alignTransform(
  rotated: Bounds,
  spec: BoatAlignSpec,
  defaults: AlignDefaults,
): AlignTransform {
  const length = rotated.max.z - rotated.min.z;
  if (!(length > 0)) throw new Error('align.json: the model has no length along its bow axis');
  const scale = spec.scale ?? (spec.loa ?? defaults.loa) / length;
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error(`align.json: bad scale ${scale}`);
  const waterline = spec.waterline ?? rotated.min.y + (spec.draft ?? defaults.draft) / scale;
  const [dx, dy, dz] = spec.offset ?? [0, 0, 0];
  const position = new Vector3(
    -((rotated.min.x + rotated.max.x) / 2) * scale + dx,
    -waterline * scale + dy,
    -((rotated.min.z + rotated.max.z) / 2) * scale + dz,
  );
  return { quaternion: alignRotation(spec), scale, position };
}

export function toBody(transform: AlignTransform, point: Vector3, target = new Vector3()): Vector3 {
  return target
    .copy(point)
    .applyQuaternion(transform.quaternion)
    .multiplyScalar(transform.scale)
    .add(transform.position);
}

// Helm eye when align.json gives none: on the centreline, a little over half the model's height.
export function defaultEye(body: Bounds): Vector3 {
  const top = Math.max(body.max.y, 1);
  return new Vector3(0, Math.min(top, top * 0.55 + 1), (body.min.z + body.max.z) / 2);
}

// Light-marker node names: light:<kind>[:n] with a BoatVisual light kind (light:sidePort), or
// light:<mount>[:n] with the lights system's COLREG mount name (light:port).
const LIGHT_KINDS: readonly LightKind[] = [
  'mastheadForward',
  'mastheadAft',
  'sidePort',
  'sideStarboard',
  'stern',
  'allRoundWhite',
  'nucUpper',
  'nucLower',
  'anchorForward',
  'anchorAft',
  'fishingRed',
  'fishingWhite',
  'tricolour',
  'spreader',
  'deckFlood',
];

const MOUNT_KINDS: Record<string, LightKind> = {
  masthead: 'mastheadForward',
  'masthead-aft': 'mastheadAft',
  port: 'sidePort',
  starboard: 'sideStarboard',
  stern: 'stern',
  'signal-red-upper': 'nucUpper',
  'signal-red-lower': 'nucLower',
  'signal-white': 'fishingWhite',
  'anchor-forward': 'anchorForward',
  'anchor-aft': 'anchorAft',
  anchor: 'allRoundWhite',
  'stern-pole': 'allRoundWhite',
  accessory: 'allRoundWhite',
  flood: 'deckFlood',
};

export function markerKind(nodeName: string): LightKind | null {
  const match = /^light:([A-Za-z-]+)(?::\d+)?$/.exec(nodeName);
  if (!match) return null;
  const name = match[1]!;
  if ((LIGHT_KINDS as readonly string[]).includes(name)) return name as LightKind;
  return Object.hasOwn(MOUNT_KINDS, name) ? MOUNT_KINDS[name]! : null;
}

// Points for the water-mask hull: body-frame vertices from the keel up to height `top`,
// thinned to at most `maxPoints` (the convex hull only needs the outline).
export function maskPoints(positions: ArrayLike<number>, top: number, maxPoints = 20_000): number[] {
  const count = Math.floor(positions.length / 3);
  let below = 0;
  for (let i = 0; i < count; i++) if (positions[i * 3 + 1]! <= top) below++;
  const stride = Math.max(1, Math.ceil(below / maxPoints));
  const out: number[] = [];
  let k = 0;
  for (let i = 0; i < count; i++) {
    if (positions[i * 3 + 1]! > top) continue;
    if (k++ % stride === 0) out.push(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
  }
  return out;
}

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

// Parses align.json leniently: unknown keys are ignored, malformed ones throw with the key's name.
export function parseAlign(json: unknown): BoatAlignSpec {
  if (typeof json !== 'object' || json === null) throw new Error('align.json: expected an object');
  const raw = json as Record<string, unknown>;
  const spec: BoatAlignSpec = {};
  const num = (key: keyof BoatAlignSpec): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`align.json: ${key} must be a number`);
    return v;
  };
  const vec = (key: keyof BoatAlignSpec): [number, number, number] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
      throw new Error(`align.json: ${key} must be [x, y, z]`);
    return [v[0], v[1], v[2]] as [number, number, number];
  };
  for (const key of ['forward', 'up'] as const) {
    if (raw[key] === undefined) continue;
    if (!isAxis(raw[key]))
      throw new Error(`align.json: ${key} must be one of ${Object.keys(AXES).join(' ')}`);
    spec[key] = raw[key];
  }
  spec.rotation = vec('rotation');
  spec.offset = vec('offset');
  spec.eye = vec('eye');
  spec.loa = num('loa');
  spec.scale = num('scale');
  spec.draft = num('draft');
  spec.waterline = num('waterline');
  spec.maskTop = num('maskTop');
  if (raw.lights !== undefined) {
    if (!Array.isArray(raw.lights)) throw new Error('align.json: lights must be an array');
    spec.lights = raw.lights.map((light: unknown, i) => {
      const l = (typeof light === 'object' && light !== null ? light : {}) as Partial<LightMountSpec>;
      if (!l.kind || !(LIGHT_KINDS as readonly string[]).includes(l.kind) || !isVec3(l.position))
        throw new Error(`align.json: lights[${i}] needs a light kind and a position [x, y, z]`);
      if (l.direction !== undefined && !isVec3(l.direction))
        throw new Error(`align.json: lights[${i}].direction must be [x, y, z]`);
      return { kind: l.kind, position: l.position, direction: l.direction, name: l.name };
    });
  }
  for (const key of Object.keys(spec) as (keyof BoatAlignSpec)[])
    if (spec[key] === undefined) delete spec[key];
  return spec;
}
