import { describe, expect, it } from 'vite-plus/test';

import {
  createFleetLightState,
  FLEET_FADE_FAR,
  FLEET_FADE_NEAR,
  FLEET_FADE_TIME,
  type FleetCandidate,
  fleetBeam,
  fleetDistanceFade,
  type FleetLightState,
  POINT_AS_SPOT_ANGLE,
  updateFleetLights,
} from './fleetLighting';
import { defaultDeckMounts } from './mounts';

const DT = 1 / 60;
const holders = (state: FleetLightState): (string | null)[] => state.slots.map((s) => s.id);
// The boats holding a light, in name order.
const held = (state: FleetLightState): string[] =>
  state.slots.flatMap((s) => (s.id === null ? [] : [s.id])).sort((a, b) => a.localeCompare(b));
const c = (id: string, distance: number): FleetCandidate => ({ id, distance });

// Runs frames until a fade has certainly finished.
function settle(state: FleetLightState, candidates: readonly FleetCandidate[], seconds = 2): void {
  for (let t = 0; t < seconds; t += DT) updateFleetLights(state, candidates, DT);
}

describe('fleet beam', () => {
  it("merges the crab's mast flood pair into one centreline beam as bright as both", () => {
    const beam = fleetBeam(defaultDeckMounts('crab'))!;
    expect(beam.position.x).toBeCloseTo(0);
    expect(beam.target.x).toBeCloseTo(0);
    expect(beam.position.y).toBeCloseTo(11.5);
    expect(beam.intensity).toBe(32_000);
    // Wider than one flood's 32°, to cover both aim points.
    expect(beam.angle).toBeGreaterThan((32 * Math.PI) / 180);
    expect(beam.angle).toBeLessThan((45 * Math.PI) / 180);
  });

  it('keeps a lone centreline fitting as it is', () => {
    const beam = fleetBeam(defaultDeckMounts('pwc'))!;
    const [headlight] = defaultDeckMounts('pwc');
    expect(beam.intensity).toBe(headlight!.intensity);
    expect(beam.angle).toBe(headlight!.angle);
    expect(beam.range).toBe(headlight!.range);
  });

  it('skips fittings too dim to light anything from another boat', () => {
    // The powerboat's lit mounts are 4 cd courtesy LEDs (its underwater LEDs have no scene light).
    expect(fleetBeam(defaultDeckMounts('powerboat'))).toBeNull();
  });

  it('turns a point fitting into a downward hemisphere', () => {
    const [promenade] = defaultDeckMounts('cruise').filter((m) => m.light === 'point');
    const beam = fleetBeam([{ ...promenade!, priority: 0 }])!;
    expect(beam.angle).toBe(POINT_AS_SPOT_ANGLE);
    expect(beam.target.y).toBeLessThan(beam.position.y);
    expect(beam.target.x).toBe(beam.position.x);
  });
});

describe('fleet light assignment', () => {
  it('fades with distance from the camera', () => {
    expect(fleetDistanceFade(0)).toBe(1);
    expect(fleetDistanceFade(FLEET_FADE_NEAR)).toBe(1);
    expect(fleetDistanceFade((FLEET_FADE_NEAR + FLEET_FADE_FAR) / 2)).toBeCloseTo(0.5);
    expect(fleetDistanceFade(FLEET_FADE_FAR)).toBe(0);
  });

  it('lends the lights to the nearest boats, at full level as their lights come on', () => {
    const state = createFleetLightState(2);
    updateFleetLights(state, [c('far', 300), c('near', 50), c('mid', 120), c('out', FLEET_FADE_FAR + 1)], DT);
    expect(held(state)).toEqual(['mid', 'near']);
    expect(state.slots.every((s) => s.level === 1)).toBe(true);
  });

  it('keeps a holder until a challenger is clearly nearer', () => {
    const state = createFleetLightState(1);
    settle(state, [c('a', 100), c('b', 110)]);
    expect(holders(state)).toEqual(['a']);
    // b edges ahead, but not past the hysteresis: no flicker.
    settle(state, [c('a', 100), c('b', 90)]);
    expect(holders(state)).toEqual(['a']);
    expect(state.slots[0]!.level).toBe(1);
  });

  it('hands over by fading the holder out, then the newcomer in', () => {
    const state = createFleetLightState(1);
    settle(state, [c('a', 100), c('b', 200)]);
    const swap = [c('a', 200), c('b', 50)];
    updateFleetLights(state, swap, DT);
    expect(holders(state)).toEqual(['a']);
    expect(state.slots[0]!.level).toBeLessThan(1);
    // Half-way through the fade-out: still a, dimmer.
    for (let t = DT; t < FLEET_FADE_TIME / 2; t += DT) updateFleetLights(state, swap, DT);
    expect(holders(state)).toEqual(['a']);
    expect(state.slots[0]!.level).toBeCloseTo(0.5, 1);
    for (let t = 0; t < FLEET_FADE_TIME / 2 + 2 * DT; t += DT) updateFleetLights(state, swap, DT);
    expect(holders(state)).toEqual(['b']);
    expect(state.slots[0]!.level).toBeLessThan(0.2);
    settle(state, swap);
    expect(holders(state)).toEqual(['b']);
    expect(state.slots[0]!.level).toBe(1);
  });

  it('lets go at once when a boat switches off, leaves or goes out of range', () => {
    const state = createFleetLightState(3);
    settle(state, [c('a', 100), c('b', 200), c('c', 300)]);
    updateFleetLights(state, [c('b', FLEET_FADE_FAR + 5)], DT); // a off/left, b out of range
    expect(holders(state)).toEqual([null, null, null]);
    expect(state.slots.every((s) => s.level === 0)).toBe(true);
  });

  it('never gives one boat two lights, and leaves spare lights free', () => {
    const state = createFleetLightState(3);
    settle(state, [c('a', 100)]);
    expect(held(state)).toEqual(['a']);
    settle(state, [c('a', 100), c('b', 120)]);
    expect(held(state)).toEqual(['a', 'b']);
    expect(holders(state).filter((id) => id === null)).toHaveLength(1);
  });

  it('does nothing without lights', () => {
    const state = createFleetLightState(0);
    updateFleetLights(state, [c('a', 10)], DT);
    expect(state.slots).toEqual([]);
  });
});
