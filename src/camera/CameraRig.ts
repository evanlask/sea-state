// Camera modes around the active boat: chase, orbit, helm (first person at the bridge/helm eye
// point) with bridge-wing variants on the ships, a masthead camera on the sailboat, hull-mounted
// cams, a drone view, a fixed world camera the boat sails past, a cinematic auto-director, and a
// free photo camera. Mode changes blend smoothly, routed around the hull rather than through it
// (or cut, where the blend would have to pass through the boat to get there); every external
// camera stays above the local water surface and outside every hull's bounding capsule.
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';

import { type CameraInput, NO_CAMERA_INPUT } from '../input/InputManager';
import type { BoatKind, BoatSnapshot } from '../sim/world/protocol';
import { BOAT_CAMERA_INFO, type BoatCameraInfo, chaseDistance, type Vec3Like } from './boatCameraInfo';
import { Director, shotAnchor, shotPose, type Shot } from './director';
import { type HullCapsule, type HullPose, hullCapsule, hullNorm, pushOutOfHull } from './hullCapsule';

export { BOAT_CAMERA_INFO, type BoatCameraInfo } from './boatCameraInfo';

export type CameraMode =
  | 'chase'
  | 'helm'
  | 'bridge-port'
  | 'bridge-starboard'
  | 'mast'
  | 'orbit'
  | 'bow'
  | 'stern'
  | 'port'
  | 'starboard'
  | 'waterline'
  | 'drone'
  | 'fixed'
  | 'cinematic'
  | 'photo';

// Every mode, in cycle order; photo mode has its own key and is not in the cycle.
export const CAMERA_MODES: readonly CameraMode[] = [
  'chase',
  'helm',
  'bridge-port',
  'bridge-starboard',
  'mast',
  'orbit',
  'bow',
  'stern',
  'port',
  'starboard',
  'waterline',
  'drone',
  'fixed',
  'cinematic',
  'photo',
];

const CAMERA_MODE_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  orbit: 'Orbit',
  helm: 'Helm',
  'bridge-port': 'Bridge wing · port',
  'bridge-starboard': 'Bridge wing · starboard',
  mast: 'Masthead',
  bow: 'Bow',
  stern: 'Stern',
  port: 'Port side',
  starboard: 'Starboard side',
  waterline: 'Waterline',
  drone: 'Drone',
  fixed: 'Fixed',
  cinematic: 'Cinematic',
  photo: 'Photo',
};

// Eye points on board: the camera is inside the hull's bounding capsule, so blends to or from an
// outside view would sweep through the superstructure and cut instead.
const ONBOARD: ReadonlySet<CameraMode> = new Set(['helm', 'bridge-port', 'bridge-starboard', 'mast']);
// Free-standing cameras aimed at the boat: kept out of every hull and re-aimed after clamping.
const LOOK_AT: ReadonlySet<CameraMode> = new Set(['chase', 'orbit', 'fixed', 'cinematic']);

function isModeAvailable(mode: CameraMode, kind: BoatKind): boolean {
  const info = BOAT_CAMERA_INFO[kind];
  if (mode === 'mast') return !!info.mast;
  if (mode === 'bridge-port' || mode === 'bridge-starboard') return !!info.wings;
  return true;
}

// The camera cycle for a boat: the masthead only on the sailboat, bridge wings only on the ships.
export function cycleModes(kind: BoatKind): CameraMode[] {
  return CAMERA_MODES.filter((mode) => mode !== 'photo' && isModeAvailable(mode, kind));
}

// A mode this boat has: bridge wings fall back to the helm, the masthead to the chase camera.
export function resolveMode(mode: CameraMode, kind: BoatKind): CameraMode {
  if (isModeAvailable(mode, kind)) return mode;
  return mode === 'mast' ? 'chase' : 'helm';
}

const MODE_ALIASES: Record<string, CameraMode> = {
  free: 'photo',
  'free-cam': 'photo',
  freecam: 'photo',
  fly: 'photo',
  director: 'cinematic',
  auto: 'cinematic',
  cinema: 'cinematic',
  masthead: 'mast',
  'wing-port': 'bridge-port',
  'wing-starboard': 'bridge-starboard',
  'bridge-wing-port': 'bridge-port',
  'bridge-wing-starboard': 'bridge-starboard',
  'bridge-stbd': 'bridge-starboard',
  'wing-stbd': 'bridge-starboard',
  stbd: 'starboard',
  world: 'fixed',
};

// Deep-link `cam=` values: every mode id (`bridge-port`, also `bridgePort` / `bridge_port`) and a
// few aliases (`free`, `director`, `masthead`, `wing-port`). Null when unknown.
export function parseCameraMode(value: string | null | undefined): CameraMode | null {
  if (!value) return null;
  const key = value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
  if ((CAMERA_MODES as readonly string[]).includes(key)) return key as CameraMode;
  return MODE_ALIASES[key] ?? null;
}

export interface DepthOfField {
  enabled: boolean;
  focusDistance: number; // m
  aperture: number; // 0 (pinhole, all sharp) .. 1 (widest, shallowest focus)
}

const BLEND_SECONDS = 0.6;
const ARC_BLEND_SECONDS = 0.9; // blends routed around a hull travel further
const CLEARANCE = 1.2; // metres above the water for external cameras
const REST_PITCH = 0.18; // rad, the external cameras' resting elevation
const PHOTO_CLEARANCE = 0.3;
const HEAD_STABILIZATION = 0.35; // share of roll/pitch a person's head cancels at the helm
const HULL_MARGIN = 1.5; // metres outside the bounding capsule for free-standing cameras
const ARC_MARGIN = 1;
const PHOTO_TIME_SCALES = [1, 0.25, 0] as const;
const DEFAULT_APERTURE = 0.25;

const tmpVec = new Vector3();
const tmpVec2 = new Vector3();
const tmpQuat = new Quaternion();
const tmpQuat2 = new Quaternion();
const tmpEuler = new Euler(0, 0, 0, 'YXZ');
const tmpMatrix = new Matrix4();
const mount = new Vector3();
const mountTarget = new Vector3();
const UP = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);

// Rotation that points a camera (looking down −Z) from `from` toward `to`.
function lookRotation(from: Vector3, to: Vector3, out: Quaternion): Quaternion {
  return out.setFromRotationMatrix(tmpMatrix.lookAt(from, to, UP));
}

const capsules = new Map<BoatKind, HullCapsule>();
function capsuleFor(kind: BoatKind): HullCapsule {
  let capsule = capsules.get(kind);
  if (!capsule) {
    capsule = hullCapsule(BOAT_CAMERA_INFO[kind], HULL_MARGIN);
    capsules.set(kind, capsule);
  }
  return capsule;
}

const v3 = (p: Vec3Like, out = new Vector3()): Vector3 => out.set(p.x, p.y, p.z);

interface Obstacle {
  capsule: HullCapsule;
  pose: HullPose;
}

export class CameraRig {
  readonly camera: PerspectiveCamera;
  mode: CameraMode = 'chase';
  private kind: BoatKind = 'powerboat';
  private info: BoatCameraInfo = BOAT_CAMERA_INFO.powerboat;
  private yawOffset = 0;
  private pitchOffset = REST_PITCH;
  private chaseTilt = 0; // rad, the chase view's look up (+) or down on top of aiming at the boat
  private zoom = 1;
  private idleTime = 0;
  private chaseYaw = 0;
  private chaseInitialized = false;
  private blend = 1;
  private blendSeconds = BLEND_SECONDS;
  private blendPlanned = true;
  private arc: { from: number; to: number } | null = null;
  private fromMode: CameraMode = 'chase';
  private fromPosition = new Vector3();
  private fromQuaternion = new Quaternion();
  private targetPosition = new Vector3();
  private targetQuaternion = new Quaternion();
  private lookTarget = new Vector3();
  private clearance = CLEARANCE;
  private smoothedFocus = new Vector3();
  private focusAhead = new Vector3();
  private cinematic = false;
  private cutPending = true;
  private boatPose: HullPose = { position: new Vector3(), quaternion: new Quaternion() };
  private boatVelocity = new Vector3();
  private capsule: HullCapsule = capsuleFor('powerboat');
  private arcCapsule: HullCapsule = hullCapsule(BOAT_CAMERA_INFO.powerboat, ARC_MARGIN);
  private obstacles: Obstacle[] = [];
  private hs = 0;
  // Fixed world camera
  private fixedAnchor: Vector3 | null = null;
  private fixedSide: 1 | -1 = 1;
  // Cinematic director
  readonly director: Director;
  private shotAnchor = new Vector3();
  // Photo camera
  private photoReturn: CameraMode = 'chase';
  private photoReady = false;
  private photoYaw = 0;
  private photoPitch = 0;
  private photoVelocity = new Vector3();
  private photoTimeIndex = 0;
  private apertureValue = DEFAULT_APERTURE;
  private focus = 50;

  constructor(fov = 55, random: () => number = Math.random) {
    this.camera = new PerspectiveCamera(fov, 1, 0.1, 80_000);
    this.director = new Director(random);
  }

  get modeLabel(): string {
    return CAMERA_MODE_LABELS[this.mode];
  }

  get boatKind(): BoatKind {
    return this.kind;
  }

  // Simulation speed photo mode asks for (1 outside it): normal, quarter speed or frozen.
  get timeScale(): number {
    return this.mode === 'photo' ? PHOTO_TIME_SCALES[this.photoTimeIndex] : 1;
  }

  // Depth of field for the post pipeline: photo mode only, focused on the boat.
  get focusDistance(): number {
    return this.focus;
  }

  get aperture(): number {
    return this.apertureValue;
  }

  get dof(): DepthOfField {
    return { enabled: this.mode === 'photo', focusDistance: this.focus, aperture: this.apertureValue };
  }

  get isPhoto(): boolean {
    return this.mode === 'photo';
  }

  setBoat(kind: BoatKind): void {
    this.kind = kind;
    this.info = BOAT_CAMERA_INFO[kind];
    this.capsule = capsuleFor(kind);
    this.arcCapsule = hullCapsule(this.info, ARC_MARGIN);
    this.chaseInitialized = false;
    this.fixedAnchor = null;
    this.director.reset();
    const resolved = this.mode === 'photo' ? 'photo' : resolveMode(this.mode, kind);
    if (resolved !== this.mode) this.mode = resolved;
    this.photoReturn = resolveMode(this.photoReturn, kind);
    // An eye point on one boat to one on another would fly out through both hulls.
    if (ONBOARD.has(this.mode) || this.mode === 'cinematic' || this.mode === 'fixed') this.cut();
    else if (this.mode !== 'photo') this.beginBlend();
  }

  setMode(mode: CameraMode): void {
    const next = resolveMode(mode, this.kind);
    if (next === this.mode) return;
    if (next === 'photo') {
      this.enterPhoto();
      return;
    }
    const from = this.mode;
    this.mode = next;
    this.yawOffset = 0;
    this.pitchOffset = ONBOARD.has(next) ? 0 : REST_PITCH;
    this.zoom = 1;
    if (next === 'fixed') this.fixedAnchor = null;
    if (next === 'cinematic') this.director.reset();
    this.beginBlend(from);
  }

  cycle(direction: 1 | -1): void {
    const modes = cycleModes(this.kind);
    const current = this.mode === 'photo' ? this.photoReturn : this.mode;
    const index = modes.indexOf(current);
    const next = modes[(index + direction + modes.length) % modes.length];
    if (next) this.setMode(next);
  }

  togglePhoto(): void {
    if (this.mode === 'photo') this.setMode(this.photoReturn);
    else this.enterPhoto();
  }

  // Main-menu backdrop: an orbit camera turns slowly by itself.
  setCinematic(enabled: boolean): void {
    this.cinematic = enabled;
  }

  // Significant wave height (m), so the director can favour dramatic low shots in big seas.
  setSeaState(hs: number): void {
    this.hs = Number.isFinite(hs) ? Math.max(0, hs) : 0;
  }

  setAspect(width: number, height: number): void {
    // A minimised or collapsed window reports 0 × 0; keep the last good aspect rather than NaN.
    if (!(width > 0 && height > 0)) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setFov(degrees: number): void {
    this.camera.fov = degrees;
    this.camera.updateProjectionMatrix();
  }

  // Jump straight to the current mode's view on the next update, with no blend (a new voyage
  // starting: blending from the previous camera would sweep through the hull).
  cut(): void {
    this.blend = 1;
    this.blendPlanned = true;
    this.arc = null;
    this.chaseInitialized = false;
    this.cutPending = true;
  }

  private enterPhoto(): void {
    if (this.mode === 'photo') return;
    this.photoReturn = this.mode;
    this.mode = 'photo';
    this.photoReady = false;
    this.photoVelocity.set(0, 0, 0);
    this.photoTimeIndex = 0;
    // Detach right where the camera is: no blend.
    this.blend = 1;
    this.blendPlanned = true;
    this.arc = null;
  }

  private beginBlend(from: CameraMode = this.mode): void {
    if (this.cutPending) return; // nothing on screen yet to blend from
    this.fromMode = from;
    this.fromPosition.copy(this.camera.position);
    this.fromQuaternion.copy(this.camera.quaternion);
    this.blend = 0;
    this.blendPlanned = false;
    this.arc = null;
    this.blendSeconds = BLEND_SECONDS;
  }

  // waterHeight: sea surface height under the camera (from a sim probe). boats: everything on the
  // water (the player included), so free-standing cameras stay out of every hull.
  update(
    dt: number,
    boat: BoatSnapshot,
    input: CameraInput | null,
    waterHeight: number,
    boats: readonly BoatSnapshot[] = [],
  ): void {
    input ??= NO_CAMERA_INPUT;
    if (input.photo) this.togglePhoto();
    if (input.next) this.cycle(1);
    if (input.prev) this.cycle(-1);

    const pose = this.boatPose;
    pose.position.set(boat.position.x, boat.position.y, boat.position.z);
    pose.quaternion.set(boat.orientation.x, boat.orientation.y, boat.orientation.z, boat.orientation.w);
    this.boatVelocity.set(boat.velocity.x, boat.velocity.y, boat.velocity.z);
    this.updateObstacles(boat, boats);

    if (this.mode === 'photo') {
      this.updatePhoto(dt, input, waterHeight);
      this.cutPending = false;
      return;
    }

    if (this.cinematic && this.mode === 'orbit') {
      this.yawOffset += dt * 0.06;
      this.pitchOffset = 0.12;
    }
    if (input.reset) {
      this.yawOffset = 0;
      this.pitchOffset = ONBOARD.has(this.mode) ? 0 : REST_PITCH;
      this.zoom = 1;
      if (this.mode === 'cinematic') this.startShot(this.director.next(this.hs));
    }
    const turning = input.lookX !== 0 || input.lookY !== 0 || input.orbitX !== 0 || input.orbitY !== 0;
    this.idleTime = turning ? 0 : this.idleTime + dt;
    this.yawOffset -= input.lookX + input.orbitX;
    this.pitchOffset = Math.min(1.3, Math.max(-1.2, this.pitchOffset + input.lookY + input.orbitY));
    // Chase stops where its view stops changing, so reversing the mouse answers at once.
    if (this.mode === 'chase')
      this.pitchOffset = Math.min(REST_PITCH + 0.83, Math.max(REST_PITCH - 1.44, this.pitchOffset));
    this.zoom = Math.min(4, Math.max(0.35, this.zoom * Math.exp(input.zoom * 0.12)));

    this.clearance = CLEARANCE;
    this.computeTarget(dt);

    if (LOOK_AT.has(this.mode) || this.mode === 'drone') {
      // Out of every hull, then out of the water, then aimed back at the boat.
      for (const obstacle of this.obstacles) {
        pushOutOfHull(this.targetPosition, obstacle.capsule, obstacle.pose, 1, 0.3);
      }
    }
    if (!ONBOARD.has(this.mode)) {
      this.targetPosition.y = Math.max(this.targetPosition.y, waterHeight + this.clearance);
    }
    if (LOOK_AT.has(this.mode)) lookRotation(this.targetPosition, this.lookTarget, this.targetQuaternion);
    if (this.mode === 'chase' && this.chaseTilt !== 0)
      this.targetQuaternion.multiply(tmpQuat.setFromAxisAngle(X_AXIS, this.chaseTilt));
    if (this.mode === 'fixed') {
      // Free look on top of tracking the boat.
      tmpEuler.set(this.pitchOffset - REST_PITCH, this.yawOffset, 0, 'YXZ');
      this.targetQuaternion.multiply(tmpQuat.setFromEuler(tmpEuler));
    }

    if (this.cutPending) this.blend = 1;
    if (this.blend < 1 && !this.blendPlanned) this.planBlend();
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.blendSeconds);
      const t = this.blend * this.blend * (3 - 2 * this.blend);
      this.camera.position.lerpVectors(this.fromPosition, this.targetPosition, t);
      if (this.arc && this.blend < 1) {
        // Around the hull, over the top, never through it.
        const min = this.arc.from + (this.arc.to - this.arc.from) * t;
        pushOutOfHull(this.camera.position, this.arcCapsule, pose, min, 1);
      }
      this.camera.quaternion.slerpQuaternions(this.fromQuaternion, this.targetQuaternion, t);
    } else {
      this.camera.position.copy(this.targetPosition);
      this.camera.quaternion.copy(this.targetQuaternion);
    }
    this.cutPending = false;
    this.focus = this.camera.position.distanceTo(tmpVec.copy(pose.position));
    this.camera.updateMatrixWorld();
  }

  // Decide how to get from the previous view to the new one: straight, around the hull, or a cut.
  private planBlend(): void {
    this.blendPlanned = true;
    const fromOnboard = ONBOARD.has(this.fromMode);
    const toOnboard = ONBOARD.has(this.mode);
    const mastInvolved = this.fromMode !== this.mode && (this.fromMode === 'mast' || this.mode === 'mast');
    if (fromOnboard !== toOnboard || mastInvolved || this.mode === 'cinematic') {
      this.blend = 1; // a cut: the straight path would go through the boat
      return;
    }
    if (fromOnboard) return; // helm ↔ bridge wing: across the bridge
    const capsule = this.arcCapsule;
    const from = hullNorm(this.fromPosition, capsule, this.boatPose);
    const to = hullNorm(this.targetPosition, capsule, this.boatPose);
    if (!segmentEntersCapsule(this.fromPosition, this.targetPosition, capsule, this.boatPose, from, to))
      return;
    this.arc = { from: Math.min(1, from), to: Math.min(1, to) };
    this.blendSeconds = ARC_BLEND_SECONDS;
  }

  private updateObstacles(player: BoatSnapshot, boats: readonly BoatSnapshot[]): void {
    const list = boats.some((b) => b.id === player.id) ? boats : [player, ...boats];
    while (this.obstacles.length > list.length) this.obstacles.pop();
    list.forEach((b, i) => {
      let obstacle = this.obstacles[i];
      if (!obstacle) {
        obstacle = { capsule: this.capsule, pose: { position: new Vector3(), quaternion: new Quaternion() } };
        this.obstacles[i] = obstacle;
      }
      obstacle.capsule = b.id === player.id ? this.capsule : capsuleFor(b.kind);
      obstacle.pose.position.set(b.position.x, b.position.y, b.position.z);
      obstacle.pose.quaternion.set(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
    });
  }

  private boatYaw(): number {
    const forward = tmpVec.set(0, 0, -1).applyQuaternion(this.boatPose.quaternion);
    return Math.atan2(-forward.x, -forward.z);
  }

  private speedAlong(yaw: number): number {
    return -Math.sin(yaw) * this.boatVelocity.x - Math.cos(yaw) * this.boatVelocity.z;
  }

  private followBoat(dt: number, yawRate: number, focusRate: number): number {
    const boatPos = this.boatPose.position;
    const boatYaw = this.boatYaw();
    if (!this.chaseInitialized) {
      this.chaseYaw = boatYaw;
      this.smoothedFocus.copy(boatPos);
      this.chaseInitialized = true;
    }
    this.chaseYaw += wrapAngle(boatYaw - this.chaseYaw) * (1 - Math.exp(-dt * yawRate));
    this.trackFocus(dt, focusRate);
    return boatYaw;
  }

  // Eases the focus toward the boat at `rate` (1/s), led by the boat's speed over the ground, so it
  // smooths the bobbing but keeps up with a boat moving fast: a plain first-order lag trails v / rate
  // behind it (15 m at 90 m/s for the chase camera's 6/s), this one sits on it at a steady speed.
  private trackFocus(dt: number, rate: number): void {
    const v = this.boatVelocity;
    const p = this.boatPose.position;
    this.focusAhead.set(p.x + v.x / rate, p.y, p.z + v.z / rate);
    this.smoothedFocus.lerp(this.focusAhead, 1 - Math.exp(-dt * rate));
  }

  private computeTarget(dt: number): void {
    const { length, beam, height, eye } = this.info;
    const boatPos = this.boatPose.position;
    const boatQuat = this.boatPose.quaternion;
    const boatYaw = this.boatYaw();

    switch (this.mode) {
      case 'helm':
      case 'bridge-port':
      case 'bridge-starboard': {
        // Ride the boat, but let the head cancel part of the roll and pitch.
        const level = tmpQuat.setFromAxisAngle(UP, boatYaw);
        this.targetQuaternion.slerpQuaternions(boatQuat, level, HEAD_STABILIZATION);
        const wings = this.info.wings;
        if (this.mode !== 'helm' && wings) {
          // On the wing, looking along the ship's side toward its far end and the waterline.
          const side = this.mode === 'bridge-starboard' ? 1 : -1;
          const wingEye = v3(this.mode === 'bridge-starboard' ? wings.starboard : wings.port, mount);
          const far = (wings.lookAft ? 1 : -1) * (length / 2);
          mountTarget.set(side * (beam / 2 + 2), 2, far);
          this.targetQuaternion.multiply(lookRotation(wingEye, mountTarget, tmpQuat2));
          this.targetPosition.copy(wingEye).applyQuaternion(boatQuat).add(boatPos);
        } else {
          this.targetPosition.set(eye.x, eye.y, eye.z).applyQuaternion(boatQuat).add(boatPos);
        }
        tmpEuler.set(this.pitchOffset, this.yawOffset, 0, 'YXZ');
        this.targetQuaternion.multiply(tmpQuat2.setFromEuler(tmpEuler));
        return;
      }
      case 'mast': {
        // Rigidly at the masthead: heels and pitches with the boat.
        const mast = this.info.mast;
        if (!mast) return;
        v3(mast.eye, mount);
        v3(mast.target, mountTarget);
        lookRotation(mount, mountTarget, tmpQuat2);
        this.targetQuaternion.copy(boatQuat).multiply(tmpQuat2);
        this.targetPosition.copy(mount).applyQuaternion(boatQuat).add(boatPos);
        tmpEuler.set(this.pitchOffset, this.yawOffset, 0, 'YXZ');
        this.targetQuaternion.multiply(tmpQuat2.setFromEuler(tmpEuler));
        return;
      }
      case 'chase':
      case 'orbit': {
        if (!this.chaseInitialized) {
          this.chaseYaw = boatYaw;
          this.smoothedFocus.copy(boatPos);
          this.chaseInitialized = true;
        }
        if (this.mode === 'chase') {
          // Swing back behind the boat a couple of seconds after the player lets go.
          const follow = 1 - Math.exp(-dt * 1.8);
          this.chaseYaw += wrapAngle(boatYaw - this.chaseYaw) * follow;
          if (this.idleTime > 2.5) this.yawOffset *= Math.exp(-dt * 1.2);
        }
        this.trackFocus(dt, 6);
        const distance = chaseDistance(this.info) * this.zoom;
        const yaw = (this.mode === 'chase' ? this.chaseYaw : 0) + this.yawOffset;
        // Chase looks up and down like a head: up (pitchOffset above its rest) drops the camera a
        // little and tilts the view up toward the horizon; down raises it to look down on the deck.
        // Orbit keeps the plain orbit, where up swings the camera over the top.
        const look = this.pitchOffset - REST_PITCH;
        const pitch =
          this.mode === 'chase'
            ? Math.min(0.9, Math.max(0.04, REST_PITCH + (this.info.chaseRise ?? 0) - 0.5 * look))
            : this.pitchOffset;
        this.chaseTilt = this.mode === 'chase' ? Math.min(0.5, Math.max(-0.3, look * 0.6)) : 0;
        const focus = this.lookTarget
          .copy(this.smoothedFocus)
          .add(tmpVec.set(0, Math.min(height * 0.35, 12), 0));
        this.targetPosition.set(
          focus.x + Math.sin(yaw) * Math.cos(pitch) * distance,
          focus.y + Math.sin(pitch) * distance,
          focus.z + Math.cos(yaw) * Math.cos(pitch) * distance,
        );
        return;
      }
      case 'bow':
      case 'stern':
      case 'port':
      case 'starboard':
      case 'waterline': {
        // Hull-mounted: rigidly attached, looking along or across the hull.
        const target = mountTarget;
        if (this.mode === 'bow') {
          mount.set(0, height * 0.35 + 1, -length * 0.5 - 1);
          target.set(0, height * 0.2, length * 0.2);
        } else if (this.mode === 'stern') {
          mount.set(0, height * 0.35 + 1.5, length * 0.5 + length * 0.15 + 3);
          target.set(0, height * 0.2, -length * 0.5);
        } else if (this.mode === 'waterline') {
          mount.set(beam * 0.5 + 0.6, 0.6, -length * 0.3);
          target.set(beam * 0.5, 0.4, length * 0.5);
        } else {
          const side = this.mode === 'starboard' ? 1 : -1;
          mount.set(side * (beam * 0.5 + length * 0.35 + 4), height * 0.25 + 1, 0);
          target.set(0, height * 0.2, 0);
        }
        this.targetPosition.copy(mount).applyQuaternion(boatQuat).add(boatPos);
        lookRotation(
          this.targetPosition,
          target.applyQuaternion(boatQuat).add(boatPos),
          this.targetQuaternion,
        );
        // Free look on top of the mount (half rate, so the boat stays in view).
        tmpEuler.set(
          Math.min(0.5, Math.max(-0.5, (this.pitchOffset - REST_PITCH) * 0.5)),
          this.yawOffset * 0.5,
          0,
          'YXZ',
        );
        this.targetQuaternion.multiply(tmpQuat.setFromEuler(tmpEuler));
        return;
      }
      case 'drone': {
        const altitude = Math.max(40, length * 2.2) * this.zoom;
        this.trackFocus(dt, 3);
        // Straight down; looking up tilts it toward the horizon, up to 50°, swinging back over the
        // stern so it still looks at the boat.
        const tilt = Math.min(0.87, Math.max(0, this.pitchOffset - REST_PITCH));
        const yaw = boatYaw + this.yawOffset;
        const back = altitude * Math.sin(tilt);
        this.targetPosition.set(
          this.smoothedFocus.x + Math.sin(yaw) * back,
          this.smoothedFocus.y + altitude * Math.cos(tilt),
          this.smoothedFocus.z + Math.cos(yaw) * back + 0.01,
        );
        this.targetQuaternion.setFromAxisAngle(X_AXIS, -Math.PI / 2 + tilt);
        this.targetQuaternion.premultiply(tmpQuat.setFromAxisAngle(UP, yaw));
        return;
      }
      case 'fixed': {
        // Stands in the world; the boat sails past. Once it is well past, set up further on.
        if (!this.fixedAnchor || this.fixedTooFar()) this.placeFixed(boatYaw);
        const anchor = this.fixedAnchor ?? boatPos;
        this.targetPosition.copy(anchor);
        this.lookTarget.copy(boatPos).add(tmpVec.set(0, Math.min(height * 0.3, 12), 0));
        return;
      }
      case 'cinematic': {
        this.followBoat(dt, 1.5, 4);
        if (this.director.update(dt, this.hs) || !this.director.shot) {
          const shot = this.director.shot;
          if (shot) this.startShot(shot);
        }
        const shot = this.director.shot;
        if (!shot) return;
        const pose = shotPose(shot, {
          info: this.info,
          focus: this.smoothedFocus,
          yaw: this.chaseYaw,
          hs: this.hs,
          elapsed: this.director.elapsed,
          anchor: this.shotAnchor,
        });
        this.targetPosition.set(pose.position.x, pose.position.y, pose.position.z);
        this.lookTarget.set(pose.lookAt.x, pose.lookAt.y, pose.lookAt.z);
        this.clearance = pose.clearance;
        return;
      }
      case 'photo':
        return;
    }
  }

  // A new director shot: world-fixed shots stand ahead of the boat; the camera cuts to it.
  private startShot(shot: Shot): void {
    const yaw = this.boatYaw();
    const anchor = shotAnchor(shot, this.info, this.boatPose.position, yaw, this.speedAlong(yaw), this.hs);
    this.shotAnchor.set(anchor.x, anchor.y, anchor.z);
    this.blend = 1;
    this.blendPlanned = true;
    this.arc = null;
  }

  // The fixed camera's spot: ahead of the boat and off to one side, so it sails past.
  private fixedOffsets(): { ahead: number; side: number } {
    const { length, beam } = this.info;
    return { ahead: length * 1.2 + 25, side: beam / 2 + length * 0.35 + 12 };
  }

  private placeFixed(yaw: number): void {
    const { ahead: base, side } = this.fixedOffsets();
    const ahead = base + Math.max(0, this.speedAlong(yaw)) * 4;
    const boatPos = this.boatPose.position;
    const s = side * this.fixedSide;
    this.fixedAnchor ??= new Vector3();
    this.fixedAnchor.set(
      boatPos.x - Math.sin(yaw) * ahead + Math.cos(yaw) * s,
      boatPos.y + Math.max(2.5, this.info.height * 0.25),
      boatPos.z - Math.cos(yaw) * ahead - Math.sin(yaw) * s,
    );
    this.fixedSide = this.fixedSide === 1 ? -1 : 1;
    if (!this.cutPending) {
      // A new spot is a cut, not a sweep across the sea.
      this.blend = 1;
      this.blendPlanned = true;
      this.arc = null;
    }
  }

  // Distance (horizontal) beyond which the fixed camera re-places itself.
  get fixedRange(): number {
    const { ahead, side } = this.fixedOffsets();
    return Math.max(150, 2.5 * Math.hypot(ahead, side));
  }

  private fixedTooFar(): boolean {
    const anchor = this.fixedAnchor;
    if (!anchor) return true;
    const p = this.boatPose.position;
    return Math.hypot(anchor.x - p.x, anchor.z - p.z) > this.fixedRange;
  }

  // ---------------------------------------------------------------------------
  // Photo camera: detached fly camera. WASD fly along the view, Q / E go down / up, the mouse
  // looks; the wheel (- / =) sets the aperture, focus follows the boat.

  private updatePhoto(dt: number, input: CameraInput, waterHeight: number): void {
    const cam = this.camera;
    const boatPos = this.boatPose.position;
    if (!this.photoReady) {
      if (this.cutPending) this.placePhotoBehindBoat();
      tmpEuler.setFromQuaternion(cam.quaternion, 'YXZ');
      this.photoPitch = tmpEuler.x;
      this.photoYaw = tmpEuler.y;
      this.photoReady = true;
    }
    if (input.slowMotion) this.photoTimeIndex = (this.photoTimeIndex + 1) % PHOTO_TIME_SCALES.length;
    if (input.reset) {
      this.placePhotoBehindBoat();
      tmpEuler.setFromQuaternion(cam.quaternion, 'YXZ');
      this.photoPitch = tmpEuler.x;
      this.photoYaw = tmpEuler.y;
      this.photoVelocity.set(0, 0, 0);
    }
    this.photoYaw -= input.lookX + input.orbitX;
    this.photoPitch = Math.min(1.5, Math.max(-1.5, this.photoPitch + input.lookY + input.orbitY));
    cam.quaternion.setFromEuler(tmpEuler.set(this.photoPitch, this.photoYaw, 0, 'YXZ'));

    // Fly along the view (forward includes pitch), strafe flat, climb straight up.
    const speed = photoSpeed(this.info);
    const forward = tmpVec.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const right = tmpVec2.set(Math.cos(this.photoYaw), 0, -Math.sin(this.photoYaw));
    const desired = mount
      .set(0, 0, 0)
      .addScaledVector(forward, input.moveZ)
      .addScaledVector(right, input.moveX)
      .addScaledVector(UP, input.moveY)
      .multiplyScalar(speed);
    this.photoVelocity.lerp(desired, 1 - Math.exp(-dt * 6));
    cam.position.addScaledVector(this.photoVelocity, dt);
    cam.position.y = Math.max(cam.position.y, waterHeight + PHOTO_CLEARANCE);
    // A long leash, so the boat can't be lost over the horizon.
    const leash = Math.max(600, this.info.length * 6);
    const offset = tmpVec.subVectors(cam.position, boatPos);
    if (offset.length() > leash) cam.position.copy(boatPos).addScaledVector(offset.normalize(), leash);

    // Aperture: notches open (+) or close (−) it; the wheel's "zoom in" opens it.
    const notches = -input.zoom;
    this.apertureValue = Math.min(1, Math.max(0.01, this.apertureValue * Math.exp(notches * 0.15)));
    // Auto-focus on the boat, racked smoothly.
    const target = cam.position.distanceTo(
      tmpVec.copy(boatPos).add(tmpVec2.set(0, Math.min(this.info.height * 0.3, 12), 0)),
    );
    this.focus += (target - this.focus) * (1 - Math.exp(-dt * 4));
    cam.updateMatrixWorld();
  }

  // Start (or reset) the photo camera behind and above the boat, aimed at it.
  private placePhotoBehindBoat(): void {
    const yaw = this.boatYaw();
    const { length, height } = this.info;
    const distance = length * 0.9 + 8;
    const boatPos = this.boatPose.position;
    const focus = tmpVec.copy(boatPos).add(tmpVec2.set(0, Math.min(height * 0.35, 12), 0));
    this.camera.position.set(
      focus.x + Math.sin(yaw) * distance,
      focus.y + distance * 0.25,
      focus.z + Math.cos(yaw) * distance,
    );
    lookRotation(this.camera.position, focus, this.camera.quaternion);
    this.focus = this.camera.position.distanceTo(focus);
  }
}

// Fly speed: brisk around a jet ski, faster around a container ship.
export function photoSpeed(info: BoatCameraInfo): number {
  return Math.min(40, Math.max(6, info.length * 0.3));
}

// Does the straight segment a → b pass through the capsule (beyond what its endpoints already do)?
function segmentEntersCapsule(
  a: Vector3,
  b: Vector3,
  capsule: HullCapsule,
  pose: HullPose,
  normA: number,
  normB: number,
): boolean {
  const steps = 16;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const allowed = Math.min(1, normA + (normB - normA) * t);
    if (hullNorm(tmpVec.lerpVectors(a, b, t), capsule, pose) < allowed) return true;
  }
  return false;
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
