// The ocean's surface material: a NodeMaterial with its own lighting model, so three's lights (the
// CSM-shadowed sun/moon light) feed it, and fog/aerial perspective applies as usual. Per pixel:
//
//  - Slopes from every cascade's mipmapped derivative texture (trilinear + anisotropic). Each
//    cascade fades by pixel footprint; whatever a cascade's waves lose to filtering (LEAN moments) or
//    fading (its analytic spectrum variance) becomes GGX roughness, so far water turns into a smooth
//    sheen and the glitter path widens correctly instead of sparkling.
//  - Exact Fresnel (n = 1.333) reflection of the sky probe at that roughness, plus analytic GGX
//    glints of the sun/moon widened by their 0.267° disk (energy conserving) and shadowed by CSM.
//  - Water body from the region's optics: upwelling light tinted by deepColor, screen-space
//    refraction of what is below the surface (hulls) with Beer–Lambert absorption + scattering.
//  - Crest subsurface scattering (Atlas/Sea of Thieves style): light through backlit, high crests,
//    tinted by the region's subsurfaceTint.
//  - Whitecap foam from the Jacobian foam textures, shaped by a procedural bubble texture, with
//    procedural wind streaks above Beaufort 7 (foamPattern.ts: nothing in it may tile visibly), lit
//    diffusely with a little translucency; it hides the specular and body underneath.
//  - From below (back faces): Snell's window — refracted sky inside the critical angle, total
//    internal reflection of the water body outside it.
//  - Boat wakes (WakeLayer): their slopes tilt the normals; steep wake crests, the long foam trails
//    and a contact line where the surface meets a hull (refraction depth within ~0.6 m) add to the
//    whitecaps. Fragments inside a boat's water-exclusion volume are discarded (WaterMask).
//  - Screen-space reflections (setReflections, graphics.reflections): a post pass of their own
//    (post/OceanReflections.ts) finds the sea in the depth buffer, rebuilds this material's normal
//    and roughness there (surfaceAt) and traces the opaque copies refraction reads; nothing extra
//    is drawn or written here.
//  - Rain ripples (rainRipples.ts): procedural expanding rings tilt the normals near the camera
//    and roughen the sea beyond, scaled by the rain; nothing runs while it is dry.

import {
  DepthTexture,
  DoubleSide,
  FloatType,
  LightingModel,
  LightingNode,
  type LightingModelDirectInput,
  Matrix4,
  NodeMaterial,
  type NodeBuilder,
  type Texture,
  Vector2,
  Vector3,
} from 'three/webgpu';

import { EARTH_RADIUS } from '../../sim/core/units';
import { ViewportColorCopy, ViewportDepthCopy } from '../gpuResources';
import { type N, tsl } from '../tsl';
import { FLASH_FALLOFF } from '../weather/flashLight';
import {
  FOAM_ACCUMULATED_GAIN,
  FOAM_DRIFT_ACROSS,
  FOAM_DRIFT_ALONG,
  FOAM_MASK_RMS,
  FOAM_PATCH_ANGLE,
  FOAM_PATCH_TILE,
  FOAM_REGION_ANGLE,
  FOAM_REGION_THRESHOLD,
  FOAM_REGION_TILE,
  FOAM_STRAIN_MASK,
  FOAM_THICK_LACE,
  foamCascadeWeight,
  FOAM_EDGE_SOFTNESS,
  FOAM_FAR_BRIGHTNESS,
  FOAM_LOGISTIC_SCALE,
  FOAM_PATTERN_FALLOFF,
  FOAM_PATTERN_FOOTPRINT,
  FOAM_PATTERN_MEAN,
  FOAM_PATTERN_STD,
  FOAM_MASK_GAIN,
  FOAM_MASK_MAX,
  GROUP_MAX,
  GROUP_OFFSET,
  GROUP_SCALE,
  LACE_COARSE_TILE,
  LACE_FINE_ANGLE,
  LACE_FINE_TILE,
  LACE_WARP,
  MASK_PATCH_DRIFT,
  MASK_SHORT_DRIFT,
  MASK_SHORT_PATCHES,
  STREAK_BAND,
  STREAK_BAND_REGION,
  STREAK_BASE,
  STREAK_BRIGHTNESS,
  STREAK_CENTRE,
  STREAK_FADE_END,
  STREAK_FADE_START,
  STREAK_FALL,
  STREAK_FRAY,
  STREAK_GAP_EDGES,
  STREAK_GAIN,
  STREAK_LEE,
  STREAK_LENGTH,
  STREAK_MEANS,
  STREAK_MIN_WIDTH,
  STREAK_OCTAVES,
  STREAK_PRESENCE,
  STREAK_REGION_WARP,
  STREAK_SPUME_GAIN,
  STREAK_RISE,
  STREAK_TRAIL,
  STREAK_WARP,
  STREAK_WINDWARD,
  streakGapSalt,
  streakSalt,
  WAKE_FOAM_EDGES,
} from './foamPattern';
import { type CascadeGroup, FOAM_MIN_PATCH } from './GpuOcean';
import {
  BASE_SLOPE_VARIANCE,
  BODY_DIRECT_FLAT,
  diskSlopeVariance,
  jacobianStd,
  type OceanShadingQuality,
  SUBSURFACE_AMBIENT,
  SUBSURFACE_AMBIENT_CREST,
  SUBSURFACE_VIEW,
  SUN_ANGULAR_RADIUS,
  WATER_F0,
  WATER_IOR,
} from './oceanOptics';
import {
  RIPPLE_CELL,
  RIPPLE_FOOTPRINT_FULL,
  RIPPLE_FOOTPRINT_GONE,
  RIPPLE_MAX_RADIUS,
  RIPPLE_WAVELENGTH,
} from './rainRipples';
import { createOccluderSlots, type OccluderSlots } from './ssrOccluders';
import type { OceanWakeNodes } from './WakeLayer';
import { WaterMask } from './WaterMask';

const {
  If,
  abs,
  context,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraViewMatrix,
  cos,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  floor,
  fract,
  frontFacing,
  length,
  log2,
  materialEnvIntensity,
  max,
  min,
  mix,
  mrt,
  normalize,
  perspectiveDepthToViewZ,
  pmremTexture,
  positionView,
  positionWorld,
  pow,
  refract,
  saturate,
  screenUV,
  select,
  smoothstep,
  sqrt,
  texture,
  uint,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportTexture,
} = tsl;

const INV_PI = 1 / Math.PI;

// Exact unpolarised Fresnel for cosI in a medium of relative index eta = n1/n2 (1 under TIR).
export function fresnelNode(cosI: N, eta: number): N {
  const c = saturate(cosI);
  const sinT2 = float(eta * eta).mul(float(1).sub(c.mul(c)));
  const cosT = sqrt(max(float(1).sub(sinT2), 0));
  const rs = c.mul(eta).sub(cosT).div(c.mul(eta).add(cosT));
  const rp = cosT.mul(eta).sub(c).div(cosT.mul(eta).add(c));
  return select(sinT2.greaterThanEqual(1), float(1), rs.mul(rs).add(rp.mul(rp)).mul(0.5));
}

// Water optics and weather-driven controls shared by the material (set by OceanSurface).
export class OceanShadingUniforms {
  readonly absorption: N = uniform(new Vector3(0.47, 0.085, 0.095)); // m⁻¹
  readonly scattering: N = uniform(new Vector3(0.17, 0.22, 0.26)); // m⁻¹
  readonly deepColor: N = uniform(new Vector3(0.012, 0.05, 0.058));
  readonly subsurfaceTint: N = uniform(new Vector3(0.12, 0.48, 0.42));
  readonly bodyScale: N = uniform(0.6); // deepColor → upwelling reflectance (art-directed)
  readonly windDirection: N = uniform(new Vector2(1, 0)); // unit, toward
  readonly foamCoverage: N = uniform(1); // art multiplier on foam amount
  readonly foamStreaks: N = uniform(0);
  readonly foamSpume: N = uniform(0);
  readonly crestThreshold: N = uniform(0.35); // combined Jacobian where crests go white
  readonly waveAmplitude: N = uniform(1); // m, ≈ Hs / 2, normalises crest height for SSS
  readonly baseVariance: N = uniform(BASE_SLOPE_VARIANCE);
  readonly lightDiskVariance: N = uniform(diskSlopeVariance(SUN_ANGULAR_RADIUS));
  readonly subsurfaceStrength: N = uniform(4);
  readonly refractionStrength: N = uniform(0.35);
  // Motion vectors (TRAA): unjittered view-projection of this and the previous frame.
  readonly viewProjection: N = uniform(new Matrix4());
  readonly previousViewProjection: N = uniform(new Matrix4());
  // Rain ripples (rainRippleParams); density 0 skips them entirely.
  readonly rippleDensity: N = uniform(0);
  readonly rippleSlope: N = uniform(0);
  readonly ripplePeriod: N = uniform(1);
  readonly rippleVariance: N = uniform(0);
  readonly time: N = uniform(0); // s, wrapped (ripple phases)
  readonly frame: N = uniform(0); // frame counter mod 64 (SSR jitter)
  // Device pixels of the frame (the opaque copies' size; screenSize can hold another target's).
  readonly drawingBufferSize: N = uniform(new Vector2(1, 1));
  // Where SSR can hit (ssrOccluders.ts): the boats' screen rectangles and nearest view distances.
  // One full-screen rectangle (the full march) until the scene sets them.
  readonly ssrOccluders: OccluderSlots = createOccluderSlots(uniform(1));
  readonly ssrOccluderData: N = uniformArray(this.ssrOccluders.data, 'vec4');
  // Lightning (weather/flashLight.ts), which the sky probe leaves out: the lit cloud base's radiance
  // at the source (pre-exposed, 0 while dark), the source (scene m), the base's height (m), and the
  // base's glow averaged over the sky (pre-exposed).
  readonly flashRadiance: N = uniform(new Vector3());
  readonly flashSource: N = uniform(new Vector3(0, 1400, 0));
  readonly flashBase: N = uniform(1000);
  readonly flashSky: N = uniform(new Vector3());
}

// Hash without sine (Hoskins): vec3 in [0, 1) from a vec3.
const hash33 = (p: N): N => {
  const p3 = fract(p.mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yxz.add(33.33)));
  return fract(p3.xxy.add(p3.yxx).mul(p3.zyx));
};

// Slope (∂h/∂x, ∂h/∂z) of the rain-ripple rings at world xz: two offset grids of cells, each
// starting a ring at a random spot every period (rainRipples.ts).
function rippleSlope(xz: N, u: OceanShadingUniforms): N {
  let slope: N = vec2(0);
  const k = (2 * Math.PI) / RIPPLE_WAVELENGTH;
  const width = RIPPLE_WAVELENGTH * 0.9;
  for (let layer = 0; layer < 2; layer++) {
    const g = xz.div(RIPPLE_CELL).add(layer * 0.5);
    const id = floor(g);
    const f = fract(g).sub(0.5);
    const phase = u.time.div(u.ripplePeriod).add(hash33(vec3(id, layer * 17 + 3)).x);
    const life = fract(phase);
    const h = hash33(vec3(id, floor(phase).add(layer * 31 + 7)));
    const active = select(h.z.lessThan(u.rippleDensity), float(1), float(0));
    const d = f.sub(h.xy.sub(0.5).mul(0.3)).mul(RIPPLE_CELL);
    const r = max(d.length(), 1e-4);
    const x = r.sub(life.mul(RIPPLE_MAX_RADIUS));
    const fade = float(1).sub(life).pow(2);
    const ring = exp(x.div(width).pow(2).negate());
    const dhdr = cos(x.mul(k)).mul(ring).mul(fade).mul(u.rippleSlope).mul(active);
    slope = slope.add(d.div(r).mul(dhdr));
  }
  return slope;
}

// lowbias32 on u32 (sim/ocean/hash.ts's hash32).
const hashU32 = (x: N): N => {
  let h: N = x.bitXor(x.shiftRight(uint(16))).mul(uint(0x7feb352d));
  h = h.bitXor(h.shiftRight(uint(15))).mul(uint(0x846ca68b));
  return h.bitXor(h.shiftRight(uint(16)));
};

// Byte k of a hash as a value in [0, 1] (foamPattern.hashByte).
const hashByte = (h: N, k: number): N => float(h.shiftRight(uint(8 * k)).bitAnd(uint(255))).div(255);

// Signed cell index → its two's-complement bits (WGSL's u32(i32)), as foamPattern.hashCell.
const cellBits = (cell: N): N => cell.toInt().toUint();

// One octave of wind streaks (foamPattern.streakOctave) at wind-frame coordinates.
function streakOctaveNode(along: N, across: N, footprint: N, octave: number): N {
  const o = STREAK_OCTAVES[octave] as (typeof STREAK_OCTAVES)[number];
  const c = across.div(o.spacing);
  const cell = floor(c);
  const f = c.sub(cell);
  const h = hashU32(cellBits(cell).bitXor(uint(streakSalt(octave)))).toVar();
  const centre = hashByte(h, 0).mul(STREAK_CENTRE[1]).add(STREAK_CENTRE[0]);
  const halfWidth = hashByte(h, 1).mul(o.halfWidth[1]).add(o.halfWidth[0]);
  const brightness = hashByte(h, 2).mul(STREAK_BRIGHTNESS[1]).add(STREAK_BRIGHTNESS[0]);
  const length = hashByte(h, 3).mul(STREAK_LENGTH[1]).add(STREAK_LENGTH[0]).mul(o.length);
  const q = along.div(length).add(hashByte(h, 2).mul(7.3));
  const trail = floor(q);
  const g = q.sub(trail);
  const t = hashU32(h.bitXor(hashU32(cellBits(trail)))).toVar();
  const present = select(hashByte(t, 0).lessThan(STREAK_PRESENCE), float(1), float(0));
  const rise = hashByte(t, 1).mul(STREAK_RISE[1]).add(STREAK_RISE[0]);
  const fall = hashByte(t, 2).mul(STREAK_FALL[1]).add(STREAK_FALL[0]);
  const taper = smoothstep(0, rise, g).mul(float(1).sub(smoothstep(fall, 1, g)));
  const d = abs(f.sub(centre)).mul(o.spacing);
  const w = max(halfWidth, footprint.mul(STREAK_MIN_WIDTH));
  const x = min(d.div(w).pow(2), 1);
  const profile = float(1).sub(x).pow(2).mul(halfWidth.div(w));
  const lines = profile.mul(brightness).mul(taper).mul(present);
  // Broken into fragments along its length (foamPattern.streakGap).
  const s = along.div(o.gap).add(hashByte(h, 3).mul(13.7));
  const knot = floor(s);
  const k = s.sub(knot);
  const knotValue = (n: N): N =>
    hashByte(hashU32(h.bitXor(hashU32(cellBits(n).bitXor(uint(streakGapSalt))))), 0);
  const a = knotValue(knot);
  const gap = smoothstep(
    STREAK_GAP_EDGES[0],
    STREAK_GAP_EDGES[1],
    mix(a, knotValue(knot.add(1)), k.mul(k).mul(k.mul(-2).add(3))),
  );
  const fade = smoothstep(STREAK_FADE_START * o.spacing, STREAK_FADE_END * o.spacing, footprint);
  return mix(lines.mul(gap), float(STREAK_MEANS[octave] as number), fade).mul(o.weight);
}

// Rotates a 2D vector by a constant angle.
const rotate = (v: N, angle: number): N => {
  const c = Math.cos(angle);
  const sn = Math.sin(angle);
  return vec2(v.x.mul(c).sub(v.y.mul(sn)), v.x.mul(sn).add(v.y.mul(c)));
};

// Low-frequency foam fields (foamPattern.ts), centred on 0, and the wind frame they use.
interface FoamFields {
  along: N; // m downwind
  across: N; // m across the wind (left of it)
  region: N;
  patches: N;
  drift: N;
}

// foamPattern.foamMask
const foamMaskNode = (deviation: N): N => deviation.mul(FOAM_MASK_GAIN).add(1).clamp(0, FOAM_MASK_MAX);

// foamPattern.foamShown × foamBrightness: the white a foam amount shows of the bubble pattern at
// this footprint (its mean is linear in the amount, close up or far away).
function foamWhiteNode(amount: N, pattern: N, footprint: N): N {
  const a = amount.clamp(1e-5, 0.999);
  const centre = float(FOAM_PATTERN_MEAN).sub(
    tsl.log(a.div(float(1).sub(a))).mul(FOAM_PATTERN_STD * FOAM_LOGISTIC_SCALE),
  );
  const fade = float(1)
    .sub(pow(footprint.div(FOAM_PATTERN_FOOTPRINT).add(1), -FOAM_PATTERN_FALLOFF))
    .toVar();
  const std = float(1).sub(fade).mul(FOAM_PATTERN_STD);
  const softness = max(
    sqrt(max(float(FOAM_PATTERN_STD * FOAM_PATTERN_STD).sub(std.mul(std)), 0)).mul(FOAM_LOGISTIC_SCALE),
    FOAM_EDGE_SOFTNESS,
  );
  const shown = float(1).div(exp(centre.sub(pattern).div(softness)).add(1));
  return shown.mul(mix(amount.mul(0.4).add(0.6), FOAM_FAR_BRIGHTNESS, fade));
}

export interface OceanMaterialParams {
  groups: readonly CascadeGroup[];
  offsets: readonly N[]; // per group: uniformArray(vec2) of world-origin offsets per layer
  variances: readonly N[]; // per group: uniformArray(float) of analytic slope variance per layer
  jacobianStds: readonly N[]; // per group: uniformArray(float) of each layer's Jacobian deviation
  lagrangian: N; // fragment varying: Lagrangian (undisplaced) world xz
  previousPosition: N; // fragment varying: previous frame's world position (null: no motion vectors)
  foamDetail: Texture;
  quality: OceanShadingQuality;
  uniforms: OceanShadingUniforms;
  wake?: OceanWakeNodes;
  waterMask?: Texture;
  glint?: N; // direct-beam share of the directional light's colour (cloud cover), or none
}

// Per-pixel surface state built once in setupVariants and read by the lighting model.
interface OceanSurfaceNodes {
  front: N; // 1 above water (front face), 0 seen from below
  normal: N; // world
  normalView: N;
  viewWorld: N; // unit, surface → camera
  alpha2: N; // GGX α² of the filtered surface
  foam: N;
  crest: N; // 0..1 crest height for SSS
  transmittance: N; // vec3, refraction path transmittance (0 when refraction is off)
  refracted: N; // vec3 scene colour behind the surface
  fresnelView: N;
  glint: N; // direct-beam share of the sun/moon light, or null
}

// Forces the lighting model to run even when no scene light is visible (a moonless night still
// needs sky reflections and the water body).
class OceanAmbientNode extends LightingNode {}

class OceanLightingModel extends LightingModel {
  private s: OceanSurfaceNodes;
  private u: OceanShadingUniforms;
  private quality: OceanShadingQuality;

  constructor(surface: OceanSurfaceNodes, uniforms: OceanShadingUniforms, quality: OceanShadingQuality) {
    super();
    this.s = surface;
    this.u = uniforms;
    this.quality = quality;
  }

  // three's shadow lookups bias along `normalWorld`, derived from the cached `normalView` var. If
  // that var were first built inside a cascade's branch, other cascades would normalise a zero
  // vector, get NaN shadow coordinates and read as lit. Reading it here, before the lights,
  // assigns it unconditionally.
  override start(builder: NodeBuilder): void {
    vec3(0).toVar('oceanShadowNormal').assign(tsl.normalWorld);
    super.start(builder);
  }

  override direct({ lightDirection, lightColor, reflectedLight, lightNode }: LightingModelDirectInput): void {
    const { s, u } = this;
    const reflected = reflectedLight as N;
    const l: N = lightDirection;
    const color: N = lightColor;
    const n = s.normalView;
    const v = tsl.positionViewDirection;
    const nl = dot(n, l);
    const nv = max(dot(n, v), 1e-3);
    const h = normalize(l.add(v));
    const nh = saturate(dot(n, h));
    const vh = saturate(dot(v, h));
    const above = s.front.mul(float(1).sub(s.foam));

    // GGX glint, widened by the light's disk (variances add), Smith height-correlated visibility.
    const a2 = min(s.alpha2.add(u.lightDiskVariance), 1);
    const denom = nh.mul(nh).mul(a2.sub(1)).add(1);
    const d = a2.div(denom.mul(denom).mul(Math.PI));
    const nlc = saturate(nl);
    const gv = nlc.mul(sqrt(nv.mul(nv).mul(float(1).sub(a2)).add(a2)));
    const gl = nv.mul(sqrt(nlc.mul(nlc).mul(float(1).sub(a2)).add(a2)));
    const visibility = float(0.5).div(max(gv.add(gl), 1e-5));
    const fresnel = fresnelNode(vh, 1 / WATER_IOR);
    // Clamp keeps a perfectly aligned facet inside fp16 while still blooming.
    const specular = min(color.mul(d.mul(visibility).mul(fresnel).mul(nlc)), 3e4);
    // The sun/moon's colour carries the cloud shadow, whose long multiple-scattering tail lights
    // the sea diffusely under thick cloud; the glint is the disk's mirror image and takes only the
    // direct beam.
    const sun = (lightNode as { light?: { isDirectionalLight?: boolean } } | undefined)?.light
      ?.isDirectionalLight;
    const glint = sun && s.glint ? s.glint : 1;
    reflected.directSpecular.addAssign(specular.mul(above).mul(glint));

    // Light in world space for the body terms (which care about elevation, not microfacets).
    const lw = normalize(l.transformDirection(tsl.cameraWorldMatrix));
    const nw = s.normal;
    const vw = s.viewWorld;
    const elevation = saturate(lw.y);
    const transmit = float(1).sub(s.fresnelView).mul(above);
    const scattered = vec3(1).sub(s.transmittance);

    // Upwelling light from the water body: the light that entered (∝ irradiance) tinted by deepColor
    // (oceanOptics.seaUpwelling mirrors it and the glow below).
    const tilt = saturate(nl)
      .mul(1 - BODY_DIRECT_FLAT)
      .add(BODY_DIRECT_FLAT);
    const body = u.deepColor.mul(u.bodyScale).mul(color).mul(elevation.mul(tilt).mul(INV_PI));
    let diffuse: N = body.mul(scattered).mul(transmit);

    // Crest SSS: strongest looking toward the light through a crest whose face leans away from it.
    const toward = pow(saturate(dot(lw, vw.negate())), 4);
    const facing = pow(saturate(dot(lw, nw).mul(-0.5).add(0.5)), 2);
    const view = pow(saturate(dot(vw, nw)), 2);
    const crestTerm = this.quality.subsurface ? s.crest.mul(toward).mul(facing).mul(u.subsurfaceStrength) : 0;
    const sss = u.subsurfaceTint.mul(color).mul(view.mul(SUBSURFACE_VIEW).add(crestTerm).mul(INV_PI));
    diffuse = diffuse.add(sss.mul(transmit));

    // Foam: rough diffuse white with a little forward-scattered (translucent) light.
    const foamAlbedo = vec3(0.86, 0.88, 0.9);
    const wrap = saturate(dot(nw, lw).mul(0.6).add(0.4)).mul(saturate(elevation.mul(6)));
    const foamLight = foamAlbedo.mul(color).mul(wrap.mul(INV_PI));
    const foamGlow = u.subsurfaceTint.mul(color).mul(toward.mul(0.12));
    diffuse = diffuse.add(foamLight.add(foamGlow).mul(s.foam).mul(s.front));

    reflected.directDiffuse.addAssign(diffuse);
  }

  override indirect(builder: NodeBuilder): void {
    const { s, u } = this;
    const reflected = (builder.context as N).reflectedLight as N;
    const environment = (builder as N).environmentNode as N;
    const nw = s.normal;
    const vw = s.viewWorld;
    const back = float(1).sub(s.front);
    const above = s.front.mul(float(1).sub(s.foam));

    // Perceptual roughness (three's PMREM parameter) is √α.
    const roughness = sqrt(sqrt(s.alpha2));
    const r = vw.negate().reflect(nw);
    // Rays reflected below the horizon would hit the next wave; reflect the low sky, dimmed.
    const lookup = vec3(r.x, abs(r.y), r.z);
    const dip = mix(0.7, 1, smoothstep(-0.2, 0, r.y));
    let sky: N = vec3(0);
    let reflection: N = vec3(0);
    const snell: N = vec3(0).toVar('oceanSnell');
    if (environment?.isTextureNode) {
      const envMap = environment.value as Texture;
      const intensity = materialEnvIntensity;
      reflection = pmremTexture(envMap, lookup, roughness).rgb.mul(intensity).mul(dip);
      // Hemispherical sky radiance (irradiance / π) onto the sea.
      sky = pmremTexture(envMap, vec3(0, 1, 0), float(1)).rgb.mul(intensity);
      // From below: the sky refracted through Snell's window (explicit-LOD lookup, so it may branch).
      tsl.If(s.front.lessThan(0.5), () => {
        const out = refract(vw.negate(), nw.negate(), WATER_IOR);
        const outDir = select(dot(out, out).lessThan(1e-4), vec3(0, 1, 0), normalize(out));
        snell.assign(pmremTexture(envMap, outDir, roughness.add(0.05)).rgb.mul(intensity));
      });
    }
    // Lightning: the lit cloud base where the reflected ray meets it, falling off from the source
    // as the clouds shade it, and its glow over the whole sky for the water body and foam.
    const reach = u.flashBase.sub(positionWorld.y).div(max(lookup.y, 0.02));
    const base = positionWorld.add(lookup.mul(reach));
    const glow = exp(length(base.sub(u.flashSource)).mul(-FLASH_FALLOFF / 1000));
    reflection = reflection.add(u.flashRadiance.mul(glow).mul(dip));
    sky = sky.add(u.flashSky);

    // Rough surfaces reflect less at grazing (Fdez-Agüera's roughness-aware Fresnel).
    const grazing = max(float(1).sub(roughness), WATER_F0)
      .sub(WATER_F0)
      .div(1 - WATER_F0);
    const fresnel = mix(float(WATER_F0), s.fresnelView, grazing);
    reflected.indirectSpecular.addAssign(reflection.mul(fresnel).mul(above));

    const transmit = float(1).sub(fresnel).mul(above);
    const scattered = vec3(1).sub(s.transmittance);
    const body = u.deepColor.mul(u.bodyScale).mul(sky);
    const sssAmbient = u.subsurfaceTint
      .mul(sky)
      .mul(s.crest.mul(SUBSURFACE_AMBIENT_CREST).add(SUBSURFACE_AMBIENT));
    const foamAmbient = vec3(0.86, 0.88, 0.9).mul(sky).mul(s.foam).mul(s.front);
    const refracted = s.refracted.mul(s.transmittance);
    let diffuse: N = body.mul(scattered).add(sssAmbient).add(refracted).mul(transmit).add(foamAmbient);

    // Underside: Snell's window inside the critical angle, the water body mirrored outside it.
    const cosUnder = saturate(dot(vw, nw.negate()));
    const fresnelUnder = fresnelNode(cosUnder, WATER_IOR);
    const waterBelow = u.deepColor.mul(sky).mul(0.8).add(u.subsurfaceTint.mul(sky).mul(0.02));
    const under = snell.add(u.flashSky).mul(float(1).sub(fresnelUnder)).add(waterBelow.mul(fresnelUnder));
    diffuse = diffuse.add(under.mul(back));

    reflected.indirectDiffuse.addAssign(diffuse);
  }
}

export class OceanMaterial extends NodeMaterial {
  private params: OceanMaterialParams;
  private surface: OceanSurfaceNodes | null = null;
  private refractionDepth: ViewportDepthCopy | null = null;
  private refractionColor: ViewportColorCopy | null = null;
  private motionVectors = false;
  private reflections = false;

  constructor(params: OceanMaterialParams) {
    super();
    this.params = params;
    this.lights = true;
    this.side = DoubleSide;
    this.name = 'ocean';
    if (params.quality.refraction) this.useOpaqueCopies();
    if (params.waterMask) this.maskNode = WaterMask.keepNode(params.waterMask);
    // Only the sun/moon (CSM) shadows the sea: the boats' shadowed deck floods would each add a shadow
    // map and sampler, and the fragment stage is already near WebGPU's 16-sampler limit.
    this.contextNode = context({
      getShadow: (light: {
        light: { isDirectionalLight?: boolean };
        baseColorNode: N;
        shadowColorNode: N;
      }) => (light.light.isDirectionalLight ? light.shadowColorNode : light.baseColorNode),
    });
    // The shadow lookup's normal bias reads three's normal. The grid has no normal attribute and the
    // sea casts no shadow, so plain up is enough (no slope-aware bias).
    this.normalNode = vec3(0, 1, 0).transformDirection(cameraViewMatrix);
  }

  // TRAA: writes the ocean's own motion vectors (its vertices move every frame).
  setMotionVectors(enabled: boolean): void {
    const next = enabled && this.params.previousPosition !== undefined;
    if (next === this.motionVectors) return;
    this.motionVectors = next;
    const previous = this.params.previousPosition;
    this.mrtNode = next && previous ? mrt({ velocity: this.velocityNode(previous) }) : null;
    this.needsUpdate = true;
  }

  // The opaque scene's colour and depth as the ocean saw them this frame (the SSR pass traces
  // them after the scene pass), or null without refraction or SSR.
  get opaqueCopies(): { color: Texture; depth: DepthTexture } | null {
    if (!this.refractionDepth || !this.refractionColor) return null;
    return { color: this.refractionColor.target, depth: this.refractionDepth.target };
  }

  // Refraction and SSR sample copies of the opaque scene, so the ocean draws after it (first among
  // transparents).
  private useOpaqueCopies(): void {
    if (this.refractionDepth) return;
    this.transparent = true;
    this.forceSinglePass = true;
    this.depthWrite = true;
    // Reversed-Z renders into depth32float, and the copy must match it. One copy for every lookup
    // and render target (refraction and SSR read the same opaque depth), freed with the material.
    this.refractionDepth = new ViewportDepthCopy(1, 1);
    this.refractionDepth.type = FloatType;
    this.refractionColor = new ViewportColorCopy(1, 1);
  }

  override dispose(): void {
    this.refractionDepth?.dispose();
    this.refractionDepth = null;
    this.refractionColor?.dispose();
    this.refractionColor = null;
    super.dispose();
  }

  // Screen-space reflections (post/OceanReflections.ts) trace the opaque copies refraction makes
  // (Medium and up); on Low, asking for them makes the copies without turning refraction on.
  setReflections(enabled: boolean): void {
    if (enabled) this.useOpaqueCopies();
    if (enabled === this.reflections) return;
    this.reflections = enabled;
    if (!this.params.quality.refraction) this.needsUpdate = true;
  }

  // z = 1 marks the sea in the velocity buffer (everything else writes 0): post GTAO skips it.
  private velocityNode(previous: N): N {
    const u = this.params.uniforms;
    const current = u.viewProjection.mul(vec4(positionWorld, 1));
    const before = u.previousViewProjection.mul(vec4(previous, 1));
    return vec3(current.xy.div(current.w).sub(before.xy.div(before.w)), 1);
  }

  override setupMaterialLightings(builder: NodeBuilder): LightingNode[] {
    return [...super.setupMaterialLightings(builder), new OceanAmbientNode()];
  }

  override setupLightingModel(): LightingModel {
    if (!this.surface) throw new Error('OceanMaterial: setupVariants must run before lighting');
    return new OceanLightingModel(this.surface, this.params.uniforms, this.params.quality);
  }

  override setupVariants(): void {
    this.surface = this.buildSurface();
  }

  private buildSurface(): OceanSurfaceNodes {
    const p = this.params;
    const u = p.uniforms;
    const xz: N = p.lagrangian;
    // World metres per pixel along the worse screen axis.
    const footprint = max(dFdx(xz).length(), dFdy(xz).length()).toVar('oceanFootprint');

    const cascades = this.sampleCascades(xz, footprint);
    // Foam-making cascades: accumulated foam and strain (∂Dx/∂x, ∂Dz/∂z), combined below.
    const foamLayers: { patch: number; foam: N; strain: N; std: N }[] = [];
    let foamSlope: N = vec2(0); // ∂h/∂x, ∂h/∂z of the foam-making cascades
    for (const { patch, g, layer, d, f, weight } of cascades.layers) {
      if (patch < FOAM_MIN_PATCH) continue;
      foamSlope = foamSlope.add(d.xy.mul(weight));
      foamLayers.push({
        patch,
        foam: max(f.x, 0).mul(weight),
        strain: d.zw.mul(weight),
        std: p.jacobianStds[g]?.element(layer),
      });
    }
    // Each cascade's foam tiles at its patch, so its copies are told apart (foamPattern.ts): longest
    // first, each is masked by a low-frequency field, and its accumulated foam follows the next
    // longer cascade's crests (breaking groups).
    const fields = this.foamFields(xz);
    const masks = [
      float(1),
      foamMaskNode(fields.region),
      foamMaskNode(fields.patches.add(fields.drift.mul(MASK_PATCH_DRIFT))),
      foamMaskNode(fields.drift.mul(MASK_SHORT_DRIFT).add(fields.patches.mul(MASK_SHORT_PATCHES))),
    ];
    let foamAmount: N = float(0);
    let strain: N = vec2(0); // of the foam-making cascades
    foamLayers.sort((a, b) => b.patch - a.patch);
    foamLayers.forEach((layer, rank) => {
      const mask = (masks[Math.min(rank, masks.length - 1)] as N).toVar();
      const weight = foamCascadeWeight(layer.patch);
      const longer = foamLayers[rank - 1];
      let group: N = float(1);
      if (longer) {
        const z = longer.strain.x.add(longer.strain.y).div(max(longer.std, 1e-3));
        group = float(GROUP_OFFSET).sub(z).clamp(0, GROUP_MAX).mul(GROUP_SCALE);
      }
      foamAmount = foamAmount.add(
        layer.foam
          .mul(mask)
          .mul(group)
          .mul(weight * FOAM_ACCUMULATED_GAIN),
      );
      const strainMask = mix(1, mask.div(FOAM_MASK_RMS), FOAM_STRAIN_MASK);
      strain = strain.add(layer.strain.mul(strainMask.mul(weight)));
    });
    const { normal, alpha2, wake } = this.surfaceNormal(xz, footprint, cascades);

    const front = select(frontFacing, float(1), float(0)).toVar('oceanFront');
    const viewWorld = normalize(cameraPosition.sub(positionWorld)).toVar('oceanView');
    const normalView = normal.transformDirection(cameraViewMatrix).toVar('oceanNormalView');
    const fresnelView = fresnelNode(max(dot(normal, viewWorld), 0), 1 / WATER_IOR).toVar('oceanFresnel');

    // Crest height above mean sea level (undo the Earth-curvature drop applied to the mesh).
    const toCamera = xz.sub(cameraPosition.xz);
    const height = positionWorld.y.add(dot(toCamera, toCamera).div(2 * EARTH_RADIUS));
    const crest = saturate(height.div(u.waveAmplitude)).toVar('oceanCrest');

    let wakeFoam: N = p.wake ? wake.w.add(p.wake.trail(xz).mul(0.9)) : float(0);

    let transmittance: N = vec3(0);
    let refracted: N = vec3(0);
    if (this.refractionDepth && this.params.quality.refraction) {
      const surfaceDepth = positionView.z.negate();
      const flat = vec3(0, 1, 0).transformDirection(cameraViewMatrix);
      const bend = normalView.sub(flat).xy;
      const offset = vec2(bend.x, bend.y.negate()).mul(u.refractionStrength).div(max(surfaceDepth, 1));
      const sceneDepthAt = (uv: N): N =>
        perspectiveDepthToViewZ(
          viewportDepthTexture(uv, null, this.refractionDepth),
          cameraNear,
          cameraFar,
        ).negate();
      const bent = screenUV.add(offset);
      // Anything in front of the surface (a hull above water) must not leak into the refraction.
      const uv = select(sceneDepthAt(bent).lessThan(surfaceDepth), screenUV, bent).toVar('oceanRefractUv');
      const sceneDepth = sceneDepthAt(uv);
      const pathScale = positionView.length().div(max(surfaceDepth, 1e-3));
      const thickness = max(sceneDepth.sub(surfaceDepth), 0).mul(pathScale);
      const extinction = u.absorption.add(u.scattering);
      transmittance = exp(extinction.mul(thickness.min(200)).negate())
        .mul(front)
        .toVar('oceanTransmittance');
      refracted = viewportTexture(uv, null, this.refractionColor).rgb;
      // Where the surface meets a hull: the scene right behind the water is within a hand's breadth.
      const gap = max(sceneDepthAt(screenUV).sub(surfaceDepth), 0).mul(pathScale);
      wakeFoam = wakeFoam.add(
        float(1)
          .sub(smoothstep(0.08, 0.6, gap))
          .mul(0.6)
          .mul(front),
      );
    }
    // Wake foam shows once thick (foamPattern.wakeFoamAmount).
    const wakeAmount = wakeFoam.mul(smoothstep(WAKE_FOAM_EDGES[0], WAKE_FOAM_EDGES[1], wakeFoam));
    const foam = this.buildFoam(fields, footprint, strain, foamSlope, foamAmount.add(wakeAmount)).toVar(
      'oceanFoam',
    );
    // The copies happen when a shader reads them: for SSR without refraction, a read that adds
    // nothing.
    let roughness: N = alpha2;
    if (this.reflections && !this.params.quality.refraction && this.refractionDepth) {
      const depth = viewportDepthTexture(screenUV, null, this.refractionDepth).x;
      const color = viewportTexture(screenUV, null, this.refractionColor).r;
      roughness = alpha2.add(select(depth.add(color).greaterThan(1e30), float(1e-30), float(0)));
    }

    return {
      front,
      normal,
      normalView,
      viewWorld,
      alpha2: roughness,
      foam,
      crest,
      transmittance,
      refracted,
      fresnelView,
      glint: this.params.glint ?? null,
    };
  }

  // Every cascade's derivatives and moments at a Lagrangian point, faded by the pixel footprint,
  // their summed slopes and the LEAN variance of what the footprint filters away.
  // lodFootprint: sample at the mip level of that footprint (m) instead of the screen derivatives.
  private sampleCascades(
    xz: N,
    footprint: N,
    lodFootprint: N = null,
  ): { slope: N; variance: N; layers: { patch: number; g: number; layer: number; d: N; f: N; weight: N }[] } {
    const p = this.params;
    let slope: N = vec4(0);
    let variance: N = float(0);
    const layers: { patch: number; g: number; layer: number; d: N; f: N; weight: N }[] = [];
    p.groups.forEach((group, g) => {
      group.patchLengths.forEach((patch, layer) => {
        const weight = float(1).sub(smoothstep(patch * 0.12, patch * 0.5, footprint));
        const uv = xz
          .add(p.offsets[g]?.element(layer))
          .div(patch)
          .add(0.5 / group.size);
        let d: N = texture(group.derivatives, uv).depth(layer);
        let f: N = texture(group.foam, uv).depth(layer);
        if (lodFootprint) {
          const lod = log2(max(lodFootprint.mul(group.size / patch), 1)).toVar();
          d = d.level(lod);
          f = f.level(lod);
        }
        d = d.toVar();
        f = f.toVar();
        slope = slope.add(d.mul(weight));
        // LEAN: E[s²] − E[s]² is what this footprint averaged away; once faded, all of it.
        const lean = max(f.z.sub(d.x.mul(d.x)), 0).add(max(f.w.sub(d.y.mul(d.y)), 0));
        variance = variance.add(mix(p.variances[g]?.element(layer), lean, weight));
        layers.push({ patch, g, layer, d, f, weight });
      });
    });
    return { slope, variance, layers };
  }

  // The shading normal (waves, boat wakes, rain ripples) and GGX α² at a Lagrangian point.
  private surfaceNormal(
    xz: N,
    footprint: N,
    cascades: { slope: N; variance: N },
    explicitLod = false,
  ): { normal: N; alpha2: N; wake: N } {
    const p = this.params;
    const u = p.uniforms;
    const s = cascades.slope.toVar('oceanSlope');
    // Boat wakes: (η, ∂η/∂x, ∂η/∂z, crest foam), slopes added to the waves'.
    let wake: N = vec4(0);
    if (p.wake) wake = (explicitLod ? p.wake.surfaceLevel0(xz) : p.wake.surface(xz)).toVar('oceanWake');
    // Rain ripples: drawn where a pixel is small enough to resolve the rings, roughness beyond.
    const ripple = vec2(0).toVar('oceanRipple');
    const rippleDetail = smoothstep(RIPPLE_FOOTPRINT_GONE, RIPPLE_FOOTPRINT_FULL, footprint).toVar();
    If(u.rippleDensity.greaterThan(0).and(rippleDetail.greaterThan(0)), () => {
      ripple.assign(rippleSlope(xz, u).mul(rippleDetail));
    });
    const sx = s.x
      .div(max(s.z.add(1), 0.2))
      .add(wake.y)
      .add(ripple.x);
    const sz = s.y
      .div(max(s.w.add(1), 0.2))
      .add(wake.z)
      .add(ripple.y);
    const normal = normalize(vec3(sx.negate(), 1, sz.negate())).toVar('oceanNormal');
    const rippleRoughness = u.rippleVariance.mul(float(1).sub(rippleDetail));
    const alpha2 = min(cascades.variance.add(u.baseVariance).add(rippleRoughness), 1).toVar('oceanAlpha2');
    return { normal, alpha2, wake };
  }

  // The sea's shading normal (world) and GGX α² at a Lagrangian point xz (render frame), as this
  // material shades them, for passes that look at the sea after it is drawn (the SSR pass,
  // post/OceanReflections.ts): footprint (m per pixel, worse axis) fades the cascades, lodFootprint
  // (the finer axis, as anisotropic filtering would) picks their mip levels. Explicit LODs only,
  // so it may run in branches. Foam is not included.
  surfaceAt(xz: N, footprint: N, lodFootprint: N): { normal: N; alpha2: N } {
    const cascades = this.sampleCascades(xz, footprint, lodFootprint);
    const { normal, alpha2 } = this.surfaceNormal(xz, footprint, cascades, true);
    return { normal, alpha2 };
  }

  // The low-frequency foam fields: the detail texture's density, sampled at large scales rotated off
  // the cascade grid (region, patches) and along the wind (drift).
  private foamFields(xz: N): FoamFields {
    const detail = this.params.foamDetail;
    const wind = this.params.uniforms.windDirection;
    const along = dot(xz, wind).toVar('oceanFoamAlong');
    const across = dot(xz, vec2(wind.y.negate(), wind.x)).toVar('oceanFoamAcross');
    const density = (uv: N): N => texture(detail, uv).y.sub(0.5);
    const turned = (angle: number, tile: number, offset: number): N =>
      vec2(
        xz.x.mul(Math.cos(angle)).sub(xz.y.mul(Math.sin(angle))),
        xz.x.mul(Math.sin(angle)).add(xz.y.mul(Math.cos(angle))),
      )
        .div(tile)
        .add(offset);
    const drift = vec2(along.div(FOAM_DRIFT_ALONG), across.div(FOAM_DRIFT_ACROSS)).add(0.29);
    return {
      along,
      across,
      region: density(turned(FOAM_REGION_ANGLE, FOAM_REGION_TILE, 0.13)).toVar('oceanFoamRegion'),
      patches: density(turned(FOAM_PATCH_ANGLE, FOAM_PATCH_TILE, 0.71)).toVar('oceanFoamPatches'),
      drift: density(drift).toVar('oceanFoamDrift'),
    };
  }

  // Whitecap foam: accumulated (persistent) foam plus crests compressed past the threshold, shaped by
  // the bubble texture and stretched along the wind; wind streaks where foam is being drawn out.
  private buildFoam(fields: FoamFields, footprint: N, strain: N, slope: N, accumulated: N): N {
    const u = this.params.uniforms;
    const detail = this.params.foamDetail;
    const { along, across, region, drift } = fields;
    const stretch = u.foamStreaks.mul(2.5).add(1);
    // The drift bends the bubble cells, so neither tile's copies line up with the next.
    const warp = drift.mul(LACE_WARP);
    const windUv = vec2(along.div(stretch).add(warp), across.sub(warp)).toVar();
    const coarse = texture(detail, windUv.div(LACE_COARSE_TILE)).toVar();
    let lace: N = coarse.x;
    if (this.params.quality.foamOctaves > 1) {
      const fine = texture(detail, rotate(windUv, LACE_FINE_ANGLE).div(LACE_FINE_TILE).add(0.37));
      lace = mix(coarse.x, fine.x, 0.45);
    }
    lace = lace.toVar('oceanLace');
    // Combined Jacobian of the foam-making cascades (cross term omitted): crests about to break,
    // more of them in some regions of the sea than others.
    const jacobian = strain.x.add(1).mul(strain.y.add(1));
    const reach = float(1).sub(u.crestThreshold);
    const threshold = u.crestThreshold.add(reach.mul(region.mul(FOAM_REGION_THRESHOLD)));
    const crest = smoothstep(threshold.add(0.1), threshold.sub(0.15), jacobian);
    const amount = saturate(accumulated.mul(0.8).add(crest).mul(u.foamCoverage));
    // Thick foam (fresh wakes, breaking crests) fills in its cells; thin foam keeps the lace.
    const thick = smoothstep(0.55, 1, amount);
    const pattern = mix(lace.mul(coarse.y.mul(0.6).add(0.55)), coarse.y.mul(0.3).add(0.75), thick);
    // Thin foam shows only the brightest bubble walls; thick foam closes up, keeping some structure.
    const whitecap = foamWhiteNode(amount, pattern, footprint).mul(
      float(1).sub(thick.mul(FOAM_THICK_LACE).mul(float(1).sub(lace))),
    );
    // Beaufort 7+: wind streaks, fine broken threads in a few octaves (nothing to tile), bent by
    // the drift and the region.
    const streaks = float(0).toVar('oceanStreaks');
    If(u.foamStreaks.greaterThan(0), () => {
      const xz = this.params.lagrangian;
      const bend = drift.mul(STREAK_WARP).add(region.mul(STREAK_REGION_WARP));
      let lines: N = float(0);
      STREAK_OCTAVES.forEach((octave, i) => {
        const dir = rotate(u.windDirection, octave.angle);
        const a = dot(xz, dir);
        const c = dot(xz, vec2(dir.y.negate(), dir.x)).add(bend);
        lines = lines.add(streakOctaveNode(a, c, footprint, i));
      });
      // Foam drawn out downwind of breaking crests (strongest on their lee faces), and towards a
      // hurricane old foam and spume in wind-aligned bands everywhere; frayed by the bubbles.
      const lee = smoothstep(STREAK_LEE[0], STREAK_LEE[1], dot(slope, u.windDirection));
      const trail = smoothstep(STREAK_TRAIL[0], STREAK_TRAIL[1], accumulated).mul(
        mix(STREAK_WINDWARD, 1, lee),
      );
      const band = smoothstep(STREAK_BAND[0], STREAK_BAND[1], drift.add(region.mul(STREAK_BAND_REGION)));
      const base = u.foamSpume.mul(u.foamSpume).mul(STREAK_BASE).mul(band);
      const fray = smoothstep(STREAK_FRAY[0], STREAK_FRAY[1], lace.mul(0.7).add(coarse.z.mul(0.5)));
      const gain = u.foamSpume.mul(STREAK_SPUME_GAIN).add(1).mul(STREAK_GAIN);
      streaks.assign(saturate(lines.mul(gain)).mul(max(trail, base)).mul(u.foamStreaks).mul(fray));
    });
    return saturate(max(whitecap, streaks));
  }
}

// Per layer: the Jacobian deviation λ·√(mean-square slope) (refreshed with the statistics).
export const createFoamJacobianStds = (groups: readonly CascadeGroup[]): N[] =>
  groups.map((group) =>
    uniformArray(
      group.statistics.map((s, layer) =>
        jacobianStd(group.choppiness[layer] ?? 1, s.slopeVarianceX + s.slopeVarianceZ),
      ),
      'float',
    ),
  );

export const createOceanVariances = (groups: readonly CascadeGroup[]): N[] =>
  groups.map((group) =>
    uniformArray(
      group.statistics.map((s) => s.slopeVarianceX + s.slopeVarianceZ),
      'float',
    ),
  );
