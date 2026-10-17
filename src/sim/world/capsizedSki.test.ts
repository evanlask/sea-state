import { describe, expect, it } from 'vite-plus/test';

import { CALIBRATION } from '../boats/calibration/index';
import { boatModel } from '../boats/drivetrains';
import { DEG } from '../core/conventions';
import { qRotate, vec3 } from '../core/math';
import { RHO_SEAWATER } from '../core/units';
import { riderlessMassProperties } from '../physics/boatModel';
import { Hydrostatics } from '../physics/hydrostatics';
import { IrregularSea } from '../physics/seas';
import { UniformWind } from '../physics/windage';
import { neutralControls, type SimCommand, type SimEvent, type Snapshot } from './protocol';
import { flatOcean, SimWorld } from './SimWorld';
import { WorldBoat } from './WorldBoat';

// The jet ski once a capsize has thrown its rider off: it floats upside down on its deck and seat
// (manufacturers mark which way to roll it back), the lanyard has stopped the engine, and Recover puts
// him back aboard, upright and running.

const UP = vec3(0, 1, 0);

const tiltOf = (s: Snapshot): number => {
  const q = s.boats[0]!.orientation;
  return Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))));
};

// On to time t in quarter seconds (an advance runs at most half a second), the throttle held open and
// the bars hard over if `throttle`; the events of the whole stretch.
function advance(world: SimWorld, t: number, throttle = 0, commands: SimCommand[] = []): Snapshot {
  const c = neutralControls();
  c.throttle = throttle;
  c.steer = throttle > 0 ? 1 : 0;
  const events: Snapshot['events'] = [];
  let s: Snapshot | null = null;
  let first = true;
  while (!s || s.time < t - 0.01) {
    const target = Math.min(t, world.time + 0.25);
    s = world.advance({
      type: 'advance',
      targetTime: target,
      controls: { ski: c },
      commands: first ? commands : [],
      probes: new Float64Array(),
    });
    events.push(...s.events);
    first = false;
  }
  return { ...s, events };
}

describe('jet ski after a capsize', () => {
  it('without its rider it floats upside down: GZ restores toward inverted past ~110°', () => {
    const model = boatModel('pwc');
    const off = riderlessMassProperties(model);
    expect(off.mass).toBe(model.mass - 90);
    expect(off.cg.y).toBeLessThan(model.cg.y - 0.1); // he sat high
    const hydro = new Hydrostatics(model.buoyant);
    const bare = hydro.gzCurve(off.cg, off.mass / RHO_SEAWATER, { step: 10 * DEG });
    // Upright it is stiff without him (an AVS of ~110°), upside down stable from about there to 180°:
    // GZ < 0 turns it on over toward inverted, and it takes a push to roll it back.
    expect(bare.gm).toBeGreaterThan(0.15);
    expect(bare.avs / DEG).toBeGreaterThan(95);
    expect(bare.avs / DEG).toBeLessThan(125);
    for (let i = 13; i <= 17; i++) expect(bare.gz[i]!).toBeLessThan(-0.01); // 130–170°
    // Ridden, the upright curve is the calibrated one (the rider only goes in a capsize).
    const ridden = hydro.gzCurve(model.cg, model.designVolume, { step: 10 * DEG });
    expect(ridden.avs).toBeCloseTo(CALIBRATION.pwc.stability.avs, 2);
    expect(ridden.gz[17]!).toBeLessThan(-0.03);
  });

  it('thrown off in the capsize: the craft loses his mass, the engine stops; Recover puts him back', () => {
    const world = new SimWorld(
      {
        seed: 1,
        physicsMode: 'realistic',
        boats: [{ id: 'ski', kind: 'pwc', x: 0, z: 0, heading: 0 }],
        wind: { speed: 0, from: 0, gustFactor: 1 },
        seaState: { mode: 'auto', fetch: 400_000, fullyDeveloped: false, swell: null },
        oceanQuality: 'low',
      },
      flatOcean,
    );
    const boat = world.boat('ski')!;
    const dyn = boat.dyn;
    const origin = vec3();
    dyn.placeAtRest(0, 0, 0, Math.PI);
    let s = advance(world, 1, 1);
    expect(s.events.some((e) => e.type === 'capsized')).toBe(true);
    // Upside down with the throttle held open and the bars over: no rider, no engine, no thrust.
    expect(dyn.riderAboard).toBe(false);
    expect(dyn.body.mass).toBeCloseTo(415, 0);
    s = advance(world, 4, 1);
    expect(s.boats[0]!.telemetry['thrust']).toBe(0);
    expect(s.boats[0]!.telemetry['rpm']).toBeLessThan(100);
    expect(tiltOf(s)).toBeGreaterThan(170 * DEG);
    // Throwing him off moves the CG within the hull, not the hull.
    dyn.body.getOrigin(origin);
    const before = { ...origin };
    dyn.setRiderAboard(true);
    dyn.body.getOrigin(origin);
    expect(Math.hypot(origin.x - before.x, origin.y - before.y, origin.z - before.z)).toBeLessThan(1e-9);
    dyn.setRiderAboard(false);
    // Recover: upright, the rider aboard, and the jet drives again.
    s = advance(world, 4.5, 0, [{ type: 'recover', boatId: 'ski' }]);
    expect(s.events.some((e) => e.type === 'recovered')).toBe(true);
    expect(dyn.riderAboard).toBe(true);
    expect(dyn.body.mass).toBe(505);
    expect(tiltOf(s)).toBeLessThan(0.05);
    s = advance(world, 6.5, 1);
    expect(s.boats[0]!.telemetry['thrust']).toBeGreaterThan(1000);
    expect(s.boats[0]!.telemetry['capsized']).toBe(0);
  });

  it('upside down, lying in a moderate sea, it stays upside down', () => {
    // A rough sea (Hs 3 m, Tp 8 s, a Gale's) and its wind on the beam, for a minute.
    for (const seed of [1, 2]) {
      const sea = new IrregularSea({ hs: 3, tp: 8, towards: Math.PI / 2, seed, components: 24 });
      const boat = new WorldBoat('ski', 'pwc', sea, 'realistic');
      boat.place(0, 0, 0, 0);
      boat.dyn.placeAtRest(0, 0, 0, Math.PI, boat.dyn.body.position.y);
      boat.water.reset();
      const wind = new UniformWind(17, -Math.PI / 2);
      const events: SimEvent[] = [];
      const up = vec3();
      let least = Math.PI;
      for (let i = 0; i < 60 * 120; i++) {
        boat.step(1 / 120, i / 120, wind, events);
        if (i < 5 * 120) continue;
        qRotate(up, boat.dyn.body.orientation, UP);
        least = Math.min(least, Math.acos(Math.max(-1, Math.min(1, up.y))));
      }
      expect(events.some((e) => e.type === 'capsized')).toBe(true);
      expect(least / DEG).toBeGreaterThan(120);
    }
  }, 30_000);
});
