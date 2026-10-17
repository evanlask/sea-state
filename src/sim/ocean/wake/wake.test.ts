import { describe, expect, it } from 'vite-plus/test';

import { GRAVITY, RHO_SEAWATER } from '../../core/units';
import { neutralControls, type SimConfig } from '../../world/protocol';
import { flatOcean, SimWorld } from '../../world/SimWorld';
import { createSurfaceSample } from '../OceanSurface';
import { EWave } from './EWave';
import { BoatWake, WAKE_STEP, WakeField, wakeSample, type WakeSource, wakeSource } from './WakeField';
import { WakeSurface } from './WakeSurface';

const DEG = 180 / Math.PI;

// A 1 m³ boat (4 m × 1.5 m footprint) heading +x at speed v.
function smallSource(v: number): WakeSource {
  const s = wakeSource();
  s.forwardX = 1;
  s.forwardZ = 0;
  s.vx = v;
  s.length = 4;
  s.beam = 1.5;
  s.load = RHO_SEAWATER * GRAVITY;
  return s;
}

describe('eWave propagation', () => {
  it('propagates a single mode at the deep-water phase speed √(g/k)', () => {
    const n = 64;
    const cell = 1;
    const wave = new EWave(n, cell, WAKE_STEP, 0, 0); // no sponge: fully periodic
    const k = (2 * Math.PI * 5) / (n * cell);
    const omega = Math.sqrt(GRAVITY * k);
    const a = 0.5;
    // Travelling wave η = a·cos(kx − ωt): φ = (aω/k)·sin(kx − ωt) at the surface.
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = c * cell;
        wave.height[r * n + c] = a * Math.cos(k * x);
        wave.potential[r * n + c] = ((a * omega) / k) * Math.sin(k * x);
      }
    }
    const steps = 300;
    for (let i = 0; i < steps; i++) {
      wave.propagate();
      wave.force(null);
    }
    const t = steps * WAKE_STEP;
    let error = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const expected = a * Math.cos(k * c * cell - omega * t);
        error = Math.max(error, Math.abs((wave.height[r * n + c] as number) - expected));
      }
    }
    expect(error).toBeLessThan(1e-9);
    // That is, the crest moved by √(g/k)·t.
    expect(omega / k).toBeCloseTo(Math.sqrt(GRAVITY / k), 12);
  });

  it('scrolling by whole cells commutes with propagation (the field is preserved)', () => {
    const n = 64;
    const make = (): EWave => {
      const w = new EWave(n, 1, WAKE_STEP, 0, 0);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const d2 = (c - 32) ** 2 + (r - 30) ** 2;
          w.height[r * n + c] = 0.3 * Math.exp(-d2 / 8);
        }
      }
      return w;
    };
    const a = make();
    const b = make();
    a.scroll(3, -2);
    // The exposed strips start calm.
    for (let r = 0; r < 2; r++) expect(a.height[r * n + 10]).toBe(0);
    for (let c = n - 3; c < n; c++) expect(a.height[10 * n + c]).toBe(0);
    for (let i = 0; i < 20; i++) {
      a.propagate();
      a.force(null);
      b.propagate();
      b.force(null);
    }
    b.scroll(3, -2);
    let error = 0;
    let peak = 0;
    for (let r = 8; r < n - 8; r++) {
      for (let c = 8; c < n - 8; c++) {
        const i = r * n + c;
        error = Math.max(error, Math.abs((a.height[i] as number) - (b.height[i] as number)));
        peak = Math.max(peak, Math.abs(b.height[i] as number));
      }
    }
    expect(peak).toBeGreaterThan(1e-3);
    expect(error).toBeLessThan(1e-4 * peak);
  });

  it(
    'stays bounded for 10 minutes of manoeuvring, and the sponge absorbs the wake after',
    { timeout: 30_000 },
    () => {
      const wake = new BoatWake({ n: 64, cell: 1, designSpeed: 3 });
      const s = smallSource(3);
      let peak = 0;
      let t = 0;
      for (let i = 0; i < 18_000; i++) {
        t = (i + 1) * WAKE_STEP;
        // Circles of 40 m radius with speed changes.
        const speed = 2 + Math.sin(t / 20);
        const angle = (speed * t) / 40;
        s.forwardX = -Math.sin(angle);
        s.forwardZ = Math.cos(angle);
        s.vx = speed * s.forwardX;
        s.vz = speed * s.forwardZ;
        s.x = 40 * Math.cos(angle);
        s.z = 40 * Math.sin(angle);
        wake.update(s, t);
        peak = Math.max(peak, wake.peak);
      }
      expect(Number.isFinite(peak)).toBe(true);
      expect(peak).toBeLessThan(1);
      const energy = (): number => {
        let e = 0;
        for (const v of wake.surface) e += v * v;
        return e;
      };
      // Lift the boat out: what is left radiates into the sponge.
      s.load = 0;
      s.vx = s.vz = 0;
      wake.update(s, (t += WAKE_STEP));
      const before = energy();
      for (let i = 0; i < 1800; i++) wake.update(s, (t += WAKE_STEP));
      expect(before).toBeGreaterThan(0);
      expect(energy()).toBeLessThan(0.01 * before);
    },
  );

  it('leaves no wake behind a boat at rest', () => {
    const wake = new BoatWake({ n: 64, cell: 0.5, designSpeed: 3 });
    const s = smallSource(0);
    for (let i = 0; i < 600; i++) wake.update(s, (i + 1) * WAKE_STEP);
    // η_w = h + p/(ρg) relaxes to zero; the hull's static depression (~0.17 m here) is not a wake.
    expect(wake.peak).toBeLessThan(0.01);
  });
});

describe('wake robustness', () => {
  it('starts over, rather than holding NaN for good, when a boat reports a non-finite pose', () => {
    const wake = new BoatWake({ n: 64, cell: 0.5, designSpeed: 3 });
    const s = smallSource(3);
    let t = 0;
    for (let i = 0; i < 120; i++) wake.update(s, (t += WAKE_STEP));
    expect(wake.peak).toBeGreaterThan(0);
    s.x = Number.NaN;
    wake.update(s, (t += WAKE_STEP));
    expect(wake.peak).toBe(0);
    s.x = 0;
    for (let i = 0; i < 120; i++) wake.update(s, (t += WAKE_STEP));
    expect(Number.isFinite(wake.peak)).toBe(true);
    expect(wake.surface.every(Number.isFinite)).toBe(true);
    expect(wake.peak).toBeGreaterThan(0);
  });
});

describe('Kelvin wake', () => {
  it('has arms at ≈19.5° behind a source at moderate Froude number', () => {
    const v = 2.5; // Fn = 0.4 on the 4 m footprint
    const wake = new BoatWake({ n: 128, cell: 0.5, designSpeed: v });
    const s = smallSource(v);
    for (let t = WAKE_STEP; t < 25; t += WAKE_STEP) {
      s.x = v * t;
      wake.update(s, t);
    }
    // The cusp line: where the wake envelope peaks across the track, at each distance astern.
    const out = wakeSample();
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let count = 0;
    for (let back = 6; back <= 26; back += 2) {
      let best = 0;
      let bestY = 0;
      for (let y = 0.5; y <= 20; y += 0.25) {
        let envelope = 0;
        for (let dx = -1.5; dx <= 1.5; dx += 0.25) {
          out.height = 0;
          wake.addTo(s.x - back + dx, y, wake.time, 0, out);
          envelope = Math.max(envelope, Math.abs(out.height));
        }
        if (envelope > best) {
          best = envelope;
          bestY = y;
        }
      }
      sx += back;
      sy += bestY;
      sxx += back * back;
      sxy += back * bestY;
      count++;
    }
    const slope = (count * sxy - sx * sy) / (count * sxx - sx * sx);
    const angle = Math.atan(slope) * DEG;
    expect(angle).toBeGreaterThan(19.47 - 3);
    expect(angle).toBeLessThan(19.47 + 3);
    expect(wake.peak).toBeGreaterThan(0.02);
  });

  it('costs well under a few ms per 128² update', () => {
    const wake = new BoatWake({ n: 128, cell: 1, designSpeed: 10 });
    const s = smallSource(10);
    for (let i = 0; i < 20; i++) wake.update(s, (i + 1) * WAKE_STEP); // warm up the JIT
    const started = performance.now();
    const updates = 60;
    for (let i = 0; i < updates; i++) {
      s.x += 10 * WAKE_STEP;
      wake.update(s, (i + 21) * WAKE_STEP);
    }
    const ms = (performance.now() - started) / updates;
    expect(ms).toBeLessThan(4);
  });
});

describe('wake coupling', () => {
  it('a boat samples every wake but its own', () => {
    const field = new WakeField([
      { n: 64, cell: 0.5, designSpeed: 3 },
      { n: 64, cell: 0.5, designSpeed: 3 },
    ]);
    const s = smallSource(3);
    for (let i = 0; i < 200; i++) {
      s.x = 3 * (i + 1) * WAKE_STEP;
      field.wakes[0]!.update(s, (i + 1) * WAKE_STEP);
    }
    const t = 200 * WAKE_STEP;
    const flat = {
      query: (_x: number, _z: number, _t: number, out: ReturnType<typeof createSurfaceSample>) => out,
    };
    const own = new WakeSurface(flat, field, field.wakes[0]!);
    const other = new WakeSurface(flat, field, field.wakes[1]!);
    // Strongest point of boat 0's wake.
    let x = 0;
    let z = 0;
    let best = 0;
    const probe = wakeSample();
    for (let dx = 0; dx < 12; dx += 0.25) {
      for (let dz = -6; dz <= 6; dz += 0.25) {
        probe.height = 0;
        field.wakes[0]!.addTo(s.x - dx, dz, t, 0, probe);
        if (Math.abs(probe.height) > best) {
          best = Math.abs(probe.height);
          x = s.x - dx;
          z = dz;
        }
      }
    }
    expect(best).toBeGreaterThan(0.01);
    expect(own.query(x, z, t, createSurfaceSample()).height).toBe(0);
    const felt = other.query(x, z, t, createSurfaceSample());
    expect(Math.abs(felt.height)).toBeCloseTo(best, 6);
    expect(felt.normalY).toBeLessThan(1);
  });

  it("in the world, a drifting jet ski rides a passing powerboat's wake", { timeout: 30_000 }, () => {
    const config = (wakes: boolean): SimConfig => ({
      seed: 3,
      physicsMode: 'arcade',
      boats: [
        { id: 'player', kind: 'powerboat', x: 0, z: 0, heading: 0 },
        { id: 'ski', kind: 'pwc', x: 12, z: -70, heading: Math.PI / 2 },
      ],
      wind: { speed: 0, from: 0, gustFactor: 1 },
      seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
      oceanQuality: 'low',
      wakes,
    });
    const run = (wakes: boolean): { heave: number; own: number; felt: number; others: number } => {
      const world = new SimWorld(config(wakes), flatOcean);
      world.command({ type: 'setAutopilot', boatId: 'ski', autopilot: { mode: 'drift' } });
      const ski = world.boat('ski')!;
      const player = world.boat('player')!;
      const y0 = ski.dyn.body.position.y;
      let heave = 0;
      const sample = createSurfaceSample();
      for (let t = 0.5; t <= 14; t += 0.5) {
        world.advance({
          type: 'advance',
          targetTime: t,
          controls: { player: { ...neutralControls(), throttle: 1 } },
          commands: [],
          probes: new Float64Array(),
        });
        heave = Math.max(heave, Math.abs(ski.dyn.body.position.y - y0));
      }
      // Just astern of the powerboat, in its own wake: its sampler sees only the ski's grid.
      const p = player.dyn.body.position;
      const grids = world.wakes?.field.wakes ?? [];
      const at = (exclude: number): number =>
        world.wakes?.field.sample(p.x, p.z + 8, world.time, grids[exclude] ?? null, 0, wakeSample()).height ??
        0;
      const felt = player.water.surface.query(p.x, p.z + 8, world.time, sample).height;
      return { heave, own: at(1), felt, others: at(0) };
    };
    const calm = run(false);
    const waked = run(true);
    expect(calm.heave).toBeLessThan(0.01);
    expect(waked.heave).toBeGreaterThan(0.05);
    expect(Math.abs(waked.own)).toBeGreaterThan(0.02); // the powerboat's wake is there…
    expect(waked.felt).toBeCloseTo(waked.others, 9); // …but its own hull does not feel it
  });
});
