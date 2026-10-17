import { describe, expect, it } from 'vite-plus/test';

import { mountsFromMarkers } from './modelMounts';
import { defaultDeckMounts } from './mounts';

describe('mountsFromMarkers', () => {
  it('moves the COLREG mounts onto the model lanterns', () => {
    const { mounts } = mountsFromMarkers('crab', [
      { kind: 'sidePort', position: { x: -3, y: 5, z: -9 } },
      { kind: 'fishingRed', position: { x: 0, y: 12, z: -11 } },
      { kind: 'fishingWhite', position: { x: 0, y: 11, z: -11 } },
      { kind: 'tricolour', position: { x: 0, y: 20, z: 0 } }, // not part of a crabber's set
    ]);
    expect(mounts.map((m) => m.name)).toEqual(['port', 'signal-red-upper', 'signal-white']);
    expect(mounts[0]?.roles).toEqual(['port']);
    expect(mounts[0]?.position).toEqual({ x: -3, y: 5, z: -9 });
  });

  it('maps the all-round white lantern per boat', () => {
    const marker = { kind: 'allRoundWhite' as const, position: { x: 0, y: 2, z: 4 } };
    expect(mountsFromMarkers('powerboat', [marker]).mounts[0]?.name).toBe('stern-pole');
    expect(mountsFromMarkers('pwc', [marker]).mounts[0]?.name).toBe('accessory');
  });

  it('replaces the default floods with the model floods, aimed along the marker', () => {
    const floods = defaultDeckMounts('crab').filter((m) => m.type === 'flood');
    const result = mountsFromMarkers('crab', [
      { kind: 'deckFlood', position: { x: 1, y: 10, z: -10 }, aim: { x: 0, y: -0.6, z: 0.8 } },
      { kind: 'deckFlood', position: { x: -1, y: 10, z: -10 }, aim: { x: 0, y: 0, z: 1 } },
    ]);
    expect(result.replaceFloods).toBe(true);
    expect(result.deckMounts).toHaveLength(2);
    const [first] = result.deckMounts;
    expect(first?.colour).toEqual(floods[0]?.colour);
    expect(first?.intensity).toBe(floods[0]?.intensity);
    expect(first!.target.y).toBeLessThan(first!.position.y);
    expect(first!.target.z).toBeGreaterThan(first!.position.z);
  });

  it('keeps the defaults when the model has no floods', () => {
    expect(mountsFromMarkers('sail', []).replaceFloods).toBe(false);
  });

  it('spreads a sailboat tricolour over its three sectors and moves the spreader lights', () => {
    const result = mountsFromMarkers('sail', [
      { kind: 'tricolour', position: { x: 0, y: 16.7, z: -1.2 } },
      { kind: 'allRoundWhite', position: { x: 0, y: 16.8, z: -1.2 } },
      { kind: 'spreader', position: { x: -0.16, y: 6.1, z: -1.2 }, aim: { x: 0, y: -1, z: 0 } },
      { kind: 'spreader', position: { x: 0.16, y: 6.1, z: -1.2 }, aim: { x: 0, y: -1, z: 0 } },
    ]);
    expect(result.mounts.map((m) => m.name)).toEqual([
      'tricolour-port',
      'tricolour-starboard',
      'tricolour-stern',
      'anchor',
    ]);
    const spreaders = defaultDeckMounts('sail').filter((m) => m.type === 'spreader');
    expect(result.deckMounts.map((m) => m.name)).toEqual(spreaders.map((m) => m.name));
    expect(result.deckMounts[0]?.position).toEqual({ x: -0.16, y: 6.1, z: -1.2 });
    expect(result.deckMounts[0]!.target.y).toBeLessThan(6.1);
    expect(result.replaceFloods).toBe(false);
  });

  it('moves the searchlights onto the model lamp heads, keeping their aim', () => {
    const defaults = defaultDeckMounts('crab').filter((m) => m.type === 'searchlight');
    const result = mountsFromMarkers('crab', [
      { kind: 'searchlight', position: { x: -1.6, y: 9.3, z: -11 }, aim: { x: 0, y: 1, z: 0 } },
      { kind: 'searchlight', position: { x: 1.6, y: 9.3, z: -11 } },
    ]);
    expect(result.deckMounts.map((m) => m.name)).toEqual(defaults.map((m) => m.name));
    const [port] = result.deckMounts;
    const base = defaults[0]!;
    expect(port?.position).toEqual({ x: -1.6, y: 9.3, z: -11 });
    expect(port!.target.x - port!.position.x).toBeCloseTo(base.target.x - base.position.x);
    expect(port!.target.z - port!.position.z).toBeCloseTo(base.target.z - base.position.z);
    expect(result.replaceFloods).toBe(false);
  });
});
