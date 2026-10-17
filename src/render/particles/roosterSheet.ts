// The hydroplane's rooster tail as a lit sheet of water: the far view the particles can't carry (a
// droplet a few hundred metres off is under a pixel), and the body of the wall up close, with the
// particles (emitters.ts HydroRoosterTail) for the detail on it. Built on the CPU every frame from
// the propeller's track over the last few seconds: each point of the track is the water thrown up
// there, rising fast behind the transom (most of its height within ~30 m at 200 mph), hanging, then
// raining back down, its top fanning out sideways. Two parts in one draw: a ribbon standing along the
// track (the wall seen from the side) and cards across it (the fan seen from astern or ahead), each
// fading as it turns edge-on. Streaky, lumpy, lit by the sun with the droplets' forward scattering.
// World frame, like the particles.

import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Mesh,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type Object3D,
  Group,
} from 'three/webgpu';

import { noiseTexture } from '../boats/kit/textures';
import { type N, tsl } from '../tsl';
import type { Vec3Like } from './emissionQueue';
import { type FxLighting, henyeyGreenstein } from './shading';

const {
  Fn,
  abs,
  attribute,
  cameraPosition,
  dot,
  float,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  saturate,
  select,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} = tsl;

export const SHEET_LIFE = 3.8; // s, how long the water thrown at a point of the track stays up
const SAMPLE_DT = 1 / 30; // s between track points
const SAMPLES = Math.ceil(SHEET_LIFE / SAMPLE_DT) + 2; // with the head (the propeller, now)
const CARD_EVERY = 3; // a card across the track every this many points
const CARDS = Math.ceil(SAMPLES / CARD_EVERY);
const RISE = 0.3; // s, the time constant of the climb
const HANG = 1.0; // s, then it rains down
const DRIFT = 0.1; // share of the boat's speed the water drifts aft over the ground (as the particles)
const FOOT = 0.3; // m, half-width of the fan at the water (it widens by 0.35 m per m up)

interface TailPoint {
  t: number; // s, the sheet clock when the water was thrown
  x: number;
  y: number; // the sea at the propeller
  z: number;
  fx: number; // the boat's heading (horizontal unit vector)
  fz: number;
  height: number; // m, how tall the water thrown here stands (roosterShape)
  speed: number; // m/s, the boat's speed
  s: number; // m along the track since the tail began (the streaks stay where the water is)
}

// Height of the water thrown `age` seconds ago up to `height`: a fast climb, a hang, and the fall.
export function sheetTop(height: number, age: number): number {
  if (age <= 0 || height <= 0) return 0;
  const rise = 1 - Math.exp(-age / RISE);
  const fallTime = 0.55 * Math.sqrt(height);
  const late = Math.max(0, age - HANG) / fallTime;
  return height * rise * Math.max(0, 1 - late * late);
}

// Opacity scale of a point of the track: faint for a small tail, fading in and out with its age.
function strengthOf(p: TailPoint, age: number): number {
  const tall = Math.min(1, p.height / 5);
  const fadeIn = Math.min(1, age / 0.08);
  const fadeOut = 1 - Math.min(1, Math.max(0, (age - (SHEET_LIFE - 1.2)) / 1.2));
  return tall * fadeIn * fadeOut;
}

class Tail {
  readonly points: TailPoint[] = []; // oldest first, the head last
  readonly mesh: Mesh;
  private positions: Float32Array;
  private data: Float32Array; // noise coordinate, height share, strength, kind (0 ribbon, 2 + lateral card)
  private normals: Float32Array;
  private head: TailPoint | null = null;
  lastActive = -Infinity; // the sheet clock when it last threw water

  constructor(material: NodeMaterial) {
    const vertices = SAMPLES * 2 + CARDS * 4;
    this.positions = new Float32Array(vertices * 3);
    this.data = new Float32Array(vertices * 4);
    this.normals = new Float32Array(vertices * 3);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(this.positions, 3));
    g.setAttribute('sheetData', new BufferAttribute(this.data, 4));
    g.setAttribute('sheetNormal', new BufferAttribute(this.normals, 3));
    const index: number[] = [];
    for (let i = 0; i + 1 < SAMPLES; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    for (let c = 0; c < CARDS; c++) {
      const a = SAMPLES * 2 + c * 4;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    g.setIndex(index);
    this.mesh = new Mesh(g, material);
    this.mesh.name = 'fx-rooster-sheet';
    this.mesh.frustumCulled = false; // rebuilt every frame, hundreds of metres long
    this.mesh.renderOrder = 9; // under the particles
    this.mesh.matrixAutoUpdate = false;
  }

  push(now: number, p: Omit<TailPoint, 't' | 's'>): void {
    const pts = this.points;
    const last = pts[pts.length - 1];
    const point: TailPoint = { ...p, t: now, s: last ? last.s + Math.hypot(p.x - last.x, p.z - last.z) : 0 };
    // The head follows the propeller every frame; a point stays behind every SAMPLE_DT.
    if (!last || now - last.t >= SAMPLE_DT) {
      pts.push(point);
      this.head = null;
      while (pts.length > SAMPLES - 1) pts.shift();
    } else {
      this.head = point;
    }
    if (p.height > 0.2) this.lastActive = now;
  }

  private at(k: number): TailPoint | undefined {
    // k = 0 the newest (the head when there is one), counting back.
    const pts = this.points;
    if (this.head) return k === 0 ? this.head : pts[pts.length - k];
    return pts[pts.length - 1 - k];
  }

  // Rebuilds the sheet for the clock `now`; false once all of it has come down.
  build(now: number): boolean {
    const pts = this.points;
    while (pts.length > 1 && now - pts[0]!.t > SHEET_LIFE) pts.shift();
    const n = pts.length + (this.head ? 1 : 0);
    const oldest = pts[0] ?? this.head;
    const pos = this.positions;
    const data = this.data;
    const nrm = this.normals;
    let alive = false;
    const g = this.mesh.geometry;
    for (let k = 0; k < SAMPLES; k++) {
      // Newest (the head) first; missing points collapse onto the oldest.
      const p = k < n ? this.at(k) : oldest;
      const o3 = k * 6;
      const o4 = k * 8;
      if (!p) {
        pos.fill(0, o3, o3 + 6);
        data.fill(0, o4, o4 + 8);
        continue;
      }
      const age = now - p.t;
      const top = sheetTop(p.height, age);
      const strength = k < n ? strengthOf(p, age) : 0;
      if (strength > 0 && top > 0.2) alive = true;
      const drift = DRIFT * p.speed * age;
      const x = p.x - p.fx * drift;
      const z = p.z - p.fz * drift;
      // (Written element by element: this runs every frame for every tail.)
      pos[o3] = x;
      pos[o3 + 1] = p.y - 0.2;
      pos[o3 + 2] = z;
      pos[o3 + 3] = x;
      pos[o3 + 4] = p.y + top;
      pos[o3 + 5] = z;
      data[o4] = p.s;
      data[o4 + 1] = 0;
      data[o4 + 2] = strength;
      data[o4 + 3] = 0;
      data[o4 + 4] = p.s;
      data[o4 + 5] = 1;
      data[o4 + 6] = strength;
      data[o4 + 7] = 0;
      // The ribbon faces across the track.
      for (let v = 0; v < 2; v++) {
        nrm[o3 + 3 * v] = -p.fz;
        nrm[o3 + 3 * v + 1] = 0;
        nrm[o3 + 3 * v + 2] = p.fx;
      }
    }
    for (let c = 0; c < CARDS; c++) {
      const k = c * CARD_EVERY + 1;
      const p = k < n ? this.at(k) : undefined;
      const base = SAMPLES * 2 + c * 4;
      if (!p) {
        pos.fill(0, base * 3, base * 3 + 12);
        data.fill(0, base * 4, base * 4 + 16);
        continue;
      }
      const age = now - p.t;
      const top = sheetTop(p.height, age);
      const strength = strengthOf(p, age);
      const drift = DRIFT * p.speed * age;
      const x = p.x - p.fx * drift;
      const z = p.z - p.fz * drift;
      const rx = -p.fz;
      const rz = p.fx;
      const wTop = FOOT + 0.35 * top;
      // The card's four corners: bottom port, bottom starboard, top port, top starboard.
      for (let i = 0; i < 4; i++) {
        const side = i & 1 ? 1 : -1;
        const top2 = i >> 1;
        const w = top2 ? wTop : FOOT;
        const v3 = (base + i) * 3;
        const v4 = (base + i) * 4;
        pos[v3] = x + rx * side * w;
        pos[v3 + 1] = top2 ? p.y + top : p.y - 0.2;
        pos[v3 + 2] = z + rz * side * w;
        data[v4] = p.s * 0.37 + side * w;
        data[v4 + 1] = top2;
        data[v4 + 2] = strength;
        data[v4 + 3] = 2 + side;
        nrm[v3] = p.fx;
        nrm[v3 + 1] = 0;
        nrm[v3 + 2] = p.fz;
      }
    }
    for (const name of ['position', 'sheetData', 'sheetNormal']) g.getAttribute(name).needsUpdate = true;
    return alive;
  }
}

// The lit, streaky water of the sheet (shared by every tail).
function sheetMaterial(lighting: FxLighting): NodeMaterial {
  const m = new NodeMaterial();
  m.name = 'fx-rooster-sheet';
  m.transparent = true;
  m.depthWrite = false;
  m.side = DoubleSide;
  m.fog = false;
  m.blending = CustomBlending;
  m.blendSrc = OneFactor;
  m.blendDst = OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = OneFactor;
  m.blendDstAlpha = OneMinusSrcAlphaFactor;
  const noise = noiseTexture();
  m.outputNode = Fn(() => {
    const d: N = attribute('sheetData', 'vec4');
    const facingNormal: N = normalize(attribute('sheetNormal', 'vec3'));
    const p: N = positionWorld;
    const toCamera = cameraPosition.sub(p);
    const distance = length(toCamera);
    const view = toCamera.div(max(distance, 1e-3));
    const across = abs(dot(facingNormal, view));
    const card = d.w.greaterThan(0.5);
    const lateral = abs(d.w.sub(2));
    // Each part fades as it turns edge-on; the cards, many deep from astern, are fainter each and
    // soft at their sides.
    const facing = select(
      card,
      smoothstep(0.2, 0.8, across)
        .mul(0.45)
        .mul(float(1).sub(smoothstep(0.5, 1, lateral))),
      smoothstep(0.03, 0.45, across),
    );
    // Thin at the water, densest in the head of the plume, soft at its top.
    const v = d.y;
    const profile = smoothstep(0, 0.3, v)
      .mul(mix(float(0.45), float(1), smoothstep(0.3, 0.85, v)))
      .mul(float(1).sub(smoothstep(0.86, 1, v)));
    // Streaks of falling water and lumps, fixed where the water is.
    const streaks = texture(noise, vec2(d.x.mul(0.06), p.y.mul(0.012))).b;
    const lumps = texture(noise, vec2(d.x.mul(0.013), p.y.mul(0.03).add(0.37))).r;
    const density = saturate(streaks.mul(1.1).add(0.15)).mul(saturate(lumps.mul(1.3).add(0.15)));
    // Out of the way of a camera inside it (the chase camera at speed).
    const near = smoothstep(2.5, 10, distance);
    const alpha = saturate(d.z.mul(profile).mul(density).mul(facing).mul(near).mul(1.1));
    // Sunlit droplets, brightest backlit (forward scattering), a hint of the sea's colour.
    const cosTheta = dot(view.negate(), lighting.sunDirection);
    const phase = min(
      mix(henyeyGreenstein(cosTheta, 0.1), henyeyGreenstein(cosTheta, 0.75), 0.5).mul(4 * Math.PI),
      4,
    );
    const sunUp = smoothstep(-0.05, 0.05, lighting.sunDirection.y);
    const albedo = mix(vec3(1), lighting.seaTint, 0.06).mul(0.95);
    const radiance = lighting.ambientColor
      .add(lighting.flashColor)
      .add(lighting.sunColor.mul(phase).mul(sunUp).mul(0.65))
      .mul(albedo)
      .mul(mix(float(0.8), float(1), v));
    return vec4(radiance.mul(alpha), alpha);
  })();
  return m;
}

// Every rooster tail on the water, by boat.
export class RoosterSheets {
  readonly group: Group = new Group();
  private material: NodeMaterial;
  private tails = new Map<string, Tail>();
  private now = 0;

  constructor(lighting: FxLighting) {
    this.group.name = 'fx-rooster-sheets';
    this.material = sheetMaterial(lighting);
  }

  // The propeller of boat `id` this frame (world), throwing a tail `height` m tall.
  push(id: string, propeller: Vec3Like, heading: Vec3Like, height: number, speed: number): void {
    let tail = this.tails.get(id);
    if (!tail) {
      if (height <= 0.2) return;
      tail = new Tail(this.material);
      this.tails.set(id, tail);
      this.group.add(tail.mesh);
    }
    tail.push(this.now, {
      x: propeller.x,
      y: propeller.y,
      z: propeller.z,
      fx: heading.x,
      fz: heading.z,
      height,
      speed,
    });
  }

  update(dt: number): void {
    this.now += Math.max(0, dt);
    for (const [id, tail] of this.tails) {
      const alive = tail.build(this.now);
      tail.mesh.visible = alive;
      // A boat gone (or off the plane) for longer than the water stays up.
      if (!alive && this.now - tail.lastActive > SHEET_LIFE) {
        this.group.remove(tail.mesh);
        tail.mesh.geometry.dispose();
        this.tails.delete(id);
      }
    }
  }

  get count(): number {
    return this.tails.size;
  }

  meshes(): readonly Object3D[] {
    return this.group.children;
  }

  dispose(): void {
    for (const tail of this.tails.values()) tail.mesh.geometry.dispose();
    this.tails.clear();
    this.material.dispose();
  }
}
