import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { EMPTY_MANIFEST, type AssetManifest } from '../../../app/loading/manifest';
import {
  alignRotation,
  alignTransform,
  type Bounds,
  markerKind,
  maskPoints,
  parseAlign,
  toBody,
} from './align';
import { boatModelFiles } from './files';

const close = (v: Vector3, x: number, y: number, z: number): void => {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
};

describe('alignRotation', () => {
  it('is the identity for a model already in the body frame', () => {
    close(new Vector3(1, 2, 3).applyQuaternion(alignRotation({})), 1, 2, 3);
  });

  it('turns a +X-bow, Z-up model so the bow is −Z, up +Y and starboard +X', () => {
    const q = alignRotation({ forward: '+X', up: '+Z' });
    close(new Vector3(1, 0, 0).applyQuaternion(q), 0, 0, -1); // bow
    close(new Vector3(0, 0, 1).applyQuaternion(q), 0, 1, 0); // up
    // Starboard of a +X-forward, Z-up model is −Y.
    close(new Vector3(0, -1, 0).applyQuaternion(q), 1, 0, 0);
  });

  it('applies the extra rotation after the axis change', () => {
    const q = alignRotation({ forward: '+Z', rotation: [0, 90, 0] });
    // +Z bow → −Z, then 90° about +Y takes −Z to −X.
    close(new Vector3(0, 0, 1).applyQuaternion(q), -1, 0, 0);
  });

  it('rejects a forward axis parallel to up', () => {
    expect(() => alignRotation({ forward: '+Y', up: '-Y' })).toThrow(/same axis/);
  });
});

describe('alignTransform', () => {
  // A 20-unit model, 4 wide, 6 tall, sitting off-centre.
  const bounds: Bounds = { min: { x: 1, y: -2, z: -5 }, max: { x: 5, y: 4, z: 15 } };

  it('scales to the LOA, centres it and sinks the keel to the draft', () => {
    const t = alignTransform(bounds, {}, { loa: 10, draft: 0.5 });
    expect(t.scale).toBeCloseTo(0.5);
    close(toBody(t, new Vector3(3, -2, 5)), 0, -0.5, 0); // keel, midships
    close(toBody(t, new Vector3(3, 4, -5)), 0, 2.5, -5); // bow top
  });

  it('honours an explicit scale, waterline and offset', () => {
    const t = alignTransform(
      bounds,
      { scale: 2, waterline: 0, offset: [0, 0.1, 1] },
      { loa: 10, draft: 0.5 },
    );
    expect(t.scale).toBe(2);
    close(toBody(t, new Vector3(3, 0, 5)), 0, 0.1, 1);
  });

  it('fails on a model with no length', () => {
    const flat: Bounds = { min: { x: 0, y: 0, z: 1 }, max: { x: 1, y: 1, z: 1 } };
    expect(() => alignTransform(flat, {}, { loa: 10, draft: 1 })).toThrow(/no length/);
  });
});

describe('markerKind', () => {
  it('reads model-kit kinds and COLREG mount names, with optional index', () => {
    expect(markerKind('light:sidePort')).toBe('sidePort');
    expect(markerKind('light:port')).toBe('sidePort');
    expect(markerKind('light:masthead-aft')).toBe('mastheadAft');
    expect(markerKind('light:deckFlood:2')).toBe('deckFlood');
    expect(markerKind('light:stern-pole')).toBe('allRoundWhite');
  });

  it('ignores other names', () => {
    expect(markerKind('hull')).toBeNull();
    expect(markerKind('light:disco')).toBeNull();
    expect(markerKind('light:constructor')).toBeNull();
  });
});

describe('maskPoints', () => {
  it('keeps vertices up to the top and thins them to the limit', () => {
    const positions = [0, -1, 0, 0, 0.5, 0, 0, 3, 0, 1, 0.2, 1, 2, 0.9, 2];
    expect(maskPoints(positions, 1)).toEqual([0, -1, 0, 0, 0.5, 0, 1, 0.2, 1, 2, 0.9, 2]);
    expect(maskPoints(positions, 1, 2)).toEqual([0, -1, 0, 1, 0.2, 1]);
  });
});

describe('parseAlign', () => {
  it('accepts a full spec and drops absent keys', () => {
    const spec = parseAlign({
      forward: '+X',
      up: '+Z',
      loa: 10.1,
      eye: [0, 2, 1],
      lights: [{ kind: 'stern', position: [0, 1, 5] }],
      comment: 'ignored',
    });
    expect(spec).toEqual({
      forward: '+X',
      up: '+Z',
      loa: 10.1,
      eye: [0, 2, 1],
      lights: [{ kind: 'stern', position: [0, 1, 5], direction: undefined, name: undefined }],
    });
  });

  it('names the bad key', () => {
    expect(() => parseAlign({ forward: 'north' })).toThrow(/forward/);
    expect(() => parseAlign({ eye: [0, 1] })).toThrow(/eye/);
    expect(() => parseAlign({ scale: '2' })).toThrow(/scale/);
    expect(() => parseAlign({ lights: [{ kind: 'laser', position: [0, 0, 0] }] })).toThrow(/lights\[0\]/);
    expect(() => parseAlign({ lights: [{ kind: 'stern', position: [0, 1] }] })).toThrow(/lights\[0\]/);
    expect(() => parseAlign({ lights: [{ kind: 'stern', position: [0, 1, 'x'] }] })).toThrow(/lights\[0\]/);
    expect(() => parseAlign({ lights: [{ kind: 'stern', position: [0, 1, 2], direction: [0, 1] }] })).toThrow(
      /direction/,
    );
    expect(() => parseAlign({ lights: [null] })).toThrow(/lights\[0\]/);
  });
});

describe('boatModelFiles', () => {
  const entry = (kind: 'model' | 'align') => ({ bytes: 10, sha256: 'ab', kind });
  const manifest: AssetManifest = {
    version: 1,
    assets: {
      'models/sail/model.glb': entry('model'),
      'models/sail/model.lod1.glb': entry('model'),
      'models/sail/align.json': entry('align'),
      'models/crab/model.glb': entry('model'),
      'models/crab/model.lod2.glb': entry('model'),
    },
  };

  it('finds the model, its consecutive LODs and align.json', () => {
    const files = boatModelFiles(manifest, 'sail');
    expect(files?.lods.map((f) => f.path)).toEqual(['models/sail/model.glb', 'models/sail/model.lod1.glb']);
    expect(files?.align?.path).toBe('models/sail/align.json');
    // LOD2 without LOD1 is ignored.
    expect(boatModelFiles(manifest, 'crab')?.lods).toHaveLength(1);
  });

  it('is null when nothing is listed, so nothing is fetched', () => {
    expect(boatModelFiles(manifest, 'cargo')).toBeNull();
    expect(boatModelFiles(EMPTY_MANIFEST, 'sail')).toBeNull();
  });
});
