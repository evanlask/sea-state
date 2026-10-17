// ContrailSystem: the rare jet's condensation trail and the aircraft itself, drawn analytically in
// the sky background (no meshes): each sky pixel's ray meets the trail's altitude, is projected onto
// the trail's line (contrails.ts) to find the age it sees, and that age sets the width, the optical
// depth and the ragged break-up of an old trail. The trail is lit by the sun and moon at its own
// height through the transmittance LUT (so it turns pink at sunset and stays lit a while after the
// sun has left the sea), takes skylight, and fades into the haze toward the horizon. CloudSystem
// composites the result as the sky behind its clouds (sky × T + clouds), so low cloud and the 9 km
// cirrus hide the trail at 10–11 km. Pixel-filtered: a 4 m trail at 12 km is a fraction of a pixel,
// drawn a pixel wide at the matching lower opacity.
//
// The aircraft is a few point sources splatted with a pixel-wide Gaussian, normalised to their
// illuminance at the camera: a faint sunlit speck with the odd glint by day; the red and green
// wingtip lights, white strobes and red beacon at night (a 400 cd strobe at 12 km is about a
// magnitude-0 star, and vanishes against the day sky by itself).
//
// Cost: when no jet is about, one uniform branch per sky pixel; with one, a sphere intersection,
// a few dot products and two noise taps per slot, the lighting only near the trail.

import { type Node, type PerspectiveCamera, Vector2, Vector3, Vector4 } from 'three/webgpu';

import { sphereRoots } from '../clouds/cloudShading';
import { PLANET_RADIUS } from '../sky/AtmosphereLuts';
import type { SkySystem } from '../sky/SkySystem';
import { type N, tsl } from '../tsl';
import {
  aircraftGlint,
  aircraftLights,
  aircraftPosition,
  aircraftVelocity,
  alongTrack,
  ContrailSchedule,
  type ContrailEvent,
  type ContrailWeather,
  headingVector,
  MAX_CONTRAILS,
  TRAIL_SHAPE,
  trailAgeRange,
  trailRecession,
} from './contrails';

const {
  Fn,
  If,
  clamp,
  dot,
  exp,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  pow,
  saturate,
  smoothstep,
  sqrt,
  uniform,
  vec2,
  vec3,
} = tsl;

const R = PLANET_RADIUS;
const INV_4PI = 1 / (4 * Math.PI);
const SUN_RADIUS = 0.2666 * (Math.PI / 180);
const FWHM_TO_SIGMA = 1 / 2.3548;
const AIRCRAFT_AREA = 250; // m², planform of a wide-body seen from below
const WINGTIP = 0.03; // km from the fuselage to each wingtip light
const SKY_BEHIND = 0.3; // share of the clear sky's light scattered beyond the trail's altitude
const REFERENCE_ALTITUDE = 10.5; // km, for the pixel footprint
const SOURCES = 3; // per aircraft: fuselage (body, strobe, beacon), port and starboard wingtips
// Light colours (linear Rec.709, luminance ≈ 1).
const RED: readonly [number, number, number] = [4.1, 0.15, 0.06];
const GREEN: readonly [number, number, number] = [0.02, 1.3, 0.6];
const WHITE: readonly [number, number, number] = [0.92, 0.98, 1.1];

interface SlotUniforms {
  head: N; // vec2 km, the aircraft relative to the camera (xz)
  recede: N; // vec2 km/s, V − W
  ages: N; // vec2 s, [min, max] of the trail's ages (empty: no trail)
  shape: N; // vec4 (width0 m, spread m/s, tau0, life s)
  shape2: N; // vec4 (maxAge s, altitude km, along-track now km, speed km/s)
  seed: N; // float, the trail's noise offset
  sources: { direction: N; illuminance: N }[]; // vec4 (unit dir, distance km), vec3 lux
}

export interface AircraftState {
  position: { x: number; y: number; z: number }; // world m
  velocity: { x: number; y: number; z: number }; // m/s
}

// Henyey-Greenstein phase (1/sr).
const hg = (c: N, g: number): N => {
  const g2 = g * g;
  return float(1 - g2)
    .div(pow(max(float(1 + g2).sub(c.mul(2 * g)), 1e-4), 1.5))
    .mul(INV_4PI);
};
// Ice crystals: a strong forward lobe and some back-scatter (the cirrus layer's phase).
const icePhase = (c: N): N => mix(hg(c, 0.65), hg(c, -0.25), 0.3);

const lux = [0, 0, 0] as [number, number, number];

export class ContrailSystem {
  readonly schedule: ContrailSchedule;
  private sky: SkySystem;
  private slots: SlotUniforms[] = [];
  private anyActive: N = uniform(0);
  private aircraftStates: AircraftState[] = [];
  private around = { x: 0, z: 0 };
  private wind = { x: 0, z: 0 };
  private time = 0;
  private forcePending = false;
  private weather: ContrailWeather = {
    clouds: { type: 'clear', coverage: 0 },
    precipitation: 0,
    visibility: 30_000,
  };

  constructor(sky: SkySystem, seed: number) {
    this.sky = sky;
    this.schedule = new ContrailSchedule(seed);
    for (let i = 0; i < MAX_CONTRAILS; i++) {
      this.slots.push({
        head: uniform(new Vector2()),
        recede: uniform(new Vector2(0.25, 0)),
        ages: uniform(new Vector2(0, -1)),
        shape: uniform(new Vector4(4, 1, 0.5, 300)),
        shape2: uniform(new Vector4(900, 10.5, 0, 0.25)),
        seed: uniform(0),
        sources: Array.from({ length: SOURCES }, () => ({
          direction: uniform(new Vector4(0, 1, 0, 10)),
          illuminance: uniform(new Vector3()),
        })),
      });
    }
  }

  // The aircraft in the sky now (world m), for the audio engine's distant rumble.
  get aircraft(): readonly AircraftState[] {
    return this.aircraftStates;
  }

  // Debug: a jet passing almost overhead from the next update, its trail already stretching
  // behind it.
  requestForce(): void {
    this.forcePending = true;
  }

  // `sky`: the pre-exposed clear-sky radiance along `direction` (no sun or moon disks); returns it
  // with the trails and aircraft in front (still behind the clouds, which composite over this).
  composite(direction: Node, sky: Node): Node {
    const atmosphere = this.sky.atmosphere;
    const luts = atmosphere.luts;
    const u = atmosphere.uniforms;
    const exposure = this.sky.preExposure;
    return Fn(() => {
      const d = normalize(direction as N).toVar();
      const color = (sky as N).toVar();
      const r0 = u.viewRadius;
      const toInfinity = luts.sampleTransmittance(r0, d.y).toVar();
      // Transmittance from the camera to `t` km along a ray (the LUT ratio, as the clouds do).
      const airTo = (rd: N, t: N, mu0Infinity: N): N => {
        const p = vec3(0, r0, 0).add(rd.mul(t));
        const rp = length(p);
        return saturate(mu0Infinity.div(max(luts.sampleTransmittance(rp, dot(p, rd).div(rp)), 1e-4)));
      };
      // Direct light at a point high up (planet-centred km), shadowed by the planet below its horizon.
      const lightAt = (p: N, radius: N, direction: N, illuminance: N): N => {
        const mu = dot(p.div(radius), direction);
        const horizon = sqrt(max(radius.sub(R).mul(radius.add(R)), 0))
          .div(radius)
          .negate();
        const shadow = smoothstep(-SUN_RADIUS, SUN_RADIUS, mu.sub(horizon));
        return illuminance.mul(luts.sampleTransmittance(radius, mu)).mul(shadow);
      };
      const pixel = max(length(fwidth(d)), 1e-6).toVar();
      const horizon = saturate(d.y.mul(60).add(0.5)).toVar();
      // The pixel's footprint (km) on a layer at the nominal height, up front so the derivative
      // stays in uniform control flow; each trail scales it by its own distance.
      const tRef = sphereRoots(r0, d.y, float(R + REFERENCE_ALTITUDE)).far.toVar();
      const footprintRef = length(fwidth(d.xz.mul(tRef)))
        .div(max(tRef, 1e-3))
        .toVar();
      If(this.anyActive.greaterThan(0), () => {
        for (const slot of this.slots) {
          If(slot.ages.y.greaterThan(slot.ages.x), () => {
            const radius = float(R).add(slot.shape2.y).toVar();
            const t = sphereRoots(r0, d.y, radius).far.toVar();
            const q = d.xz.mul(t).toVar(); // km from the camera, horizontal
            const footprint = footprintRef.mul(t);
            const U = slot.recede;
            const along = normalize(U);
            const across = vec2(along.y.negate(), along.x);
            const age = clamp(dot(slot.head.sub(q), U).div(max(dot(U, U), 1e-12)), slot.ages.x, slot.ages.y);
            const offset = q.sub(slot.head.sub(U.mul(age))).toVar();
            // Width (m, FWHM) and optical depth at this age (contrails.ts trailWidth/OpticalDepth).
            const s = slot.shape;
            const width = s.x
              .add(exp(age.div(-TRAIL_SHAPE.vortexTime)).oneMinus().mul(TRAIL_SHAPE.vortexSpread))
              .add(s.y.mul(age))
              .toVar();
            const sigma = width.mul(FWHM_TO_SIGMA / 1000).toVar(); // km
            // Break-up of an older trail, fixed to the air it formed in: a wandering centreline and
            // denser and thinner stretches.
            const emitted = slot.shape2.z.sub(slot.shape2.w.mul(age));
            const old = smoothstep(20, 200, age);
            const wander = mx_noise_float(vec3(emitted.mul(0.8), slot.seed, 0.5))
              .mul(sigma)
              .mul(old.mul(0.8));
            const clumps = mx_noise_float(vec3(emitted.mul(2.6), slot.seed.add(9.1), 3.7));
            const lateral = dot(offset, across).add(wander);
            const lengthwise = dot(offset, along);
            const filtered = sqrt(sigma.mul(sigma).add(footprint.mul(footprint).mul(0.2))).toVar();
            const profile = exp(
              lateral.mul(lateral).add(lengthwise.mul(lengthwise)).div(filtered.mul(filtered).mul(-2)),
            ).mul(sigma.div(filtered));
            const onset = smoothstep(TRAIL_SHAPE.gap, TRAIL_SHAPE.gap + TRAIL_SHAPE.onset, age);
            const dilution = min(pow(float(TRAIL_SHAPE.referenceWidth).div(width), 0.35), 1.4);
            const fade = exp(age.negate().div(s.w)).mul(
              smoothstep(slot.shape2.x.mul(0.6), slot.shape2.x, age).oneMinus(),
            );
            const ragged = mix(1, clumps.mul(0.6).add(0.75), old);
            const tau = s.z.mul(onset).mul(dilution).mul(fade).mul(ragged);
            const alpha = exp(tau.mul(profile).negate()).oneMinus().mul(horizon).toVar();
            If(alpha.greaterThan(1e-4), () => {
              const p = vec3(0, r0, 0).add(d.mul(t)).toVar();
              const air = airTo(d, t, toInfinity).toVar();
              const sun = lightAt(p, radius, u.sunDirection, u.sunIlluminance).mul(
                icePhase(dot(d, u.sunDirection)),
              );
              const moon = lightAt(p, radius, u.moonDirection, u.moonIlluminance).mul(
                icePhase(dot(d, u.moonDirection)),
              );
              const radiance = sun.add(moon).mul(exposure).add(color.mul(0.35));
              const seen = alpha.mul(air.x.add(air.y).add(air.z).div(3));
              color.assign(color.mul(seen.mul(-SKY_BEHIND).add(1)).add(radiance.mul(alpha).mul(air)));
            });
          });
        }
        // The aircraft: point sources a pixel wide, normalised to their illuminance.
        const sigma = pixel.mul(0.6);
        const inv2s2 = float(0.5).div(sigma.mul(sigma)).toVar();
        const reach = float(1).sub(sigma.mul(sigma).mul(18)).toVar(); // cos of ~6σ
        for (const slot of this.slots) {
          for (const source of slot.sources) {
            const dir = source.direction.xyz;
            const e = source.illuminance;
            If(e.x.add(e.y).add(e.z).greaterThan(0).and(dot(d, dir).greaterThan(reach)), () => {
              const delta = d.sub(dir);
              const psf = exp(dot(delta, delta).mul(inv2s2).negate()).mul(inv2s2.div(Math.PI));
              const air = airTo(dir, source.direction.w, luts.sampleTransmittance(r0, dir.y));
              color.addAssign(e.mul(air).mul(psf).mul(exposure).mul(horizon));
            });
          }
        }
      });
      return color;
    })() as Node;
  }

  // Per frame, after SkySystem.update (the camera's height and the sun are current).
  update(
    time: number,
    camera: PerspectiveCamera,
    weather: ContrailWeather & { windVelocity: { x: number; z: number } },
  ): void {
    const e = camera.matrixWorld.elements;
    const cx = e[12] ?? 0;
    const cy = e[13] ?? 0;
    const cz = e[14] ?? 0;
    this.time = time;
    this.around.x = cx;
    this.around.z = cz;
    this.wind.x = weather.windVelocity.x;
    this.wind.z = weather.windVelocity.z;
    this.weather = weather;
    this.schedule.update(this.scheduleFrame());
    if (this.forcePending) {
      this.forcePending = false;
      this.schedule.force(this.scheduleFrame());
    }

    const events = this.schedule.events;
    this.anyActive.value = events.length;
    this.aircraftStates.length = events.length;
    const r0 = R + Math.max(cy, 0.5) / 1000;
    const sun = this.sky.sunDirection;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i] as SlotUniforms;
      const event = events[i];
      if (!event) {
        (slot.ages.value as Vector2).set(0, -1);
        for (const source of slot.sources) (source.illuminance.value as Vector3).set(0, 0, 0);
        continue;
      }
      const position = aircraftPosition(event, time);
      this.aircraftStates[i] = { position, velocity: aircraftVelocity(event) };
      const hx = (position.x - cx) / 1000;
      const hz = (position.z - cz) / 1000;
      const altitude = event.altitude / 1000;
      (slot.head.value as Vector2).set(hx, hz);
      const recede = trailRecession(event);
      (slot.recede.value as Vector2).set(recede.x / 1000, recede.z / 1000);
      const ages = trailAgeRange(event, time);
      (slot.ages.value as Vector2).set(ages.min, ages.max);
      const p = event.persistence;
      (slot.shape.value as Vector4).set(p.width0, p.spread, p.tau0, p.life);
      (slot.shape2.value as Vector4).set(
        p.maxAge,
        altitude,
        alongTrack(event, time) / 1000,
        event.speed / 1000,
      );
      slot.seed.value = (event.id * 7.31) % 97;
      this.updateSources(slot, event, time, hx, hz, altitude, r0, sun);
    }
  }

  private updateSources(
    slot: SlotUniforms,
    event: ContrailEvent,
    time: number,
    hx: number,
    hz: number,
    altitude: number,
    r0: number,
    sun: Readonly<Vector3>,
  ): void {
    const radius = R + altitude;
    const heading = headingVector(event.heading);
    const right = { x: -heading.z, z: heading.x };
    const lights = aircraftLights(event, time);
    const [fuselage, port, starboard] = slot.sources as [
      SlotUniforms['sources'][number],
      SlotUniforms['sources'][number],
      SlotUniforms['sources'][number],
    ];
    // Planet-centred position of a point at the aircraft's height above (x, z) km from the camera.
    const place = (source: typeof fuselage, x: number, z: number): number => {
      const ground2 = x * x + z * z;
      if (ground2 >= radius * radius) {
        (source.illuminance.value as Vector3).set(0, 0, 0);
        return 0;
      }
      const y = Math.sqrt(radius * radius - ground2);
      const vy = y - r0;
      const distance = Math.hypot(x, vy, z);
      (source.direction.value as Vector4).set(x / distance, vy / distance, z / distance, distance);
      return distance * 1000;
    };
    const set = (source: typeof fuselage, rgb: readonly number[], scale: number): void => {
      (source.illuminance.value as Vector3).set(
        (rgb[0] ?? 0) * scale,
        (rgb[1] ?? 0) * scale,
        (rgb[2] ?? 0) * scale,
      );
    };

    const metres = place(fuselage, hx, hz);
    if (metres > 0) {
      // Sunlit fuselage and wings: the sun at the aircraft's height (after sunset at sea level too).
      const y = Math.sqrt(radius * radius - hx * hx - hz * hz);
      const cosZenith = (hx * sun.x + y * sun.y + hz * sun.z) / radius;
      this.sky.sunIlluminanceAloft(altitude, cosZenith, lux);
      const inv2 = 1 / (metres * metres);
      const body = ((0.12 + 0.6 * aircraftGlint(event, time)) / Math.PI) * AIRCRAFT_AREA * inv2;
      const strobe = lights.strobe * inv2;
      const beacon = lights.beacon * inv2;
      (fuselage.illuminance.value as Vector3).set(
        lux[0] * body + WHITE[0] * strobe + RED[0] * beacon,
        lux[1] * body + WHITE[1] * strobe + RED[1] * beacon,
        lux[2] * body + WHITE[2] * strobe + RED[2] * beacon,
      );
    }
    const portMetres = place(port, hx - right.x * WINGTIP, hz - right.z * WINGTIP);
    if (portMetres > 0) set(port, RED, lights.red / (portMetres * portMetres));
    const starboardMetres = place(starboard, hx + right.x * WINGTIP, hz + right.z * WINGTIP);
    if (starboardMetres > 0) set(starboard, GREEN, lights.green / (starboardMetres * starboardMetres));
  }

  private scheduleFrame(): Parameters<ContrailSchedule['update']>[0] {
    return { time: this.time, around: this.around, weather: this.weather, surfaceWind: this.wind };
  }
}
