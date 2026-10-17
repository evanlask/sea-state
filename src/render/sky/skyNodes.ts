// Sky shading nodes: the sky radiance seen along a direction (sky-view LUT + sun disk with limb
// darkening + moon disk shaded by phase with earthshine + catalogue stars + airglow), and the
// aerial-perspective lookup for surfaces. All outputs are pre-exposed linear Rec.709 radiance.

import { Matrix3, Matrix4, Vector2, Vector3 } from 'three/webgpu';

import { releaseBuffer } from '../gpuResources';
import { type N, tsl } from '../tsl';
import {
  AERIAL_SIZE,
  type AtmosphereLuts,
  type AtmosphereUniforms,
  PLANET_RADIUS,
  zenithHorizonAngle,
} from './AtmosphereLuts';
import { MOON_ANGULAR_RADIUS, MOON_TINT, solidAngle, SUN_ANGULAR_RADIUS } from './atmosphereParams';
import { DEFAULT_STAR_GRID, STAR_ENTRY_FLOATS, type StarGrid } from './stars';

const {
  Fn,
  If,
  Loop,
  abs,
  acos,
  atan,
  attributeArray,
  clamp,
  cos,
  cross,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  pow,
  saturate,
  select,
  sin,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} = tsl;

const FP16_SAFE = 60000;
const STAR_SKY_LIMIT = 200; // cd/m²
const LUMA = [0.2126, 0.7152, 0.0722] as const;
// Natural night-sky brightness at a dark site, ~21.8 mag/arcsec² V [K]: airglow plus a floor for
// integrated starlight and zodiacal light, in cd/m².
const AIRGLOW_ZENITH = 1.2e-4;
const NIGHT_FLOOR = 0.6e-4;
// van Rhijn: an airglow layer ~100 km up looks brighter toward the horizon.
const AIRGLOW_RATIO = (PLANET_RADIUS / (PLANET_RADIUS + 100)) ** 2;

export interface SkyRadianceOptions {
  sun?: boolean;
  moon?: boolean;
  moonMask?: boolean; // hide the stars behind the moon even when the disk isn't drawn
  stars?: boolean;
  exposure: N; // pre-exposure multiplier node
}

export interface AerialPerspectiveNodes {
  transmittance: N; // float, 0..1
  inscatter: N; // vec3, pre-exposed radiance to add
}

// Keep within fp16, scaling rather than clipping so a low sun keeps its colour.
const fp16Scaled = (radiance: N): N => {
  const exposed = radiance.toVar();
  const peak = max(max(exposed.x, exposed.y), max(exposed.z, 1e-6));
  return exposed.mul(min(float(FP16_SAFE).div(peak), 1));
};

const toSubUv = (u: N, resolution: number): N => u.add(0.5 / resolution).mul(resolution / (resolution + 1));

const tintLuminance = MOON_TINT[0] * LUMA[0] + MOON_TINT[1] * LUMA[1] + MOON_TINT[2] * LUMA[2];

export class SkyShading {
  readonly overcast: N = uniform(0);
  readonly moonPhaseAngle: N = uniform(Math.PI);
  readonly moonRadianceScale: N = uniform(0); // cd/m² per unit Lommel-Seeliger × albedo
  readonly earthshine: N = uniform(0); // cd/m² on the unlit disk
  readonly worldToCelestial: N = uniform(new Matrix3());
  readonly starBrightness: N = uniform(1);
  readonly inscatterScale: N = uniform(1); // aerial-perspective inscatter (cloud shadowing)
  // The air under a cloud deck (physical cd/m²) and the share of the haze it lights instead of the
  // sun and clear sky (SkySystem.setOvercastAir; none by default).
  overcastAir: N = uniform(new Vector3());
  overcastWeight: N = uniform(0);
  murk: N = uniform(0); // 1/km, rain and mist under the deck
  // Main-camera state for aerial-perspective lookups (independent of the rendering camera).
  readonly apViewMatrix: N = uniform(new Matrix4());
  readonly apProjection: N = uniform(new Vector2(1, 1)); // 1 / tan(half fov) per axis
  readonly apCameraPosition: N = uniform(new Vector3());
  private luts: AtmosphereLuts;
  private u: AtmosphereUniforms;
  private cells: N;
  private stars: N;
  private gridSize: number;
  private maxEntries: number;

  constructor(luts: AtmosphereLuts, uniforms: AtmosphereUniforms) {
    this.luts = luts;
    this.u = uniforms;
    this.gridSize = DEFAULT_STAR_GRID.gridSize;
    this.maxEntries = DEFAULT_STAR_GRID.maxEntries;
    const cellCount = 6 * this.gridSize * this.gridSize;
    // (start, count) as floats: exact below 2^24, and avoids integer storage quirks.
    this.cells = attributeArray(cellCount, 'vec2').toReadOnly();
    this.stars = attributeArray(this.maxEntries * (STAR_ENTRY_FLOATS / 4), 'vec4').toReadOnly();
  }

  // Frees the star buffers (three keeps storage buffers allocated otherwise, see gpuResources).
  dispose(): void {
    releaseBuffer(this.cells.value);
    releaseBuffer(this.stars.value);
  }

  get starGridOptions(): { gridSize: number; maxEntries: number } {
    return { gridSize: this.gridSize, maxEntries: this.maxEntries };
  }

  setStarGrid(grid: StarGrid): void {
    const cells = this.cells.value.array as Float32Array;
    const stars = this.stars.value.array as Float32Array;
    cells.set(grid.cells.subarray(0, cells.length));
    stars.fill(0);
    stars.set(grid.entries.subarray(0, Math.min(stars.length, grid.entryCount * STAR_ENTRY_FLOATS)));
    this.cells.value.needsUpdate = true;
    this.stars.value.needsUpdate = true;
  }

  // Sky-view LUT radiance (physical cd/m²) along a unit direction; horizon value below it.
  private skyViewLuminance(d: N): N {
    const h = this.luts.quality.skyView[1];
    const r0 = this.u.viewRadius;
    const zha = zenithHorizonAngle(r0);
    const zenithAngle = min(acos(clamp(d.y, -1, 1)), zha);
    const coord = sqrt(max(float(1).sub(zenithAngle.div(zha)), 0));
    const v = toSubUv(coord.oneMinus(), h);
    // Azimuth clockwise from north (−Z), matching the LUT kernel; the LUT repeats in u.
    const azimuth = fract(
      atan(d.x, d.z.negate())
        .div(2 * Math.PI)
        .add(1),
    );
    return texture(this.luts.skyView, vec2(azimuth, v)).level(0).rgb;
  }

  private viewTransmittance(d: N): N {
    return this.luts.sampleTransmittance(this.u.viewRadius, max(d.y, 0));
  }

  private sunDisk(d: N, pixel: N, horizon: N, transmittance: N): N {
    const s = this.u.sunDirection;
    const angle = atan(length(cross(d, s)), dot(d, s));
    const edge = saturate(float(SUN_ANGULAR_RADIUS).sub(angle).div(pixel).add(0.5));
    // Limb darkening (Neckel & Labs fit as in the references), normalised to conserve flux.
    const c = saturate(angle.div(SUN_ANGULAR_RADIUS));
    const mu = sqrt(max(c.mul(c).oneMinus(), 0));
    const a = vec3(0.397, 0.503, 0.652);
    const limb = pow(vec3(mu), a).mul(a.mul(0.5).add(1));
    const luminance = this.u.sunIlluminance.div(solidAngle(SUN_ANGULAR_RADIUS));
    const clear = pow(this.overcast.oneMinus(), 4);
    return luminance.mul(transmittance).mul(limb).mul(edge.mul(horizon).mul(clear));
  }

  // Returns (radiance, coverage) so the disk can hide the stars behind it.
  private moonDisk(d: N, pixel: N, horizon: N, transmittance: N): { radiance: N; coverage: N } {
    const m = this.u.moonDirection;
    const cosAngle = dot(d, m);
    const angle = atan(length(cross(d, m)), cosAngle);
    const coverage = saturate(float(MOON_ANGULAR_RADIUS).sub(angle).div(pixel).add(0.5)).mul(horizon);
    const helper = select(abs(m.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
    const e1 = normalize(cross(helper, m));
    const e2 = cross(m, e1);
    const offset = d.sub(m.mul(cosAngle));
    const sinRadius = Math.sin(MOON_ANGULAR_RADIUS);
    const px = dot(offset, e1).div(sinRadius);
    const py = dot(offset, e2).div(sinRadius);
    const pz = sqrt(max(float(1).sub(px.mul(px)).sub(py.mul(py)), 0));
    const normal = e1.mul(px).add(e2.mul(py)).sub(m.mul(pz));
    // Sunlight direction at the moon: phase angle away from the earth, toward the sun's side.
    const sunSide = this.u.sunDirection.sub(m.mul(dot(this.u.sunDirection, m)));
    const toward = select(length(sunSide).greaterThan(1e-5), normalize(sunSide), e1);
    const phase = this.moonPhaseAngle;
    const light = m
      .negate()
      .mul(cos(phase))
      .add(toward.mul(sin(phase)));
    const mu0 = max(dot(normal, light), 0);
    const lommelSeeliger = mu0.div(mu0.add(pz).add(1e-4));
    // Maria and highlands: low-frequency noise fixed to the disk (the moon is tidally locked).
    const surface = vec3(px, py, pz);
    const maria = smoothstep(-0.05, 0.45, mx_noise_float(surface.mul(2.2).add(vec3(3.1, 1.7, 0.4))));
    const speckle = mx_noise_float(surface.mul(11).add(7.3)).mul(0.06);
    const albedo = float(1).sub(maria.mul(0.32)).add(speckle);
    const tint = vec3(MOON_TINT[0], MOON_TINT[1], MOON_TINT[2]).div(tintLuminance);
    const luminance = this.moonRadianceScale.mul(lommelSeeliger).add(this.earthshine).mul(albedo);
    const clear = pow(this.overcast.oneMinus(), 2);
    return { radiance: tint.mul(luminance).mul(transmittance).mul(coverage.mul(clear)), coverage };
  }

  // Cube-cell lookup of the star grid; Gaussian PSF about a pixel wide, normalised to the star's
  // illuminance, so brightness follows magnitude at any resolution.
  private starField(d: N, pixel: N): N {
    const g = this.gridSize;
    const c = this.worldToCelestial.mul(d);
    const a = abs(c);
    const xMajor = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z));
    const yMajor = xMajor.not().and(a.y.greaterThanEqual(a.z));
    const face = select(
      xMajor,
      select(c.x.greaterThanEqual(0), uint(0), uint(1)),
      select(
        yMajor,
        select(c.y.greaterThanEqual(0), uint(2), uint(3)),
        select(c.z.greaterThanEqual(0), uint(4), uint(5)),
      ),
    );
    const major = select(xMajor, a.x, select(yMajor, a.y, a.z));
    const fu = select(xMajor, c.y, c.x).div(major);
    const fv = select(xMajor.or(yMajor), c.z, c.y).div(major);
    const cellOf = (s: N): N => uint(clamp(floor(s.mul(0.5).add(0.5).mul(g)), 0, g - 1));
    const cell = face
      .mul(uint(g * g))
      .add(cellOf(fv).mul(uint(g)))
      .add(cellOf(fu));
    const range = this.cells.element(cell).toVar();
    const start = uint(range.x).toVar();
    const count = uint(range.y).toVar();
    const sigma = max(pixel.mul(0.55), 1.5e-5);
    const inv2s2 = float(0.5).div(sigma.mul(sigma)).toVar();
    const sum = vec3(0).toVar();
    Loop({ start: uint(0), end: count, type: 'uint', condition: '<' }, ({ i }: { i: N }) => {
      const base = start.add(i).mul(uint(2));
      const position = this.stars.element(base);
      const colour = this.stars.element(base.add(uint(1)));
      const delta = c.sub(position.xyz);
      sum.addAssign(colour.xyz.mul(position.w.mul(exp(dot(delta, delta).mul(inv2s2).negate()))));
    });
    return sum.mul(inv2s2.div(Math.PI)).mul(this.starBrightness);
  }

  private airglow(d: N): N {
    const cosZenith = max(d.y, 0);
    const sin2 = cosZenith.mul(cosZenith).oneMinus();
    const vanRhijn = float(1).div(sqrt(max(float(1).sub(sin2.mul(AIRGLOW_RATIO)), 0.02)));
    const glow = vec3(0.85, 1.08, 0.82).mul(AIRGLOW_ZENITH).mul(vanRhijn);
    return glow.add(vec3(0.9, 0.97, 1.12).mul(NIGHT_FLOOR));
  }

  // Pre-exposed sky radiance along `direction` (need not be normalised).
  radiance(direction: N, options: SkyRadianceOptions): N {
    // Built inside Fn so the dynamic branches have a shader stack to live in.
    return Fn(() => {
      const d = normalize(direction).toVar();
      const pixel = max(length(fwidth(d)), 1e-6).toVar();
      const transmittance = this.viewTransmittance(d).toVar();
      // Anti-aliased horizon cut for the disks and stars (the ocean covers the rest). toVar() so it
      // is evaluated here, not inside whichever branch first uses it.
      const horizon = saturate(d.y.div(pixel).add(0.5)).toVar();

      let sky: N = this.skyViewLuminance(d).add(this.airglow(d).mul(transmittance));
      // Below the horizon: fade toward a dark, sea-like reflection of the horizon.
      sky = sky.mul(mix(1, 0.08, smoothstep(0, 0.12, d.y.negate())));
      // Overcast: desaturate and dim the clear sky.
      const grey = dot(sky, vec3(LUMA[0], LUMA[1], LUMA[2])).toVar();
      sky = mix(
        sky,
        vec3(grey)
          .mul(vec3(0.96, 0.98, 1.02))
          .mul(0.55),
        this.overcast,
      );

      // Disks and stars are evaluated only where they can contribute (dynamic branches).
      const total = sky.toVar();
      if (options.sun) {
        If(dot(d, this.u.sunDirection).greaterThan(Math.cos(SUN_ANGULAR_RADIUS * 1.5 + 0.004)), () => {
          total.addAssign(this.sunDisk(d, pixel, horizon, transmittance));
        });
      }
      const starMask = float(1).toVar();
      if (options.moon || options.moonMask) {
        If(dot(d, this.u.moonDirection).greaterThan(Math.cos(MOON_ANGULAR_RADIUS * 1.5 + 0.004)), () => {
          const moon = this.moonDisk(d, pixel, horizon, transmittance);
          if (options.moon) total.addAssign(moon.radiance);
          starMask.assign(moon.coverage.oneMinus());
        });
      }
      if (options.stars) {
        // Against a sky brighter than ~200 cd/m² (daylight, early twilight) no star shows.
        const visible = grey.lessThan(STAR_SKY_LIMIT).and(d.y.greaterThan(pixel.negate()));
        If(visible, () => {
          const clear = pow(this.overcast.oneMinus(), 2);
          total.addAssign(this.starField(d, pixel).mul(transmittance).mul(horizon.mul(starMask).mul(clear)));
        });
      }
      return fp16Scaled(total.mul(options.exposure));
    })();
  }

  // Pre-exposed radiance of the sun and moon disks alone along `direction` (zero elsewhere), for
  // compositing them behind clouds separately from the sky (radiance with sun/moon off).
  diskRadiance(direction: N, exposure: N): N {
    return Fn(() => {
      const d = normalize(direction).toVar();
      const pixel = max(length(fwidth(d)), 1e-6).toVar();
      const total = vec3(0).toVar();
      If(dot(d, this.u.sunDirection).greaterThan(Math.cos(SUN_ANGULAR_RADIUS * 1.5 + 0.004)), () => {
        const horizon = saturate(d.y.div(pixel).add(0.5));
        total.addAssign(this.sunDisk(d, pixel, horizon, this.viewTransmittance(d)));
      });
      If(dot(d, this.u.moonDirection).greaterThan(Math.cos(MOON_ANGULAR_RADIUS * 1.5 + 0.004)), () => {
        const horizon = saturate(d.y.div(pixel).add(0.5));
        total.addAssign(this.moonDisk(d, pixel, horizon, this.viewTransmittance(d)).radiance);
      });
      return fp16Scaled(total.mul(exposure));
    })();
  }

  // Pre-exposed sun + moon illuminance through the atmosphere per steradian of a normalised
  // Gaussian lobe of width `sigma` (rad) about each: what cloud in front of them scatters into a
  // forward aureole, before the cloud's own share (see clouds/diskOcclusion.ts). Zero beyond 4σ.
  aureole(direction: N, exposure: N, sigma: number): N {
    return Fn(() => {
      const d = normalize(direction).toVar();
      const total = vec3(0).toVar();
      const reach = Math.cos(sigma * 4);
      const lobe = (cosAngle: N): N => {
        const angle = acos(min(cosAngle, 1));
        return exp(angle.mul(angle).mul(-1 / (2 * sigma * sigma))).mul(1 / (2 * Math.PI * sigma * sigma));
      };
      // Above the horizon only (the source's own elevation: the sea covers the rest).
      const up = (source: N): N => smoothstep(-0.01, 0.01, source.y);
      const sun = this.u.sunDirection;
      const moon = this.u.moonDirection;
      If(dot(d, sun).greaterThan(reach), () => {
        const light = this.u.sunIlluminance
          .mul(this.viewTransmittance(sun))
          .mul(pow(this.overcast.oneMinus(), 4));
        total.addAssign(light.mul(lobe(dot(d, sun))).mul(up(sun)));
      });
      If(dot(d, moon).greaterThan(reach), () => {
        const light = this.u.moonIlluminance
          .mul(this.viewTransmittance(moon))
          .mul(pow(this.overcast.oneMinus(), 2));
        total.addAssign(light.mul(lobe(dot(d, moon))).mul(up(moon)));
      });
      return fp16Scaled(total.mul(exposure));
    })();
  }

  // Aerial perspective toward a world-space position (metres), using the main camera's froxels.
  aerialPerspective(worldPosition: N, exposure: N, distancePerSlice: number): AerialPerspectiveNodes {
    const view = this.apViewMatrix.mul(vec4(worldPosition, 1)).xyz;
    const depth = max(view.z.negate(), 1e-3);
    const ndc = view.xy.mul(this.apProjection).div(depth);
    const uv = saturate(ndc.mul(0.5).add(0.5));
    const distance = length(worldPosition.sub(this.apCameraPosition)).div(1000);
    const slice = distance.div(distancePerSlice);
    // Fade to nothing at the camera (the first froxel slice is centred a little way out).
    const weight = saturate(slice.mul(2));
    const w = sqrt(max(slice, 0.5).div(AERIAL_SIZE));
    const sample = texture3D(this.luts.aerial, vec3(uv, saturate(w))).level(0);
    const haze = sample.a.mul(weight); // 1 − transmittance
    // Under a deck the haze glows with the deck's grey air light, not the clear sky's inscatter.
    const clear = sample.rgb.mul(weight).mul(this.inscatterScale);
    const overcast = this.overcastAir.mul(haze);
    // The murk under a deck, in front (it fills the near air the froxels resolve coarsely).
    const murkT = exp(this.murk.mul(distance).negate());
    const inscatter = mix(clear, overcast, this.overcastWeight)
      .mul(murkT)
      .add(this.overcastAir.mul(murkT.oneMinus()));
    return {
      transmittance: haze.oneMinus().mul(murkT),
      inscatter: min(inscatter.mul(exposure), FP16_SAFE),
    };
  }
}
