// Sky lab (dev only, /dev/sky-lab.html): the atmosphere, sun/moon light, environment probe and
// exposure on a dark plane with test spheres and distant pillars (for aerial perspective).
//
// URL parameters (all optional): preset=noon|afternoon|sunset|twilight|fullmoon|moonless,
// elevation, azimuth (sun, degrees; azimuth clockwise from north), moonElevation, moonAzimuth,
// phase (moon phase angle, degrees, 0 = full), haze, overcast, ev (manual EV100), bias (EV),
// tone=agx|aces|neutral, purkinje=0|1, view (camera azimuth), pitch, fov, lat, lst, ui=0, quality.

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BoxGeometry,
  Matrix3,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderPipeline,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';

import type { QualityPreset } from '../app/Scenario';
import { EnvironmentProbe } from '../render/lighting/EnvironmentProbe';
import { Exposure, type ToneMappingMode } from '../render/lighting/Exposure';
import { SunMoonLight } from '../render/lighting/SunMoonLight';
import { Renderer } from '../render/Renderer';
import { moonIlluminanceToa } from '../render/sky/atmosphereParams';
import { SkySystem } from '../render/sky/SkySystem';
import { equatorialToWorld } from '../render/sky/stars';
import { tsl } from '../render/tsl';

const DEG = Math.PI / 180;

interface LabParams {
  elevation: number;
  azimuth: number;
  moonElevation: number;
  moonAzimuth: number;
  phase: number;
  haze: number;
  overcast: number;
  manual: boolean;
  ev: number;
  bias: number;
  tone: ToneMappingMode;
  purkinje: boolean;
  view: number;
  pitch: number;
  fov: number;
  lat: number;
  lst: number;
}

const PRESETS: Record<string, Partial<LabParams>> = {
  noon: { elevation: 65, azimuth: 180, moonElevation: -30, view: 200, pitch: 12 },
  afternoon: { elevation: 30, azimuth: 235, moonElevation: -30, view: 235, pitch: 8 },
  sunset: { elevation: 2, azimuth: 290, moonElevation: -30, view: 290, pitch: 4 },
  twilight: { elevation: -4, azimuth: 295, moonElevation: -30, view: 295, pitch: 6 },
  fullmoon: {
    elevation: -35,
    azimuth: 340,
    moonElevation: 28,
    moonAzimuth: 140,
    phase: 8,
    view: 140,
    pitch: 12,
  },
  moonless: {
    elevation: -35,
    azimuth: 340,
    moonElevation: -40,
    moonAzimuth: 160,
    phase: 170,
    view: 20,
    pitch: 25,
  },
};

const DEFAULTS: LabParams = {
  elevation: 30,
  azimuth: 235,
  moonElevation: -30,
  moonAzimuth: 120,
  phase: 30,
  haze: 1,
  overcast: 0,
  manual: false,
  ev: 14,
  bias: 0,
  tone: 'agx',
  purkinje: true,
  view: 235,
  pitch: 8,
  fov: 60,
  lat: 35,
  lst: 0,
};

function readParams(): { params: LabParams; ui: boolean; quality: QualityPreset } {
  const query = new URLSearchParams(window.location.search);
  const params: LabParams = { ...DEFAULTS, ...PRESETS[query.get('preset') ?? ''] };
  const numeric: (keyof LabParams)[] = [
    'elevation',
    'azimuth',
    'moonElevation',
    'moonAzimuth',
    'phase',
    'haze',
    'overcast',
    'bias',
    'view',
    'pitch',
    'fov',
    'lat',
    'lst',
  ];
  for (const key of numeric) {
    const value = Number.parseFloat(query.get(key) ?? '');
    if (Number.isFinite(value)) (params[key] as number) = value;
  }
  const ev = Number.parseFloat(query.get('ev') ?? '');
  if (Number.isFinite(ev)) {
    params.manual = true;
    params.ev = ev;
  }
  const tone = query.get('tone');
  if (tone === 'agx' || tone === 'aces' || tone === 'neutral') params.tone = tone;
  if (query.get('purkinje') === '0') params.purkinje = false;
  const q = query.get('quality');
  const quality: QualityPreset = q === 'low' || q === 'medium' || q === 'ultra' ? q : 'high';
  return { params, ui: query.get('ui') !== '0', quality };
}

// Direction from elevation/azimuth in degrees (azimuth clockwise from north = −Z).
const direction = (elevation: number, azimuth: number, out = new Vector3()): Vector3 =>
  out.set(
    Math.sin(azimuth * DEG) * Math.cos(elevation * DEG),
    Math.sin(elevation * DEG),
    -Math.cos(azimuth * DEG) * Math.cos(elevation * DEG),
  );

function buildScene(scene: Scene): void {
  const ground = new Mesh(
    new PlaneGeometry(4000, 4000),
    new MeshStandardNodeMaterial({ color: 0x0b1014, roughness: 0.85, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const sphere = new SphereGeometry(1, 96, 48);
  const materials = [
    new MeshStandardNodeMaterial({ color: 0xf2f2f2, roughness: 0.9, metalness: 0 }), // white diffuse
    new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.12, metalness: 1 }), // polished metal
    new MeshStandardNodeMaterial({ color: 0x7a7a7a, roughness: 0.55, metalness: 0 }), // rough grey
    new MeshStandardNodeMaterial({ color: 0xe8c39a, roughness: 0.35, metalness: 1 }), // brushed gold
  ];
  materials.forEach((material, i) => {
    const mesh = new Mesh(sphere, material);
    mesh.position.set((i - 1.5) * 2.6, 1, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
  });

  // Distant pillars along several bearings to show aerial perspective (kept off the preset sun
  // azimuths so they never hide the disk).
  const pillar = new BoxGeometry(1, 1, 1);
  pillar.translate(0, 0.5, 0);
  const pillarMaterial = new MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.8 });
  for (const [distance, bearing] of [
    [300, 35],
    [1500, 50],
    [5000, 65],
    [15000, 75],
    [40000, 85],
  ] as const) {
    for (let k = 0; k < 4; k++) {
      const mesh = new Mesh(pillar, pillarMaterial);
      const b = (bearing + k * 90) * DEG;
      mesh.position.set(Math.sin(b) * distance, 0, -Math.cos(b) * distance);
      mesh.scale.set(distance * 0.01, distance * 0.04, distance * 0.01);
      mesh.castShadow = distance < 400;
      scene.add(mesh);
    }
  }
}

async function main(): Promise<void> {
  const container = document.querySelector<HTMLElement>('#view');
  const panel = document.querySelector<HTMLElement>('#panel');
  const controlsRoot = document.querySelector<HTMLElement>('#controls');
  const presetsRoot = document.querySelector<HTMLElement>('#presets');
  const readout = document.querySelector<HTMLElement>('#readout');
  if (!container || !panel || !controlsRoot || !presetsRoot || !readout) throw new Error('sky-lab markup');
  const { params, ui, quality } = readParams();
  if (!ui) panel.classList.add('hidden');

  const renderer = await Renderer.create({ container, renderScale: 1 });
  const three = renderer.three;
  three.shadowMap.enabled = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 1, 0.1, 60_000);
  renderer.onResize((width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  buildScene(scene);

  const sky = new SkySystem(three, { quality });
  sky.applyTo(scene);
  (scene as Scene & { fogNode: unknown }).fogNode = sky.createFogNode();
  const exposure = new Exposure({ toneMapping: params.tone });
  exposure.applyToneMapping(three);
  const light = new SunMoonLight(scene);
  const probe = new EnvironmentProbe(three, sky);
  probe.attach(scene);

  const pipeline = new RenderPipeline(three);
  const scenePass = tsl.pass(scene, camera);
  pipeline.outputNode = exposure.createOutputNode(scenePass);
  exposure.setMeasureSource(scenePass.getTexture('output'));

  const target = new Vector3(0, 1, 0);
  const controls = new OrbitControls(camera, three.domElement);
  const placeCamera = (): void => {
    const view = direction(0, params.view);
    // Camera 10 m behind the spheres at eye height 2.2 m, pitched up by `pitch` degrees.
    camera.position.set(-view.x * 10, 2.2, -view.z * 10);
    camera.fov = params.fov;
    camera.updateProjectionMatrix();
    controls.target.set(0, 2.2 + Math.tan(params.pitch * DEG) * 10, 0);
    controls.update();
  };
  placeCamera();

  const sunDir = new Vector3();
  const moonDir = new Vector3();
  const apply = (): void => {
    sky.setSun(direction(params.elevation, params.azimuth, sunDir));
    const phase = params.phase * DEG;
    sky.setMoon(
      direction(params.moonElevation, params.moonAzimuth, moonDir),
      (1 + Math.cos(phase)) / 2,
      phase,
    );
    sky.setAtmosphere({ hazeDensity: params.haze, overcast: params.overcast });
    const rotation = new Matrix3()
      .fromArray(equatorialToWorld(params.lat * DEG, params.lst * DEG))
      .transpose();
    sky.setCelestialRotation(rotation);
    exposure.settings.mode = params.manual ? 'manual' : 'auto';
    exposure.settings.manualEv100 = params.ev;
    exposure.settings.compensation = params.bias;
    exposure.setPurkinje(params.purkinje);
    if (exposure.toneMapping !== params.tone) exposure.setToneMapping(three, params.tone);
    exposure.snap();
  };
  apply();

  // --- Controls ---------------------------------------------------------------------------------
  const outputs = new Map<keyof LabParams, () => void>();
  const slider = (label: string, key: keyof LabParams, min: number, max: number, step: number): void => {
    const row = document.createElement('label');
    row.className = 'row';
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
    const out = document.createElement('output');
    const sync = (): void => {
      input.value = String(params[key]);
      out.textContent = String(params[key]);
    };
    input.addEventListener('input', () => {
      (params[key] as number) = Number.parseFloat(input.value);
      out.textContent = input.value;
      if (key === 'view' || key === 'pitch' || key === 'fov') placeCamera();
      apply();
    });
    row.append(label, input, out);
    controlsRoot.append(row);
    outputs.set(key, sync);
    sync();
  };
  const heading = (text: string): void => {
    const h = document.createElement('h2');
    h.textContent = text;
    controlsRoot.append(h);
  };
  const choice = (
    label: string,
    options: string[],
    get: () => string,
    set: (value: string) => void,
  ): void => {
    const row = document.createElement('label');
    row.className = 'row';
    const select = document.createElement('select');
    for (const option of options) select.add(new Option(option, option));
    select.value = get();
    select.addEventListener('change', () => {
      set(select.value);
      apply();
    });
    row.append(label, select, document.createElement('span'));
    controlsRoot.append(row);
  };

  heading('Sun');
  slider('elevation', 'elevation', -20, 90, 0.5);
  slider('azimuth', 'azimuth', 0, 360, 1);
  heading('Moon');
  slider('elevation', 'moonElevation', -30, 90, 0.5);
  slider('azimuth', 'moonAzimuth', 0, 360, 1);
  slider('phase angle', 'phase', 0, 180, 1);
  heading('Atmosphere');
  slider('haze', 'haze', 0, 10, 0.1);
  slider('overcast', 'overcast', 0, 1, 0.01);
  slider('sidereal', 'lst', 0, 360, 1);
  heading('Exposure');
  choice(
    'mode',
    ['auto', 'manual'],
    () => (params.manual ? 'manual' : 'auto'),
    (v) => (params.manual = v === 'manual'),
  );
  slider('manual EV', 'ev', -6, 17, 0.25);
  slider('bias EV', 'bias', -4, 4, 0.1);
  choice(
    'tone map',
    ['agx', 'aces', 'neutral'],
    () => params.tone,
    (v) => (params.tone = v as ToneMappingMode),
  );
  choice(
    'purkinje',
    ['on', 'off'],
    () => (params.purkinje ? 'on' : 'off'),
    (v) => (params.purkinje = v === 'on'),
  );
  heading('Camera');
  slider('view az', 'view', 0, 360, 1);
  slider('pitch', 'pitch', -10, 80, 1);
  slider('fov', 'fov', 10, 100, 1);

  for (const name of Object.keys(PRESETS)) {
    const button = document.createElement('button');
    button.textContent = name;
    button.addEventListener('click', () => {
      Object.assign(params, DEFAULTS, PRESETS[name]);
      for (const sync of outputs.values()) sync();
      placeCamera();
      apply();
    });
    presetsRoot.append(button);
  }

  // --- Loop -------------------------------------------------------------------------------------
  let last = performance.now();
  let computeMs = 0;
  let renderMs = 0;
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  const startTime = last;
  void three.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    exposure.update(three, {
      dt,
      sunElevation: sky.sunElevation,
      moonElevation: sky.moonElevation,
      moonIlluminance: moonIlluminanceToa(params.phase * DEG),
      overcast: params.overcast,
    });
    sky.setPreExposure(exposure.preExposure);
    sky.update(three, camera);
    light.update(sky, exposure.preExposure, target);
    probe.update(three, (now - startTime) / 1000, exposure.preExposure);
    pipeline.render();

    void three.resolveTimestampsAsync('compute').then((ms) => {
      if (typeof ms === 'number') computeMs = computeMs * 0.9 + ms * 0.1;
    });
    void three.resolveTimestampsAsync('render').then((ms) => {
      if (typeof ms === 'number') renderMs = renderMs * 0.9 + ms * 0.1;
    });
    frames++;
    if (now - fpsTime > 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const sun = sky.sunIlluminance();
      const moon = sky.moonIlluminance();
      const lum = (c: { r: number; g: number; b: number }): number =>
        0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      readout.textContent = [
        `EV100        ${exposure.ev100.toFixed(2)}  (metered ${exposure.meteredEv100.toFixed(2)})`,
        `pre-exposure ${exposure.preExposure.toExponential(3)}`,
        `sun direct   ${lum(sun).toPrecision(4)} lx  rgb ${[sun.r, sun.g, sun.b].map((v) => v.toPrecision(3)).join(' ')}`,
        `moon direct  ${lum(moon).toPrecision(3)} lx`,
        `light        ${light.source} ${light.illuminanceLux.toPrecision(3)} lx`,
        `probe faces  ${probe.plan.faces.join(',') || '-'}${probe.plan.convolve ? ' +pmrem' : ''}`,
        `GPU compute  ${computeMs.toFixed(3)} ms`,
        `GPU render   ${renderMs.toFixed(3)} ms`,
        `fps          ${fps.toFixed(0)}`,
      ].join('\n');
    }
  });

  // Handle for the DevTools console and screenshot scripts.
  (window as unknown as { skyLab: unknown }).skyLab = {
    sky,
    exposure,
    light,
    probe,
    params,
    apply,
    placeCamera,
    scene,
    three,
    camera,
  };
}

void main();
