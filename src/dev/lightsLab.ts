// Dev-only lights lab (/dev/lights-lab.html): the six boats as box hulls of real size with their
// default light mounts, on a flat dark sea under the physical sky (SkySystem + auto-exposure + the
// game's bloom pipeline). The camera sits at a relative bearing and distance from the selected boat
// (50 m … 6 nm) to check arcs, cut-offs, pinpoint sizes and day/night visibility; drag to orbit.
// URL parameters (for screenshots):
//   ?boat=crab &bearing=30 (deg from the bow, + starboard) &dist=3704 (m) | &nm=2 &eye=3 (m) &fov=40
//   &sun=-12 (deg) &nav=auto|on|off &deck=auto|on|off &extra=auto|on|off &cabin=auto|0..1 &fishing=1
//   &nuc=1 &anchor=1 &ram=1 &tricolour=1 &making=0 &fleet=1 (all six in a row) &quality=high
//   &aa=traa|smaa|fxaa|off &bloom=0 &haze=1 &vis=20000 (m) &lens=0 &hud=0

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
} from 'three/webgpu';

import { QUALITY_PRESETS, type QualityPreset } from '../app/Scenario';
import { type AutoSwitch, BoatLights, type BoatLightState } from '../render/boats/lights/BoatLights';
import { NAUTICAL_MILE, type NavSignals, visibility } from '../render/boats/lights/colregs';
import { mountLight } from '../render/boats/lights/mounts';
import { EnvironmentProbe } from '../render/lighting/EnvironmentProbe';
import { Exposure } from '../render/lighting/Exposure';
import { SunMoonLight } from '../render/lighting/SunMoonLight';
import { PostPipeline } from '../render/post/PostPipeline';
import type { AntiAliasingMode } from '../render/post/postSettings';
import { Renderer } from '../render/Renderer';
import { SkySystem } from '../render/sky/SkySystem';
import { tsl } from '../render/tsl';
import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';

const { float, fract, positionLocal, step, vec3 } = tsl;
const DEG = Math.PI / 180;
const MIN_DIST = 50;
const MAX_DIST = 6 * NAUTICAL_MILE;

const query = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const value = query.get(key);
  return value === null || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);
};
const flag = (key: string): boolean => query.get(key) === '1' || query.get(key) === 'true';
const auto = (key: string): AutoSwitch => {
  const value = query.get(key);
  return value === 'on' || value === '1' ? true : value === 'off' || value === '0' ? false : 'auto';
};

const params = {
  boat: (BOAT_KINDS as readonly string[]).includes(query.get('boat') ?? '')
    ? (query.get('boat') as BoatKind)
    : ('crab' as BoatKind),
  bearing: num('bearing', 35),
  dist: query.has('nm') ? num('nm', 1) * NAUTICAL_MILE : num('dist', 120),
  eye: num('eye', 3),
  fov: num('fov', 40),
  sun: num('sun', -14),
  haze: num('haze', 1),
  vis: num('vis', 40_000),
  fleet: flag('fleet'),
  quality: (QUALITY_PRESETS as readonly string[]).includes(query.get('quality') ?? '')
    ? (query.get('quality') as QualityPreset)
    : ('high' as QualityPreset),
};
const state: BoatLightState = {
  nav: auto('nav'),
  deck: auto('deck'),
  extra: auto('extra'),
  cabin: query.has('cabin') && query.get('cabin') !== 'auto' ? num('cabin', 1) : 'auto',
  makingWay: query.get('making') !== '0',
  signals: {
    fishing: flag('fishing'),
    nuc: flag('nuc'),
    anchor: flag('anchor'),
    ram: flag('ram'),
    tricolour: flag('tricolour'),
  },
};
if (query.get('hud') === '0') document.body.classList.add('clean');

// --- Box hulls ---------------------------------------------------------------------------------
// [x half-width, yBottom, yTop, zFront, zBack, x offset]
type Block = [number, number, number, number, number, number?];
const BLOCKS: Record<BoatKind, Block[]> = {
  cargo: [
    [16.1, -10.8, 8.2, -121.25, 122.25],
    [10, 8.2, 10.7, -121, -109],
    [15, 8.2, 23.8, -95, 55],
    [13, 8.2, 34, 58, 78],
    [16.1, 32, 34, 60, 64],
    [0.5, 10.7, 43, -100.5, -99.5],
    [0.75, 34, 51.5, 65.5, 68],
    [5, 30, 40, 85, 95],
  ],
  cruise: [
    [18.4, -8.3, 5.7, -158.5, 158.7],
    [18, 5.7, 44, -140, 140],
    [18.4, 30, 34, -132, -126],
    [0.5, 44, 47, -135.5, -134.5],
    [0.75, 44, 56, -21, -19],
    [5, 44, 58, 40, 60],
  ],
  crab: [
    [4.4, -4, 1, -20.1, 18],
    [3.5, 1, 2.6, -20, -9],
    [3.3, 2.6, 7.8, -14, -6.5],
    [0.15, 7.8, 14.6, -11.8, -11.2],
    [0.15, 1, 6, 15.5, 16.5, 3],
    [0.15, 1, 6, 15.5, 16.5, -3],
    [3.2, 5.5, 6, 15.5, 16.5],
  ],
  sail: [
    [1.82, -0.5, 1.05, -5.9, 5.6],
    [0.08, -2, -0.5, -0.8, 0.3],
    [1.1, 1.05, 1.5, -2.8, 1.6],
    [0.1, 1.05, 16.65, -1.2, -1.0],
    [0.05, 1.9, 2.05, -1.1, 4.15],
  ],
  powerboat: [
    [1.6, -0.65, 1.0, -5.05, 5.05],
    [0.65, 1.0, 2.1, -1.1, 0.3],
    [0.03, 1.0, 2.75, 4.35, 4.45],
    [0.25, -0.6, 1.2, 5.05, 5.6, 0.5],
    [0.25, -0.6, 1.2, 5.05, 5.6, -0.5],
  ],
  pwc: [
    [0.62, -0.32, 0.3, -1.65, 1.65],
    [0.27, 0.3, 0.62, -0.35, 1.05],
    [0.015, 0.3, 1.25, 1.42, 1.48],
    [0.4, 0.6, 0.66, -0.62, -0.56],
  ],
  hydro: [
    [2.15, -0.27, 0.58, -4.7, 4.7],
    [0.5, 0.58, 1.17, -3.6, -1.7],
    [0.66, 0.58, 1.15, -1.7, 4.3],
    [0.025, 0.58, 1.64, 3.5, 4.8, 0.72],
    [0.025, 0.58, 1.64, 3.5, 4.8, -0.72],
    [1.5, 1.46, 1.54, 4.25, 4.93],
  ],
};
// Lit window bands on the superstructure sides: [x, yBottom, yTop, zFront, zBack].
const WINDOWS: Partial<Record<BoatKind, [number, number, number, number, number][]>> = {
  cargo: [[13.02, 10, 33, 58.5, 77.5]],
  cruise: [[18.02, 8, 42, -138, 138]],
  crab: [[3.32, 5.6, 7.4, -13.5, -7]],
  sail: [[1.12, 1.2, 1.4, -2.4, 0.8]],
};

const hullMaterial = new MeshStandardNodeMaterial({ color: 0xd9d4c8, roughness: 0.7 });
const darkMaterial = new MeshStandardNodeMaterial({ color: 0x2a3036, roughness: 0.6 });

function buildBoat(kind: BoatKind): Group {
  const group = new Group();
  group.name = `boat-${kind}`;
  BLOCKS[kind].forEach(([hw, y0, y1, z0, z1, x = 0], i) => {
    const mesh = new Mesh(new BoxGeometry(hw * 2, y1 - y0, z1 - z0), i === 0 ? hullMaterial : darkMaterial);
    mesh.position.set(x, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group;
}

function addWindows(group: Group, kind: BoatKind, lights: BoatLights): void {
  const bands = WINDOWS[kind];
  if (!bands) return;
  const material = new MeshStandardNodeMaterial({ color: 0x111418, roughness: 0.2 });
  // Window grid: 1.2 m pitch horizontally, 2.8 m decks.
  const p = positionLocal;
  const mask = step(fract(p.z.div(1.2)), float(0.55)).mul(step(fract(p.y.div(2.8)), float(0.4)));
  const c = lights.deck.cabinColour;
  material.emissiveNode = vec3(c.r, c.g, c.b).mul(mask).mul(lights.cabinGlowNode);
  for (const [x, y0, y1, z0, z1] of bands) {
    for (const side of [-1, 1]) {
      const mesh = new Mesh(new BoxGeometry(0.02, y1 - y0, z1 - z0), material);
      mesh.position.set(side * x, (y0 + y1) / 2, (z0 + z1) / 2);
      group.add(mesh);
    }
  }
}

// Direction for an elevation and azimuth (clockwise from north = −Z).
const direction = (elevationDeg: number, azimuthDeg: number, out = new Vector3()): Vector3 => {
  const e = elevationDeg * DEG;
  const a = azimuthDeg * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
};

async function main(): Promise<void> {
  const container = document.getElementById('view');
  const controlsRoot = document.getElementById('controls');
  const readout = document.getElementById('readout');
  if (!container || !controlsRoot || !readout) return;
  const renderer = await Renderer.create({ container, renderScale: 1 });
  const three = renderer.three;
  three.shadowMap.enabled = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(params.fov, 1, 0.1, 80_000);
  renderer.onResize((width, height) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });

  const sky = new SkySystem(three, { quality: params.quality });
  sky.applyTo(scene);
  scene.fogNode = sky.createFogNode();
  const exposure = new Exposure();
  exposure.applyToneMapping(three);
  const sun = new SunMoonLight(scene, { enabled: true, mapSize: 2048, cascades: 2, maxFar: 400 });
  const probe = new EnvironmentProbe(three, sky);
  probe.attach(scene);
  const aa = (query.get('aa') ?? 'traa') as AntiAliasingMode;
  const pipeline = new PostPipeline(three, scene, camera, exposure, {
    quality: params.quality,
    settings: { aa, bloom: query.get('bloom') !== '0' },
  });

  // A flat, glossy dark sea for spill and glints.
  const sea = new Mesh(
    new PlaneGeometry(200_000, 200_000),
    new MeshStandardNodeMaterial({ color: new Color(0.004, 0.012, 0.018), roughness: 0.14, metalness: 0 }),
  );
  sea.rotation.x = -Math.PI / 2;
  sea.receiveShadow = true;
  scene.add(sea);

  // Boats: a row abeam (fleet) or only the selected one at the origin.
  const boats = new Map<BoatKind, { group: Group; lights: BoatLights }>();
  for (const kind of BOAT_KINDS) {
    const group = buildBoat(kind);
    const lights = new BoatLights(group, {
      kind,
      quality: params.quality,
      lens: query.get('lens') !== '0',
    });
    lights.setState(state);
    addWindows(group, kind, lights);
    scene.add(group);
    boats.set(kind, { group, lights });
  }
  const layout = (): void => {
    let x = 0;
    for (const kind of BOAT_KINDS) {
      const boat = boats.get(kind);
      if (!boat) continue;
      boat.group.visible = params.fleet || kind === params.boat;
      boat.group.position.set(0, 0, 0);
    }
    if (!params.fleet) return;
    // Row along x, the selected boat at the origin.
    const order = [params.boat, ...BOAT_KINDS.filter((k) => k !== params.boat)];
    for (const kind of order) {
      const boat = boats.get(kind);
      if (!boat) continue;
      const beam = { cargo: 32, cruise: 37, crab: 9, sail: 4, powerboat: 3, pwc: 1.3, hydro: 4.3 }[kind];
      if (kind !== params.boat) x += beam / 2 + 25;
      boat.group.position.x = x;
      x += beam / 2;
    }
  };
  layout();

  const controls = new OrbitControls(camera, three.domElement);
  controls.maxDistance = 30_000;
  const focusHeight = (): number =>
    ({ cargo: 25, cruise: 30, crab: 6, sail: 6, powerboat: 1.5, pwc: 0.8, hydro: 1 })[params.boat];
  const placeCamera = (): void => {
    const b = params.bearing * DEG;
    camera.position.set(Math.sin(b) * params.dist, params.eye, -Math.cos(b) * params.dist);
    camera.fov = params.fov;
    camera.updateProjectionMatrix();
    controls.target.set(0, focusHeight(), 0);
    controls.update();
  };
  placeCamera();

  const sunDirection = new Vector3();
  const applySky = (): void => {
    sky.setSun(direction(params.sun, 250, sunDirection));
    sky.setMoon(direction(-30, 90), 0, Math.PI);
    sky.setAtmosphere({ hazeDensity: params.haze, overcast: 0 });
    exposure.snap();
  };
  applySky();
  const applyState = (): void => {
    for (const { lights } of boats.values()) lights.setState(state);
  };

  // --- Controls ----------------------------------------------------------------------------------
  const heading = (text: string): void => {
    const h = document.createElement('h2');
    h.textContent = text;
    controlsRoot.append(h);
  };
  const slider = (
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string = (v) => String(v),
  ): void => {
    const row = document.createElement('label');
    row.className = 'row';
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', min: String(min), max: String(max), step: String(step) });
    input.value = String(get());
    const out = document.createElement('output');
    out.textContent = format(get());
    input.addEventListener('input', () => {
      set(Number(input.value));
      out.textContent = format(get());
    });
    row.append(label, input, out);
    controlsRoot.append(row);
  };
  const select = (label: string, options: string[], get: () => string, set: (v: string) => void): void => {
    const row = document.createElement('label');
    row.className = 'row';
    const input = document.createElement('select');
    for (const option of options) input.add(new Option(option, option));
    input.value = get();
    input.addEventListener('change', () => set(input.value));
    row.append(label, input, document.createElement('span'));
    controlsRoot.append(row);
  };
  const checks = document.createElement('div');
  const check = (label: string, get: () => boolean, set: (v: boolean) => void): void => {
    const row = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = get();
    input.addEventListener('change', () => set(input.checked));
    row.append(input, label);
    checks.append(row);
  };
  const switchName = (s: AutoSwitch | number): string => (s === 'auto' ? 'auto' : s ? 'on' : 'off');
  const parseSwitch = (v: string): AutoSwitch => (v === 'auto' ? 'auto' : v === 'on');

  heading('Boat');
  select(
    'boat',
    [...BOAT_KINDS],
    () => params.boat,
    (v) => {
      params.boat = v as BoatKind;
      layout();
      placeCamera();
    },
  );
  checks.className = 'checks';
  controlsRoot.append(checks);
  check(
    'fleet row',
    () => params.fleet,
    (v) => {
      params.fleet = v;
      layout();
    },
  );
  heading('Lights');
  select(
    'nav',
    ['auto', 'on', 'off'],
    () => switchName(state.nav),
    (v) => {
      state.nav = parseSwitch(v);
      applyState();
    },
  );
  select(
    'deck',
    ['auto', 'on', 'off'],
    () => switchName(state.deck),
    (v) => {
      state.deck = parseSwitch(v);
      applyState();
    },
  );
  select(
    'extra',
    ['auto', 'on', 'off'],
    () => switchName(state.extra),
    (v) => {
      state.extra = parseSwitch(v);
      applyState();
    },
  );
  select(
    'cabin',
    ['auto', 'on', 'off'],
    () => switchName(state.cabin),
    (v) => {
      state.cabin = parseSwitch(v);
      applyState();
    },
  );
  const signalChecks = document.createElement('div');
  signalChecks.className = 'checks';
  controlsRoot.append(signalChecks);
  for (const key of ['fishing', 'nuc', 'anchor', 'ram', 'tricolour'] as (keyof NavSignals)[]) {
    const row = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state.signals[key] === true;
    input.addEventListener('change', () => {
      state.signals = { ...state.signals, [key]: input.checked };
      applyState();
    });
    row.append(input, key);
    signalChecks.append(row);
  }
  const makingRow = document.createElement('label');
  const making = document.createElement('input');
  making.type = 'checkbox';
  making.checked = state.makingWay;
  making.addEventListener('change', () => {
    state.makingWay = making.checked;
    applyState();
  });
  makingRow.append(making, 'making way');
  signalChecks.append(makingRow);

  heading('Camera');
  const toSlider = (d: number): number => (1000 * Math.log(d / MIN_DIST)) / Math.log(MAX_DIST / MIN_DIST);
  const fromSlider = (v: number): number => MIN_DIST * (MAX_DIST / MIN_DIST) ** (v / 1000);
  const formatDistance = (d: number): string =>
    d < 1000 ? `${d.toFixed(0)} m` : `${(d / NAUTICAL_MILE).toFixed(2)} nm`;
  slider(
    'distance',
    0,
    1000,
    1,
    () => toSlider(params.dist),
    (v) => {
      params.dist = fromSlider(v);
      placeCamera();
    },
    (v) => formatDistance(fromSlider(v)),
  );
  slider(
    'bearing',
    -180,
    180,
    0.5,
    () => params.bearing,
    (v) => {
      params.bearing = v;
      placeCamera();
    },
    (v) => `${v}°`,
  );
  slider(
    'eye height',
    0.5,
    60,
    0.5,
    () => params.eye,
    (v) => {
      params.eye = v;
      placeCamera();
    },
    (v) => `${v} m`,
  );
  slider(
    'fov',
    2,
    90,
    1,
    () => params.fov,
    (v) => {
      params.fov = v;
      placeCamera();
    },
    (v) => `${v}°`,
  );
  heading('Sky');
  slider(
    'sun elev',
    -20,
    60,
    0.5,
    () => params.sun,
    (v) => {
      params.sun = v;
      applySky();
    },
    (v) => `${v}°`,
  );
  slider(
    'haze',
    0,
    10,
    0.1,
    () => params.haze,
    (v) => {
      params.haze = v;
      applySky();
    },
  );
  slider(
    'visibility',
    200,
    40_000,
    100,
    () => params.vis,
    (v) => (params.vis = v),
    (v) => formatDistance(v),
  );

  // --- Loop --------------------------------------------------------------------------------------
  const target = new Vector3();
  const toCamera = new Vector3();
  const lightWorld = new Vector3();
  const inverse = new Group();
  let last = performance.now();
  let frames = 0;
  let fpsTime = last;
  let fps = 0;
  void three.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    exposure.update(three, {
      dt,
      sunElevation: sky.sunElevation,
      moonElevation: sky.moonElevation,
      moonIlluminance: 0,
      overcast: 0,
    });
    const pre = exposure.preExposure;
    sky.setPreExposure(pre);
    sky.update(three, camera);
    sun.update(sky, pre, target.set(0, 0, 0));
    for (const { group, lights } of boats.values()) {
      if (!group.visible) continue;
      lights.update(camera, dt, pre, sky.sunElevation, { hazeDensity: params.haze, visibility: params.vis });
    }
    pipeline.render();
    probe.update(three, now / 1000, pre);

    frames++;
    if (now - fpsTime > 500) {
      fps = (frames * 1000) / (now - fpsTime);
      frames = 0;
      fpsTime = now;
      const boat = boats.get(params.boat);
      if (!boat) return;
      const { group, lights } = boat;
      group.updateMatrixWorld();
      inverse.matrix.copy(group.matrixWorld).invert();
      const lines = lights.nav.mounts
        .filter((m) => lights.nav.isLit(m.name))
        .map((m) => {
          lightWorld.set(m.position.x, m.position.y, m.position.z).applyMatrix4(group.matrixWorld);
          toCamera.copy(camera.position).sub(lightWorld);
          const d = toCamera.length();
          toCamera.transformDirection(inverse.matrix);
          const { kind, colour } = mountLight(m);
          const vis = visibility(kind, toCamera);
          const cd = lights.nav.intensityOf(m.name);
          const lux = (cd * vis) / (d * d);
          return `${m.name.padEnd(20)} ${colour.padEnd(6)} ${cd.toFixed(1).padStart(5)} cd  vis ${vis.toFixed(2)}  ${lux.toExponential(1)} lx`;
        });
      readout.textContent = [
        `${params.boat}  ${formatDistance(camera.position.distanceTo(controls.target))}  bearing ${params.bearing}°`,
        `nav ${lights.navigationLightsOn ? 'on' : 'off'}  deck ${lights.deckLightsOn ? 'on' : 'off'}  ` +
          `extra ${lights.extraLightsOn ? 'on' : 'off'}  ` +
          `scene lights ${lights.deck.sceneLights} deck (${lights.deck.shadowedLights} shadowed) + ${lights.budget.navSpill} spill`,
        `roles ${lights.activeRoles.join(', ') || '—'}`,
        ...lines,
        `EV100 ${exposure.ev100.toFixed(2)}  pre-exposure ${pre.toExponential(2)}  sun ${params.sun}°`,
        `fps ${fps.toFixed(0)}`,
      ].join('\n');
    }
  });

  (window as unknown as { lightsLab: unknown }).lightsLab = {
    boats,
    params,
    state,
    camera,
    controls,
    exposure,
    sky,
  };
}

void main();
