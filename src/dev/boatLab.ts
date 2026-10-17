// Boat lab (dev only, /dev/boat-lab.html): one procedural vessel on an ocean-free stage under the
// physically based sky, with orbit controls, time of day, LOD, wireframe and light switches.
//
// URL parameters (all optional): boat=cargo|cruise|crab|…, time=HH:MM (local solar time),
// cam=orbit|helm|wing|chase|bow|stern|side|waterline|top|detail, lod=0|1|2, water=0 (hide the
// waterline plane), floods=0|1, wipers=1, wire=1, ui=0, quality=low|medium|high|ultra, lat (deg).
// Small-craft animation (synthetic telemetry): steer=−1..1, trim=0..1, throttle=−1..1, boom (deg),
// bucket=0..3, lean=−1..1. The sailboat also gets its cloth sails. Surface-detail textures load as in
// the game (Medium quality and up); detail=0 shows the procedural-only look for comparison.

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  type Material,
  Mesh,
  MeshStandardNodeMaterial,
  type Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RenderPipeline,
  Scene,
  Vector3,
} from 'three/webgpu';

import { LoadingManager } from '../app/loading/LoadingManager';
import type { QualityPreset } from '../app/Scenario';
import { createBoatVisual, loadBoatDrafts } from '../render/boats/createBoatVisual';
import { preloadBoatDetail } from '../render/boats/detail/preload';
import { BoatVisual } from '../render/boats/kit/BoatVisual';
import { nightFactor, setBoatEnvironment } from '../render/boats/kit/environment';
import { SailView } from '../render/boats/SailView';
import { EnvironmentProbe } from '../render/lighting/EnvironmentProbe';
import { Exposure } from '../render/lighting/Exposure';
import { SunMoonLight } from '../render/lighting/SunMoonLight';
import { Renderer } from '../render/Renderer';
import { moonIlluminanceToa } from '../render/sky/atmosphereParams';
import { SkySystem } from '../render/sky/SkySystem';
import { tsl } from '../render/tsl';
import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';

const DEG = Math.PI / 180;
const CAMS = [
  'orbit',
  'helm',
  'wing',
  'chase',
  'bow',
  'stern',
  'side',
  'waterline',
  'top',
  'detail',
] as const;
type Cam = (typeof CAMS)[number];

const query = new URLSearchParams(window.location.search);
const state = {
  boat: (BOAT_KINDS as readonly string[]).includes(query.get('boat') ?? '')
    ? (query.get('boat') as BoatKind)
    : 'cargo',
  hours: parseTime(query.get('time') ?? '10:30'),
  lat: Number.parseFloat(query.get('lat') ?? '40') || 40,
  cam: (CAMS as readonly string[]).includes(query.get('cam') ?? '') ? (query.get('cam') as Cam) : 'orbit',
  lod: query.has('lod') ? Number(query.get('lod')) : -1,
  water: query.get('water') !== '0',
  floods: query.get('floods') === '1' ? 1 : query.get('floods') === '0' ? 0 : -1,
  wipers: query.get('wipers') === '1',
  wire: query.get('wire') === '1',
  steer: Number(query.get('steer') ?? 0) || 0,
  trim: Number(query.get('trim') ?? 0.3) || 0,
  throttle: Number(query.get('throttle') ?? 0) || 0,
  boom: Number(query.get('boom') ?? 0) || 0,
  bucket: Number(query.get('bucket') ?? 0) || 0,
  lean: Number(query.get('lean') ?? 0) || 0,
};

// Telemetry the small craft animate from, synthesised from the lab sliders.
function labTelemetry(): Record<string, number> {
  const side = state.boom >= 0 ? 1 : -1;
  return {
    rudderAngle: state.steer * 35 * DEG,
    steering: state.steer * 30 * DEG,
    nozzle: state.steer * 20 * DEG,
    eng0Trim: state.trim,
    eng1Trim: state.trim,
    outboardTrim: state.trim,
    eng0Throttle: state.throttle,
    eng1Throttle: state.throttle,
    eng0Rpm: Math.abs(state.throttle) * 5800,
    eng1Rpm: Math.abs(state.throttle) * 5800,
    bucket: state.bucket,
    riderLean: state.lean,
    'sail.boomAngle': state.boom * DEG,
    'sail.jibAngle': side * 14 * DEG,
    'sail.jibClewX': side * 1.15,
    'sail.jibClewY': 1.75,
    'sail.jibClewZ': 0.35,
  };
}

function parseTime(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return Number.isFinite(h) ? (h ?? 0) + (Number.isFinite(m) ? (m ?? 0) / 60 : 0) : 10.5;
}

// Solar geometry for lab lighting: fixed declination +15°, local solar time.
function sunAt(hours: number, latDeg: number): { elevation: number; azimuth: number } {
  const dec = 15 * DEG;
  const lat = latDeg * DEG;
  const h = (hours - 12) * 15 * DEG;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h);
  const el = Math.asin(sinEl);
  const az = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI;
  return { elevation: el, azimuth: az };
}

const dirFrom = (elevation: number, azimuth: number, out = new Vector3()): Vector3 =>
  out.set(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    -Math.cos(azimuth) * Math.cos(elevation),
  );

async function main(): Promise<void> {
  const container = document.querySelector<HTMLElement>('#view')!;
  const panel = document.querySelector<HTMLElement>('#panel')!;
  const controlsRoot = document.querySelector<HTMLElement>('#controls')!;
  const camsRoot = document.querySelector<HTMLElement>('#cams')!;
  const readout = document.querySelector<HTMLElement>('#readout')!;
  if (query.get('ui') === '0') panel.classList.add('hidden');
  const q = query.get('quality');
  const quality: QualityPreset = q === 'low' || q === 'medium' || q === 'ultra' ? q : 'high';

  const renderer = await Renderer.create({ container, renderScale: 1 });
  const three = renderer.three;
  three.shadowMap.enabled = true;
  await preloadBoatDetail(
    BOAT_KINDS,
    query.get('detail') === '0' ? 'low' : quality,
    three,
    new LoadingManager(),
  );
  await loadBoatDrafts(); // the model builders, so the lab can build visuals synchronously
  const scene = new Scene();
  const camera = new PerspectiveCamera(55, 1, 0.1, 60_000);
  renderer.onResize((w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });
  const sky = new SkySystem(three, { quality });
  sky.applyTo(scene);
  (scene as Scene & { fogNode: unknown }).fogNode = sky.createFogNode();
  const exposure = new Exposure();
  exposure.applyToneMapping(three);
  const light = new SunMoonLight(scene);
  const probe = new EnvironmentProbe(three, sky);
  probe.attach(scene);
  const pipeline = new RenderPipeline(three);
  const scenePass = tsl.pass(scene, camera);
  pipeline.outputNode = exposure.createOutputNode(scenePass);
  exposure.setMeasureSource(scenePass.getTexture('output'));

  const water = new Mesh(
    new PlaneGeometry(20000, 20000),
    new MeshStandardNodeMaterial({ color: 0x06141c, roughness: 0.12, metalness: 0 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.receiveShadow = true;
  scene.add(water);

  const controls = new OrbitControls(camera, three.domElement);
  controls.enableDamping = true;

  let visual: BoatVisual | null = null;
  let root: Object3D | null = null;
  let sails: SailView | null = null;
  let buildMs = 0;
  const load = (): void => {
    root?.removeFromParent();
    sails?.dispose();
    sails = null;
    const t0 = performance.now();
    const made = createBoatVisual(state.boat);
    buildMs = performance.now() - t0;
    visual = made instanceof BoatVisual ? made : null;
    root = made instanceof BoatVisual ? made.root : made;
    scene.add(root);
    if (state.boat === 'sail') sails = new SailView({ parent: root, quality, showRig: !visual });
    visual?.enableFloodLights(3);
    visual?.setLod(state.lod >= 0 ? state.lod : null);
    applyWire();
    placeCamera();
  };

  const applyWire = (): void => {
    root?.traverse((o) => {
      const m = (o as Mesh).material as Material | undefined;
      if (m && 'wireframe' in m) (m as Material & { wireframe: boolean }).wireframe = state.wire;
    });
  };

  const placeCamera = (): void => {
    const L = visual?.template.length ?? 40;
    const eye = visual?.eye ?? new Vector3(0, 4, 0);
    const set = (p: [number, number, number], t: [number, number, number], fov = 55): void => {
      camera.position.set(...p);
      controls.target.set(...t);
      camera.fov = fov;
      camera.updateProjectionMatrix();
      controls.update();
    };
    switch (state.cam) {
      case 'helm':
        // Slightly below the horizon, as a helmsman looks over the bow.
        set([eye.x, eye.y, eye.z], [eye.x, eye.y - 7, eye.z - 60], 65);
        break;
      case 'wing': {
        const w = visual?.wingEyes?.starboard ?? eye;
        set([w.x, w.y, w.z], [w.x - 6, w.y - 6, w.z - 60], 65);
        break;
      }
      case 'chase':
        set([0, 0.2 * L, 0.95 * L], [0, 0.06 * L, 0]);
        break;
      case 'bow':
        set([0.3 * L, 0.07 * L, -0.8 * L], [0, 0.06 * L, -0.25 * L]);
        break;
      case 'stern':
        set([-0.35 * L, 0.1 * L, 0.75 * L], [0, 0.06 * L, 0.25 * L]);
        break;
      case 'side':
        set([1.1 * L, 0.08 * L, 0], [0, 0.07 * L, 0], 45);
        break;
      case 'waterline':
        set([0.3 * L, Math.max(1, 0.01 * L), -0.35 * L], [0, 0.04 * L, 0]);
        break;
      case 'top':
        set([0.001, 1.2 * L, 0.05 * L], [0, 0, 0]);
        break;
      case 'detail':
        set([0.09 * L, eye.y + 0.02 * L, eye.z - 0.12 * L], [0, eye.y - 0.03 * L, eye.z - 0.02 * L]);
        break;
      default:
        set([0.55 * L, 0.22 * L, -0.55 * L], [0, 0.06 * L, 0]);
    }
  };

  // --- UI -----------------------------------------------------------------------------------------
  const row = (label: string, el: HTMLElement, out?: HTMLElement): void => {
    const r = document.createElement('label');
    r.className = 'row';
    r.append(label, el, out ?? document.createElement('span'));
    controlsRoot.append(r);
  };
  const select = (label: string, options: string[], value: string, onChange: (v: string) => void): void => {
    const s = document.createElement('select');
    for (const o of options) s.add(new Option(o, o));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    row(label, s);
  };
  const check = (label: string, value: boolean, onChange: (v: boolean) => void): void => {
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = value;
    c.addEventListener('change', () => onChange(c.checked));
    row(label, c);
  };
  select('boat', [...BOAT_KINDS], state.boat, (v) => {
    state.boat = v as BoatKind;
    load();
  });
  const time = document.createElement('input');
  Object.assign(time, { type: 'range', min: '0', max: '24', step: '0.05', value: String(state.hours) });
  const timeOut = document.createElement('output');
  time.addEventListener('input', () => (state.hours = Number(time.value)));
  row('time', time, timeOut);
  select('LOD', ['auto', '0', '1', '2'], state.lod < 0 ? 'auto' : String(state.lod), (v) => {
    state.lod = v === 'auto' ? -1 : Number(v);
    visual?.setLod(state.lod >= 0 ? state.lod : null);
  });
  select('floods', ['auto', 'on', 'off'], state.floods < 0 ? 'auto' : state.floods ? 'on' : 'off', (v) => {
    state.floods = v === 'auto' ? -1 : v === 'on' ? 1 : 0;
  });
  check('wireframe', state.wire, (v) => {
    state.wire = v;
    applyWire();
  });
  check('water', state.water, (v) => (state.water = v));
  check('wipers', state.wipers, (v) => (state.wipers = v));
  const slider = (
    label: string,
    key: 'steer' | 'trim' | 'throttle' | 'boom' | 'bucket' | 'lean',
    min: number,
    max: number,
    step: number,
  ): void => {
    const input = document.createElement('input');
    Object.assign(input, {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(state[key]),
    });
    const out = document.createElement('output');
    out.textContent = String(state[key]);
    input.addEventListener('input', () => {
      state[key] = Number(input.value);
      out.textContent = input.value;
    });
    row(label, input, out);
  };
  slider('steer', 'steer', -1, 1, 0.05);
  slider('trim', 'trim', 0, 1, 0.05);
  slider('throttle', 'throttle', -1, 1, 0.05);
  slider('boom°', 'boom', -85, 85, 1);
  slider('bucket', 'bucket', 0, 3, 1);
  slider('lean', 'lean', -1, 1, 0.05);
  for (const cam of CAMS) {
    const b = document.createElement('button');
    b.textContent = cam;
    b.addEventListener('click', () => {
      state.cam = cam;
      placeCamera();
    });
    camsRoot.append(b);
  }

  load();

  // --- Loop -------------------------------------------------------------------------------------
  const sunDir = new Vector3();
  const moonDir = new Vector3();
  const target = new Vector3();
  let last = performance.now();
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  const start = last;
  void three.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const sun = sunAt(state.hours, state.lat);
    sky.setSun(dirFrom(sun.elevation, sun.azimuth, sunDir));
    // Moon roughly opposite the sun, a few days off full.
    sky.setMoon(dirFrom(-sun.elevation * 0.8 + 0.1, sun.azimuth + Math.PI * 0.9, moonDir), 0.85, 0.6);
    const night = nightFactor(sun.elevation);
    water.visible = state.water;
    exposure.update(three, {
      dt,
      sunElevation: sky.sunElevation,
      moonElevation: sky.moonElevation,
      moonIlluminance: moonIlluminanceToa(0.6),
      overcast: 0,
    });
    const pre = exposure.preExposure;
    setBoatEnvironment({
      preExposure: pre,
      night,
      deck: state.floods < 0 ? (night > 0.5 ? 1 : 0) : state.floods,
    });
    sky.setPreExposure(pre);
    sky.update(three, camera);
    light.update(sky, pre, target);
    const telemetry = labTelemetry();
    if (visual) {
      visual.wipersOn = state.wipers;
      visual.update(dt, camera, three.domElement.height, telemetry);
    }
    if (sails && root) sails.update(dt, telemetry, root.quaternion, (now - start) / 1000);
    controls.update();
    probe.update(three, (now - start) / 1000, pre);
    pipeline.render();
    frames++;
    if (now - fpsTime > 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const h = Math.floor(state.hours);
      const m = Math.round((state.hours - h) * 60);
      timeOut.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const tris = visual?.template.triangles ?? [];
      readout.textContent = [
        `${visual?.template.name ?? state.boat}`,
        `LOD ${visual?.lod ?? '-'}  tris ${tris.map((t) => (t / 1000).toFixed(1) + 'k').join(' / ')}`,
        `draw calls ${three.info.render.drawCalls}`,
        `build ${buildMs.toFixed(0)} ms  sun ${(sun.elevation / DEG).toFixed(1)}°  night ${night.toFixed(2)}`,
        `fps ${fps.toFixed(0)}`,
      ].join('\n');
    }
  });

  (window as unknown as { boatLab: unknown }).boatLab = {
    state,
    scene,
    camera,
    controls,
    three,
    get visual() {
      return visual;
    },
    placeCamera,
    load,
  };
}

void main();
