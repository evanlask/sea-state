import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_CAMERA_INFO } from './boatCameraInfo';
import {
  Director,
  pickShotKind,
  SHOT_KINDS,
  SHOT_MAX_SECONDS,
  SHOT_MIN_SECONDS,
  seaDrama,
  shotAnchor,
  shotPose,
  shotWeights,
  type Shot,
} from './director';
import { capsuleNorm, hullCapsule, pushOut } from './hullCapsule';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('director', () => {
  it('holds each shot 6–12 s and never repeats a kind back to back', () => {
    const director = new Director(seeded(3));
    let previous = director.next(1);
    for (let i = 0; i < 300; i++) {
      const shot = director.next(i % 7);
      expect(shot.duration).toBeGreaterThanOrEqual(SHOT_MIN_SECONDS);
      expect(shot.duration).toBeLessThanOrEqual(SHOT_MAX_SECONDS);
      expect(shot.kind).not.toBe(previous.kind);
      previous = shot;
    }
  });

  it('cuts exactly when a shot runs out', () => {
    const director = new Director(seeded(4));
    expect(director.update(0.1, 0)).toBe(true); // first shot
    const first = director.shot!;
    let t = 0;
    let cutAt = -1;
    for (let i = 0; i < 2000 && cutAt < 0; i++) {
      t += 0.01;
      if (director.update(0.01, 0)) cutAt = t;
    }
    expect(cutAt).toBeCloseTo(first.duration, 1);
    expect(director.shot).not.toBe(first);
  });

  it('uses every kind of shot', () => {
    const director = new Director(seeded(5));
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(director.next(2).kind);
    expect([...seen].sort()).toEqual([...SHOT_KINDS].sort());
  });

  it('favours low shots in big seas', () => {
    expect(seaDrama(0.5)).toBe(0);
    expect(seaDrama(6)).toBe(1);
    const calm = shotWeights(0.3);
    const storm = shotWeights(7);
    expect(storm.waterline).toBeGreaterThan(calm.waterline * 3);
    expect(storm.fixed).toBeGreaterThan(calm.fixed);
    expect(storm.orbit).toBeLessThan(calm.orbit);
    const lowShare = (hs: number): number => {
      const random = seeded(9);
      let low = 0;
      let previous = null as Shot['kind'] | null;
      for (let i = 0; i < 2000; i++) {
        previous = pickShotKind(shotWeights(hs), previous, random);
        if (previous === 'waterline' || previous === 'fixed') low++;
      }
      return low / 2000;
    };
    expect(lowShare(7)).toBeGreaterThan(lowShare(0.3) + 0.15);
  });

  it('stands low shots ahead of the boat, further off in big seas', () => {
    const info = BOAT_CAMERA_INFO.powerboat;
    const shot: Shot = { kind: 'waterline', duration: 10, side: 1, variant: 0.5 };
    const calm = shotAnchor(shot, info, { x: 0, y: 0, z: 0 }, 0, 10, 0);
    const storm = shotAnchor(shot, info, { x: 0, y: 0, z: 0 }, 0, 10, 6);
    expect(calm.z).toBeCloseTo(-50); // speed × half the shot: the boat passes mid-shot
    expect(calm.x).toBeGreaterThan(0); // starboard
    expect(calm.y).toBeLessThan(1);
    expect(storm.x).toBeGreaterThan(calm.x + 20);
    const pose = shotPose(shot, {
      info,
      focus: { x: 0, y: 0, z: 0 },
      yaw: 0,
      hs: 0,
      elapsed: 0,
      anchor: calm,
    });
    expect(pose.clearance).toBeLessThan(1);
  });

  it('flies by from ahead of the boat to behind it', () => {
    const info = BOAT_CAMERA_INFO.crab;
    const shot: Shot = { kind: 'flyby', duration: 8, side: -1, variant: 0.2 };
    const at = (elapsed: number) =>
      shotPose(shot, {
        info,
        focus: { x: 0, y: 0, z: 0 },
        yaw: 0,
        hs: 0,
        elapsed,
        anchor: { x: 0, y: 0, z: 0 },
      });
    expect(at(0).position.z).toBeLessThan(-info.length);
    expect(at(8).position.z).toBeGreaterThan(info.length);
    expect(at(4).position.x).toBeLessThan(-info.beam); // port side
  });
});

describe('hull capsule', () => {
  const info = BOAT_CAMERA_INFO.cargo;
  const c = hullCapsule(info);

  it('contains the hull from the waterline to the masthead, bow to stern', () => {
    for (const [x, y, z] of [
      [info.beam / 2, 0, 0],
      [info.beam / 2, info.height, 0],
      [0, info.height * 0.5, -info.length / 2],
      [info.beam / 2, 10, info.length / 2],
    ]) {
      expect(capsuleNorm(c, { x: x!, y: y!, z: z! })).toBeLessThanOrEqual(1.0001);
    }
    expect(capsuleNorm(c, { x: info.beam * 2, y: 10, z: 0 })).toBeGreaterThan(1);
    expect(capsuleNorm(c, { x: 0, y: 10, z: info.length })).toBeGreaterThan(1);
  });

  it('pushes points inside out to the surface and leaves outside points alone', () => {
    const p = new Vector3(5, 20, 30);
    expect(pushOut(c, p)).toBe(true);
    expect(capsuleNorm(c, p)).toBeCloseTo(1, 6);
    expect(p.x).toBeGreaterThan(5); // radially outward
    const q = new Vector3(100, 20, 0);
    expect(pushOut(c, q)).toBe(false);
    expect(q.x).toBe(100);
    const centre = new Vector3(0, c.centerY, 0);
    pushOut(c, centre);
    expect(centre.y).toBeCloseTo(c.centerY + c.radiusY); // straight up from dead centre
  });

  it('pushes over the top with an upward bias, continuously across the centreline', () => {
    let last: Vector3 | null = null;
    for (let x = -10; x <= 10; x += 0.5) {
      const p = new Vector3(x, 8, 0); // below the capsule's centre
      pushOut(c, p, 1, 1);
      expect(p.y).toBeGreaterThan(8);
      if (last) expect(p.distanceTo(last)).toBeLessThan(5);
      last = p;
    }
  });

  it('can stop short of the surface for blends into hull-hugging cameras', () => {
    const p = new Vector3(0, 20, 0);
    pushOut(c, p, 0.6);
    expect(capsuleNorm(c, p)).toBeCloseTo(0.6, 6);
  });
});
