// Dev-only sail lab (/dev/sail-lab.html): a placeholder hull with the cloth main and genoa, driven by
// the real sail force module on a kinematic boat (fixed heading north, chosen speed and heel). Sliders
// for wind, sheets, reef, furl, auto-trim and heel; the panel shows the aero numbers and trim state.
// URL parameters (for screenshots):
//   ?tws=12 (kn) &twa=45 (deg, + from starboard) &speed=6.5|polar (kn) &heel=-15 (deg, + starboard down)
//   &main=12&jib=10 (sheet limits, deg; implies auto=0) &auto=1 &reef=0..3 &furl=0..1 &mode=arcade|realistic
//   &quality=low|medium|high|ultra &twaRate=4 (deg/s sweep, e.g. a gybe from twa=170) &warm=4 (s settled
//   before the first frame) &cam=x,y,z&look=x,y,z &sun=35 (elevation) &az=140 &hud=0

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  AgXToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Shape,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { type ClothQuality } from '../cloth/SailCloth';
import { SailView } from '../render/boats/SailView';
import { tsl } from '../render/tsl';
import { sailSpec } from '../sim/boats/specs/sail';
import { DEG } from '../sim/core/conventions';
import { qFromAxisAngle, vec3 } from '../sim/core/math';
import { KNOT } from '../sim/core/units';
import type { ForceContext } from '../sim/physics/modules';
import { RigidBody } from '../sim/physics/RigidBody';
import { flatWater } from '../sim/physics/water';
import { LogShearWind } from '../sim/physics/windage';
import { polarSpeed } from '../sim/sail/orcPolar';
import { createSailModule } from '../sim/sail/sailModule';
import { SAIL_KEYS as K, trimStateOf } from '../sim/sail/telemetry';
import { neutralControls, type PhysicsMode } from '../sim/world/protocol';
import { POINT_OF_SAIL_LABEL, pointOfSail } from '../ui/hud/sailing';

const { Fn, max, mix, positionWorldDirection, pow } = tsl;

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const value = params.get(key);
  return value === null || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);
};
const vector = (key: string, fallback: Vector3): Vector3 => {
  const parts = params.get(key)?.split(',').map(Number);
  return parts?.length === 3 && parts.every(Number.isFinite) ? new Vector3(...parts) : fallback;
};
const QUALITIES: ClothQuality[] = ['low', 'medium', 'high', 'ultra'];
const manualSheets = params.has('main') || params.has('jib');

const state = {
  tws: num('tws', 12),
  twa: num('twa', 45),
  polar: params.get('speed') === 'polar' || !params.has('speed'),
  speed: num('speed', 6),
  heel: num('heel', Number.NaN), // NaN: estimated from the heeling moment
  main: num('main', 15),
  jib: num('jib', 12),
  auto: params.has('auto') ? params.get('auto') !== '0' : !manualSheets,
  reef: num('reef', 0),
  furl: num('furl', 0),
  mode: (params.get('mode') === 'realistic' ? 'realistic' : 'arcade') as PhysicsMode,
  quality: (QUALITIES as string[]).includes(params.get('quality') ?? '')
    ? (params.get('quality') as ClothQuality)
    : 'high',
  twaRate: num('twaRate', 0),
  sunElevation: num('sun', 35),
  sunAzimuth: num('az', 140),
};
if (params.get('hud') === '0') document.body.classList.add('clean');

// Kinematic boat: heading north, sailing at the chosen speed and heel.
const BOW = vec3(0, 0, -1);
const sails = createSailModule(sailSpec);
const body = new RigidBody({
  mass: sailSpec.mass,
  inertia: vec3(46000, 46000, 13400),
  cg: vec3(0, 0.13, 0.83),
});
const ctx: ForceContext = {
  body,
  water: flatWater,
  wind: new LogShearWind(1, 0),
  time: 0,
  dt: 1 / 240,
  controls: neutralControls(),
  physicsMode: state.mode,
};
const telemetry: Record<string, number> = {};
const boatQuat = new Quaternion();
let heelEstimate = 0;

function boatSpeed(): number {
  return state.polar ? polarSpeed(state.tws * KNOT, state.twa * DEG) : state.speed * KNOT;
}

function stepSim(dt: number): void {
  const rig = sails.rig;
  const heel = Number.isFinite(state.heel) ? state.heel * DEG : heelEstimate;
  qFromAxisAngle(body.orientation, BOW, heel);
  body.position.x = body.position.z = 0;
  body.position.y = body.cg.y;
  body.velocity.x = body.velocity.y = 0;
  body.velocity.z = -boatSpeed();
  body.angularVelocity.x = body.angularVelocity.y = body.angularVelocity.z = 0;
  ctx.wind = new LogShearWind(state.tws * KNOT, state.twa * DEG);
  ctx.physicsMode = state.mode;
  const n = Math.max(1, Math.round(dt / (1 / 240)));
  for (let i = 0; i < n; i++) {
    rig.autoTrim = state.auto;
    if (!state.auto) {
      rig.mainSheetLimit = state.main * DEG;
      rig.jibSheetLimit = state.jib * DEG;
    }
    rig.setReef(state.reef);
    rig.furlTarget = state.furl;
    body.clearForces();
    ctx.dt = dt / n;
    sails.apply(ctx);
    ctx.time += ctx.dt;
  }
  sails.writeTelemetry(telemetry);
  // Without a heel slider the boat heels until a linear righting moment (GM·Δ per radian, below) balances the sails.
  if (!Number.isFinite(state.heel)) {
    const rm = sailSpec.mass * 9.81 * 1.9; // N·m per radian (GM 1.9 m)
    const target = Math.max(-0.7, Math.min(0.7, (telemetry[K.heelMoment] ?? 0) / rm));
    heelEstimate += (target - heelEstimate) * Math.min(1, dt * 1.5);
  }
  state.twa += state.twaRate * dt;
  if (state.twa > 180) state.twa -= 360;
  if (state.twa < -180) state.twa += 360;
}

function hullGeometry(): ExtrudeGeometry {
  // Deck plan (x = half-beam, y = −z body), extruded upward from the canoe bottom to the sheer.
  const shape = new Shape();
  const n = 24;
  const half = (z: number): number => {
    const t = (z + 5.9) / 11.5; // 0 bow .. 1 stern
    return 1.82 * Math.min(1, Math.sin(Math.min(1, t * 1.6) * (Math.PI / 2)) ** 0.8) * (1 - 0.22 * t * t);
  };
  for (let i = 0; i <= n; i++) {
    const z = -5.9 + (11.5 * i) / n;
    if (i === 0) shape.moveTo(0, -z);
    else shape.lineTo(half(z), -z);
  }
  for (let i = n; i >= 0; i--) {
    const z = -5.9 + (11.5 * i) / n;
    shape.lineTo(-half(z), -z);
  }
  const geometry = new ExtrudeGeometry(shape, { depth: 1.45, bevelEnabled: false });
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, -0.5, 0);
  return geometry;
}

async function main(): Promise<void> {
  const container = document.getElementById('viewport');
  const panel = document.getElementById('panel');
  if (!container || !panel) return;
  const renderer = new WebGPURenderer({ antialias: true, reversedDepthBuffer: true });
  await renderer.init();
  renderer.toneMapping = AgXToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const camera = new PerspectiveCamera(50, 1, 0.1, 5000);
  camera.position.copy(vector('cam', new Vector3(-24, 9, 16)));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vector('look', new Vector3(0, 6.5, -1)));
  controls.update();
  const resize = (): void => {
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const scene = new Scene();
  scene.backgroundNode = Fn(() => {
    const dir = positionWorldDirection;
    return mix(new Color(0.62, 0.74, 0.86), new Color(0.16, 0.36, 0.66), pow(max(dir.y, 0), 0.5));
  })();
  const sunDir = new Vector3().setFromSphericalCoords(
    1,
    (90 - state.sunElevation) * DEG,
    Math.PI - state.sunAzimuth * DEG,
  );
  const hemisphere = new HemisphereLight(0xdbe9ff, 0x20425a, 1.1);
  const sun = new DirectionalLight(0xfff4e0, 2.6);
  sun.position.copy(sunDir).multiplyScalar(40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  for (const k of ['left', 'bottom'] as const) sun.shadow.camera[k] = -14;
  for (const k of ['right', 'top'] as const) sun.shadow.camera[k] = 14;
  scene.add(hemisphere, sun);

  const water = new Mesh(
    new PlaneGeometry(4000, 4000),
    new MeshStandardNodeMaterial({ color: 0x0c3550, roughness: 0.18, metalness: 0.1 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  scene.add(water);

  const boat = new Group();
  scene.add(boat);
  const hull = new Mesh(hullGeometry(), new MeshStandardNodeMaterial({ color: 0xf2f0ea, roughness: 0.45 }));
  hull.castShadow = hull.receiveShadow = true;
  const keel = new Mesh(new BoxGeometry(0.14, 1.5, 1.1), new MeshStandardNodeMaterial({ color: 0x1d2633 }));
  keel.position.set(0, -1.25, -0.3);
  const cabin = new Mesh(new BoxGeometry(2.2, 0.45, 4.3), hull.material);
  cabin.position.set(0, 1.15, -0.6);
  boat.add(hull, keel, cabin);
  const view = new SailView({ parent: boat, quality: state.quality, showRig: true });
  view.setSun(sunDir, new Color(1, 0.96, 0.88));

  // Panel.
  const stats = document.createElement('div');
  stats.id = 'stats';
  type NumKey = 'tws' | 'twa' | 'speed' | 'heel' | 'main' | 'jib' | 'reef' | 'furl' | 'twaRate';
  const inputs = new Map<NumKey, HTMLInputElement>();
  const slider = (label: string, key: NumKey, min: number, max: number, step: number): void => {
    const row = document.createElement('label');
    const input = document.createElement('input');
    const value = document.createElement('span');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number.isFinite(state[key]) ? state[key] : 0);
    value.textContent = input.value;
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      value.textContent = input.value;
      if (key === 'speed') state.polar = false;
      if (key === 'main' || key === 'jib') state.auto = false;
    });
    inputs.set(key, input);
    row.append(label, input, value);
    panel.append(row);
  };
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): void => {
    const row = document.createElement('label');
    row.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => set(input.checked));
    row.append(input, label);
    panel.append(row);
  };
  slider('TWS kn', 'tws', 0, 140, 1);
  slider('TWA °', 'twa', -180, 180, 1);
  slider('Speed kn', 'speed', 0, 12, 0.1);
  slider('Heel °', 'heel', -45, 45, 1);
  slider('Main °', 'main', 1, 85, 1);
  slider('Jib °', 'jib', 8, 50, 1);
  slider('Reef', 'reef', 0, 3, 1);
  slider('Furl', 'furl', 0, 1, 0.05);
  slider('TWA °/s', 'twaRate', -10, 10, 0.5);
  check(
    'auto-trim',
    () => state.auto,
    (v) => (state.auto = v),
  );
  check(
    'polar speed',
    () => state.polar,
    (v) => (state.polar = v),
  );
  check(
    'auto heel',
    () => !Number.isFinite(state.heel),
    (v) => (state.heel = v ? Number.NaN : 0),
  );
  check(
    'realistic',
    () => state.mode === 'realistic',
    (v) => (state.mode = v ? 'realistic' : 'arcade'),
  );
  panel.append(stats);

  // Warm up so screenshots show a settled rig and cloth.
  const warm = num('warm', 3);
  for (let t = 0; t < warm; t += 1 / 60) {
    stepSim(1 / 60);
    boatQuat.set(body.orientation.x, body.orientation.y, body.orientation.z, body.orientation.w);
    view.update(1 / 60, telemetry, boatQuat, ctx.time);
  }

  let last = performance.now();
  let frame = 0;
  let clothMs = 0;
  void renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    stepSim(dt);
    const o = body.orientation;
    boatQuat.set(o.x, o.y, o.z, o.w);
    boat.quaternion.copy(boatQuat);
    const started = performance.now();
    view.update(dt, telemetry, boatQuat, ctx.time);
    clothMs += (performance.now() - started - clothMs) * 0.05;
    renderer.render(scene, camera);
    if (frame++ % 6 === 0) {
      const t = telemetry;
      const deg = (k: string): string => (((t[k] ?? 0) / DEG).toFixed(1) + '°').padStart(7);
      const kn = (k: string): string => ((t[k] ?? 0) / KNOT).toFixed(1).padStart(5);
      inputs.get('twa')!.value = String(Math.round(state.twa));
      if (state.auto) {
        inputs.get('main')!.value = String(Math.round((t[K.mainSheet] ?? 0) / DEG));
        inputs.get('jib')!.value = String(Math.round((t[K.jibSheet] ?? 0) / DEG));
      }
      stats.textContent = [
        `${POINT_OF_SAIL_LABEL[pointOfSail(t[K.twa] ?? 0)]}  ${state.mode}${t[K.lightAir] ? '  light-air assist' : ''}`,
        `TWS ${kn(K.tws)} kn  TWA ${deg(K.twa)}`,
        `AWS ${kn(K.aws)} kn  AWA ${deg(K.awa)}`,
        `boat ${(boatSpeed() / KNOT).toFixed(2)} kn  target ${kn(K.targetSpeed)}  heel ${deg(K.heel)}`,
        `boom ${deg(K.boomAngle)} ideal ${deg(K.idealBoomAngle)}`,
        `jib  ${deg(K.jibAngle)} ideal ${deg(K.idealJibAngle)}`,
        `main α ${deg(K.mainAlpha)} CL ${(t[K.mainCl] ?? 0).toFixed(2)} CD ${(t[K.mainCd] ?? 0).toFixed(2)} ${trimStateOf(t[K.mainTrim] ?? 0)}`,
        `jib  α ${deg(K.jibAlpha)} CL ${(t[K.jibCl] ?? 0).toFixed(2)} CD ${(t[K.jibCd] ?? 0).toFixed(2)} ${trimStateOf(t[K.jibTrim] ?? 0)}`,
        `luff main ${(t[K.mainLuff] ?? 0).toFixed(2)} jib ${(t[K.jibLuff] ?? 0).toFixed(2)}`,
        `telltales jW ${(t[K.telltaleJibWindward] ?? 0).toFixed(2)} jL ${(t[K.telltaleJibLeeward] ?? 0).toFixed(2)} mL ${(t[K.telltaleMainLeech] ?? 0).toFixed(2)}`,
        `drive ${(t[K.drive] ?? 0).toFixed(0)} N  side ${(t[K.side] ?? 0).toFixed(0)} N`,
        `heel M ${((t[K.heelMoment] ?? 0) / 1000).toFixed(1)} kNm  yaw M ${((t[K.yawMoment] ?? 0) / 1000).toFixed(1)} kNm`,
        `area main ${(t[K.mainArea] ?? 0).toFixed(1)} jib ${(t[K.jibArea] ?? 0).toFixed(1)} m²  reef ${t[K.reef]}`,
        `gybes ${t[K.gybes]}  slams ${t[K.boomSlams]} (${(t[K.boomSlam] ?? 0).toFixed(1)} rad/s)${t[K.gybeDanger] ? '  GYBE DANGER' : ''}${t[K.inIrons] ? '  IN IRONS' : ''}`,
        `cloth ${clothMs.toFixed(2)} ms  ${state.quality} (${view.mainCloth.cols}×${view.mainCloth.rows})`,
      ].join('\n');
    }
  });
}

void main();
