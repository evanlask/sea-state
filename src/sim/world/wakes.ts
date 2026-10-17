// The world's boat wakes: eWave grid sizes per boat kind, each boat's pressure footprint from its
// dynamics, distance LOD, and the WakeGrid messages snapshots carry to the renderer. Each boat's hull
// samples the ocean through a WakeSurface that adds every grid but its own. Grids are keyed by boat
// id, so boats can join and leave the fleet mid-voyage.

import { BOAT_SPECS } from '../boats/specs/index';
import { vec3 } from '../core/math';
import {
  type BoatWake,
  type WakeGridConfig,
  WakeField,
  WAKE_RESOLUTION,
  WAKE_STEP,
  type WakeSource,
  wakeSource,
} from '../ocean/wake/WakeField';
import { WakeSurface } from '../ocean/wake/WakeSurface';
import type { SurfaceQuery } from '../physics/hullWater';
import type { BoatKind, WakeGrid } from './protocol';
import type { WorldBoat } from './WorldBoat';

// Cell size per kind (128² grids): ships ~1.5 km, the crabber ~320 m, small craft 128–160 m.
const WAKE_CELL: Record<BoatKind, number> = {
  cargo: 12,
  cruise: 12,
  crab: 2.5,
  sail: 1.25,
  powerboat: 1.25,
  pwc: 1,
  hydro: 2, // moving 90 m/s, it crosses a 128-cell grid in under 3 s
};

export const WAKE_SUBSTEPS = 4; // master steps (120 Hz) per wake update (WAKE_STEP = 1/30 s)

// Footprint pressure scale: a surface pressure patch makes a deeper stern hollow than a real hull
// (which pushes water aside rather than down), so displacement hulls are toned down.
const WAKE_GAIN: Record<BoatKind, number> = {
  cargo: 0.55,
  cruise: 0.55,
  crab: 0.45,
  sail: 0.8,
  powerboat: 1,
  pwc: 1,
  hydro: 0.6, // [E] it skims: only its pads and propeller touch the water at speed
};

// Grids further than this (plus half their extent) from the player are not stepped.
const WAKE_LOD_RADIUS = 3000; // m
const LOAD_TAU = 0.3; // s, smoothing of the footprint's load (heave and slam spikes)

function wakeConfigFor(kind: BoatKind): WakeGridConfig {
  const p = BOAT_SPECS[kind].propulsion;
  return { n: WAKE_RESOLUTION, cell: WAKE_CELL[kind], designSpeed: p.serviceSpeed ?? p.topSpeed };
}

const origin = vec3();

interface WakeEntry {
  wake: BoatWake;
  source: WakeSource;
  load: number; // smoothed vertical water force, N
}

// Recycled grid buffers kept for reuse (a couple of snapshots' worth for a full fleet).
const MAX_POOLED = 32;

export class WorldWakes {
  readonly field = new WakeField();
  private readonly entries = new Map<string, WakeEntry>();
  private cleared: string[] = []; // boats removed since the last publication
  private primed = false;
  private pool: Float32Array[] = []; // grid buffers the renderer sent back (recycle)
  totalMs = 0; // smoothed CPU per update, all grids

  // Buffers of published grids the renderer is done with: the next publications reuse them rather
  // than allocating 64 kB per grid each time.
  recycle(buffers: readonly ArrayBuffer[]): void {
    for (const buffer of buffers) {
      if (this.pool.length >= MAX_POOLED) break;
      this.pool.push(new Float32Array(buffer));
    }
  }

  private copyOf(surface: Float32Array): Float32Array {
    let out = this.pool.pop();
    while (out && out.length !== surface.length) out = this.pool.pop();
    out ??= new Float32Array(surface.length);
    out.set(surface);
    return out;
  }

  // Gives a boat its grid; the returned surface is the sea plus every other boat's wake.
  add(boatId: string, kind: BoatKind, base: SurfaceQuery): SurfaceQuery {
    this.remove(boatId);
    const wake = this.field.add(wakeConfigFor(kind));
    this.entries.set(boatId, { wake, source: wakeSource(), load: 0 });
    this.cleared = this.cleared.filter((id) => id !== boatId);
    return new WakeSurface(base, this.field, wake);
  }

  // Drops a boat's grid; the next publication tells the renderer to free it.
  remove(boatId: string): void {
    const entry = this.entries.get(boatId);
    if (!entry) return;
    this.field.remove(entry.wake);
    this.entries.delete(boatId);
    this.cleared.push(boatId);
  }

  grid(boatId: string): BoatWake | undefined {
    return this.entries.get(boatId)?.wake;
  }

  // One WAKE_STEP for every grid in range of the player; `time` is the world time after the step.
  update(boats: readonly WorldBoat[], time: number, player: WorldBoat | undefined): void {
    const started = performance.now();
    let px = 0;
    let pz = 0;
    if (player) {
      player.dyn.body.getOrigin(origin);
      px = origin.x;
      pz = origin.z;
    }
    const blend = this.primed ? 1 - Math.exp(-WAKE_STEP / LOAD_TAU) : 1;
    this.primed = true;
    for (const boat of boats) {
      const entry = this.entries.get(boat.id);
      if (!entry) continue;
      const { wake, source } = entry;
      // (A non-finite force reads as none: a NaN here would stay in the smoothed load for good.)
      const lift = boat.dyn.hullForces.force.y;
      entry.load += ((lift > 0 ? lift : 0) - entry.load) * blend;
      fillSource(boat, entry.load * WAKE_GAIN[boat.kind], source);
      const range = WAKE_LOD_RADIUS + 0.5 * wake.extent;
      const near = !player || Math.hypot(source.x - px, source.z - pz) < range;
      if (!near || boat.sunk) {
        if (wake.enabled) {
          wake.enabled = false;
          wake.reset();
          wake.updated = true; // publish the clear
        }
        continue;
      }
      wake.enabled = true;
      if (!wake.idle(source)) wake.update(source, time);
    }
    const ms = performance.now() - started;
    this.totalMs += (ms - this.totalMs) * 0.05;
  }

  // Grids updated since the last call, as transferable copies (recycled buffers where available);
  // removed boats' grids go out empty, which frees them on the renderer.
  publish(): WakeGrid[] {
    const out: WakeGrid[] = this.cleared.map((boatId) => ({
      boatId,
      time: 0,
      minX: 0,
      minZ: 0,
      cell: 1,
      n: 0,
      vx: 0,
      vz: 0,
      height: new Float32Array(0),
    }));
    this.cleared = [];
    for (const [boatId, { wake }] of this.entries) {
      if (!wake.updated) continue;
      wake.updated = false;
      out.push({
        boatId,
        time: wake.time,
        minX: wake.minX,
        minZ: wake.minZ,
        cell: wake.cell,
        n: wake.n,
        vx: wake.vx,
        vz: wake.vz,
        height: wake.enabled ? this.copyOf(wake.surface) : new Float32Array(0),
      });
    }
    return out;
  }

  cpuUs(boatId: string): number {
    return this.entries.get(boatId)?.wake.cpuUs ?? 0;
  }
}

// The boat's wetted footprint now: its waterline length shrinks (and moves aft) as it rises onto
// the plane; the load is the smoothed vertical water force, zero when airborne.
function fillSource(boat: WorldBoat, load: number, out: WakeSource): void {
  const body = boat.dyn.body;
  body.getOrigin(origin);
  const q = body.orientation;
  let fx = -2 * (q.x * q.z + q.w * q.y);
  let fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  const len = Math.hypot(fx, fz);
  if (len > 1e-3) {
    fx /= len;
    fz /= len;
  } else {
    fx = out.forwardX;
    fz = out.forwardZ;
  }
  const spec = boat.dyn.model.spec;
  const lwl = spec.dimensions.lwl;
  const immersion = Math.max(0, Math.min(1, boat.dyn.hullForces.immersion));
  const length = lwl * (0.4 + 0.6 * Math.sqrt(immersion));
  out.x = origin.x;
  out.z = origin.z;
  out.forwardX = fx;
  out.forwardZ = fz;
  out.vx = body.velocity.x;
  out.vz = body.velocity.z;
  out.load = load;
  out.length = length;
  out.beam = 'beamWaterline' in spec.hull ? spec.hull.beamWaterline : 0.85 * spec.dimensions.beam;
  out.offset = -0.4 * (lwl - length);
}
