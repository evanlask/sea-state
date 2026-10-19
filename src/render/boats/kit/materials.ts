// Procedural PBR node materials for boats. Everything is evaluated in the
// boat's body frame (so weathering sticks to the hull as it moves) from one
// cached noise texture, the baked AO volume and analytic patterns:
//  - painted steel with plate seams / weld beads / frame dishing as bump,
//    grime from AO, vertical streaks, rust patches and streaks;
//  - hull paint in antifouling / boot-top / topside bands with waterline staining;
//  - non-skid decks, brushed metal, chrome, rubber, GRP, tinted glass;
//  - small-craft finishes: clear-coated gelcoat, moulded diamond non-skid, laid
//    teak with caulked seams, woven canvas and stitched vinyl;
//  - emissive lamps and window facades with random cabin occupancy,
//    all in cd/m² × pre-exposure and switched by the shared boat uniforms.

import {
  ClampToEdgeWrapping,
  Color,
  type ColorRepresentation,
  Data3DTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  type Material,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  RedFormat,
  type Side,
  type Texture,
  UnsignedByteType,
  Vector3,
} from 'three/webgpu';

import { type N, tsl } from '../../tsl';
import type { ResolvedDetail } from '../detail/detail';
import { applyDetail, applyWornLayer, detailNormal, type Surface } from '../detail/nodes';
import { featureSize } from '../detail/tuning';
import type { AoVolumeData } from './ao';
import { boatEnvironment } from './environment';
import { noiseTexture } from './textures';

const {
  Fn,
  abs,
  attribute,
  cos,
  faceDirection,
  float,
  floor,
  fract,
  fwidth,
  hash,
  max,
  mix,
  modelWorldMatrixInverse,
  normalView,
  normalWorldGeometry,
  positionView,
  positionViewDirection,
  positionWorld,
  pow,
  saturate,
  select,
  smoothstep,
  texture,
  texture3D,
  uv,
  vec2,
  vec3,
  vec4,
} = tsl;

// ------------------------------------------------------------------ AO volume

export interface AoVolume {
  texture: Data3DTexture;
  min: Vector3;
  size: Vector3;
  data: AoVolumeData;
}

export function createAoVolume(data: AoVolumeData): AoVolume {
  const tex = new Data3DTexture(data.data, data.nx, data.ny, data.nz);
  tex.format = RedFormat;
  tex.type = UnsignedByteType;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return {
    texture: tex,
    min: new Vector3(...data.min),
    size: new Vector3(...data.size),
    data,
  };
}

// --------------------------------------------------------------- body space

// Body-frame position/normal. Meshes sit at identity under the boat root, so the object's inverse
// world matrix maps back to the body frame; for instanced meshes positionWorld includes the instance.
export const bodyPosition = (): N => modelWorldMatrixInverse.mul(vec4(positionWorld, 1)).xyz;
export const bodyNormal = (): N => modelWorldMatrixInverse.mul(vec4(normalWorldGeometry, 0)).xyz.normalize();

export function aoNode(ao: AoVolume | null | undefined, p: N, n: N, offset = 1.0): N {
  if (!ao) return float(1);
  const voxel = ao.size.x / ao.data.nx;
  const q = p.add(n.mul(voxel * offset));
  const uvw = q.sub(vec3(ao.min.x, ao.min.y, ao.min.z)).div(vec3(ao.size.x, ao.size.y, ao.size.z));
  // Voxel staircases on oblique walls read slightly occluded; remap so only real occlusion darkens.
  return smoothstep(float(0.3), float(0.92), texture3D(ao.texture, uvw).r);
}

// Triplanar sample of the shared noise tile (scale = tiles per metre). Streak channel (b) runs vertically on walls.
function triNoise(p: N, n: N, scale: number): N {
  const tex = noiseTexture();
  const w0 = pow(abs(n), vec3(4));
  const w = w0.div(w0.x.add(w0.y).add(w0.z).add(1e-5));
  const a = texture(tex, p.zy.mul(scale));
  const b = texture(tex, p.xz.mul(scale));
  const c = texture(tex, p.xy.mul(scale));
  return a.mul(w.x).add(b.mul(w.y)).add(c.mul(w.z));
}

// Distance-to-nearest-line coverage, antialiased: 1 on a line of the given width every `spacing`.
function lineCoverage(u: N, spacing: number, width: number): N {
  const d = abs(fract(u.div(spacing).add(0.5)).sub(0.5)).mul(spacing);
  const aa = fwidth(u).mul(0.75).add(1e-4);
  return float(1).sub(smoothstep(float(width * 0.5), aa.add(width * 0.5), d));
}

// ------------------------------------------------------------------ wet surfaces

const STREAKS_PER_METRE = 22; // run-off rivulets across a wall
const STREAK_MEAN = 0.4; // their average wetness, where they are sub-pixel

// Rain and spray on the boat (boatEnvironment.wetness, 0..1; see wetness.ts), in node math only (no
// textures: some boat materials are near the 16-sampler limit). Upward faces (decks) get wettest:
// porous finishes darken (water fills the pores, after Lagarde's wet-surface model) and every finish
// gets a smooth water film; flat decks gather puddles once soaked. Walls only carry streaks of
// run-off, undersides stay dry, and AO (overhangs, under covers) shelters both.
function wetSurface(color: N, roughness: N, metalness: N, ao: N, p: N, n: N): { color: N; roughness: N } {
  const w = boatEnvironment.wetness;
  const up = smoothstep(float(0.3), float(0.8), n.y);
  const vertical = float(1).sub(abs(n.y));
  // Rivulets: random-width columns along the wall, each with drips repeating down it.
  const u = p.x.add(p.z).mul(STREAKS_PER_METRE);
  const r = hash(floor(u));
  const drips = smoothstep(float(0), float(0.7), fract(p.y.mul(0.6).add(r.mul(7.3))));
  const rivulet = smoothstep(float(0.3), float(0.85), r).mul(drips.mul(0.6).add(0.4));
  const streaks = mix(rivulet, float(STREAK_MEAN), saturate(fwidth(u).mul(0.5)));
  const coverage = max(up, vertical.mul(streaks.mul(0.6).add(0.15)));
  const shelter = mix(float(0.3), float(1), ao);
  const wet = saturate(w.mul(coverage).mul(shelter));
  // Porous (rough, non-metal) finishes darken most; a water film smooths everything.
  const porosity = smoothstep(float(0.25), float(0.85), roughness).mul(float(1).sub(metalness));
  const darken = float(1).sub(wet.mul(porosity.mul(0.45).add(0.08)));
  let rough = mix(roughness, roughness.min(0.12), wet.mul(0.9));
  // Puddles on flat decks once well soaked: blotches from interfering waves (no noise texture).
  const flat = smoothstep(float(0.94), float(0.99), n.y);
  const blotch = p.x
    .mul(1.3)
    .add(p.z.mul(0.7).sin().mul(2))
    .sin()
    .mul(p.z.mul(1.1).add(p.x.mul(0.9).sin().mul(2)).sin());
  const puddle = flat
    .mul(smoothstep(float(0.5), float(0.85), w))
    .mul(smoothstep(float(0.05), float(0.45), blotch))
    .mul(shelter);
  rough = mix(rough, float(0.03), puddle);
  return { color: color.mul(darken).mul(mix(float(1), float(0.85), puddle)), roughness: rough };
}

// Normal perturbed by a procedural height (metres) via screen-space derivatives (Mikkelsen 2010).
const perturbNormal = Fn(([height]: [N]) => {
  const sx = positionView.dFdx();
  const sy = positionView.dFdy();
  const nrm = normalView;
  const r1 = sy.cross(nrm);
  const r2 = nrm.cross(sx);
  const det = sx.dot(r1).mul(faceDirection);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(nrm).sub(grad).normalize();
});

// Plate seams for body-frame surfaces: picks the plane by the dominant normal axis.
export interface PlateLayout {
  horizontal: number; // seam spacing along the length/width, m
  vertical: number; // seam spacing in height (strakes), m
  frames?: number; // stiffener spacing for "hungry horse" dishing, m (0 = off)
  bead?: number; // weld bead height, m
}

function plateHeight(p: N, n: N, plates: PlateLayout): N {
  const an = abs(n);
  const onDeck = an.y.greaterThan(max(an.x, an.z));
  const onSide = an.x.greaterThan(an.z);
  const hu = select(onDeck, p.x, select(onSide, p.z, p.x));
  const hv = select(onDeck, p.z, p.y);
  const bead = plates.bead ?? 0.003;
  let h = lineCoverage(hu, plates.horizontal, 0.025)
    .max(lineCoverage(hv, plates.vertical, 0.025))
    .mul(bead);
  if (plates.frames) {
    const dish = float(1)
      .sub(cos(hu.div(plates.frames).mul(Math.PI * 2)))
      .mul(-0.0012);
    // Fade the dishing out with distance (derivative-sized) to avoid moiré.
    const fade = float(1).sub(saturate(fwidth(hu).div(plates.frames * 0.25)));
    h = h.add(dish.mul(fade));
  }
  return h;
}

// --------------------------------------------------------------- weathering

const vec3Of = (c: ColorRepresentation): N => {
  const col = new Color(c);
  return vec3(col.r, col.g, col.b);
};

interface WeatherOptions {
  ao?: AoVolume | null;
  grime?: number; // 0..1 dirt in occluded areas and blotches
  streaks?: number; // 0..1 vertical run marks on walls
  rust?: number; // 0..1 rust patches / streaks
  rustColor?: ColorRepresentation;
  grimeColor?: ColorRepresentation;
}

interface Weathered extends Surface {
  ao: N;
}

// `detail` (ambientCG layers, see ../detail): the base layer sits in the paint under the rust; a worn
// layer turns the procedural rust patches into chipped paint shaped by its texture.
function weather(
  base: N,
  roughness: number,
  metalness: number,
  p: N,
  n: N,
  o: WeatherOptions & { detail?: ResolvedDetail | null },
): Weathered {
  const ao = aoNode(o.ao, p, n);
  const big = triNoise(p, n, 1 / 14);
  const mid = triNoise(p, n, 1 / 3.5);
  const vertical = float(1).sub(abs(n.y));
  const grime = float(o.grime ?? 0.35);
  const streaks = float(o.streaks ?? 0.3);
  const rust = o.rust ?? 0;
  const streak = pow(mid.b, float(3)).mul(vertical).mul(streaks);
  const dirt = saturate(
    float(1).sub(ao).mul(1.4).mul(grime).add(big.r.sub(0.5).mul(0.35).mul(grime)).add(streak.mul(0.6)),
  );
  const grimeTint = vec3Of(o.grimeColor ?? 0x3a3428);
  let color = mix(base, base.mul(grimeTint).mul(1.6), dirt.mul(0.85));
  // Subtle large-scale paint fade so big panels aren't uniform.
  color = color.mul(big.g.sub(0.5).mul(0.08).add(1));
  const rough = float(roughness).add(mid.g.sub(0.5).mul(0.12)).add(dirt.mul(0.18));
  let s: Surface = applyDetail(o.detail, p, n, {
    color,
    roughness: rough,
    ao,
    metalness: float(metalness),
    delta: null,
  });
  if (rust > 0) {
    const rc = new Color(o.rustColor ?? 0x6a3015);
    const rustTint = vec3(rc.r, rc.g, rc.b).mul(mid.a.mul(0.5).add(0.75));
    const patch = smoothstep(
      float(1 - rust * 0.55),
      float(1.08 - rust * 0.55),
      mid.g.mul(0.55).add(float(1).sub(ao).mul(0.6)).add(big.a.mul(0.25)),
    );
    const runs = pow(mid.b, float(6))
      .mul(vertical)
      .mul(rust * 1.4);
    const worn = applyWornLayer(
      o.detail?.worn ?? null,
      p,
      n,
      s,
      saturate(patch.add(dirt.mul(0.25))),
      rustTint,
    );
    // With a worn layer the patches become its chips; the run-off streaks stay procedural.
    const amount = worn ? saturate(runs) : saturate(max(patch, runs));
    if (worn) s = worn;
    s = {
      ...s,
      color: mix(s.color, rustTint, amount),
      roughness: mix(s.roughness, float(0.85), amount),
      metalness: o.detail ? mix(s.metalness, float(0), amount) : s.metalness,
    };
  }
  // Contact darkening on direct light too (the AO node only scales indirect light).
  const wet = wetSurface(
    s.color.mul(mix(float(0.8), float(1), ao)),
    saturate(s.roughness),
    s.metalness,
    ao,
    p,
    n,
  );
  return { ...s, ...wet };
}

// Normal (and clear-coat normal) of a material: its procedural normal tilted by the detail offset.
function setNormals(m: MeshStandardNodeMaterial, procedural: N, delta: N, clearcoat = false): void {
  const normal = detailNormal(procedural, delta);
  if (normal) m.normalNode = normal;
  // Gelcoat's orange peel is in the clear coat itself.
  if (clearcoat && delta) (m as MeshPhysicalNodeMaterial).clearcoatNormalNode = normal;
}

// ------------------------------------------------------------------ factories

export interface PaintOptions extends WeatherOptions {
  color: ColorRepresentation;
  roughness?: number;
  metalness?: number;
  plates?: PlateLayout | null;
  side?: Side;
  name?: string;
  detail?: ResolvedDetail | null;
}

// Painted steel (or any opaque painted surface) with seams and weathering.
export function paintMaterial(o: PaintOptions): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = o.name ?? 'paint';
  const p = bodyPosition();
  const n = bodyNormal();
  const w = weather(vec3Of(o.color), o.roughness ?? 0.55, o.metalness ?? 0, p, n, o);
  m.colorNode = w.color;
  m.roughnessNode = w.roughness;
  m.metalness = o.metalness ?? 0;
  if (o.detail) m.metalnessNode = w.metalness;
  m.aoNode = w.ao;
  setNormals(m, o.plates ? perturbNormal(plateHeight(p, n, o.plates)) : null, w.delta);
  m.side = o.side ?? FrontSide;
  return m;
}

interface HullBand {
  below: number; // body y; the band applies below this height (bands sorted bottom-up)
  color: ColorRepresentation;
  roughness: number;
}

export interface HullPaintOptions extends WeatherOptions {
  bands: HullBand[]; // e.g. antifouling < −1.2, boot-top < 0.6
  topside: ColorRepresentation;
  topsideRoughness?: number;
  stripes?: { y0: number; y1: number; color: ColorRepresentation }[]; // sheer stripes etc.
  stain?: number; // waterline staining 0..1
  // Side-projected rust/grime mask (r = rust streaks, g = grime), see liveries.ts.
  mask?: { texture: Texture; zBow: number; length: number; yMin: number; yMax: number };
  plates?: PlateLayout | null;
  waterlineY?: number;
  clearcoat?: number; // glossy gelcoat (small craft): physical material with a clear coat
  detail?: ResolvedDetail | null;
}

export function hullPaintMaterial(o: HullPaintOptions): MeshStandardNodeMaterial {
  const m = o.clearcoat ? gelcoatBase(o.clearcoat) : new MeshStandardNodeMaterial();
  m.name = 'hull';
  const p = bodyPosition();
  const n = bodyNormal();
  const y = p.y;
  const aa = fwidth(y).add(1e-4);
  let color: N = vec3Of(o.topside);
  let rough: N = float(o.topsideRoughness ?? 0.45);
  for (const s of o.stripes ?? []) {
    const inside = smoothstep(float(s.y0).sub(aa), float(s.y0).add(aa), y).mul(
      float(1).sub(smoothstep(float(s.y1).sub(aa), float(s.y1).add(aa), y)),
    );
    color = mix(color, vec3Of(s.color), inside);
  }
  // Bands from the top down so lower bands overwrite.
  const bands = [...o.bands].sort((a, b) => b.below - a.below);
  for (const band of bands) {
    const t = float(1).sub(smoothstep(float(band.below).sub(aa), float(band.below).add(aa), y));
    color = mix(color, vec3Of(band.color), t);
    rough = mix(rough, float(band.roughness), t);
  }
  const mid = triNoise(p, n, 1 / 4);
  const big = triNoise(p, n, 1 / 20);
  // Waterline staining: a mottled brownish-green film just above the boot-top.
  const wl = o.waterlineY ?? 0;
  const stainBand = smoothstep(float(wl - 0.4), float(wl + 0.2), y).mul(
    float(1).sub(smoothstep(float(wl + 0.3), float(wl + 1.8), y)),
  );
  const stain = saturate(stainBand.mul(mid.r.mul(0.8).add(0.4)).mul(o.stain ?? 0.5));
  color = mix(color, color.mul(vec3(0.55, 0.56, 0.42)), stain);
  // Slime just below the waterline on the antifouling.
  const slime = smoothstep(float(wl - 1.2), float(wl - 0.1), y).mul(
    float(1).sub(smoothstep(float(wl - 0.1), float(wl + 0.05), y)),
  );
  color = mix(color, vec3(0.16, 0.17, 0.09), slime.mul(mid.g).mul(0.45));
  const ao = aoNode(o.ao, p, n);
  let s: Surface = applyDetail(o.detail, p, n, {
    color,
    roughness: rough.add(mid.g.sub(0.5).mul(0.1)).add(stain.mul(0.2)),
    ao,
    metalness: float(0),
    delta: null,
  });
  if (o.mask) {
    const u = p.z.sub(o.mask.zBow).div(o.mask.length);
    const v = float(1).sub(y.sub(o.mask.yMin).div(o.mask.yMax - o.mask.yMin));
    const mk = texture(o.mask.texture, vec2(u, v));
    const rc = new Color(o.rustColor ?? 0x5a2a12);
    const rustTint = vec3(rc.r, rc.g, rc.b).mul(mid.a.mul(0.4).add(0.8));
    const rust = o.rust ?? 0.8;
    const grime = o.grime ?? 0.4;
    // Chipped paint where the rust streaks start and in scattered spots across the plating.
    const wear = saturate(
      mk.r
        .mul(rust)
        .add(pow(big.a, float(3)).mul(rust * 0.6))
        .add(mk.g.mul(grime * 0.3)),
    );
    s = applyWornLayer(o.detail?.worn ?? null, p, n, s, wear, rustTint) ?? s;
    let c = mix(s.color, rustTint, saturate(mk.r.mul(rust)));
    c = mix(c, c.mul(0.6), saturate(mk.g.mul(grime)));
    s = { ...s, color: c };
  }
  color = s.color.mul(big.g.sub(0.5).mul(0.07).add(1));
  color = color.mul(mix(float(0.82), float(1), ao));
  const wet = wetSurface(color, saturate(s.roughness), s.metalness, ao, p, n);
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  m.metalness = 0;
  if (o.detail) m.metalnessNode = s.metalness;
  m.aoNode = s.ao;
  setNormals(m, o.plates ? perturbNormal(plateHeight(p, n, o.plates)) : null, s.delta, !!o.clearcoat);
  return m;
}

export interface DeckOptions extends WeatherOptions {
  color: ColorRepresentation;
  roughness?: number;
  nonSkid?: boolean;
  plates?: PlateLayout | null;
  wear?: number; // 0..1 worn-through paint showing primer/steel
  detail?: ResolvedDetail | null;
}

export function deckMaterial(o: DeckOptions): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'deck';
  const p = bodyPosition();
  const n = bodyNormal();
  const w = weather(vec3Of(o.color), o.roughness ?? 0.75, 0, p, n, o);
  let color = w.color;
  if (o.wear) {
    const fine = triNoise(p, n, 1 / 1.2);
    const worn = smoothstep(
      float(1 - o.wear * 0.5),
      float(1.05 - o.wear * 0.5),
      fine.r.mul(0.7).add(fine.a.mul(0.3)),
    );
    color = mix(color, vec3(0.22, 0.2, 0.18), worn.mul(0.8));
  }
  m.colorNode = color;
  m.roughnessNode = w.roughness;
  if (o.detail) m.metalnessNode = w.metalness;
  m.aoNode = w.ao;
  let h: N = float(0);
  // Procedural non-skid grit only where no detail texture brings its own relief.
  if ((o.nonSkid ?? true) && !o.detail?.base) {
    const grit = triNoise(p, n, 1 / 0.18).a;
    const fade = float(1).sub(saturate(fwidth(p.x).add(fwidth(p.z)).div(0.02)));
    h = h.add(grit.mul(0.0008).mul(fade));
  }
  if (o.plates) h = h.add(plateHeight(p, n, o.plates));
  setNormals(m, perturbNormal(h), w.delta);
  return m;
}

export interface SimpleOptions {
  color: ColorRepresentation;
  roughness?: number;
  metalness?: number;
  ao?: AoVolume | null;
  side?: Side;
  name?: string;
  brushed?: boolean;
  clearcoat?: number;
  detail?: ResolvedDetail | null;
}

function gelcoatBase(clearcoat: number): MeshPhysicalNodeMaterial {
  const m = new MeshPhysicalNodeMaterial();
  m.clearcoat = clearcoat;
  m.clearcoatRoughness = 0.06;
  return m;
}

// What a plain simple or lamp material is made of: PartBuilder merges the slots whose materials
// differ only in these into one mesh carrying them per vertex (slotMerge.ts), drawn with
// mergedSimpleMaterial / mergedLampMaterial, which shade exactly as the originals.
export interface SimpleParams {
  color: Color;
  roughness: number;
  metalness: number;
  brushed: boolean;
  ao: AoVolume | null;
  side: Side;
}

export interface LampParams {
  base: Color;
  glow: Color; // colour × nits
  channel: LampChannel;
}

const simpleParams = new WeakMap<Material, SimpleParams>();
const lampParams = new WeakMap<Material, LampParams>();

export const simpleParamsOf = (m: Material): SimpleParams | undefined => simpleParams.get(m);
export const lampParamsOf = (m: Material): LampParams | undefined => lampParams.get(m);

// Per-vertex attribute names carrying the merged slots' values (slotMerge.ts).
export const SIMPLE_COLOR = 'simpleColor';
export const SIMPLE_PBR = 'simplePbr'; // roughness, metalness
export const LAMP_BASE = 'lampBase';
export const LAMP_GLOW = 'lampGlow';
export const LAMP_CHANNEL = 'lampChannel'; // one-hot: always, interior, deck, bridge

// The shared part of simpleMaterial and mergedSimpleMaterial.
function simpleSurface(
  m: MeshStandardNodeMaterial,
  color: N,
  rough: N,
  metalness: N,
  o: { ao?: AoVolume | null; brushed?: boolean; detail?: ResolvedDetail | null; clearcoat?: number },
): void {
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const mid = triNoise(p, n, o.brushed ? 1 / 0.6 : 1 / 2.5);
  const s = applyDetail(o.detail, p, n, {
    color: color.mul(mid.g.sub(0.5).mul(0.1).add(1)),
    roughness: saturate(rough.add(mid.a.sub(0.5).mul(o.brushed ? 0.25 : 0.1))),
    ao,
    metalness,
    delta: null,
  });
  const wet = wetSurface(s.color.mul(mix(float(0.82), float(1), ao)), s.roughness, s.metalness, ao, p, n);
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  if (o.detail) m.metalnessNode = s.metalness;
  m.aoNode = s.ao;
  setNormals(m, null, s.delta, !!o.clearcoat);
}

// Several simple slots in one mesh, their colour, roughness and metalness per vertex.
export function mergedSimpleMaterial(o: {
  ao: AoVolume | null;
  brushed: boolean;
  side: Side;
}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'simple-merged';
  const pbr = attribute(SIMPLE_PBR, 'vec2');
  simpleSurface(m, attribute(SIMPLE_COLOR, 'vec3'), pbr.x, pbr.y, o);
  m.metalnessNode = pbr.y;
  m.side = o.side;
  return m;
}

// Several lamp slots in one mesh, their base colour, glow and switch channel per vertex.
export function mergedLampMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'lamp-merged';
  const channel = attribute(LAMP_CHANNEL, 'vec4');
  const gain = channel.x
    .add(channel.y.mul(channelGain('interior')))
    .add(channel.z.mul(channelGain('deck')))
    .add(channel.w.mul(channelGain('bridge')));
  m.colorNode = attribute(LAMP_BASE, 'vec3');
  m.roughness = 0.25;
  m.emissiveNode = attribute(LAMP_GLOW, 'vec3').mul(gain).mul(boatEnvironment.preExposure);
  return m;
}

// Metals, rubber, GRP: lightly varied, AO-shaded, no seams.
export function simpleMaterial(o: SimpleOptions): MeshStandardNodeMaterial {
  const m = o.clearcoat ? gelcoatBase(o.clearcoat) : new MeshStandardNodeMaterial();
  m.name = o.name ?? 'simple';
  simpleSurface(m, vec3Of(o.color), float(o.roughness ?? 0.5), float(o.metalness ?? 0), o);
  m.metalness = o.metalness ?? 0;
  m.side = o.side ?? FrontSide;
  if (!o.detail && !o.clearcoat) {
    simpleParams.set(m, {
      color: new Color(o.color),
      roughness: o.roughness ?? 0.5,
      metalness: o.metalness ?? 0,
      brushed: !!o.brushed,
      ao: o.ao ?? null,
      side: m.side,
    });
  }
  return m;
}

// Tinted bridge/house glass: reflective and fairly opaque from outside, clear from inside.
export function glassMaterial(
  o: { tint?: ColorRepresentation; outside?: number; inside?: number } = {},
): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'glass';
  m.transparent = true;
  m.depthWrite = false;
  m.side = DoubleSide;
  m.colorNode = vec3Of(o.tint ?? 0x1c2a30);
  m.roughness = 0.04;
  m.metalness = 0;
  const facing = abs(normalView.dot(positionViewDirection));
  const fres = pow(float(1).sub(facing), float(4));
  const outside = float(o.outside ?? 0.72);
  const inside = float(o.inside ?? 0.1);
  m.opacityNode = select(tsl.frontFacing, mix(outside, float(1), fres), mix(inside, float(0.6), fres));
  return m;
}

// 'bridge': wheelhouse lighting, with the interior lights but dimmed at night for night vision.
export type LampChannel = 'always' | 'interior' | 'deck' | 'bridge';

const channelGain = (channel: LampChannel): N => {
  if (channel === 'interior') return boatEnvironment.interior;
  if (channel === 'deck') return boatEnvironment.deck;
  if (channel === 'bridge')
    return mix(float(1), float(0.06), boatEnvironment.night).mul(boatEnvironment.interior);
  return float(1);
};

// Self-lit surface (lamp lenses, nav light housings, ceiling lights) in cd/m².
export function lampMaterial(o: {
  color: ColorRepresentation;
  nits: number;
  channel?: LampChannel;
  base?: ColorRepresentation;
  map?: Texture;
  name?: string;
}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = o.name ?? 'lamp';
  const glow = vec3Of(o.color);
  const tex = o.map ? texture(o.map, uv()).rgb : vec3(1);
  m.colorNode = vec3Of(o.base ?? 0x222222).mul(o.map ? tex : vec3(1));
  m.roughness = 0.25;
  m.emissiveNode = glow
    .mul(tex)
    .mul(o.nits)
    .mul(channelGain(o.channel ?? 'always'))
    .mul(boatEnvironment.preExposure);
  if (!o.map) {
    lampParams.set(m, {
      base: new Color(o.base ?? 0x222222),
      glow: new Color(o.color).multiplyScalar(o.nits),
      channel: o.channel ?? 'always',
    });
  }
  return m;
}

export interface WindowFacadeOptions {
  pitch: number; // window centre spacing along the facade, m
  width: number; // window width, m
  height: number; // window height, m
  sill: number; // bottom of the window above the deck, m
  deckHeight: number; // deck-to-deck, m (uv.y in metres wraps per deck)
  frame?: ColorRepresentation; // wall/frame paint between windows
  glass?: ColorRepresentation;
  shape?: 'rect' | 'round' | 'door'; // door = full-height balcony door with a solid lower panel
  occupancy?: number; // fraction of cabins lit at night
  nits?: number; // lit-window luminance
  seed?: number;
  ao?: AoVolume | null;
  corner?: number; // corner radius for rect windows, m
}

// Facade strip whose metric UVs (u along, v up) generate the windows procedurally: frames, dark
// reflective glass, and per-cabin random lights (curtains, colour temperature, brightness).
export function windowFacadeMaterial(o: WindowFacadeOptions): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'windows';
  const t = uv();
  const u = t.x;
  const v = t.y;
  const deck = floor(v.div(o.deckHeight));
  const lv = v.sub(deck.mul(o.deckHeight));
  const cell = floor(u.div(o.pitch));
  const lu = u.sub(cell.mul(o.pitch)).sub(o.pitch / 2);
  const aaU = fwidth(u).add(1e-4);
  const aaV = fwidth(v).add(1e-4);
  const shape = o.shape ?? 'rect';
  let inside: N;
  if (shape === 'round') {
    const r = o.width / 2;
    const dy = lv.sub(o.sill + r);
    const d = lu.mul(lu).add(dy.mul(dy)).sqrt();
    inside = float(1).sub(smoothstep(float(r).sub(aaU), float(r).add(aaU), d));
  } else {
    const hw = o.width / 2;
    const cr = o.corner ?? 0.08;
    const cx = max(abs(lu).sub(hw - cr), 0);
    const cy = max(abs(lv.sub(o.sill + o.height / 2)).sub(o.height / 2 - cr), 0);
    const d = cx.mul(cx).add(cy.mul(cy)).sqrt();
    inside = float(1).sub(smoothstep(float(cr).sub(aaU.max(aaV)), float(cr).add(aaU.max(aaV)), d));
  }
  const seed = float(o.seed ?? 1);
  const id = cell.add(deck.mul(1031)).add(seed.mul(7919));
  const r0 = hash(id);
  const r1 = hash(id.add(17.3));
  const r2 = hash(id.add(41.7));
  const occupancy = mix(float((o.occupancy ?? 0.5) * 0.6), float(o.occupancy ?? 0.5), boatEnvironment.night);
  const lit = select(r0.lessThan(occupancy), float(1), float(0));
  // Curtains: some windows show a soft drawn curtain (dimmer, warmer, with a vertical gap).
  const curtain = select(r2.lessThan(0.35), float(1), float(0));
  const gap = smoothstep(float(0.04), float(0.1), abs(lu.add(r1.sub(0.5).mul(o.width * 0.6))));
  const warm = mix(vec3(1, 0.6, 0.28), vec3(1, 0.84, 0.62), r1);
  const level = mix(float(0.35), float(1), r2).mul(mix(float(1), gap.mul(0.6).add(0.15), curtain));
  // Interior falloff: brighter near the top of the window (ceiling lights).
  const fall = smoothstep(float(o.sill), float(o.sill + o.height), lv)
    .mul(0.4)
    .add(0.6);
  const emissive = warm
    .mul(lit)
    .mul(level)
    .mul(fall)
    .mul(inside)
    .mul(o.nits ?? 60)
    .mul(boatEnvironment.interior)
    .mul(boatEnvironment.preExposure);
  const frame = vec3Of(o.frame ?? 0xe8e6df);
  const glass = vec3Of(o.glass ?? 0x1a262c);
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const noise = triNoise(p, n, 1 / 6);
  const frameCol = frame.mul(noise.g.sub(0.5).mul(0.06).add(1));
  m.colorNode = mix(frameCol, glass, inside).mul(mix(float(0.82), float(1), ao));
  m.roughnessNode = mix(float(0.5), float(0.05), inside);
  m.metalness = 0;
  m.aoNode = ao;
  m.emissiveNode = emissive;
  // Window recess: a small step at the frame edge.
  m.normalNode = perturbNormal(inside.mul(-0.01));
  return m;
}

// Per-instance container livery: base colour from aColor, liveries atlas row from aVariant.x,
// seed in aVariant.y. Corrugation, door gear and dirt are procedural from the metric face UVs.
export function containerMaterial(o: {
  logos: Texture;
  rows: number;
  ao?: AoVolume | null;
}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'containers';
  const t = uv();
  const face = attribute('aFace', 'float'); // 0 long side, 1 door end, 2 front end, 3 roof
  const variant = attribute('aVariant', 'vec2');
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n, 0.8);
  const isSide = face.lessThan(0.5);
  const isEnd = face.greaterThan(0.5).and(face.lessThan(2.5));
  // Trapezoidal corrugation: sides along u (pitch 0.278 m), ends vertical, roof shallow.
  const pitch = select(isSide, float(0.278), select(isEnd, float(0.3), float(0.6)));
  const ph = fract(t.x.div(pitch));
  const tri = abs(ph.sub(0.5)).mul(2);
  const corr = smoothstep(float(0.3), float(0.7), tri);
  const aa = saturate(fwidth(t.x).div(pitch).mul(2));
  const depth = select(face.greaterThan(2.5), float(0.006), float(0.03));
  let h = mix(corr, float(0.5), aa).mul(depth);
  // Door end: two doors with four vertical locking bars.
  const bars = lineCoverage(t.x.add(0.15), 0.6, 0.035).mul(face.greaterThan(0.5).and(face.lessThan(1.5)));
  h = h.add(bars.mul(0.03));
  const seed = variant.y;
  const dirt = triNoise(p.add(seed.mul(13)), n, 1 / 2.2);
  // Own attribute rather than instanceColor: the material would multiply the logo by it too.
  let color: N = attribute('aColor', 'vec3');
  // Logo on the long sides: atlas row = livery, placed in the upper middle.
  const L = t.y; // metres up from the bottom of the face
  const logoU = t.x.sub(1.5).div(9);
  const logoV = L.sub(1.0).div(1.25);
  const inLogo = isSide
    .and(logoU.greaterThan(0))
    .and(logoU.lessThan(1))
    .and(logoV.greaterThan(0))
    .and(logoV.lessThan(1));
  const row = variant.x;
  // CanvasTexture flipY: row r spans v ∈ [1 − (r + 1)/rows, 1 − r/rows].
  const logo = texture(
    o.logos,
    vec2(
      logoU,
      float(o.rows - 1)
        .sub(row)
        .add(logoV)
        .div(o.rows),
    ),
  );
  color = mix(color, logo.rgb, logo.a.mul(select(inLogo, float(1), float(0))));
  // Rust and dirt: bottom rails, corner castings and random streaks.
  const bottom = float(1).sub(smoothstep(float(0.05), float(0.5), L));
  const rust = saturate(
    pow(dirt.b, float(5))
      .mul(1.6)
      .mul(float(1).sub(face.greaterThan(2.5)))
      .add(bottom.mul(dirt.r).mul(0.8)),
  );
  color = mix(color, vec3(0.3, 0.14, 0.07), rust.mul(0.7));
  color = color.mul(dirt.g.sub(0.5).mul(0.25).add(1)).mul(mix(float(0.55), float(1), ao));
  const rough = saturate(float(0.6).add(dirt.a.sub(0.5).mul(0.2)).add(rust.mul(0.2)));
  const wet = wetSurface(color, rough, float(0.15), ao, p, n);
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  m.metalness = 0.15;
  m.aoNode = ao;
  m.normalNode = perturbNormal(h);
  return m;
}

// Galvanised steel mesh webbing (crab pots, safety nets), uv in metres. Diamond mesh with analytic
// coverage: crisp up close, a translucent film far away.
export function webbingMaterial(
  o: { color?: ColorRepresentation; cell?: number; wire?: number } = {},
): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'webbing';
  const t = uv();
  const cell = o.cell ?? 0.09;
  const wire = o.wire ?? 0.006;
  const a = t.x.add(t.y);
  const b = t.x.sub(t.y);
  const cover = lineCoverage(a, cell, wire).max(lineCoverage(b, cell, wire));
  // Expected coverage when lines are sub-pixel: keeps the far film from vanishing.
  const film = saturate(fwidth(a).div(cell).mul(2.5));
  m.colorNode = vec3Of(o.color ?? 0x8a8d88);
  m.opacityNode = mix(cover, float((2 * wire) / cell + 0.15), film);
  m.transparent = true;
  m.depthWrite = false;
  m.side = DoubleSide;
  m.roughness = 0.85;
  m.metalness = 0;
  return m;
}

// ------------------------------------------------------------- small craft

// Moulded non-skid: a raised diamond pattern in the gelcoat (body xz), slightly darker and rougher
// than the smooth gelcoat, with dirt settling in the low spots.
export function nonSkidMaterial(o: {
  color: ColorRepresentation;
  ao?: AoVolume | null;
  cell?: number;
  name?: string;
  detail?: ResolvedDetail | null;
}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = o.name ?? 'nonSkid';
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const cell = o.cell ?? 0.012;
  const a = p.x.add(p.z).div(cell);
  const b = p.x.sub(p.z).div(cell);
  const bump = abs(fract(a).sub(0.5)).add(abs(fract(b).sub(0.5)));
  // Fade the pattern to its mean where it is sub-pixel.
  const fade = float(1).sub(saturate(fwidth(a).mul(1.5)));
  const h = smoothstep(float(0.35), float(0.65), bump)
    .mul(fade)
    .add(float(0.5).mul(float(1).sub(fade)));
  const noise = triNoise(p, n, 1 / 1.5);
  const col = vec3Of(o.color)
    .mul(noise.g.sub(0.5).mul(0.06).add(0.97))
    .mul(mix(float(0.92), float(1), h))
    .mul(mix(float(0.78), float(1), ao));
  const s = applyDetail(o.detail, p, n, {
    color: col,
    roughness: float(0.62).add(noise.a.sub(0.5).mul(0.1)),
    ao,
    metalness: float(0),
    delta: null,
  });
  const wet = wetSurface(s.color, saturate(s.roughness), s.metalness, ao, p, n);
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  m.aoNode = s.ao;
  setNormals(m, perturbNormal(h.mul(0.0006)), s.delta);
  return m;
}

// Laid teak: planks along body z (or x) with black caulked seams, per-plank tone and grain streaks.
// With a deck-planks detail layer the planks take its plank width, so the procedural seams and
// per-plank tones line up with the texture's.
export function teakMaterial(
  o: {
    ao?: AoVolume | null;
    plank?: number;
    along?: 'z' | 'x';
    tone?: ColorRepresentation;
    detail?: ResolvedDetail | null;
  } = {},
): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = 'teak';
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const layer = o.detail?.base?.layer;
  const plank = (layer && featureSize(layer)) ?? o.plank ?? 0.055;
  const across = o.along === 'x' ? p.z : p.x;
  const along = o.along === 'x' ? p.x : p.z;
  const seam = lineCoverage(across, plank, 0.006);
  const id = floor(across.div(plank));
  const tone = hash(id.add(3.1)).sub(0.5).mul(0.18).add(1);
  // Grain: streaks stretched along the plank.
  const grain = texture(noiseTexture(), vec2(across.mul(2.2).add(id.mul(0.37)), along.mul(0.09))).b;
  const fine = texture(noiseTexture(), vec2(across.mul(9), along.mul(0.6))).a;
  const wood = vec3Of(o.tone ?? 0xa47a4c)
    .mul(tone)
    .mul(grain.sub(0.5).mul(0.35).add(1))
    .mul(fine.sub(0.5).mul(0.1).add(1));
  const s = applyDetail(o.detail, p, n, {
    color: mix(wood, vec3(0.03, 0.03, 0.03), seam),
    roughness: mix(float(0.62).add(grain.mul(0.15)), float(0.85), seam),
    ao,
    metalness: float(0),
    delta: null,
  });
  const wet = wetSurface(
    s.color.mul(mix(float(0.75), float(1), ao)),
    saturate(s.roughness),
    s.metalness,
    ao,
    p,
    n,
  );
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  m.aoNode = s.ao;
  setNormals(m, perturbNormal(seam.mul(-0.002).add(grain.mul(0.0003))), s.delta);
  return m;
}

// Woven canvas / Sunbrella (T-top, covers, bimini) or stitched vinyl (cushions).
export function fabricMaterial(o: {
  color: ColorRepresentation;
  ao?: AoVolume | null;
  kind?: 'canvas' | 'vinyl';
  side?: Side;
  name?: string;
}): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial();
  m.name = o.name ?? o.kind ?? 'canvas';
  const p = bodyPosition();
  const n = bodyNormal();
  const ao = aoNode(o.ao, p, n);
  const noise = triNoise(p, n, 1 / 1.2);
  const vinyl = o.kind === 'vinyl';
  const color = vec3Of(o.color)
    .mul(
      noise.g
        .sub(0.5)
        .mul(vinyl ? 0.05 : 0.1)
        .add(1),
    )
    .mul(mix(float(0.7), float(1), ao));
  const wet = wetSurface(
    color,
    saturate(float(vinyl ? 0.45 : 0.88).add(noise.a.sub(0.5).mul(0.1))),
    float(0),
    ao,
    p,
    n,
  );
  m.colorNode = wet.color;
  m.roughnessNode = wet.roughness;
  m.aoNode = ao;
  // Weave: two crossed fine line sets in triplanar-ish body coordinates (dominant plane).
  const an = abs(n);
  const onTop = an.y.greaterThan(max(an.x, an.z));
  const u = select(onTop, p.x, select(an.x.greaterThan(an.z), p.z, p.x));
  const v = select(onTop, p.z, p.y);
  const pitch = vinyl ? 0.004 : 0.0018;
  const fade = float(1).sub(saturate(fwidth(u).div(pitch * 0.5)));
  const weave = lineCoverage(u, pitch, pitch * 0.4)
    .max(lineCoverage(v, pitch, pitch * 0.4))
    .mul(fade);
  m.normalNode = perturbNormal(
    weave.mul(vinyl ? 0.00005 : 0.00012).add(noise.r.mul(vinyl ? 0.0004 : 0.0002)),
  );
  m.side = o.side ?? FrontSide;
  return m;
}
