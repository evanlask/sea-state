import { describe, expect, it } from 'vite-plus/test';

import { attitudeFromQuat } from '../sim/core/attitude';
import { DEG, headingToVector, signedAngle } from '../sim/core/conventions';
import { knotsToMs } from '../sim/core/units';
import { CC115_RIG } from '../sim/sail/rig';
import { SAIL_KEYS } from '../sim/sail/telemetry';
import { getWeatherPreset } from '../sim/weather/presets';
import type { SeaStateSettings } from '../sim/weather/seaState';
import { MIN_WIND_ANGLE } from '../sim/world/autopilot';
import { BOAT_KINDS, neutralControls, type PhysicsMode, type WindConfig } from '../sim/world/protocol';
import { SimWorld } from '../sim/world/SimWorld';
import { REEF_WIND_KN } from '../ui/hud/sailing';
import { defaultScenario } from './Scenario';
import { simConfigFor } from './scenarioConfig';
import {
  dominantSeasFrom,
  FURL_BY_REEF,
  followerPlan,
  SAIL_TWA,
  sailSetupFor,
  SEAS_OFF_BOW,
  spawnPlan,
} from './spawnPlan';

const presetWind = (id: string): WindConfig => {
  const p = getWeatherPreset(id);
  return { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor };
};
const presetSea = (id: string): SeaStateSettings => getWeatherPreset(id).seaState;
const offWind = (wind: WindConfig, heading: number): number => signedAngle(wind.from - heading);

// A manual wind sea with a swell from 90° to its right.
const crossSea = (hs: number, swellHeight: number, swellPeriod: number): SeaStateSettings => ({
  mode: 'manual',
  height: { kind: 'hs', hs },
  tp: null,
  choppiness: 1,
  crestLength: 'normal',
  directionOffset: 0,
  swell: { height: swellHeight, period: swellPeriod, from: 340 * DEG },
});

describe('spawn plan: powered boats', () => {
  it('put the ships, the crab boat and the jet ski bow-on to the seas, the center console 45° off', () => {
    for (const weather of ['squalls', 'gale', 'storm', 'hurricane-3']) {
      const wind = presetWind(weather);
      for (const kind of ['cargo', 'cruise', 'crab', 'pwc', 'powerboat'] as const) {
        const plan = spawnPlan(kind, wind, presetSea(weather), 'arcade');
        expect(offWind(wind, plan.heading), `${kind} in ${weather}`).toBeCloseTo(SEAS_OFF_BOW[kind]);
        expect(plan.speed).toBe(0);
        expect(plan.sail).toBeUndefined();
      }
    }
    expect(SEAS_OFF_BOW.powerboat).toBeCloseTo(45 * DEG);
  });

  it('face into the wind in a calm, whatever the boat', () => {
    for (const weather of ['glassy-calm', 'fair', 'fog-bank']) {
      const wind = presetWind(weather);
      for (const kind of ['cargo', 'powerboat', 'pwc'] as const) {
        expect(offWind(wind, spawnPlan(kind, wind, presetSea(weather), 'realistic').heading)).toBeCloseTo(0);
      }
    }
  });

  it('face a swell that outruns the wind sea, and the steeper of the two when both are up', () => {
    // Long Ocean Swell: a 3 m swell from 250° under a 6 kn breeze from 160°.
    const wind = presetWind('long-swell');
    expect(dominantSeasFrom(wind, presetSea('long-swell'))).toBeCloseTo(250 * DEG);
    expect(spawnPlan('cargo', wind, presetSea('long-swell'), 'arcade').heading).toBeCloseTo(250 * DEG);
    // A 5 m wind sea (Tp ≈ 11 s) is steeper than a 6 m, 14 s swell; a 6 m, 8 s swell is steeper still.
    const gale: WindConfig = { speed: knotsToMs(40), from: 250 * DEG, gustFactor: 1.3 };
    expect(dominantSeasFrom(gale, crossSea(5, 6, 14))).toBeCloseTo(250 * DEG);
    expect(dominantSeasFrom(gale, crossSea(5, 6, 8))).toBeCloseTo(340 * DEG);
    // Cross Seas: the 1.7 m, 6.6 s wind sea (Hs/Tp² ≈ 0.040) is steeper than the 4.5 m, 12 s swell 75°
    // to its right (≈ 0.031), so the boats meet the wind sea.
    const cross = presetWind('cross-seas');
    expect(dominantSeasFrom(cross, presetSea('cross-seas'))).toBeCloseTo(cross.from);
    // The manual direction offset turns the wind sea.
    const turned = { ...crossSea(5, 0, 14), swell: null, directionOffset: 30 * DEG };
    expect(dominantSeasFrom(gale, turned)).toBeCloseTo(280 * DEG);
    // Nothing a metre high: no seas to face.
    expect(dominantSeasFrom(gale, { ...crossSea(0.5, 0.5, 14) })).toBeNull();
  });
});

describe('spawn plan: the sailboat', () => {
  it('starts on starboard tack on a beam reach, out of irons', () => {
    for (const weather of ['glassy-calm', 'fair', 'breezy', 'squalls', 'gale', 'storm', 'hurricane-5']) {
      const wind = presetWind(weather);
      for (const mode of ['arcade', 'realistic'] as PhysicsMode[]) {
        const plan = spawnPlan('sail', wind, presetSea(weather), mode);
        const twa = offWind(wind, plan.heading);
        expect(twa, weather).toBeCloseTo(SAIL_TWA);
        expect(Math.abs(twa)).toBeGreaterThan(MIN_WIND_ANGLE);
      }
    }
  });

  it('reefs as the HUD advises, furls the genoa to match and sets the sheets within the rig’s travel', () => {
    const reefFor = (kn: number): number => REEF_WIND_KN.filter((limit) => kn >= limit).length;
    for (const kn of [4, 12, 18, 20, 24, 28, 30, 38, 52, 105]) {
      const setup = sailSetupFor(knotsToMs(kn), SAIL_TWA);
      expect(setup.reef, `${kn} kn`).toBe(reefFor(kn));
      expect(setup.furl).toBeCloseTo(FURL_BY_REEF[setup.reef]!);
      expect(setup.mainSheet).toBeGreaterThanOrEqual(CC115_RIG.boomMinIn - 1e-9);
      expect(setup.mainSheet).toBeLessThanOrEqual(CC115_RIG.boomMaxOut + 1e-9);
      expect(setup.jibSheet).toBeGreaterThanOrEqual(CC115_RIG.jibMinIn - 1e-9);
      expect(setup.jibSheet).toBeLessThanOrEqual(CC115_RIG.jibMaxOut + 1e-9);
    }
    expect(sailSetupFor(knotsToMs(38), SAIL_TWA)).toMatchObject({ reef: 3, furl: 2 / 3 });
    expect(sailSetupFor(knotsToMs(8), SAIL_TWA)).toMatchObject({ reef: 0, furl: 0 });
    // From storm force the main is feathered: eased past where the gale's is trimmed.
    expect(sailSetupFor(knotsToMs(52), SAIL_TWA).mainSheet).toBeGreaterThan(
      sailSetupFor(knotsToMs(38), SAIL_TWA).mainSheet + 10 * DEG,
    );
    // Further off the wind, the sheets are eased further.
    const beam = sailSetupFor(knotsToMs(20), 90 * DEG);
    const broad = sailSetupFor(knotsToMs(20), 130 * DEG);
    expect(broad.mainSheet).toBeGreaterThan(beam.mainSheet);
    expect(broad.jibSheet).toBeGreaterThanOrEqual(beam.jibSheet); // the genoa may be eased right out at both
  });
});

describe('spawn plan: the fleet', () => {
  const wind = presetWind('gale');

  it('powered boats take the leader’s heading; a sailboat too when it can sail it', () => {
    expect(followerPlan('cargo', 1.2, wind)).toEqual({ heading: 1.2, speed: 0 });
    const beamReach = wind.from - 80 * DEG;
    expect(followerPlan('sail', beamReach, wind).heading).toBeCloseTo(beamReach);
  });

  it('a sailboat following a boat head to wind or dead downwind sails the nearest heading it can hold', () => {
    const intoWind = followerPlan('sail', wind.from + 5 * DEG, wind);
    // Leader 5° to starboard of the wind (on its port bow): port tack, close-hauled; and vice versa.
    expect(offWind(wind, intoWind.heading)).toBeCloseTo(-50 * DEG);
    expect(followerPlan('sail', wind.from - 5 * DEG, wind).heading).toBeCloseTo(wind.from - 50 * DEG);
    const run = followerPlan('sail', wind.from + Math.PI, wind);
    expect(Math.abs(offWind(wind, run.heading))).toBeCloseTo(150 * DEG);
    expect(intoWind.sail?.reef).toBe(3);
  });

  it('forms up abeam of the player on its heading, the same every time', () => {
    const choices = {
      ...defaultScenario(),
      playerBoat: 'crab' as const,
      fleet: ['pwc', 'sail', 'cargo'] as const,
    };
    for (const weather of ['fair', 'gale', 'long-swell']) {
      const config = simConfigFor({ ...choices, fleet: [...choices.fleet], weather }, 'low');
      const [player, ...fleet] = config.boats;
      const f = headingToVector(player!.heading);
      const sides = fleet.map((boat) => {
        // Abeam: nothing ahead or astern of the player, starboard first.
        expect(boat.x * f.x + boat.z * f.z).toBeCloseTo(0);
        return boat.x * -f.z + boat.z * f.x;
      });
      expect(sides[0]).toBeGreaterThan(30);
      expect(sides[1]).toBeLessThan(-30);
      expect(sides[2]).toBeGreaterThan(sides[0]!);
      expect(simConfigFor({ ...choices, fleet: [...choices.fleet], weather }, 'low')).toEqual(config);
    }
  });

  it('every boat kind gets a plan in every preset', () => {
    for (const weather of ['glassy-calm', 'breezy', 'night-thunderstorm', 'hurricane-1']) {
      for (const kind of BOAT_KINDS) {
        const plan = spawnPlan(kind, presetWind(weather), presetSea(weather), 'arcade');
        expect(Number.isFinite(plan.heading)).toBe(true);
        expect(plan.heading).toBeGreaterThanOrEqual(0);
        expect(plan.heading).toBeLessThan(2 * Math.PI);
      }
    }
  });
});

// The sailboat as the player finds it: spawned by the plan in a Gale, nobody touching anything for a
// minute. It must stay on its feet, keep out of irons and sail.
function sailUnattended(seed: number, mode: PhysicsMode, seconds: number) {
  const choices = {
    ...defaultScenario(),
    seed,
    playerBoat: 'sail' as const,
    weather: 'gale',
    physicsMode: mode,
  };
  const world = new SimWorld({ ...simConfigFor(choices, 'low'), wakes: false });
  const att = { heading: 0, pitch: 0, roll: 0 };
  let capsized = false;
  let heel = 0;
  let irons = 0;
  let speed = 0;
  const dt = 0.5;
  for (let i = 1; i <= seconds / dt; i++) {
    const s = world.advance({
      type: 'advance',
      targetTime: i * dt,
      controls: { player: neutralControls() },
      commands: [],
      probes: new Float64Array(),
    });
    const b = s.boats[0]!;
    capsized ||= s.events.some((e) => e.type === 'capsized');
    heel += Math.abs(attitudeFromQuat(b.orientation, att).roll);
    irons += b.telemetry[SAIL_KEYS.inIrons] ?? 0;
    if (i * dt > seconds / 2) speed += b.telemetry['speedThroughWater'] ?? 0;
  }
  const n = seconds / dt;
  return { capsized, meanHeel: heel / n / DEG, irons: irons / n, speed: speed / (n / 2) };
}

describe('the sailboat at spawn in a Gale, no input', () => {
  for (const [mode, seed] of [
    ['arcade', 1],
    ['realistic', 2],
  ] as const) {
    it(`(${mode}, seed ${seed}) stays upright, out of irons and sailing for a minute`, () => {
      const r = sailUnattended(seed, mode, 60);
      expect(r.capsized).toBe(false);
      expect(r.meanHeel).toBeLessThan(35);
      expect(r.irons).toBeLessThan(0.1);
      expect(r.speed).toBeGreaterThan(2.5);
    }, 60_000);
  }
});
