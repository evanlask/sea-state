// Cloud shading as TSL node builders shared by the cloud kernels (main view, environment panorama,
// shadow map): the density field (weather map → height profile → Perlin-Worley shape → Worley
// erosion), the light march toward the sun/moon, the raymarch through the spherical cloud shell
// with energy-conserving integration, the 2D cirrus layer, and aerial perspective. Distances are
// kilometres in a planet-centred frame (world xz, R + altitude); radiance is physical (cd/m²)
// until the kernels apply the pre-exposure.
//
// Lighting per sample (Schneider 2015/2017, Hillaire 2016, Wrenninge 2015):
//   sun/moon  E · T_atm(r, μ) · Σᵢ aⁱ p(θ, cⁱg) e^(−bⁱτ)   transmittance LUT colours it (red sunsets)
//   powder    1 − 0.8 e^(−2σ·Δ)                            dark edges facing away from the light
//   ambient   sky above × D(τ↑) + sea below × D(τ↓) + the diffusely transmitted sun, where D is
//             the diffusion long tail 1 / (1 + 0.11 τ) of thick media (overcast bases stay lit)
//   lightning a point source inside the cloud with exponential falloff

import { Vector2, Vector3, Vector4 } from 'three/webgpu';

import { PLANET_RADIUS, zenithHorizonAngle } from '../sky/AtmosphereLuts';
import type { AtmosphereLuts, AtmosphereUniforms } from '../sky/AtmosphereLuts';
import { type N, tsl } from '../tsl';
import { FLASH_FALLOFF } from '../weather/flashLight';
import { BASE_TILE, CIRRUS_TILE, CURL_TILE, DETAIL_TILE, type CloudNoise } from './CloudNoise';
import {
  ANVIL_BASE,
  ANVIL_DRIFT,
  ANVIL_TOP,
  CIRRUS_ALTITUDE,
  CROWN_LIFT,
  COLUMN_DEPTH_FACTOR,
  DECK_SEA_ALBEDO,
  DIFFUSION,
  MAX_COLUMN_SCALE,
  TROPOPAUSE_CAP,
} from './cloudTypes';
import { WEATHER_TILE } from './WeatherMap';

const {
  Break,
  If,
  Loop,
  acos,
  atan,
  clamp,
  dot,
  exp,
  float,
  fract,
  int,
  length,
  max,
  min,
  mix,
  normalize,
  pow,
  saturate,
  select,
  smoothstep,
  sqrt,
  texture,
  texture3D,
  uniform,
  vec2,
  vec3,
} = tsl;

const R = PLANET_RADIUS;
const INV_4PI = 1 / (4 * Math.PI);
const SUN_RADIUS = 0.2666 * (Math.PI / 180);
const DETAIL_DISTANCE = 18; // km; beyond it erosion is sub-pixel (and aliases)
const MIN_STEP = 0.03; // km
const MS_GAIN = 2.6;
const RAIN_DISTANCE = 40; // km of rain-shaft march along a view ray
const RAIN_EXTINCTION = 2.2; // 1/km under a fully raining cell (visibility ~1.4 km)
// Billowing columns remap the shape noise's working range (it spans ~0.75–0.96) to 0..1 near
// their surface, so turrets bulge out of the flanks and crowns.
const BILLOW_LOW = 0.72;
const BILLOW_HIGH = 0.98;
const ANVIL_SQUASH = 1.5; // extra vertical noise frequency in the anvil band (stratified sheet)
const ANVIL_DENSITY = 0.6; // anvil sheet density relative to a tower's (thinner, cirriform)
// Light-march sample spacing jitter (±½ of this): breaks up the discrete sample shells; wider
// spreads made dense, sunlit edges flicker between lit and shadowed (grain).
const LIGHT_SPREAD = 0.3;

export interface CloudSample {
  density: N; // extinction σ (1/km)
  z: N; // height fraction in the column (0 base .. 1 top)
  coverage: N; // weather-map coverage
  rain: N; // weather-map precipitation
  thickness: N; // km, column depth
}

export interface MarchOptions {
  steps: number;
  lightSteps: number;
  detail: boolean;
  maxDistance: number; // km
  // Light the cloud from inside with the lightning flash (default on). The environment panorama
  // leaves it out: the probe would hold a captured flash for seconds (weather/flashLight.ts).
  flash?: boolean;
}

export interface MarchResult {
  color: N; // physical radiance, aerial perspective not applied
  transmittance: N; // 0..1
  depth: N; // km, opacity-weighted mean distance (or the far end when empty)
}

// Uniforms shared by every cloud kernel (one set; written by CloudSystem each frame).
export class CloudUniforms {
  readonly baseKm: N = uniform(1);
  readonly topKm: N = uniform(3);
  // Profile A/B: (thickness km, bottomFade, taperStart, roundness) and (density, anvil, billow).
  readonly profileA: N = uniform(new Vector4(1.3, 0.06, 0.2, 1.6));
  readonly profileA2: N = uniform(new Vector3(1, 0, 0));
  readonly profileB: N = uniform(new Vector4(3.2, 0.04, 0.3, 1.8));
  readonly profileB2: N = uniform(new Vector3(1.15, 0, 0));
  readonly coverage: N = uniform(1); // global multiplier (fades weather transitions)
  readonly extinction: N = uniform(45);
  readonly cirrus: N = uniform(0);
  readonly weatherOffset: N = uniform(new Vector2()); // km, wrapped
  readonly noiseOffset: N = uniform(new Vector3()); // km, wrapped
  readonly detailOffset: N = uniform(new Vector3()); // km, wrapped
  readonly cirrusOffset: N = uniform(new Vector2()); // km, wrapped
  readonly windDirection: N = uniform(new Vector2(1, 0)); // unit, toward
  readonly lightDirection: N = uniform(new Vector3(0, 1, 0));
  readonly lightIlluminance: N = uniform(new Vector3()); // lux outside the atmosphere
  readonly camera: N = uniform(new Vector3(0, R + 0.002, 0)); // planet-centred km
  readonly flashPosition: N = uniform(new Vector3(0, R + 1, 0)); // planet-centred km
  readonly flashRadiance: N = uniform(new Vector3()); // cd/m² near the source
  readonly airLight: N = uniform(1); // under-deck dimming of the haze in front of the clouds
  readonly groundIrradiance: N = uniform(new Vector3()); // lux on the sea from the sun/moon (shadowed)
  readonly rain: N = uniform(0); // 0..1 layer precipitation; 0 skips the rain-shaft march
  readonly deckDepth: N = uniform(0); // deck column optical depth (cloudTypes deckOpticalDepth)
  readonly overcast: N = uniform(0); // 0..1 share of the air lit by the deck (overcastAirWeight)
  readonly murk: N = uniform(0); // 1/km extinction of the murk under the deck (murkExtinction)
}

const remap = (x: N, a: N, b: N): N => x.sub(a).div(max(b.sub(a), 1e-5));

// Henyey-Greenstein phase (1/sr).
const hg = (c: N, g: N): N => {
  const g2 = g.mul(g);
  return g2
    .oneMinus()
    .div(pow(max(g2.add(1).sub(g.mul(c).mul(2)), 1e-4), 1.5))
    .mul(INV_4PI);
};

// Dual-lobe HG: the strong forward peak (silver lining) plus some back-scatter (glory side).
const cloudPhase = (c: N, attenuation: N): N => {
  const k = float(attenuation);
  return mix(hg(c, k.mul(0.75)), hg(c, k.mul(-0.2)), 0.35);
};

// Ray-sphere roots (near, far) for a sphere of radius `radius` about the planet centre, given the
// ray origin's radius r0 and cos-zenith mu0 (stable for origins near the surface).
export const sphereRoots = (r0: N, mu0: N, radius: N): { near: N; far: N; hit: N } => {
  const b = r0.mul(mu0);
  const c = r0.sub(radius).mul(r0.add(radius));
  const disc = b.mul(b).sub(c);
  const s = sqrt(max(disc, 0));
  return { near: b.negate().sub(s), far: b.negate().add(s), hit: disc.greaterThanEqual(0) };
};

export class CloudShading {
  readonly u: CloudUniforms;
  readonly noise: CloudNoise;
  private weather: N; // StorageTexture
  private luts: AtmosphereLuts;
  private atmosphere: AtmosphereUniforms;
  private ambient: N; // storage buffer: [sky above (rgb), sea below (rgb)]

  constructor(
    uniforms: CloudUniforms,
    noise: CloudNoise,
    weather: N,
    luts: AtmosphereLuts,
    atmosphere: AtmosphereUniforms,
    ambient: N,
  ) {
    this.u = uniforms;
    this.noise = noise;
    this.weather = weather;
    this.luts = luts;
    this.atmosphere = atmosphere;
    this.ambient = ambient;
  }

  // --- Density -----------------------------------------------------------------------------------

  sampleWeather(p: N): N {
    return this.sampleWeatherAt(p.xz);
  }

  private sampleWeatherAt(xz: N): N {
    const uv = xz.add(this.u.weatherOffset).div(WEATHER_TILE);
    return texture(this.weather, uv).level(0);
  }

  // Layer constants of the anvil (uniform-only, folded per invocation): the tropopause (the
  // deepest profile's thickness, km above the base), the anvil weight of the layer (0 for layers
  // without cumulonimbus) and the altitude where the anvil band starts.
  private tropopause(): { depth: N; anvil: N; start: N } {
    const u = this.u;
    const depth = max(u.profileA.x, u.profileB.x);
    const anvil = max(u.profileA2.y, u.profileB2.y);
    return { depth, anvil, start: u.baseKm.add(depth.mul(ANVIL_BASE)) };
  }

  // Low-frequency density (no erosion): cheap, used to find clouds and for light/shadow rays.
  // Returns the 0..1 base density and the sampling context for the detail pass.
  //
  // The column is the profile formula of cloudTypes.ts (flat base, full body, superellipse dome)
  // on the height the weather map's height channel domes over each cell. Billowing profiles
  // (towering cumulus, cumulonimbus) raise the shape noise's contrast toward the column's surface
  // and lift or dent the crown with it, so flanks and tops bulge into cauliflower turrets while
  // the core stays solid. In a layer with anvils the columns end at the tropopause, and the anvil
  // is a sheet of its own: it spreads from the tops of the tallest cores, its underside rising
  // outward to a flat top, read from the map upwind so it streams downwind, with stratified,
  // fibrous noise.
  private baseShape(p: N, h: N): { base: N; sample: CloudSample; densityScale: N; uvw: N; anvil: N } {
    const u = this.u;
    const a = u.profileA;
    const b = u.profileB;
    const tropo = this.tropopause();
    const height = h.sub(u.baseKm).toVar();
    const drift = smoothstep(tropo.start.sub(tropo.depth.mul(0.1)), u.baseKm.add(tropo.depth), h).mul(
      tropo.anvil.mul(ANVIL_DRIFT),
    );
    const w = this.sampleWeatherAt(p.xz.sub(u.windDirection.mul(drift))).toVar();
    const t = w.g;
    const nominal = mix(a.x, b.x, t);
    const thickness = nominal.mul(w.a.mul(MAX_COLUMN_SCALE)).toVar();
    const z = height.div(thickness).toVar();
    const bottomFade = mix(a.y, b.y, t);
    const taper = mix(a.z, b.z, t).toVar();
    const roundness = mix(a.w, b.w, t).toVar();
    const billow = mix(u.profileA2.z, u.profileB2.z, t).toVar();
    const storm = mix(u.profileA2.y, u.profileB2.y, t);
    const za = height.div(tropo.depth).toVar();
    const bottom = smoothstep(0, bottomFade, z);
    const cap = float(1).sub(tropo.anvil.mul(smoothstep(0.97, TROPOPAUSE_CAP, za)));
    const lower = select(z.greaterThan(0), bottom.mul(cap), float(0)).toVar();
    // Envelope with the crown lifted by `lift` (fraction of the column).
    const body = (lift: N): N => {
      const zz = z.sub(lift);
      const tt = saturate(zz.sub(taper).div(taper.oneMinus()));
      const top = pow(max(float(1).sub(pow(tt, roundness)), 0), float(1).div(roundness));
      return select(zz.lessThan(1), lower.mul(top), float(0));
    };
    // Anvil: thick over the cores that reach the tropopause, thinning outward.
    const reach = saturate(thickness.div(tropo.depth));
    const underside = mix(float(ANVIL_TOP), float(ANVIL_BASE), smoothstep(0.5, 0.95, reach));
    const sheet = select(
      za.lessThan(1),
      smoothstep(underside, underside.add(0.06), za).mul(smoothstep(0.93, 1, za).oneMinus()),
      float(0),
    ).toVar();
    const anvil = smoothstep(0.55, 0.85, storm)
      .mul(smoothstep(0.45, 0.7, reach))
      .mul(sheet)
      .toVar();
    const cover = w.r.mul(u.coverage).toVar();
    const spread = cover.mul(smoothstep(0, 0.05, cover)).toVar();
    // Columns lean downwind with height (wind shear), more so for the anvil; its noise is
    // squashed into thinner layers (h above the anvil band's start counts SQUASH× more).
    const shear = u.windDirection.mul(height.mul(0.18).add(anvil.mul(1.5)));
    const squash = max(h.sub(tropo.start), 0).mul(tropo.anvil.mul(ANVIL_SQUASH));
    const uvw = vec3(p.x.add(shear.x), h.add(squash), p.z.add(shear.y)).add(u.noiseOffset).toVar();
    const lift = billow.mul(CROWN_LIFT).toVar();
    const base = float(0).toVar();
    // The shape noise is ≤ 1, so where the (most lifted) envelope can't pass the coverage
    // threshold, and there's no anvil sheet, there can't be cloud: skip the fetch.
    If(body(lift.mul(0.5)).add(spread).greaterThan(1).or(sheet.add(anvil).greaterThan(1)), () => {
      const noise = texture3D(this.noise.base, uvw.div(BASE_TILE)).level(0);
      const billowy = saturate(remap(noise.r, float(BILLOW_LOW), float(BILLOW_HIGH)));
      const envelope = body(lift.mul(billowy.sub(0.5))).toVar();
      const surface = saturate(float(1).sub(spread.mul(envelope)));
      const shape = mix(noise.r, billowy, billow.mul(sqrt(surface)));
      const column = saturate(remap(shape.mul(envelope), spread.oneMinus(), float(1))).mul(spread);
      const fibres = saturate(remap(noise.a, float(0.2), float(0.7)));
      const spreadOut = saturate(remap(fibres.mul(sheet), anvil.oneMinus(), float(1)))
        .mul(anvil.mul(anvil))
        .mul(ANVIL_DENSITY);
      base.assign(max(column, spreadOut));
    });
    return {
      base,
      sample: { density: base, z, coverage: cover, rain: w.b, thickness },
      densityScale: mix(u.profileA2.x, u.profileB2.x, t),
      uvw,
      anvil,
    };
  }

  // Extinction (1/km) at p (planet-centred km). `erosion` (0..1, or null for none) scales the
  // high-frequency detail, so it can fade out with distance instead of popping.
  density(p: N, h: N, erosion: N): CloudSample {
    const u = this.u;
    const s = this.baseShape(p, h);
    const value = s.base.toVar();
    if (erosion !== null) {
      const amount = float(erosion).toVar();
      If(value.greaterThan(0).and(amount.greaterThan(0.01)), () => {
        const zc = saturate(s.sample.z).toVar();
        const curl = texture(this.noise.curl, s.uvw.xz.div(CURL_TILE)).level(0).rg.mul(2).sub(1);
        const twist = vec3(curl.x, 0, curl.y).mul(zc.oneMinus().mul(0.25));
        const q = s.uvw.add(twist).add(u.detailOffset).div(DETAIL_TILE);
        const hf = texture3D(this.noise.detail, q).level(0).r;
        // Wispy at the base, billowy toward the top (Nubis 2015), and eroding harder toward the
        // top so the domes break into turrets while the base stays flat.
        const modifier = mix(hf, hf.oneMinus(), saturate(zc.mul(5)));
        const strength = zc.mul(0.3).add(0.4);
        value.assign(saturate(remap(value, modifier.mul(amount.mul(strength)), float(1))));
      });
    }
    return { ...s.sample, density: value.mul(u.extinction).mul(s.densityScale) };
  }

  // --- Light -------------------------------------------------------------------------------------

  // Atmosphere transmittance from radius r toward cos-zenith mu, zero in the planet's shadow.
  transmittanceAt(r: N, mu: N): N {
    const horizon = sqrt(max(r.sub(R).mul(r.add(R)), 0))
      .div(r)
      .negate();
    const shadow = smoothstep(-SUN_RADIUS, SUN_RADIUS, mu.sub(horizon));
    return this.luts.sampleTransmittance(r, mu).mul(shadow);
  }

  // Clear-sky luminance (physical cd/m²) from the sky-view LUT along a unit direction (as skyNodes).
  skyLuminance(d: N): N {
    const h = this.luts.quality.skyView[1];
    const zha = zenithHorizonAngle(this.atmosphere.viewRadius);
    const zenithAngle = min(acos(clamp(d.y, -1, 1)), zha);
    const coord = sqrt(max(float(1).sub(zenithAngle.div(zha)), 0));
    const v = coord
      .oneMinus()
      .add(0.5 / h)
      .mul(h / (h + 1));
    const azimuth = fract(
      atan(d.x, d.z.negate())
        .div(2 * Math.PI)
        .add(1),
    );
    return texture(this.luts.skyView, vec2(azimuth, v)).level(0).rgb;
  }

  ambientAbove(): N {
    return this.ambient.element(0).xyz;
  }

  ambientBelow(): N {
    return this.ambient.element(1).xyz;
  }

  // Radiance of the air under the deck (deckAirLight, written by the ambient kernel).
  ambientAir(): N {
    return this.ambient.element(2).xyz;
  }

  // The grey glow of haze and rain under a deck (cloudTypes deckAirRadiance, the CPU twin): the mean
  // of the cloud base's radiance (the march's ambient term at the base) and the sea's under it.
  deckAirLight(above: N): N {
    const u = this.u;
    const mu = u.lightDirection.y;
    const sunlight = u.lightIlluminance.mul(this.transmittanceAt(u.baseKm.add(R), mu));
    const tau = max(u.deckDepth, 0);
    const diffuse = float(1).div(tau.mul(DIFFUSION).add(1)).toVar();
    const direct = exp(tau.div(max(mu, 0.15)).negate());
    const sunDiffuse = sunlight.mul(
      max(mu, 0)
        .mul(INV_4PI * 2)
        .mul(max(diffuse.sub(direct), 0)),
    );
    const through = above.mul(diffuse.mul(0.5)).add(sunDiffuse.mul(diffuse.mul(0.5).add(0.5)));
    // The sea under the deck is lit by the base (not the clear sky) and lights it back a little.
    return through.mul((0.5 * (1 + DECK_SEA_ALBEDO)) / (1 - 0.5 * DECK_SEA_ALBEDO));
  }

  // Optical depth toward the light from p: samples at 0.05·(i+1)^1.7 × scale km, plus one long
  // sample (Nubis cone march, without the cone: temporal jitter does the softening).
  private lightOpticalDepth(p: N, steps: number, scale: N, jitter: N): N {
    const u = this.u;
    const tau = float(0).toVar();
    const previous = float(0).toVar();
    const spread = jitter.sub(0.5).mul(LIGHT_SPREAD).add(1);
    Loop(steps + 1, ({ i }: { i: N }) => {
      const fi = float(i);
      const last = i.equal(int(steps));
      const d = select(last, float(3.2), pow(fi.add(1), 1.7).mul(0.05))
        .mul(scale)
        .mul(spread)
        .toVar();
      const q = p.add(u.lightDirection.mul(d));
      const hq = length(q).sub(R);
      If(hq.greaterThan(u.topKm).or(hq.lessThan(u.baseKm.sub(0.05))), () => {
        Break();
      });
      const s = this.baseShape(q, hq);
      tau.addAssign(s.base.mul(u.extinction).mul(s.densityScale).mul(d.sub(previous)));
      previous.assign(d);
    });
    return tau;
  }

  // Wrenninge-style multiple scattering octaves (a = b = c = ½).
  private multipleScattering(tau: N, cosTheta: N): N {
    let sum: N = float(0);
    for (let o = 0; o < 4; o++) {
      const k = 0.5 ** o;
      sum = sum.add(exp(tau.mul(-k)).mul(cloudPhase(cosTheta, k)).mul(k));
    }
    // The octaves undercount the energy dense clouds scatter back out (their sunlit faces reach
    // ~albedo·E/π); a constant gain restores it.
    return sum.mul(MS_GAIN);
  }

  // --- March -------------------------------------------------------------------------------------

  // Distances along the ray (from the camera) where it is inside the cloud shell.
  shellInterval(ro: N, rd: N, maxDistance: number): { start: N; end: N } {
    const u = this.u;
    const r0 = length(ro).toVar();
    const mu0 = dot(ro, rd).div(r0).toVar();
    const bottom = sphereRoots(r0, mu0, u.baseKm.add(R));
    const top = sphereRoots(r0, mu0, u.topKm.add(R));
    const below = r0.lessThan(u.baseKm.add(R));
    const above = r0.greaterThan(u.topKm.add(R));
    // Below the shell: from the far root of the base sphere to the far root of the top sphere.
    // Inside: from the camera to whichever boundary comes first. Above: top near → base near.
    const groundward = bottom.hit.and(bottom.near.greaterThan(0));
    const start = select(below, bottom.far, select(above, max(top.near, 0), float(0)));
    const end = select(below, top.far, select(groundward, bottom.near, top.far));
    return { start: max(start, 0), end: min(end, maxDistance) };
  }

  march(ro: N, rd: N, jitter: N, options: MarchOptions): MarchResult {
    const u = this.u;
    const interval = this.shellInterval(ro, rd, options.maxDistance);
    const start = interval.start.toVar();
    const end = interval.end.toVar();
    const iterations = Math.ceil(options.steps * 1.6) + 4;
    // Steps grow with distance (perspective: a pixel covers more cloud farther out), at least fast
    // enough that the iteration budget reaches the far end of the shell: geometric growth from
    // the shell's entry, (end / start)^(1 / budget), over a floor of half the even spacing (a
    // floor of the full even spacing would give the near towers of a deep shell coarse steps,
    // several optical depths each, with visible banding).
    const budget = iterations * 0.85;
    const growth = max(pow(end.div(max(start, 0.5)), 1 / budget).sub(1), 0.96 / options.steps).toVar();
    const floorStep = max(end.sub(start).div(budget * 2), MIN_STEP).toVar();
    const stepAt = (distance: N): N => max(distance.mul(growth).add(MIN_STEP), floorStep);
    const dt = stepAt(start).toVar();
    const t = start.add(dt.mul(jitter)).toVar();
    const transmittance = float(1).toVar();
    const radiance = vec3(0).toVar();
    const depthSum = float(0).toVar();
    const weightSum = float(0).toVar();
    const fine = float(0).toVar();
    const misses = float(0).toVar();
    const cosTheta = dot(rd, u.lightDirection).toVar();
    const tauLight = float(-1).toVar(); // last light march (−1: none yet)
    const above = this.ambientAbove().toVar();
    const below = this.ambientBelow().toVar();
    const light = u.lightIlluminance.toVar();

    If(end.greaterThan(start), () => {
      Loop(iterations, () => {
        If(t.greaterThan(end).or(transmittance.lessThan(0.01)), () => {
          Break();
        });
        dt.assign(stepAt(t));
        const p = ro.add(rd.mul(t)).toVar();
        const r = length(p).toVar();
        const h = r.sub(R).toVar();
        If(fine.lessThan(0.5), () => {
          // Coarse: double steps through clear air until the low-frequency shape shows cloud.
          const s = this.baseShape(p, h);
          If(s.base.greaterThan(0.002), () => {
            fine.assign(1);
            misses.assign(0);
            t.subAssign(dt.mul(0.75));
          }).Else(() => {
            t.addAssign(dt.mul(2));
          });
        }).Else(() => {
          const erosion = options.detail ? saturate(float(1).sub(t.div(DETAIL_DISTANCE))).mul(1.4) : null;
          const s = this.density(p, h, erosion === null ? null : min(erosion, 1));
          const sigma = s.density.toVar();
          If(sigma.greaterThan(1e-3), () => {
            misses.assign(0);
            const zenith = p.div(r);
            const mu = dot(zenith, u.lightDirection);
            const sunlight = light.mul(this.transmittanceAt(r, mu)).toVar();
            const lightScale = clamp(s.thickness.mul(0.6), 0.6, 3);
            // Behind 90% opacity a sample adds little: reuse the last light march (the finer near
            // steps take more samples to cross a dense face; this keeps the cost level).
            If(transmittance.greaterThan(0.1).or(tauLight.lessThan(0)), () => {
              tauLight.assign(this.lightOpticalDepth(p, options.lightSteps, lightScale, jitter));
            });
            const direct = sunlight.mul(this.multipleScattering(tauLight, cosTheta));
            // Powder: in-scattering builds up with depth, so thin edges facing away look darker.
            const powder = float(1).sub(exp(sigma.mul(dt).mul(-2)).mul(0.8));
            const powderMix = mix(powder, 1, saturate(cosTheta.mul(0.5).add(0.5)).mul(0.5));
            // Ambient: optical depth above/below the sample from the column fraction.
            // z is clamped: anvil samples above a short column's top would get a negative optical
            // depth above them and the diffusion term would blow up.
            const column = s.coverage.mul(u.extinction).mul(s.thickness).mul(COLUMN_DEPTH_FACTOR);
            const zc = saturate(s.z);
            const tauUp = zc.oneMinus().mul(column);
            const tauDown = zc.mul(column);
            const diffuseUp = float(1).div(tauUp.mul(DIFFUSION).add(1));
            const diffuseDown = float(1).div(tauDown.mul(DIFFUSION).add(1));
            // Sunlight that diffused down through the column above (minus its direct part).
            const slant = max(mu, 0.15);
            const sunDiffuse = sunlight
              .mul(max(mu, 0))
              .mul(INV_4PI * 2)
              .mul(max(diffuseUp.sub(exp(tauUp.div(slant).negate())), 0));
            const ambient = above
              .mul(0.5)
              .mul(diffuseUp)
              .add(below.mul(0.5).mul(diffuseDown))
              .add(sunDiffuse.mul(diffuseUp.mul(0.5).add(0.5)));
            let inScatter: N = direct.mul(powderMix).add(ambient);
            if (options.flash !== false) {
              const toFlash = length(p.sub(u.flashPosition));
              inScatter = inScatter.add(u.flashRadiance.mul(exp(toFlash.mul(-FLASH_FALLOFF))));
            }
            const stepT = exp(sigma.mul(dt).negate()).toVar();
            // Energy-conserving integration (Hillaire 2016), single-scattering albedo ≈ 1.
            radiance.addAssign(inScatter.mul(stepT.oneMinus()).mul(transmittance));
            const absorbed = transmittance.mul(stepT.oneMinus());
            depthSum.addAssign(t.mul(absorbed));
            weightSum.addAssign(absorbed);
            transmittance.mulAssign(stepT);
          }).Else(() => {
            misses.addAssign(1);
            If(misses.greaterThan(5), () => {
              fine.assign(0);
            });
          });
          t.addAssign(dt);
        });
      });
    });
    const depth = select(weightSum.greaterThan(1e-4), depthSum.div(max(weightSum, 1e-4)), end);
    return { color: radiance, transmittance, depth };
  }

  // The thin 2D cirrus layer at CIRRUS_ALTITUDE: (radiance, opacity, distance).
  cirrusLayer(ro: N, rd: N): { color: N; alpha: N; depth: N } {
    const u = this.u;
    const r0 = length(ro);
    const mu0 = dot(ro, rd).div(r0);
    const radius = R + CIRRUS_ALTITUDE;
    const t = sphereRoots(r0, mu0, radius).far.toVar();
    const p = ro.add(rd.mul(t));
    const wind = u.windDirection;
    const flat = p.xz.add(u.cirrusOffset).div(CIRRUS_TILE);
    // Streaks run along the wind: rotate world xz into (along, across).
    const uv = vec2(dot(flat, wind), dot(flat, vec2(wind.y.negate(), wind.x)));
    const n = texture(this.noise.cirrus, uv).level(0);
    const patchy = n.r.mul(mix(0.55, 1.25, n.g));
    const cover = u.cirrus;
    const alpha = saturate(remap(patchy, cover.oneMinus(), float(1)))
      .mul(0.6)
      .mul(smoothstep(0, 0.02, rd.y))
      .toVar();
    const mu = dot(normalize(p), u.lightDirection);
    const sunlight = u.lightIlluminance.mul(this.transmittanceAt(float(radius), mu));
    const c = dot(rd, u.lightDirection);
    const phase = mix(hg(c, float(0.65)), hg(c, float(-0.25)), 0.3);
    const color = sunlight.mul(phase).add(this.ambientAbove().mul(0.5)).mul(alpha);
    return { color, alpha, depth: t };
  }

  // Aerial perspective between the camera and a cloud at `distance` km along rd: transmittance from
  // the LUT ratio, inscatter as the matching fraction of the clear-sky luminance (scaled down where
  // clouds shade the haze). Under a deck the air is lit by the cloud base and the sea, not the sun
  // and blue sky: there the inscatter is the deck's grey air light over the same optical depth, so
  // the distant deck fades into grey murk at the horizon rather than into a band of clear sky.
  aerial(ro: N, rd: N, distance: N): { transmittance: N; inscatter: N } {
    const r0 = length(ro).toVar();
    const mu0 = dot(ro, rd).div(r0);
    const toInfinity = this.luts.sampleTransmittance(r0, mu0).toVar();
    const p = ro.add(rd.mul(distance));
    const rp = length(p);
    const mup = dot(p, rd).div(rp);
    const toTop = this.luts.sampleTransmittance(rp, mup);
    const transmittance = saturate(toInfinity.div(max(toTop, 1e-4))).toVar();
    const fraction = saturate(transmittance.oneMinus().div(max(toInfinity.oneMinus(), 1e-3)));
    const clear = this.skyLuminance(rd).mul(fraction).mul(this.u.airLight);
    const overcast = this.ambientAir().mul(transmittance.oneMinus());
    const inscatter = mix(clear, overcast, this.u.overcast);
    return { transmittance, inscatter };
  }

  // Rain shafts: the air between the sea and the cloud base under raining cells (weather map b),
  // marched along the view ray up to RAIN_DISTANCE. Rain leans downwind as it falls, shows fine
  // vertical curtains (a high-frequency read of the same map, independent of height) and, where
  // it is light, evaporates before reaching the sea (virga). The first few kilometres are left to
  // the scene's own rain and fog. Grey-lit: sky light through the cloud above, the sea below and a
  // little forward-scattered sun.
  rainShafts(ro: N, rd: N, jitter: N, steps: number): { color: N; transmittance: N } {
    const u = this.u;
    const color = vec3(0).toVar();
    const transmittance = float(1).toVar();
    const depthSum = float(0).toVar();
    const weightSum = float(0).toVar();
    const r0 = length(ro).toVar();
    If(u.rain.greaterThan(0).and(r0.lessThan(u.baseKm.add(R))), () => {
      const mu0 = dot(ro, rd).div(r0);
      const end = min(sphereRoots(r0, mu0, u.baseKm.add(R)).far, RAIN_DISTANCE).toVar();
      const dt = end.div(steps).toVar();
      const cosTheta = dot(rd, u.lightDirection);
      const above = this.ambientAbove().toVar();
      const below = this.ambientBelow().toVar();
      const air = this.ambientAir().toVar();
      Loop(steps, ({ i }: { i: N }) => {
        const t = float(i).add(jitter).mul(dt).toVar();
        const p = ro.add(rd.mul(t)).toVar();
        const r = length(p);
        const h = r.sub(R);
        const fall = max(u.baseKm.sub(h), 0);
        // The cell that dropped this rain sits upwind, further the longer it has fallen.
        const source = vec3(
          p.x.sub(u.windDirection.x.mul(fall).mul(0.35)),
          p.y,
          p.z.sub(u.windDirection.y.mul(fall).mul(0.35)),
        );
        const w = this.sampleWeather(source);
        const rain = w.b.toVar();
        If(rain.greaterThan(0.01), () => {
          const curtains = texture(this.weather, source.xz.add(u.weatherOffset).div(WEATHER_TILE / 9)).level(
            0,
          ).r;
          const z = saturate(h.div(max(u.baseKm, 0.1)));
          const virga = saturate(float(0.55).sub(rain.mul(1.1)));
          const profile = smoothstep(virga, virga.add(0.3), z).mul(smoothstep(1.02, 0.85, z));
          const near = smoothstep(1, 3.5, t);
          const sigma = rain.mul(RAIN_EXTINCTION).mul(curtains.mul(0.8).add(0.4)).mul(profile).mul(near);
          const stepT = exp(sigma.mul(dt).negate());
          const zenith = p.div(r);
          const mu = dot(zenith, u.lightDirection);
          const sunlight = u.lightIlluminance.mul(this.transmittanceAt(r, mu));
          // Under a raining cell the rain is lit like the base of the cloud above it: sky light and
          // sunlight diffused down through the column (the march's ambient term at z = 0), direct
          // sun only through a thin one. Under a deck the rain, like the haze, is lit only by the grey
          // base and the sea (not the blue sky).
          const depth = mix(u.profileA.x, u.profileB.x, w.g).mul(w.a.mul(MAX_COLUMN_SCALE));
          const tau = w.r.mul(u.extinction).mul(depth).mul(COLUMN_DEPTH_FACTOR);
          const diffuse = float(1).div(tau.mul(DIFFUSION).add(1));
          const direct = exp(tau.div(max(mu, 0.15)).negate());
          const sunScatter = hg(cosTheta, float(0.6))
            .mul(0.25)
            .mul(direct)
            .add(
              max(mu, 0)
                .mul(INV_4PI * 2)
                .mul(max(diffuse.sub(direct), 0)),
            );
          const lit = above.mul(diffuse.mul(0.55)).add(sunlight.mul(sunScatter)).add(below.mul(0.5));
          const inScatter = mix(lit, air, u.overcast);
          color.addAssign(inScatter.mul(stepT.oneMinus()).mul(transmittance));
          const absorbed = transmittance.mul(stepT.oneMinus());
          depthSum.addAssign(t.mul(absorbed));
          weightSum.addAssign(absorbed);
          transmittance.mulAssign(stepT);
        });
      });
      // Haze between the camera and the shafts (only where there was rain on the ray).
      If(weightSum.greaterThan(1e-4), () => {
        const air = this.aerial(ro, rd, depthSum.div(weightSum));
        color.assign(color.mul(air.transmittance).add(air.inscatter.mul(transmittance.oneMinus())));
      });
    });
    return { color, transmittance };
  }

  // Path length (km) along rd from ro to the cloud base, 0 from above it.
  underDeck(ro: N, rd: N): N {
    const r0 = length(ro);
    const base = this.u.baseKm.add(R);
    const far = sphereRoots(r0, dot(ro, rd).div(r0), base).far;
    return select(r0.lessThan(base), max(far, 0), float(0));
  }

  // Full sky-facing composite for a view ray: volumetric clouds over cirrus, with aerial
  // perspective; returns physical radiance, total transmittance and the volumetric depth.
  composite(ro: N, rd: N, jitter: N, options: MarchOptions): { color: N; transmittance: N; depth: N } {
    const cloud = this.march(ro, rd, jitter, options);
    const vol = this.aerial(ro, rd, cloud.depth);
    const volColor = cloud.color
      .mul(vol.transmittance)
      .add(vol.inscatter.mul(cloud.transmittance.oneMinus()));
    const cirrus = this.cirrusLayer(ro, rd);
    const ci = this.aerial(ro, rd, cirrus.depth);
    const cirrusColor = cirrus.color.mul(ci.transmittance).add(ci.inscatter.mul(cirrus.alpha));
    const clouds = volColor.add(cirrusColor.mul(cloud.transmittance)).toVar();
    const cloudsT = cloud.transmittance.mul(cirrus.alpha.oneMinus()).toVar();
    // The clear sky seen through gaps in a deck (composited behind as sky × T) is seen through the
    // deck-lit murk too: the overcast share of the haze out to the shell's far side covers it.
    const murk = this.u.overcast.mul(vol.transmittance.oneMinus());
    clouds.addAssign(this.ambientAir().mul(murk.mul(cloudsT)));
    cloudsT.mulAssign(murk.oneMinus());
    // Rain shafts hang in front of everything above.
    const rain = this.rainShafts(ro, rd, jitter, Math.max(8, Math.round(options.steps / 8)));
    const color = rain.color.add(clouds.mul(rain.transmittance)).toVar();
    const transmittance = cloudsT.mul(rain.transmittance).toVar();
    // Murk (rain and mist) fills the air under a deck: its optical depth grows with the path below
    // the base, so the deck greys smoothly into it toward the horizon instead of a band.
    If(this.u.murk.greaterThan(0), () => {
      const murkT = exp(this.u.murk.mul(this.underDeck(ro, rd)).negate());
      color.assign(color.mul(murkT).add(this.ambientAir().mul(murkT.oneMinus())));
      transmittance.mulAssign(murkT);
    });
    return { color, transmittance, depth: cloud.depth };
  }

  // Optical depth along the light from a sea-level point (km, planet-centred) through the shell.
  // `steps` may be a uniform (more steps for the long, grazing rays of a low sun); `jitter` (0..1)
  // offsets the samples along the ray, so a temporal blend of jittered marches integrates the layer
  // smoothly rather than summing a few displaced horizontal slices (streaks along the sun's azimuth).
  shadowOpticalDepth(p0: N, steps: N, light: N, jitter: N = 0.5): N {
    const u = this.u;
    const L = light;
    const tau = float(0).toVar();
    const r0 = length(p0);
    const mu0 = dot(p0, L).div(r0);
    const start = sphereRoots(r0, mu0, u.baseKm.add(R)).far.toVar();
    const end = min(sphereRoots(r0, mu0, u.topKm.add(R)).far, start.add(40)).toVar();
    const count = int(steps).toVar();
    const dt = end.sub(start).div(float(count)).toVar();
    If(L.y.greaterThan(0), () => {
      Loop({ start: int(0), end: count, type: 'int', condition: '<' }, ({ i }: { i: N }) => {
        const p = p0.add(L.mul(start.add(dt.mul(float(i).add(jitter)))));
        const h = length(p).sub(R);
        const s = this.baseShape(p, h);
        tau.addAssign(s.base.mul(u.extinction).mul(s.densityScale).mul(dt));
      });
    });
    return tau;
  }
}

// Interleaved gradient noise at an integer pixel (temporal.ts mirror).
export const ign = (pixel: N): N => fract(fract(dot(pixel, vec2(0.06711056, 0.00583715))).mul(52.9829189));
