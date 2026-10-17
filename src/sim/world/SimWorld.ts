// The simulation world: fixed-step physics for every boat plus ocean queries.
// Runs identically inside the Web Worker and in unit tests.
//
// Each boat is a WorldBoat (rigid-body dynamics with its drive train, MMG or
// Kerner hull, calibrated resistance, deck water, flooding and breaking-wave
// modules) stepped at 120 Hz with its own substeps, sampling the ocean through
// a per-boat water grid. Fleet boats nobody helms follow their autopilots;
// boats collide with each other. Events: 'slam' (strength = impact speed,
// m/s), 'collision' (impulse and contact point), 'capsized', 'sunk', 'recovered'.
// Boats can join and leave mid-voyage (spawnBoat / removeBoat), and setConditions
// blends the wind and crossfades the sea to new weather without changing the
// seed's wave phases.

import { headingToVector, signedAngle } from '../core/conventions';
import { PHYSICS_CASCADES, visualCascades } from '../ocean/cascades';
import { type CascadeSpectrum, type OceanSpectra, OceanSpectrumBuilder, transitionBlend } from '../ocean/h0';
import { OceanSurface, type SurfaceSample } from '../ocean/OceanSurface';
import { resolveSpectrum, spectrumParamsFromSeaState } from '../ocean/spectrum';
import type { SurfaceQuery } from '../physics/hullWater';
import type { WindSampler } from '../physics/windage';
import { DEFAULT_FETCH, resolveSeaState } from '../weather/seaState';
import { blendWind, WindField } from '../weather/wind';
import type { PilotState, PilotTarget } from './autopilot';
import { type CollisionHull, type Contact, resolveCollisions } from './collisions';
import {
  type AdvanceRequest,
  type AutopilotSetting,
  type BoatSnapshot,
  type BoatSpawn,
  type CascadeData,
  type PhysicsMode,
  PROBE_STRIDE,
  type SimCommand,
  type SimConfig,
  type SimEvent,
  type Snapshot,
  type SpectrumMessage,
  type WindConfig,
} from './protocol';
import { WAKE_SUBSTEPS, WorldWakes } from './wakes';
import { WorldBoat } from './WorldBoat';

export const MASTER_STEP = 1 / 120;

// Collision events: an impact needs this closing speed to count (hulls resting against each other
// don't keep reporting), and a pair still grinding together reports again only after the interval,
// unless it hits markedly harder.
const COLLISION_MIN_SPEED = 0.3; // m/s
const COLLISION_INTERVAL = 0.5; // s

// Water surface sampled by probes (and, adapted, by the physics when no FFT ocean is built).
export interface OceanSample {
  height: number;
  normalX: number;
  normalZ: number;
  velocityY: number;
}

export interface OceanField {
  sample(x: number, z: number, time: number, out: OceanSample): OceanSample;
}

export const flatOcean: OceanField = {
  sample(_x, _z, _time, out) {
    out.height = 0;
    out.normalX = 0;
    out.normalZ = 0;
    out.velocityY = 0;
    return out;
  },
};

// A height-field OceanField as a SurfaceQuery: no orbital velocity or depth attenuation.
function surfaceFromField(field: OceanField): SurfaceQuery {
  const s: OceanSample = { height: 0, normalX: 0, normalZ: 0, velocityY: 0 };
  return {
    query(x: number, z: number, time: number, out: SurfaceSample): SurfaceSample {
      field.sample(x, z, time, s);
      out.height = s.height;
      out.normalX = s.normalX;
      out.normalZ = s.normalZ;
      out.normalY = Math.sqrt(Math.max(0, 1 - s.normalX * s.normalX - s.normalZ * s.normalZ));
      out.velocityX = 0;
      out.velocityY = s.velocityY;
      out.velocityZ = 0;
      out.jacobian = 1;
      out.steepness = 0;
      out.crestVelocityX = 0;
      out.crestVelocityZ = 0;
      out.pressureHead = s.height;
      out.lagrangianX = x;
      out.lagrangianZ = z;
      out.iterations = 0;
      out.converged = true;
      return out;
    },
  };
}

const toCascadeData = (spectrum: CascadeSpectrum): CascadeData => ({
  index: spectrum.cascade.index,
  kind: spectrum.cascade.kind,
  size: spectrum.cascade.size,
  resolution: spectrum.cascade.resolution,
  h0: spectrum.h0.slice(),
  choppiness: spectrum.choppiness,
});

const ownState: PilotState = { heading: 0, speed: 0, yawRate: 0, x: 0, z: 0 };
const stationState: PilotState = { heading: 0, speed: 0, yawRate: 0, x: 0, z: 0 };
const targetState: PilotTarget = { heading: 0, speed: 0, x: 0, z: 0 };

// A live weather change reaches the renderer before its render time (which trails the simulation)
// gets to activationTime, so both sides switch spectra at the same instant.
export const SPECTRUM_LEAD = 0.25; // s
const MIN_SEA_TRANSITION = 0.5; // s; a zero-length blend would make the activation instant ambiguous

export class SimWorld {
  time = 0;
  // The latest spectrum for the renderer; the host forwards it to the GPU.
  spectrum: SpectrumMessage | null = null;
  readonly boats: WorldBoat[] = [];
  physicsMode: PhysicsMode;
  capsizeAssist: boolean;
  private config: SimConfig;
  private ocean: OceanField;
  private readonly surface: SurfaceQuery;
  private builder: OceanSpectrumBuilder | null = null; // keeps the seed's phases for weather changes
  private spectrumVersion = 0;
  private readonly wind: WindField;
  private readonly windSampler: WindSampler;
  // Wind transition: blends windFrom → config.wind over [windStart, windStart + windDuration].
  private windFrom: WindConfig;
  private windStart = 0;
  private windDuration = 0;
  private readonly byId = new Map<string, WorldBoat>();
  // The boat being helmed (the first one the last advance request had controls for): fleet boats
  // keep station on it unless told otherwise, and it centres the wake LOD.
  private helmId: string | null;
  private readonly hulls: CollisionHull[] = [];
  private events: SimEvent[] = [];
  private readonly contacts: Contact[] = [];
  private readonly lastImpact = new Map<string, { time: number; speed: number }>(); // per pair
  private sample: OceanSample = { height: 0, normalX: 0, normalZ: 0, velocityY: 0 };
  // --- wakes: each boat's hull samples the sea plus every other boat's eWave grid ---
  readonly wakes: WorldWakes | null;
  private stepCount = 0;
  // --- end wakes ---

  // Without an explicit ocean field the world builds the FFT ocean for the scenario's sea state.
  // `surface` overrides what the hulls feel (tests use analytic seas).
  constructor(config: SimConfig, ocean?: OceanField, surface?: SurfaceQuery) {
    this.config = config;
    this.physicsMode = config.physicsMode;
    this.capsizeAssist = config.capsizeAssist ?? false;
    this.ocean = ocean ?? this.buildOcean();
    this.surface =
      surface ?? (this.ocean instanceof OceanSurface ? this.ocean : surfaceFromField(this.ocean));
    this.wind = new WindField(config.wind, config.seed);
    this.windFrom = config.wind;
    const wind = this.wind;
    this.windSampler = { sample: (x, y, z, t, out) => wind.velocityAt(x, y, z, t, out) };
    this.wakes = config.wakes === false ? null : new WorldWakes();
    this.helmId = config.boats[0]?.id ?? null;
    for (const spawn of config.boats) this.addBoat(spawn);
    // Fleet boats keep station on the helm boat where they were spawned.
    for (const spawn of config.boats) if (spawn.id !== this.helmId) this.keepStation(spawn.id);
  }

  get seed(): number {
    return this.config.seed;
  }

  boat(id: string): WorldBoat | undefined {
    return this.byId.get(id);
  }

  // The boat fleet followers keep station on by default: the one being helmed, while it exists.
  get leaderId(): string | null {
    return this.helmId !== null && this.byId.has(this.helmId) ? this.helmId : null;
  }

  // The sea the probes sample (the FFT physics ocean unless one was passed in).
  get oceanField(): OceanField {
    return this.ocean;
  }

  // Mean 10 m wind right now (it blends after a conditions change).
  get windNow(): WindConfig {
    return { speed: this.wind.speed, from: this.wind.from, gustFactor: this.wind.gustFactor };
  }

  private buildOcean(): OceanField {
    const { seed, oceanQuality } = this.config;
    this.builder = new OceanSpectrumBuilder(PHYSICS_CASCADES, visualCascades(oceanQuality), seed);
    const spectra = this.buildSpectra(0, 0);
    return OceanSurface.create(spectra.physics);
  }

  // Rebuilds h0 for the configured wind and sea (same seed, same phases: only amplitudes change)
  // and publishes it as the next spectrum version.
  private buildSpectra(activationTime: number, transitionDuration: number): OceanSpectra {
    const { wind, seaState } = this.config;
    const builder = this.builder as OceanSpectrumBuilder;
    const sea = resolveSeaState(seaState, wind.speed, wind.from);
    const fetch = seaState.mode === 'auto' ? seaState.fetch : DEFAULT_FETCH;
    const spectrum = resolveSpectrum(spectrumParamsFromSeaState(sea, wind.speed, wind.from, fetch));
    const spectra = builder.build(spectrum);
    this.spectrum = {
      type: 'spectrum',
      version: ++this.spectrumVersion,
      activationTime,
      transitionDuration,
      cascades: [...spectra.physics, ...spectra.visual].map(toCascadeData),
      significantHeight: sea.totalHs,
      peakPeriod: sea.tp,
      douglas: sea.douglas,
      wind: { ...wind },
    };
    return spectra;
  }

  // Live weather: the wind blends from wherever it is now; the sea crossfades h0 on the CPU here and
  // on the GPU from the published spectrum, both keyed to the same activation time.
  private setConditions(c: Extract<SimCommand, { type: 'setConditions' }>): void {
    this.windFrom = { speed: this.wind.speed, from: this.wind.from, gustFactor: this.wind.gustFactor };
    this.windStart = this.time;
    this.windDuration = Math.max(0, c.windTransition);
    this.config = { ...this.config, wind: c.wind, seaState: c.seaState };
    this.updateWind(this.time);
    if (!this.builder || !(this.ocean instanceof OceanSurface)) return;
    const activation = this.time + SPECTRUM_LEAD;
    const duration = Math.max(MIN_SEA_TRANSITION, c.seaTransition);
    const spectra = this.buildSpectra(activation, duration);
    this.ocean.ocean.setSpectra(spectra.physics, activation, duration);
  }

  private updateWind(t: number): void {
    const w = transitionBlend(this.windStart, this.windDuration, t);
    this.wind.set(blendWind(this.windFrom, this.config.wind, w));
  }

  private get windBlending(): boolean {
    return this.time <= this.windStart + this.windDuration;
  }

  // --- fleet: boats can join and leave mid-voyage ---
  private addBoat(spawn: BoatSpawn): WorldBoat | null {
    if (this.byId.has(spawn.id)) return null;
    const surface = this.wakes ? this.wakes.add(spawn.id, spawn.kind, this.surface) : this.surface;
    const boat = new WorldBoat(
      spawn.id,
      spawn.kind,
      surface,
      this.physicsMode,
      this.capsizeAssist,
      spawn.load,
    );
    boat.place(spawn.x, spawn.z, spawn.heading, this.time);
    boat.setOff(spawn.speed ?? 0, spawn.sail, signedAngle(this.wind.from - spawn.heading));
    this.boats.push(boat);
    this.byId.set(spawn.id, boat);
    this.hulls.push(boat.collision);
    return boat;
  }

  // A boat joining mid-voyage starts at its leader's speed (up to its own top speed), engines
  // running to match, so it holds station straight away instead of chasing from rest.
  private matchSpeed(id: string, leaderId: string | null): void {
    const boat = this.byId.get(id);
    const leader = leaderId === null ? undefined : this.byId.get(leaderId);
    if (!boat || !leader || leader === boat) return;
    const top = boat.dyn.model.spec.propulsion.topSpeed;
    const speed = Math.min(Math.max(0, leader.pilotState(ownState).speed), 0.95 * top);
    if (speed < 0.2) return;
    boat.underWay(speed, speed / top);
  }

  // Follow the leader (default: the helm boat) at the boat's current offset in the leader's frame;
  // without a leader the boat drifts, or does `fallback`.
  private keepStation(
    id: string,
    leaderId: string | null = this.leaderId,
    fallback: AutopilotSetting = { mode: 'drift' },
  ): void {
    const boat = this.byId.get(id);
    const leader = leaderId === null ? undefined : this.byId.get(leaderId);
    if (!boat) return;
    if (!leader || leader === boat) {
      boat.setAutopilot(fallback);
      return;
    }
    leader.pilotState(ownState);
    boat.pilotState(stationState);
    const f = headingToVector(ownState.heading);
    const dx = stationState.x - ownState.x;
    const dz = stationState.z - ownState.z;
    boat.setAutopilot({
      mode: 'follow',
      targetId: leader.id,
      offsetForward: dx * f.x + dz * f.z,
      offsetStarboard: dx * -f.z + dz * f.x,
    });
  }

  private removeBoat(id: string): void {
    const boat = this.byId.get(id);
    if (!boat) return;
    this.boats.splice(this.boats.indexOf(boat), 1);
    this.hulls.splice(this.hulls.indexOf(boat.collision), 1);
    this.byId.delete(id);
    this.wakes?.remove(id);
    for (const key of this.lastImpact.keys()) if (key.split('|').includes(id)) this.lastImpact.delete(key);
    // Boats that were following it keep station on the helm boat from where they are now, or hold
    // their course if that was the helm boat (or there is none).
    const leaderId = this.leaderId;
    for (const other of this.boats) {
      const setting = other.autopilot?.setting;
      if (setting?.mode === 'follow' && (setting.targetId ?? this.helmId) === id) {
        this.keepStation(other.id, leaderId, { mode: 'hold' });
      }
    }
  }
  // --- end fleet ---

  private reportCollision(c: Contact, t: number): void {
    if (c.speed < COLLISION_MIN_SPEED) return;
    const key = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    const last = this.lastImpact.get(key);
    if (last && t - last.time < COLLISION_INTERVAL && c.speed < 2 * last.speed) return;
    this.lastImpact.set(key, { time: t, speed: c.speed });
    this.events.push({
      type: 'collision',
      boatId: c.a,
      otherId: c.b,
      x: c.x,
      y: c.y,
      z: c.z,
      impulse: c.impulse,
      speed: c.speed,
    });
  }

  command(c: SimCommand): void {
    switch (c.type) {
      case 'recover':
        this.byId.get(c.boatId)?.recover(this.time, this.events);
        break;
      case 'setPhysicsMode':
        this.physicsMode = c.mode;
        for (const b of this.boats) b.setMode(c.mode, this.capsizeAssist);
        break;
      case 'setCapsizeAssist':
        this.capsizeAssist = c.enabled;
        for (const b of this.boats) b.setMode(this.physicsMode, c.enabled);
        break;
      case 'setAutopilot': {
        const a = c.autopilot;
        // Follow without a station keeps station from where the boat is now (as joining boats do).
        if (a?.mode === 'follow' && a.offsetForward === undefined && a.offsetStarboard === undefined)
          this.keepStation(c.boatId, a.targetId ?? this.leaderId, { mode: 'hold' });
        else this.byId.get(c.boatId)?.setAutopilot(a);
        break;
      }
      case 'setConditions':
        this.setConditions(c);
        break;
      case 'spawnBoat': {
        const leaderId = c.leaderId ?? this.leaderId;
        if (this.addBoat(c.spawn) && c.spawn.id !== leaderId) {
          this.matchSpeed(c.spawn.id, leaderId);
          this.keepStation(c.spawn.id, leaderId);
        }
        break;
      }
      case 'removeBoat':
        this.removeBoat(c.boatId);
        break;
      default: {
        const boat = this.byId.get(c.boatId);
        for (const m of boat?.dyn.modules ?? []) if (m.command?.(c)) break;
      }
    }
  }

  // Steps whole master steps up to targetTime and answers probes at the new time.
  advance(request: AdvanceRequest): Snapshot {
    const started = performance.now();
    for (const id in request.controls) {
      this.helmId = id;
      break;
    }
    for (const c of request.commands) this.command(c);
    if (request.spent) this.wakes?.recycle(request.spent);
    for (const boat of this.boats) {
      const helm = request.controls[boat.id];
      if (helm) boat.controls = helm;
    }
    let steps = 0;
    // Guard against a long stall (tab in background) turning into thousands of steps.
    const maxSteps = 60;
    while (this.time + MASTER_STEP <= request.targetTime + 1e-9 && steps < maxSteps) {
      this.step(MASTER_STEP, request);
      steps++;
    }
    if (steps === maxSteps) this.time = Math.max(this.time, request.targetTime);

    const probes = new Float32Array((request.probes.length / 2) * PROBE_STRIDE);
    for (let i = 0, j = 0; i < request.probes.length; i += 2, j += PROBE_STRIDE) {
      this.ocean.sample(request.probes[i] ?? 0, request.probes[i + 1] ?? 0, this.time, this.sample);
      probes[j] = this.sample.height;
      probes[j + 1] = this.sample.normalX;
      probes[j + 2] = this.sample.normalZ;
      probes[j + 3] = this.sample.velocityY;
    }

    const events = this.events;
    this.events = [];
    const boats: BoatSnapshot[] = this.boats.map((b) => b.snapshot());
    const wakes = this.wakes;
    if (wakes) boats.forEach((b) => (b.telemetry['wakeUs'] = wakes.cpuUs(b.id)));
    return {
      type: 'snapshot',
      time: this.time,
      boats,
      probes,
      events,
      stepMs: performance.now() - started,
      steps,
      ...(wakes ? { wakes: wakes.publish(), wakeMs: wakes.totalMs } : {}),
    };
  }

  private step(dt: number, request: AdvanceRequest | null): void {
    if (this.windBlending) this.updateWind(this.time);
    const t = this.time;
    for (const boat of this.boats) {
      const pilot = boat.autopilot;
      if (pilot && !(request && request.controls[boat.id])) {
        boat.pilotState(ownState);
        ownState.windFrom = this.wind.from;
        const targetId = pilot.setting.targetId ?? this.helmId;
        const target = targetId === null ? undefined : this.byId.get(targetId);
        pilot.control(
          ownState,
          target && target !== boat ? target.pilotTarget(targetState) : null,
          boat.controls,
          dt,
        );
      }
      boat.step(dt, t, this.windSampler, this.events);
    }
    if (this.hulls.length > 1) {
      this.contacts.length = 0;
      resolveCollisions(this.hulls, this.contacts, dt);
      for (const c of this.contacts) this.reportCollision(c, t);
    }
    this.time = t + dt;
    // Wakes at 30 Hz, on whole master steps so their clock is exact.
    if (this.wakes && ++this.stepCount % WAKE_SUBSTEPS === 0) {
      const helm = this.helmId === null ? undefined : this.byId.get(this.helmId);
      this.wakes.update(this.boats, this.time, helm ?? this.boats[0]);
    }
  }
}
