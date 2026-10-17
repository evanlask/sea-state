import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { NO_CAMERA_INPUT, type CameraInput } from '../input/InputManager';
import { BOAT_KINDS, type BoatKind, type BoatSnapshot } from '../sim/world/protocol';
import {
  BOAT_CAMERA_INFO,
  CAMERA_MODES,
  CameraRig,
  cycleModes,
  nextZoomPreset,
  parseCameraMode,
  photoSpeed,
  resolveMode,
} from './CameraRig';
import { hullCapsule, hullNorm } from './hullCapsule';

const DT = 1 / 60;

const boatAt = (
  x: number,
  z: number,
  kind: BoatKind = 'cargo',
  yaw = 0,
  speed = 0,
  id = 'player',
): BoatSnapshot => ({
  id,
  kind,
  position: { x, y: 0, z },
  orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
  velocity: { x: -Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed },
  angularVelocity: { x: 0, y: 0, z: 0 },
  telemetry: {},
});

const distanceTo = (rig: CameraRig, boat: BoatSnapshot): number =>
  Math.hypot(rig.camera.position.x - boat.position.x, rig.camera.position.z - boat.position.z);

const poseOf = (boat: BoatSnapshot) => ({
  position: new Vector3(boat.position.x, boat.position.y, boat.position.z),
  quaternion: new Quaternion(boat.orientation.x, boat.orientation.y, boat.orientation.z, boat.orientation.w),
});

const forwardOf = (rig: CameraRig): Vector3 => new Vector3(0, 0, -1).applyQuaternion(rig.camera.quaternion);

const input = (patch: Partial<CameraInput>): CameraInput => ({ ...NO_CAMERA_INPUT, ...patch });

// A rig settled in `mode` on a boat at the origin.
function settled(kind: BoatKind, mode: Parameters<CameraRig['setMode']>[0], frames = 1): CameraRig {
  const rig = new CameraRig(55, seeded(1));
  rig.setBoat(kind);
  rig.setMode(mode);
  rig.cut();
  const boat = boatAt(0, 0, kind);
  for (let i = 0; i < frames; i++) rig.update(DT, boat, null, 0);
  return rig;
}

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

describe('CameraRig', () => {
  it('ignores a zero-sized viewport instead of going NaN', () => {
    const rig = new CameraRig();
    rig.setAspect(1600, 800);
    rig.setAspect(0, 0);
    rig.setAspect(800, 0);
    expect(rig.camera.aspect).toBe(2);
  });

  it('cuts straight to the chase view when a voyage starts', () => {
    const rig = new CameraRig();
    const boat = boatAt(0, 0); // the camera starts at the origin too: inside the hull
    rig.setBoat('cargo');
    rig.setMode('orbit');
    rig.setMode('chase');
    rig.cut();
    rig.update(DT, boat, null, 0);
    // Already out at the chase distance: no sweep in from the previous camera through the hull.
    expect(distanceTo(rig, boat)).toBeGreaterThan(BOAT_CAMERA_INFO.cargo.length * 0.6);
  });

  it('still blends between outside cameras mid-voyage', () => {
    const rig = settled('cargo', 'chase');
    const boat = boatAt(0, 0);
    const before = rig.camera.position.clone();
    rig.setMode('starboard');
    rig.update(DT, boat, null, 0);
    expect(rig.camera.position.distanceTo(before)).toBeLessThan(5);
  });
});

describe('camera modes', () => {
  it('offers the masthead only on the sailboat and bridge wings only on the ships', () => {
    expect(cycleModes('sail')).toContain('mast');
    expect(cycleModes('sail')).not.toContain('bridge-port');
    for (const kind of ['cargo', 'cruise'] as const) {
      expect(cycleModes(kind)).toEqual(expect.arrayContaining(['bridge-port', 'bridge-starboard']));
      expect(cycleModes(kind)).not.toContain('mast');
    }
    for (const kind of ['crab', 'powerboat', 'pwc'] as const) {
      expect(cycleModes(kind).some((m) => m === 'mast' || m.startsWith('bridge'))).toBe(false);
    }
    for (const kind of BOAT_KINDS) {
      expect(cycleModes(kind)).not.toContain('photo');
      expect(cycleModes(kind)).toEqual(expect.arrayContaining(['fixed', 'cinematic']));
    }
  });

  it('cycles through every camera the boat has and back', () => {
    const rig = settled('sail', 'chase');
    const seen: string[] = [];
    const modes = cycleModes('sail');
    for (let i = 0; i < modes.length; i++) {
      rig.cycle(1);
      seen.push(rig.mode);
    }
    expect(seen.at(-1)).toBe('chase');
    expect([...seen].sort()).toEqual([...modes].sort());
  });

  it('falls back when the boat lacks a camera', () => {
    expect(resolveMode('mast', 'cargo')).toBe('chase');
    expect(resolveMode('bridge-port', 'powerboat')).toBe('helm');
    const rig = settled('cargo', 'mast');
    expect(rig.mode).toBe('chase');
    rig.setMode('bridge-starboard');
    rig.setBoat('pwc'); // taking the helm of a boat without wings
    expect(rig.mode).toBe('helm');
  });

  it('parses every mode from a deep link, plus aliases', () => {
    for (const mode of CAMERA_MODES) expect(parseCameraMode(mode)).toBe(mode);
    expect(parseCameraMode('bridgePort')).toBe('bridge-port');
    expect(parseCameraMode('BRIDGE_STARBOARD')).toBe('bridge-starboard');
    expect(parseCameraMode('free')).toBe('photo');
    expect(parseCameraMode('director')).toBe('cinematic');
    expect(parseCameraMode('masthead')).toBe('mast');
    expect(parseCameraMode('nope')).toBeNull();
    expect(parseCameraMode(null)).toBeNull();
  });

  it('puts every mode of every boat somewhere sensible', () => {
    for (const kind of BOAT_KINDS) {
      const info = BOAT_CAMERA_INFO[kind];
      const outside = hullCapsule(info, 1.4);
      for (const mode of cycleModes(kind)) {
        const rig = settled(kind, mode, 30);
        const p = rig.camera.position;
        expect(Number.isFinite(p.x + p.y + p.z), `${kind} ${mode}`).toBe(true);
        expect(p.y, `${kind} ${mode} above water`).toBeGreaterThan(0.5);
        if (['chase', 'orbit', 'drone', 'fixed', 'cinematic'].includes(mode)) {
          expect(hullNorm(p, outside, poseOf(boatAt(0, 0, kind))), `${kind} ${mode} outside`).toBeGreaterThan(
            1,
          );
        }
      }
    }
  });

  it('places the onboard eye points', () => {
    const helm = settled('cargo', 'helm');
    expect(helm.camera.position.distanceTo(new Vector3(0, 35, -121.5 + 190))).toBeLessThan(1e-6);

    const port = settled('cargo', 'bridge-port');
    const wing = BOAT_CAMERA_INFO.cargo.wings!;
    expect(port.camera.position.x).toBeCloseTo(wing.port.x);
    // Cargo bridge is aft: the wing looks forward along the port side, a little down.
    const f = forwardOf(port);
    expect(f.z).toBeLessThan(-0.95);
    expect(f.y).toBeLessThan(0);
    expect(Math.abs(f.x)).toBeLessThan(0.1);

    // Cruise bridge is forward: its wings look aft along the side.
    const cruise = settled('cruise', 'bridge-starboard');
    expect(cruise.camera.position.x).toBeGreaterThan(BOAT_CAMERA_INFO.cruise.beam / 2);
    expect(forwardOf(cruise).z).toBeGreaterThan(0.95);

    // Masthead: high up the mast, looking down at the deck.
    const mast = settled('sail', 'mast');
    expect(mast.camera.position.y).toBeGreaterThan(16);
    expect(forwardOf(mast).y).toBeLessThan(-0.9);
  });

  it('heels the masthead camera with the boat', () => {
    const rig = settled('sail', 'mast');
    const heeled = boatAt(0, 0, 'sail');
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.3); // heeled to starboard
    heeled.orientation = { x: q.x, y: q.y, z: q.z, w: q.w };
    rig.update(DT, heeled, null, 0);
    expect(rig.camera.position.x).toBeGreaterThan(4); // the masthead swings out to starboard
  });
});

describe('blends around the hull', () => {
  it('cuts from an outside view to the helm instead of sweeping through the superstructure', () => {
    const rig = settled('cargo', 'chase');
    rig.setMode('helm');
    rig.update(DT, boatAt(0, 0), null, 0);
    expect(rig.camera.position.distanceTo(new Vector3(0, 35, 68.5))).toBeLessThan(1e-6);
  });

  it('cuts between the masthead and outside views', () => {
    const rig = settled('sail', 'mast');
    rig.setMode('chase');
    rig.update(DT, boatAt(0, 0, 'sail'), null, 0);
    expect(rig.camera.position.z).toBeGreaterThan(10);
  });

  it('walks across the bridge from the helm to a wing', () => {
    const rig = settled('cargo', 'helm');
    rig.setMode('bridge-starboard');
    rig.update(DT, boatAt(0, 0), null, 0);
    const x = rig.camera.position.x;
    expect(x).toBeGreaterThan(0);
    expect(x).toBeLessThan(BOAT_CAMERA_INFO.cargo.wings!.starboard.x - 1);
  });

  it('arcs over the hull from one side camera to the other', () => {
    const rig = settled('cargo', 'port', 5);
    const boat = boatAt(0, 0);
    const capsule = hullCapsule(BOAT_CAMERA_INFO.cargo, 1);
    rig.setMode('starboard');
    let peak = 0;
    for (let i = 0; i < 70; i++) {
      rig.update(DT, boat, null, 0);
      expect(hullNorm(rig.camera.position, capsule, poseOf(boat))).toBeGreaterThan(0.99);
      peak = Math.max(peak, rig.camera.position.y);
    }
    expect(peak).toBeGreaterThan(BOAT_CAMERA_INFO.cargo.height); // over the top, not under
    expect(rig.camera.position.x).toBeGreaterThan(100); // arrived on the starboard side
  });
});

describe('chase camera at speed', () => {
  it('keeps up with a hydroplane at 200 mph, the boat centred, not trailing hundreds of metres', () => {
    const rig = new CameraRig(55, seeded(1));
    rig.setBoat('hydro');
    rig.setMode('chase');
    rig.cut();
    const speed = 89.4;
    const yaw = 0.7;
    let boat = boatAt(0, 0, 'hydro', yaw, speed);
    for (let i = 0; i <= 300; i++) {
      const t = i * DT;
      boat = boatAt(-Math.sin(yaw) * speed * t, -Math.cos(yaw) * speed * t, 'hydro', yaw, speed);
      rig.update(DT, boat, null, 0);
    }
    // 24 m back at zoom 1 (BOAT_CAMERA_INFO.hydro.chase) and ~8 m up: ~23 m back over the water.
    expect(distanceTo(rig, boat)).toBeGreaterThan(21);
    expect(distanceTo(rig, boat)).toBeLessThan(24);
    expect(rig.camera.position.y).toBeGreaterThan(6);
    const toBoat = new Vector3(boat.position.x, boat.position.y + 0.6, boat.position.z)
      .sub(rig.camera.position)
      .normalize();
    expect(forwardOf(rig).dot(toBoat)).toBeGreaterThan(Math.cos(0.05));
  });
});

describe('fixed camera', () => {
  it('stands still while the boat sails past, then sets up further on', () => {
    const rig = new CameraRig();
    rig.setBoat('powerboat');
    rig.setMode('fixed');
    rig.cut();
    const speed = 15;
    let z = 0;
    rig.update(DT, boatAt(0, z, 'powerboat', 0, speed), null, 0);
    const spot = rig.camera.position.clone();
    expect(spot.z).toBeLessThan(-10); // ahead of the boat (bow −Z)
    let moved = -1;
    for (let i = 1; i < 60 * 60; i++) {
      z -= speed * DT;
      rig.update(DT, boatAt(0, z, 'powerboat', 0, speed), null, 0);
      if (rig.camera.position.distanceTo(spot) > 1) {
        moved = -z;
        break;
      }
    }
    // The boat passed the camera and got well away before it moved.
    expect(moved).toBeGreaterThan(-spot.z + rig.fixedRange * 0.5);
    expect(rig.camera.position.z).toBeLessThan(-moved); // re-placed ahead of the boat again
  });
});

describe('cinematic director in the rig', () => {
  it('keeps every shot out of the water and out of every hull, cutting every 6–12 s', () => {
    for (const kind of ['cargo', 'sail', 'pwc'] as const) {
      const rig = new CameraRig(55, seeded(7));
      rig.setBoat(kind);
      rig.setMode('cinematic');
      rig.setSeaState(5);
      rig.cut();
      const info = BOAT_CAMERA_INFO[kind];
      const own = hullCapsule(info, 1.4);
      const other = hullCapsule(BOAT_CAMERA_INFO.crab, 1.4);
      const speed = 6;
      let shots = 0;
      let last = rig.director.shot;
      for (let i = 0; i < 60 * 60; i++) {
        const z = -speed * i * DT;
        const boat = boatAt(0, z, kind, 0, speed);
        const neighbour = boatAt(info.beam + 20, z - 30, 'crab', 0, speed, 'fleet-2');
        rig.update(DT, boat, null, 0, [boat, neighbour]);
        const p = rig.camera.position;
        expect(p.y).toBeGreaterThan(0.5);
        expect(hullNorm(p, own, poseOf(boat))).toBeGreaterThan(0.999);
        expect(hullNorm(p, other, poseOf(neighbour))).toBeGreaterThan(0.999);
        if (rig.director.shot !== last) {
          shots++;
          last = rig.director.shot;
        }
      }
      expect(shots).toBeGreaterThanOrEqual(5); // 60 s at 6–12 s a shot
      expect(shots).toBeLessThanOrEqual(11);
    }
  });

  it('starts a new shot on reset', () => {
    const rig = settled('powerboat', 'cinematic', 2);
    const shot = rig.director.shot;
    rig.update(DT, boatAt(0, 0, 'powerboat'), input({ reset: true }), 0);
    expect(rig.director.shot).not.toBe(shot);
  });
});

describe('photo camera', () => {
  it('detaches where the camera is and flies with WASD and Q / E', () => {
    const rig = settled('powerboat', 'chase', 10);
    const boat = boatAt(0, 0, 'powerboat');
    const start = rig.camera.position.clone();
    rig.update(DT, boat, input({ photo: true }), 0);
    expect(rig.mode).toBe('photo');
    expect(rig.camera.position.distanceTo(start)).toBeLessThan(0.01);

    const look = forwardOf(rig);
    const before = rig.camera.position.clone();
    for (let i = 0; i < 120; i++) rig.update(DT, boat, input({ moveZ: 1 }), 0);
    const travelled = rig.camera.position.clone().sub(before);
    expect(travelled.length()).toBeGreaterThan(photoSpeed(BOAT_CAMERA_INFO.powerboat) * 1.2);
    expect(travelled.normalize().dot(look)).toBeGreaterThan(0.99);

    const y = rig.camera.position.y;
    for (let i = 0; i < 60; i++) rig.update(DT, boat, input({ moveY: 1 }), 0);
    expect(rig.camera.position.y).toBeGreaterThan(y + 2);
    for (let i = 0; i < 600; i++) rig.update(DT, boat, input({ moveY: -1 }), 0.5);
    expect(rig.camera.position.y).toBeCloseTo(0.8); // stops just above the water
  });

  it('turns with look input and strafes sideways', () => {
    const rig = settled('powerboat', 'chase', 10);
    const boat = boatAt(0, 0, 'powerboat');
    rig.togglePhoto();
    rig.update(DT, boat, input({ lookX: Math.PI / 2 }), 0); // turn right a quarter
    const f = forwardOf(rig);
    const before = rig.camera.position.clone();
    for (let i = 0; i < 60; i++) rig.update(DT, boat, input({ moveX: 1 }), 0);
    const step = rig.camera.position.clone().sub(before).normalize();
    expect(step.dot(f)).toBeCloseTo(0, 1);
    expect(step.y).toBeCloseTo(0);
  });

  it('cycles slow motion and resets it on leaving', () => {
    const rig = settled('sail', 'helm');
    const boat = boatAt(0, 0, 'sail');
    expect(rig.timeScale).toBe(1);
    rig.update(DT, boat, input({ photo: true }), 0);
    const scales = [rig.timeScale];
    for (let i = 0; i < 3; i++) {
      rig.update(DT, boat, input({ slowMotion: true }), 0);
      scales.push(rig.timeScale);
    }
    expect(scales).toEqual([1, 0.25, 0, 1]);
    rig.update(DT, boat, input({ slowMotion: true }), 0);
    rig.update(DT, boat, input({ photo: true }), 0);
    expect(rig.mode).toBe('helm'); // back where it came from
    expect(rig.timeScale).toBe(1);
  });

  it('focuses on the boat and sets the aperture from the wheel', () => {
    const rig = settled('cargo', 'chase', 10);
    const boat = boatAt(0, 0);
    expect(rig.dof.enabled).toBe(false);
    rig.togglePhoto();
    for (let i = 0; i < 120; i++) rig.update(DT, boat, null, 0);
    const dof = rig.dof;
    expect(dof.enabled).toBe(true);
    const eye = new Vector3(0, 12, 0);
    expect(dof.focusDistance).toBeCloseTo(rig.camera.position.distanceTo(eye), 0);
    const a = rig.aperture;
    rig.update(DT, boat, input({ zoom: -3 }), 0); // wheel forward opens up
    expect(rig.aperture).toBeGreaterThan(a);
    rig.update(DT, boat, input({ aperture: -6 }), 0); // LB closes down
    expect(rig.aperture).toBeLessThan(a);
  });

  it('starts behind the boat when a voyage opens in photo mode', () => {
    const rig = new CameraRig();
    rig.setBoat('crab');
    rig.setMode('photo');
    rig.cut();
    const boat = boatAt(100, 50, 'crab');
    rig.update(DT, boat, null, 0);
    expect(rig.mode).toBe('photo');
    expect(rig.camera.position.z).toBeGreaterThan(50 + 20);
    expect(forwardOf(rig).z).toBeLessThan(0);
  });
});

describe('zoom presets', () => {
  it('steps near → normal → far → near, from wherever the wheel left it', () => {
    expect(nextZoomPreset(1)).toBe(1.8);
    expect(nextZoomPreset(1.8)).toBe(0.6);
    expect(nextZoomPreset(0.6)).toBe(1);
    expect(nextZoomPreset(1.3)).toBe(1.8);
    expect(nextZoomPreset(3)).toBe(0.6);
  });
});
