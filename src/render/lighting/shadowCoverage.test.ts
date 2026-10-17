// Shadow coverage of the big ships, through the real CSMShadowNode cascade fit: for each camera
// view and sun position, samples the hull + superstructure's shadow on the water and checks that
// each visible sample is inside a cascade's light camera (receiver and caster both within its
// orthographic box) and short of the last cascade's fade. The baseline is a fixed fit (600 m shadow
// distance, 300 m light margin, 1.6 km depth range); the other is SunMoonLight's adaptive fit.
//
// SHADOW_REPORT=1 prints the coverage table.

import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import {
  type Color,
  DirectionalLight,
  type OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPUCoordinateSystem,
} from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { BOAT_CAMERA_INFO } from '../../camera/boatCameraInfo';
import type { BoatKind } from '../../sim/world/protocol';
import type { SkySystem } from '../sky/SkySystem';
import type { ShadowCaster } from './shadowFit';
import { SunMoonLight } from './SunMoonLight';

const DEG = Math.PI / 180;
const ASPECT = 16 / 9;
const FOV = 55;
const QUALITY = { enabled: true, mapSize: 2048, cascades: 3, maxFar: 600 };
const fakeRenderer = { coordinateSystem: WebGPUCoordinateSystem, reversedDepthBuffer: false };

interface CsmInternals {
  _init(builder: { camera: PerspectiveCamera; renderer: typeof fakeRenderer }): void;
  updateBefore(): void;
  _cascades: { x: number; y: number }[];
  lights: (DirectionalLight & { target: { position: Vector3; updateMatrixWorld(): void } })[];
  camera: PerspectiveCamera | null;
  maxFar: number;
  fade: boolean;
}

type CameraName = 'chase' | 'chaseOut' | 'drone' | 'droneOut' | 'helm' | 'stern' | 'side' | 'fixed';
const MAX_ZOOM = 4; // CameraRig's zoom-out limit

// The rig's default views (CameraRig.ts), boat at the origin heading −Z.
function cameraFor(kind: BoatKind, name: CameraName): PerspectiveCamera {
  const { length, beam, height, eye } = BOAT_CAMERA_INFO[kind];
  const camera = new PerspectiveCamera(FOV, ASPECT, 0.1, 80_000);
  const look = (x: number, y: number, z: number, tx: number, ty: number, tz: number): void => {
    camera.position.set(x, y, z);
    camera.lookAt(tx, ty, tz);
  };
  const focusY = Math.min(height * 0.35, 12);
  switch (name) {
    case 'chase':
    case 'chaseOut': {
      // Chase and orbit at rest: behind, 0.18 rad up, (1.25 L + 8) from the focus (× zoom).
      const d = (length * 1.25 + 8) * (name === 'chaseOut' ? MAX_ZOOM : 1);
      look(0, focusY + Math.sin(0.18) * d, Math.cos(0.18) * d, 0, focusY, 0);
      break;
    }
    case 'drone':
    case 'droneOut': {
      camera.position.set(0, Math.max(40, length * 2.2) * (name === 'droneOut' ? MAX_ZOOM : 1), 0.01);
      camera.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
      break;
    }
    case 'helm':
      look(eye.x, eye.y, eye.z, eye.x, eye.y, eye.z - 100);
      break;
    case 'stern':
      look(0, height * 0.35 + 1.5, length * 0.65 + 3, 0, height * 0.2, -length / 2);
      break;
    case 'side':
      look(beam / 2 + length * 0.35 + 4, height * 0.25 + 1, 0, 0, height * 0.2, 0);
      break;
    case 'fixed': {
      // The world-fixed camera just before it re-places itself (fixedRange away), boat sailed past.
      const ahead = length * 1.2 + 25;
      const side = beam / 2 + length * 0.35 + 12;
      const range = Math.max(150, 2.5 * Math.hypot(ahead, side));
      const k = range / Math.hypot(ahead, side);
      look(side * k, Math.max(2.5, height * 0.25), ahead * k, 0, Math.min(height * 0.3, 12), 0);
      break;
    }
  }
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

function toLightFrom(elevation: number, azimuth: number): Vector3 {
  return new Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );
}

function fakeSky(toLight: Vector3): SkySystem {
  return {
    sunElevation: Math.asin(toLight.y),
    sunDirection: toLight,
    moonDirection: new Vector3(0, -1, 0),
    sunIlluminance: (c: Color) => c.setRGB(50_000, 50_000, 50_000),
    moonIlluminance: (c: Color) => c.setRGB(0, 0, 0),
  } as unknown as SkySystem;
}

// The hull + superstructure as a box (beam × height × length), sampled on its top and sides.
function casterSamples(kind: BoatKind): Vector3[] {
  const { length, beam, height } = BOAT_CAMERA_INFO[kind];
  const points: Vector3[] = [];
  for (let i = 0; i <= 24; i++) {
    const z = -length / 2 + (length * i) / 24;
    for (const x of [-beam / 2, 0, beam / 2]) {
      for (const y of [height * 0.25, height * 0.5, height * 0.75, height]) points.push(new Vector3(x, y, z));
    }
  }
  return points;
}

const projected = new Vector3();
const lightSpace = new Vector3();

// Share of the visible shadow samples a cascade covers at full strength.
function coverage(
  csmNode: CSMShadowNode,
  camera: PerspectiveCamera,
  toLight: Vector3,
  samples: Vector3[],
): number {
  const csm = csmNode as unknown as CsmInternals;
  csm.updateBefore();
  const lin = (d: number): number => (d - camera.near) / (Math.min(csm.maxFar, camera.far) - camera.near);
  const lastCascade = csm._cascades.length - 1;
  let visible = 0;
  let covered = 0;
  for (const caster of samples) {
    const receiver = caster.clone().addScaledVector(toLight, -caster.y / toLight.y);
    projected.copy(receiver).project(camera);
    const depth = -receiver.clone().applyMatrix4(camera.matrixWorldInverse).z;
    if (depth <= camera.near || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) continue;
    visible++;
    const l = lin(depth);
    const index = csm._cascades.findIndex((c) => l >= c.x && l <= c.y);
    if (index < 0) continue;
    // CSMShadowNode's fade: the last cascade fades out over the last quarter of maxFar.
    const strength = index === lastCascade && l > 0.75 ? Math.max(0, (1 - l) / 0.25) : 1;
    const light = csm.lights[index];
    const shadowCamera = light.shadow!.camera as OrthographicCamera;
    shadowCamera.position.copy(light.position);
    shadowCamera.lookAt(light.target.position);
    shadowCamera.updateMatrixWorld();
    const inBox = (p: Vector3): boolean => {
      lightSpace.copy(p).applyMatrix4(shadowCamera.matrixWorldInverse);
      const z = -lightSpace.z;
      return (
        lightSpace.x >= shadowCamera.left &&
        lightSpace.x <= shadowCamera.right &&
        lightSpace.y >= shadowCamera.bottom &&
        lightSpace.y <= shadowCamera.top &&
        z >= shadowCamera.near &&
        z <= shadowCamera.far
      );
    };
    if (inBox(receiver) && inBox(caster)) covered += strength;
  }
  return visible === 0 ? 1 : covered / visible;
}

// The fixed-fit baseline (no per-frame fitting).
function oldCsm(camera: PerspectiveCamera, toLight: Vector3): CSMShadowNode {
  const scene = new Scene();
  const light = new DirectionalLight(0xffffff, 1);
  scene.add(light, light.target);
  light.position.copy(toLight).multiplyScalar(1000);
  light.updateMatrixWorld();
  light.shadow.mapSize.set(QUALITY.mapSize, QUALITY.mapSize);
  light.shadow.camera.near = 1;
  light.shadow.camera.far = 300 + 600 * 2 + 100;
  const csm = new CSMShadowNode(light, { cascades: 3, maxFar: 600, mode: 'practical', lightMargin: 300 });
  csm.fade = true;
  (csm as unknown as CsmInternals)._init({ camera, renderer: fakeRenderer });
  return csm;
}

function newCsm(kind: BoatKind, camera: PerspectiveCamera, toLight: Vector3): CSMShadowNode {
  const sun = new SunMoonLight(new Scene(), QUALITY);
  const csm = sun.shadowNode as unknown as CsmInternals;
  csm._init({ camera, renderer: fakeRenderer });
  const { length, beam, height } = BOAT_CAMERA_INFO[kind];
  const casters: ShadowCaster[] = [
    { x: 0, y: 0, z: 0, radius: Math.hypot(length, beam) / 2, height, helm: true },
  ];
  sun.update(fakeSky(toLight), 1, new Vector3(), 1, { camera, casters });
  return sun.shadowNode!;
}

const CAMERAS: CameraName[] = ['chase', 'chaseOut', 'drone', 'droneOut', 'helm', 'stern', 'side', 'fixed'];
const ELEVATIONS = [5, 10, 15, 30, 60];
const AZIMUTHS = [0, 45, 90, 135, 180, 225, 270, 315];

interface Row {
  kind: BoatKind;
  camera: CameraName;
  elevation: number;
  before: number; // worst over sun azimuths, 0..1
  after: number;
  far: number; // fitted shadow distance (m), largest over azimuths
}

function survey(kinds: BoatKind[]): Row[] {
  const rows: Row[] = [];
  for (const kind of kinds) {
    const samples = casterSamples(kind);
    for (const name of CAMERAS) {
      for (const elevation of ELEVATIONS) {
        let before = 1;
        let after = 1;
        let far = 0;
        for (const azimuth of AZIMUTHS) {
          const toLight = toLightFrom(elevation * DEG, azimuth * DEG);
          const camera = cameraFor(kind, name);
          before = Math.min(before, coverage(oldCsm(camera, toLight), camera, toLight, samples));
          const fitted = newCsm(kind, camera, toLight);
          far = Math.max(far, fitted.maxFar);
          after = Math.min(after, coverage(fitted, camera, toLight, samples));
        }
        rows.push({ kind, camera: name, elevation, before, after, far });
      }
    }
  }
  return rows;
}

describe('big-ship shadow coverage (CSM cascade fit)', () => {
  const rows = survey(['cargo', 'cruise', 'crab', 'sail', 'powerboat', 'pwc']);
  if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SHADOW_REPORT) {
    const pct = (v: number): string => `${(v * 100).toFixed(0)}%`.padStart(5);
    console.log('kind    camera elev  before  after  maxFar');
    for (const r of rows)
      console.log(
        `${r.kind.padEnd(7)} ${r.camera.padEnd(6)} ${String(r.elevation).padStart(3)}°  ${pct(r.before)}  ${pct(r.after)}  ${r.far}`,
      );
  }

  it('the old fixed fit cut off the big ships’ shadows', () => {
    const worst = (kind: BoatKind): number =>
      Math.min(...rows.filter((r) => r.kind === kind).map((r) => r.before));
    expect(worst('cargo')).toBeLessThan(0.8);
    expect(worst('cruise')).toBeLessThan(0.8);
  });

  it('covers the whole shadow of every boat from every default camera, zoomed out too, sun 5° and up', () => {
    const gaps = rows
      .filter((r) => r.after < 0.999)
      .map((r) => `${r.kind} ${r.camera} ${r.elevation}°: ${r.after}`);
    expect(gaps).toEqual([]);
  });

  it('keeps the base shadow distance (crisp cascades) for the small boats, sun 10° and up', () => {
    const small = rows.filter((row) => row.kind !== 'cargo' && row.kind !== 'cruise' && row.elevation >= 10);
    for (const r of small) {
      expect(r.far, `${r.kind} ${r.camera} ${r.elevation}°`).toBe(QUALITY.maxFar);
    }
  });
});
