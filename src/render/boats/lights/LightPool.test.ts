import { type Light, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import type { QualityPreset } from '../../../app/Scenario';
import type { BoatKind } from '../../../sim/world/protocol';
import { BoatLights } from './BoatLights';
import { assignPoolSlots, FLEET_LIGHTS, LIGHT_BUDGET } from './lightBudget';
import { FleetLightPool, type FleetLightSource, SceneLightPool } from './LightPool';

const DARK = (-10 * Math.PI) / 180;

// What three keys the lit materials' pipelines on: each scene light's id, type and castShadow, in
// traversal order.
function lightSet(scene: Scene): string {
  const lights: Light[] = [];
  scene.traverseVisible((o) => {
    if ((o as Light).isLight) lights.push(o as Light);
  });
  return lights.map((l) => `${l.id}:${l.type}:${l.castShadow}`).join(',');
}

function session(quality: QualityPreset) {
  const scene = new Scene();
  const pool = new SceneLightPool(LIGHT_BUDGET[quality]);
  scene.add(pool.object);
  const camera = new PerspectiveCamera();
  camera.position.set(0, 10, 30);
  const kinds: BoatKind[] = ['crab', 'powerboat', 'pwc', 'cargo', 'cruise', 'sail'];
  const boats = kinds.map((kind, i) => {
    const root = new Scene();
    root.position.set(i * 200, 0, 0);
    scene.add(root);
    return new BoatLights(root, { kind, quality, local: false });
  });
  const frame = () => {
    for (const lights of boats) {
      lights.setState({ nav: true, deck: true, cabin: 'auto' });
      lights.update(camera, 1 / 60, 1, DARK);
    }
  };
  return { scene, pool, boats, frame };
}

describe('scene light pool', () => {
  for (const quality of ['low', 'medium', 'high', 'ultra'] as const) {
    it(`keeps the same scene lights across helm switches (${quality})`, () => {
      const { scene, pool, boats, frame } = session(quality);
      const budget = LIGHT_BUDGET[quality];
      frame();
      const before = lightSet(scene);
      expect(pool.lights).toHaveLength(budget.navSpill + budget.deckLights);
      expect(pool.lights.every((l) => l.type === 'SpotLight')).toBe(true);
      expect(pool.lights.filter((l) => l.castShadow)).toHaveLength(budget.deckShadows);
      let holder: BoatLights | null = null;
      for (const next of [...boats, null, boats[0]!]) {
        holder?.bindPool(null);
        next?.bindPool(pool);
        holder = next;
        frame();
        expect(lightSet(scene)).toBe(before);
        if (!next) expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
      }
    });
  }

  it("lights the helm boat's deck at night and leaves unused slots dark", () => {
    const { pool, boats, frame } = session('ultra');
    const crab = boats[0]!;
    crab.bindPool(pool);
    frame();
    expect(crab.deck.sceneLights).toBe(LIGHT_BUDGET.ultra.deckLights);
    expect(crab.deck.shadowedLights).toBe(LIGHT_BUDGET.ultra.deckShadows);
    expect(pool.deck.every((l) => l.intensity > 0)).toBe(true);
    // The PWC has one headlight-class deck mount at most: the rest of the pool stays dark.
    crab.bindPool(null);
    const pwc = boats[2]!;
    pwc.bindPool(pool);
    frame();
    const lit = pool.deck.filter((l) => l.intensity > 0).length;
    expect(lit).toBe(pwc.deck.sceneLights);
    expect(lit).toBeLessThan(pool.deck.length);
    // Placed in the boat's body frame; the pool follows the boat's root.
    pool.follow(pwc.object.parent);
    expect(pool.object.position.distanceTo(new Vector3(400, 0, 0))).toBe(0);
  });

  it('switches the deck lights and the extras independently, sharing the pool among what is on', () => {
    const { pool, boats } = session('low'); // one deck light
    const camera = new PerspectiveCamera();
    const crab = boats[0]!;
    crab.bindPool(pool);
    const run = (deck: boolean, extra: boolean) => {
      crab.setState({ nav: true, deck, extra, cabin: false });
      crab.update(camera, 1 / 60, 1, DARK);
      const lamps = crab.deck.mounts
        .map((m, i) => ({ m, on: crab.deck.field.intensityOf(i) > 0 }))
        .filter((l) => l.m.lamp);
      return {
        floodLamps: lamps.filter((l) => l.m.type === 'flood').every((l) => l.on),
        searchLamps: lamps.filter((l) => l.m.type === 'searchlight').every((l) => l.on),
        lit: pool.deck.filter((l) => l.intensity > 0).length,
      };
    };
    // Lamp field entries are the lamp mounts in order, so index the field by lamp mount.
    expect(crab.deck.mounts.every((m) => m.lamp)).toBe(true);
    expect(run(true, false)).toEqual({ floodLamps: true, searchLamps: false, lit: 1 });
    expect(crab.extraLightsOn).toBe(false);
    // Searchlights alone: the one scene light moves to a searchlight.
    expect(run(false, true)).toEqual({ floodLamps: false, searchLamps: true, lit: 1 });
    expect(pool.deck[0]!.angle).toBeLessThan((10 * Math.PI) / 180);
    expect(run(false, false)).toEqual({ floodLamps: false, searchLamps: false, lit: 0 });
  });

  it('lights the water at the center console’s transom with its underwater LEDs', () => {
    const { boats } = session('high');
    const powerboat = boats[1]!;
    const camera = new PerspectiveCamera();
    expect(powerboat.deck.underwater.count).toBe(2);
    powerboat.setState({ deck: false, extra: true });
    powerboat.update(camera, 1 / 60, 1, DARK);
    expect(powerboat.deck.underwater.lit).toBe(true);
    powerboat.setState({ extra: false });
    powerboat.update(camera, 1 / 60, 1, DARK);
    expect(powerboat.deck.underwater.lit).toBe(false);
  });

  it('assigns shadowed slots to shadow-eligible spots first, never to point lights', () => {
    const m = (priority: number, light: string, shadow: boolean) => ({ priority, light, shadow });
    const picks = assignPoolSlots(
      [m(0, 'point', true), m(1, 'spot', false), m(2, 'spot', true), m(3, 'none', true), m(4, 'spot', false)],
      1,
      2,
    );
    expect(picks.map((p) => [p.item.priority, p.slot, p.shadow])).toEqual([
      [0, 1, false], // point → plain slot
      [1, 2, false],
      [2, 0, true], // shadow-eligible spot → the shadowed slot
    ]);
    // Spots overflow into spare shadowed slots; points don't.
    const overflow = assignPoolSlots([m(0, 'spot', false), m(1, 'point', false), m(2, 'spot', false)], 1, 1);
    expect(overflow.map((p) => [p.item.priority, p.slot, p.shadow])).toEqual([
      [0, 1, false],
      [2, 0, true],
    ]);
  });

  it("lends the fleet lights to the nearest lit fleet boats without changing the scene's lights", () => {
    const { scene, pool, boats, frame } = session('ultra');
    const fleet = new FleetLightPool(FLEET_LIGHTS.ultra);
    scene.add(fleet.object);
    const camera = new PerspectiveCamera();
    camera.position.set(0, 10, 30);
    // boats: crab (helm, 0 m), powerboat 200 m, pwc 400 m, cargo 600 m, cruise 800 m, sail 1 km.
    const sources = (on: boolean, helm: BoatLights): FleetLightSource[] =>
      boats
        .filter((b) => b !== helm)
        .map((b) => ({ id: b.kind, root: b.object.parent!, beam: b.litFleetBeam, on }));
    boats[0]!.bindPool(pool);
    frame();
    const before = lightSet(scene);
    expect(fleet.lights).toHaveLength(FLEET_LIGHTS.ultra);
    expect(fleet.lights.every((l) => l.type === 'SpotLight' && !l.castShadow)).toBe(true);

    fleet.update(sources(false, boats[0]!), camera, 1, 1 / 60);
    expect(fleet.lights.every((l) => l.intensity === 0)).toBe(true);
    fleet.update(sources(true, boats[0]!), camera, 1, 1 / 60);
    expect(lightSet(scene)).toBe(before);
    // The powerboat's T-top and courtesy LEDs are too dim to count; the PWC's headlight (an extra, on
    // by itself after dark) is near enough, the cargo ship too far.
    expect(fleet.assignments.map((a) => a.id)).toEqual(['pwc']);
    const lit = fleet.lights.find((l) => l.intensity > 0)!;
    expect(lit.position.x).toBeCloseTo(400, 0);
    expect(lit.target.position.z).toBeLessThan(lit.position.z); // the headlight shines ahead (−Z)

    // The crab hands the helm over: it bids for a fleet light like any other boat.
    boats[0]!.bindPool(null);
    boats[2]!.bindPool(pool);
    frame();
    fleet.update(sources(true, boats[2]!), camera, 1, 1 / 60);
    expect(fleet.assignments.map((a) => a.id)).toEqual(['crab']);
    expect(lightSet(scene)).toBe(before);
    fleet.idle();
    expect(fleet.lights.every((l) => l.intensity === 0)).toBe(true);
    expect(lightSet(scene)).toBe(before);
  });
});
