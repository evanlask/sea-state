import { describe, expect, it } from 'vite-plus/test';

import { Rng } from '../../sim/core/rng';
import { getWeatherPreset, WEATHER_PRESETS } from '../../sim/weather/presets';
import {
  aircraftLights,
  aircraftPosition,
  alongTrack,
  ContrailSchedule,
  contrailFinished,
  contrailRate,
  type ContrailWeather,
  headingVector,
  MAX_CONTRAILS,
  MEAN_INTERVAL,
  persistenceFor,
  planContrail,
  TRAIL_GAP,
  trailAgeRange,
  trailOpacity,
  trailPoint,
  trailWidth,
  windAloftForJet,
} from './contrails';

const weatherOf = (id: string): ContrailWeather => {
  const p = getWeatherPreset(id);
  return { clouds: p.clouds, precipitation: p.precipitation, visibility: p.visibility };
};

const plan = (seed: number, forced = false) =>
  planContrail(new Rng(seed), 1, {
    time: 100,
    around: { x: 500, z: -300 },
    surfaceWind: { x: 3, z: 2 },
    forced,
  });

describe('contrail spawn rules', () => {
  it('comes about every few minutes on clear and fair days', () => {
    expect(contrailRate(weatherOf('glassy-calm'))).toBeCloseTo(1 / MEAN_INTERVAL);
    expect(contrailRate(weatherOf('fair'))).toBeCloseTo(1 / MEAN_INTERVAL, 4);
    expect(contrailRate(weatherOf('long-swell'))).toBeCloseTo(1 / MEAN_INTERVAL, 4);
    const breezy = contrailRate(weatherOf('breezy'));
    expect(breezy).toBeGreaterThan(0.5 / MEAN_INTERVAL);
    expect(breezy).toBeLessThan(contrailRate(weatherOf('fair')));
  });

  it('is rarer in squalls and never under overcast, rain, fog or storms', () => {
    const squalls = contrailRate(weatherOf('squalls'));
    expect(squalls).toBeGreaterThan(0);
    expect(squalls).toBeLessThan(0.5 / MEAN_INTERVAL);
    for (const id of [
      'overcast-drizzle',
      'gale',
      'storm',
      'hurricane-1',
      'hurricane-3',
      'hurricane-5',
      'fog-bank',
      'night-thunderstorm',
    ]) {
      expect(contrailRate(weatherOf(id)), id).toBe(0);
    }
    for (const preset of WEATHER_PRESETS)
      expect(contrailRate(weatherOf(preset.id))).toBeGreaterThanOrEqual(0);
  });
});

describe('contrail track', () => {
  it('flies a straight track at cruise height and speed, passing within ~45 km', () => {
    for (let seed = 1; seed < 40; seed++) {
      const e = plan(seed);
      expect(e.altitude).toBeGreaterThanOrEqual(9500);
      expect(e.altitude).toBeLessThanOrEqual(11_500);
      expect(e.speed).toBeGreaterThanOrEqual(230);
      expect(e.speed).toBeLessThanOrEqual(260);
      const dx = e.closest.x - 500;
      const dz = e.closest.z + 300;
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(45_001);
      const u = headingVector(e.heading);
      expect(Math.abs(dx * u.x + dz * u.z)).toBeLessThan(1e-6 * Math.max(1, Math.hypot(dx, dz)));
      // Starts far off, beyond the haze-hidden horizon band, and comes nearer.
      expect(-e.start).toBeGreaterThanOrEqual(80_000);
      expect(alongTrack(e, e.t0)).toBe(e.start);
      expect(e.formOn).toBeGreaterThanOrEqual(e.start);
      expect(e.formOff).toBeGreaterThan(0);
    }
  });

  it('is deterministic per seed', () => {
    expect(plan(7)).toEqual(plan(7));
    expect(plan(7)).not.toEqual(plan(8));
  });

  it('moves at its speed along its heading', () => {
    const e = plan(3);
    const a = aircraftPosition(e, 200);
    const b = aircraftPosition(e, 210);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeCloseTo(e.speed * 10, 6);
    const u = headingVector(e.heading);
    expect(((b.x - a.x) * u.x + (b.z - a.z) * u.z) / (e.speed * 10)).toBeCloseTo(1, 9);
    expect(a.y).toBe(e.altitude);
  });

  it('forced: already close and nearly overhead, its trail stretching behind it', () => {
    const e = plan(5, true);
    const now = aircraftPosition(e, 100);
    expect(Math.hypot(e.closest.x - 500, e.closest.z + 300)).toBeLessThanOrEqual(9000);
    expect(alongTrack(e, 100)).toBeCloseTo(-25_000, 3);
    expect(Math.hypot(now.x - 500, now.z + 300)).toBeLessThan(30_000);
    const ages = trailAgeRange(e, 100);
    expect(ages.min).toBe(TRAIL_GAP);
    expect(ages.max).toBeGreaterThan(60);
  });
});

describe('contrail trail', () => {
  it('drifts with the wind aloft: each bit of trail is where it formed plus wind × age', () => {
    const e = plan(11);
    const t = 400;
    for (const age of [1, 30, 120, 300]) {
      const formed = aircraftPosition(e, t - age);
      const p = trailPoint(e, t, age);
      expect(p.x).toBeCloseTo(formed.x + e.wind.x * age, 6);
      expect(p.z).toBeCloseTo(formed.z + e.wind.z * age, 6);
    }
  });

  it('has jet-stream winds aloft, veered from the surface wind and never calm', () => {
    const rng = new Rng(2);
    for (let i = 0; i < 50; i++) {
      const w = windAloftForJet({ x: 0, z: -10 }, rng); // surface wind blowing north
      const speed = Math.hypot(w.x, w.z);
      expect(speed).toBeGreaterThanOrEqual(5);
      expect(speed).toBeLessThanOrEqual(45);
      const heading = Math.atan2(w.x, -w.z);
      expect(heading).toBeGreaterThan(0.05); // veered clockwise
      expect(heading).toBeLessThan(0.5);
    }
    const calm = windAloftForJet({ x: 0, z: 0 }, new Rng(4));
    expect(Math.hypot(calm.x, calm.z)).toBeGreaterThanOrEqual(5);
  });

  it('only forms within its stretch of track, starting a short gap behind the aircraft', () => {
    const e = plan(13);
    for (const t of [e.t0 + 100, e.t0 + 500, e.t0 + 900, e.t0 + 1300]) {
      const { min, max } = trailAgeRange(e, t);
      if (max <= min) continue;
      expect(min).toBeGreaterThanOrEqual(TRAIL_GAP);
      const s = alongTrack(e, t);
      expect(s - e.speed * min).toBeLessThanOrEqual(e.formOff + 1e-6);
      expect(s - e.speed * max).toBeGreaterThanOrEqual(e.formOn - 1e-6);
      expect(max).toBeLessThanOrEqual(e.persistence.maxAge);
    }
  });

  it('spreads from a few metres to hundreds over minutes', () => {
    const p = persistenceFor(1, new Rng(1));
    expect(trailWidth(p, 0)).toBeLessThan(8);
    let last = 0;
    for (let age = 0; age <= 600; age += 10) {
      const w = trailWidth(p, age);
      expect(w).toBeGreaterThan(last);
      last = w;
    }
    expect(trailWidth(p, 300)).toBeGreaterThan(200);
    const short = persistenceFor(0, new Rng(1));
    expect(trailWidth(short, 300)).toBeLessThan(trailWidth(p, 300));
  });

  it('condenses within seconds, then fades over minutes; short-lived trails sooner', () => {
    const long = persistenceFor(1, new Rng(3));
    const short = persistenceFor(0, new Rng(3));
    expect(trailOpacity(long, 0)).toBe(0);
    expect(trailOpacity(long, TRAIL_GAP * 0.5)).toBe(0);
    expect(trailOpacity(long, 3)).toBeGreaterThan(0.3);
    expect(trailOpacity(long, 3)).toBeLessThan(0.75);
    expect(trailOpacity(long, 120)).toBeLessThan(trailOpacity(long, 5));
    expect(trailOpacity(long, 240)).toBeGreaterThan(0.03);
    expect(trailOpacity(long, long.maxAge)).toBe(0);
    expect(trailOpacity(short, 120)).toBeLessThan(0.05);
    expect(short.maxAge).toBeLessThan(long.maxAge);
    for (let age = 0; age < long.maxAge; age += 7) {
      const o = trailOpacity(long, age);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(1);
    }
  });

  it('ends once the aircraft is out of sight and its trail has faded', () => {
    const e = plan(17);
    expect(contrailFinished(e, e.t0)).toBe(false);
    expect(contrailFinished(e, e.t0 + 600)).toBe(false);
    expect(contrailFinished(e, e.t0 + 4 * 3600)).toBe(true);
  });
});

describe('aircraft lights', () => {
  it('keeps the wingtips steady and flashes the strobes and beacon briefly', () => {
    const e = plan(19);
    let strobe = 0;
    let beacon = 0;
    const n = 6000;
    for (let i = 0; i < n; i++) {
      const l = aircraftLights(e, i / 1000);
      expect(l.red).toBeGreaterThan(0);
      expect(l.green).toBeGreaterThan(0);
      if (l.strobe > 0) strobe++;
      if (l.beacon > 0) beacon++;
    }
    expect(strobe / n).toBeGreaterThan(0.03);
    expect(strobe / n).toBeLessThan(0.15);
    expect(beacon / n).toBeCloseTo(0.1, 1);
  });
});

describe('contrail schedule', () => {
  const run = (id: string, seed: number, seconds: number) => {
    const schedule = new ContrailSchedule(seed);
    const seen = new Map<number, number>();
    let most = 0;
    for (let t = 0; t <= seconds; t += 0.5) {
      schedule.update({
        time: t,
        around: { x: 0, z: 0 },
        weather: weatherOf(id),
        surfaceWind: { x: 4, z: 0 },
      });
      for (const e of schedule.events) if (!seen.has(e.id)) seen.set(e.id, t);
      most = Math.max(most, schedule.events.length);
    }
    return { seen, most };
  };

  it('brings a jet every several minutes in fair weather, at most a few at once', () => {
    const { seen, most } = run('fair', 1, 4 * 3600);
    expect(seen.size).toBeGreaterThan(12);
    expect(seen.size).toBeLessThan(45);
    expect(most).toBeLessThanOrEqual(MAX_CONTRAILS);
  });

  it('is deterministic per seed and quiet in a gale', () => {
    expect([...run('fair', 9, 3600).seen]).toEqual([...run('fair', 9, 3600).seen]);
    expect(run('gale', 9, 3600).seen.size).toBe(0);
  });

  it('forces a jet on demand, even in a gale', () => {
    const schedule = new ContrailSchedule(1);
    const frame = {
      time: 50,
      around: { x: 0, z: 0 },
      weather: weatherOf('gale'),
      surfaceWind: { x: 0, z: 0 },
    };
    for (let i = 0; i < MAX_CONTRAILS + 2; i++) schedule.force(frame);
    expect(schedule.events.length).toBe(MAX_CONTRAILS);
    schedule.update(frame);
    expect(schedule.events.length).toBe(MAX_CONTRAILS);
  });
});
