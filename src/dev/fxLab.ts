// Dev-only effects lab (/dev/fx-lab.html): the dev-spectrum GPU ocean with a
// box boat that slams, a circling jet ski with a rooster tail and wake churn,
// wind spume, rain and lightning, all driven by sliders or URL parameters:
//   ?wind=35&dir=225&sea=22&rain=0.8&lightning=6&sun=25&az=200&jet=1&wash=1&slam=2
//   &quality=ultra&stress=1&fx=0&bloom=0&hud=0&cam=x,y,z&look=x,y,z
//   &strike=2 (force a strike at t = 2 s) &pauseAt=2.1 (freeze the simulation then)
//   &trace (TSL node stack traces, for shader-build errors)
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
  AgXToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardNodeMaterial,
  Node,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import type { QualityPreset } from '../app/Scenario';
import { DEV_REPEAT_PERIOD, devCascades } from '../render/ocean/devSpectrum';
import { FoamDetail } from '../render/ocean/FoamDetail';
import { GpuOceanSimulation } from '../render/ocean/GpuOcean';
import { OceanMesh } from '../render/ocean/OceanMesh';
import { foamForWind, OCEAN_SHADING_QUALITY } from '../render/ocean/oceanOptics';
import { FxSystem } from '../render/particles/FxSystem';
import { tsl } from '../render/tsl';
import { DEG, fromDirectionToVelocity } from '../sim/core/conventions';

const { Fn, max, mix, positionWorldDirection, pow, smoothstep, uniform } = tsl;

const params = new URLSearchParams(location.search);
(Node as unknown as { captureStackTrace: boolean }).captureStackTrace = params.has('trace');
const num = (key: string, fallback: number): number => {
  const value = params.get(key);
  return value === null || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);
};
const flag = (key: string, fallback: boolean): boolean =>
  params.has(key) ? params.get(key) !== '0' : fallback;
const vector = (key: string, fallback: Vector3): Vector3 => {
  const parts = params.get(key)?.split(',').map(Number);
  return parts?.length === 3 && parts.every(Number.isFinite) ? new Vector3(...parts) : fallback;
};
const QUALITIES: QualityPreset[] = ['low', 'medium', 'high', 'ultra'];

const state = {
  wind: num('wind', 12),
  windFrom: num('dir', 225),
  sea: num('sea', Number.NaN), // spectrum wind; defaults to min(wind, 24)
  rain: num('rain', 0),
  lightning: num('lightning', 0),
  sunElevation: num('sun', 22),
  sunAzimuth: num('az', 200),
  jet: flag('jet', false),
  wash: flag('wash', false),
  slamEvery: num('slam', 0),
  quality: (QUALITIES as string[]).includes(params.get('quality') ?? '')
    ? (params.get('quality') as QualityPreset)
    : 'ultra',
  stress: flag('stress', false),
  fx: flag('fx', true),
  bloom: flag('bloom', true),
  strikeAt: num('strike', Number.NaN),
  pauseAt: num('pauseAt', Number.NaN),
};
if (!flag('hud', true)) document.body.classList.add('clean');

async function main(): Promise<void> {
  const container = document.getElementById('viewport');
  const panel = document.getElementById('panel');
  if (!container || !panel) return;
  const renderer = new WebGPURenderer({
    antialias: false,
    reversedDepthBuffer: true,
    powerPreference: 'high-performance',
    trackTimestamp: true,
  });
  await renderer.init();
  renderer.toneMapping = AgXToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.append(renderer.domElement);

  const camera = new PerspectiveCamera(55, 1, 0.1, 60_000);
  camera.position.copy(vector('cam', new Vector3(16, 4.5, 14)));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(vector('look', new Vector3(0, 1.5, -3)));
  controls.update();

  const resize = (): void => {
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  // Sky: a gradient that darkens with storminess and lights up with flashes.
  const scene = new Scene();
  const sky = {
    zenith: uniform(new Color(0.12, 0.3, 0.6)),
    horizon: uniform(new Color(0.55, 0.68, 0.8)),
    sunDir: uniform(new Vector3(0, 1, 0)),
    sunGlow: uniform(new Color(1, 0.9, 0.7)),
    flash: uniform(new Color(0, 0, 0)),
  };
  scene.backgroundNode = Fn(() => {
    const dir = positionWorldDirection;
    const up = pow(max(dir.y, 0), 0.45);
    const base = mix(sky.horizon, sky.zenith, up);
    const glow = pow(max(dir.dot(sky.sunDir), 0), 64)
      .mul(6)
      .add(pow(max(dir.dot(sky.sunDir), 0), 6).mul(0.4));
    const below = smoothstep(0, -0.2, dir.y);
    return mix(base.add(sky.sunGlow.mul(glow)), sky.horizon.mul(0.6), below).add(sky.flash.mul(up.add(0.3)));
  })();

  const hemisphere = new HemisphereLight(0xdbe9ff, 0x1a3346, 1.2);
  const sun = new DirectionalLight(0xffffff, 2.5);
  scene.add(hemisphere, sun);

  // Ocean.
  const windToward = (): number => (state.windFrom + 180) * DEG;
  const seaWind = (): number => (Number.isFinite(state.sea) ? state.sea : Math.min(state.wind, 24));
  const spectrum = (): ReturnType<typeof devCascades> =>
    devCascades({ windSpeed: Math.max(seaWind(), 3), windToward: windToward(), amplitude: 0.003, seed: 1 });
  const ocean = new GpuOceanSimulation(spectrum(), DEV_REPEAT_PERIOD);
  const foamDetail = new FoamDetail();
  const oceanMesh = new OceanMesh({
    groups: ocean.groups,
    foamDetail: foamDetail.texture,
    quality: OCEAN_SHADING_QUALITY.medium,
  });
  scene.add(oceanMesh.mesh);
  let spectrumDirty = false;

  // Boat and jet ski.
  const boat = new Mesh(
    new BoxGeometry(2.4, 1.4, 9),
    new MeshStandardNodeMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
  );
  scene.add(boat);
  const jetSki = new Mesh(
    new BoxGeometry(1, 0.7, 3.2),
    new MeshStandardNodeMaterial({ color: 0xc23a2a, roughness: 0.4 }),
  );
  scene.add(jetSki);

  const fx = new FxSystem({ quality: state.quality, ocean: ocean.groups });
  scene.add(fx.group);
  fx.group.visible = state.fx;
  fx.onThunder((event) => {
    const distance = Math.hypot(event.x - camera.position.x, event.z - camera.position.z);
    lastThunder = `thunder ${(distance / 1000).toFixed(1)} km, ${(distance / 343).toFixed(1)} s`;
  });
  let lastThunder = '';

  // Post: bloom on HDR highlights (lightning, backlit spray, glints).
  const pipeline = new RenderPipeline(renderer);
  const scenePass = tsl.pass(scene, camera);
  const sceneColor = scenePass.getTextureNode('output');
  pipeline.outputNode = sceneColor.add(bloom(sceneColor, 0.3, 0.3, 1.4));

  // Panel.
  const stats = document.createElement('div');
  stats.id = 'stats';
  const slider = (label: string, key: keyof typeof state, min: number, max: number, step: number): void => {
    const row = document.createElement('label');
    const input = document.createElement('input');
    const value = document.createElement('span');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(state[key]);
    value.textContent = String(state[key]);
    input.addEventListener('input', () => {
      (state as Record<string, unknown>)[key] = Number(input.value);
      value.textContent = input.value;
      if (key === 'wind' || key === 'windFrom' || key === 'sea') spectrumDirty = true;
    });
    row.append(label, input, value);
    panel.append(row);
  };
  const checkbox = (label: string, key: 'jet' | 'wash' | 'stress' | 'fx'): void => {
    const row = document.createElement('label');
    row.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = state[key];
    input.addEventListener('change', () => {
      state[key] = input.checked;
      fx.group.visible = state.fx;
    });
    row.append(input, label);
    panel.append(row);
  };
  const button = (label: string, action: () => void, parent: HTMLElement): void => {
    const element = document.createElement('button');
    element.textContent = label;
    element.addEventListener('click', action);
    parent.append(element);
  };
  slider('Wind m/s', 'wind', 0, 70, 1);
  slider('Wind from °', 'windFrom', 0, 360, 5);
  slider('Rain', 'rain', 0, 1, 0.01);
  slider('Lightning/min', 'lightning', 0, 30, 0.5);
  slider('Sun elev °', 'sunElevation', -10, 90, 1);
  slider('Sun azim °', 'sunAzimuth', 0, 360, 5);
  slider('Auto slam s', 'slamEvery', 0, 5, 0.25);
  checkbox('Jet ski rooster tail', 'jet');
  checkbox('Prop wash', 'wash');
  checkbox('Stress fill', 'stress');
  checkbox('Effects on', 'fx');
  const quality = document.createElement('select');
  for (const q of QUALITIES) quality.append(new Option(q, q, q === state.quality, q === state.quality));
  quality.addEventListener('change', () => {
    state.quality = quality.value as QualityPreset;
    fx.setQuality(state.quality);
  });
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  button('Slam', () => slam(5), buttons);
  button('Big slam', () => slam(9), buttons);
  button('Strike', () => strike(), buttons);
  buttons.append(quality);
  panel.append(buttons, stats);

  const boatHeading = new Vector3(0, 0, -1);
  const boatVelocity = new Vector3(0, 0, -7);
  const slam = (strength: number): void => {
    const bow = boat.localToWorld(new Vector3(0, -0.6, -3.2));
    fx.slam({ x: bow.x, y: Math.max(bow.y, 0), z: bow.z, strength }, boatVelocity, {
      heading: boatHeading,
      hullLength: 9,
    });
  };
  const strike = (): void => {
    const forward = camera.getWorldDirection(new Vector3()).setY(0).normalize();
    const distance = 2500 + Math.random() * 2500;
    fx.lightning.strike(camera.position.x + forward.x * distance, camera.position.z + forward.z * distance);
  };

  // Frame loop.
  let time = 0;
  let last = performance.now();
  let nextSlam = 1;
  let struck = false;
  let frames = 0;
  let fpsTime = 0;
  let fps = 0;
  let gpuCompute = 0;
  let gpuRender = 0;
  let live = 0;
  let timedFrames = 0;
  const wind = { x: 0, z: 0 };
  const sunDirection = new Vector3();
  const jetVelocity = new Vector3();

  const frame = (): void => {
    const now = performance.now();
    const realDt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const paused = Number.isFinite(state.pauseAt) && time >= state.pauseAt;
    const dt = paused ? 0 : realDt;
    time += dt;

    if (spectrumDirty) {
      ocean.setSpectrum(spectrum());
      spectrumDirty = false;
    }
    ocean.setFoam(foamForWind(state.wind, ocean.foamLayers));

    // Light: sun elevation/azimuth, dimmed by storminess.
    const storm = Math.min(
      1,
      Math.max(state.rain * 1.2, state.lightning > 0 ? 0.7 : 0, (state.wind - 20) / 30),
    );
    const elevation = state.sunElevation * DEG;
    const azimuth = state.sunAzimuth * DEG;
    sunDirection.set(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );
    const day = Math.min(1, Math.max(0, (Math.sin(elevation) + 0.05) / 0.25));
    const warm = 1 - Math.min(1, Math.max(0, Math.sin(elevation) / 0.5));
    const sunStrength = 3.2 * day * (1 - 0.88 * storm);
    const sunColor = new Color(1, 0.93 - 0.25 * warm, 0.85 - 0.45 * warm).multiplyScalar(sunStrength);
    const skyLevel = 0.03 + 0.97 * day;
    const ambient = new Color(0.42, 0.52, 0.66)
      .lerp(new Color(0.35, 0.37, 0.4), storm)
      .multiplyScalar(skyLevel * (1 - 0.55 * storm));
    sun.position.copy(sunDirection).multiplyScalar(500);
    sun.color.copy(sunColor).multiplyScalar(1 / 3.2);
    sun.intensity = 2.5;
    const flash = fx.flash;
    hemisphere.intensity = 1.2 * skyLevel * (1 - 0.5 * storm) + flash.intensity * 4;
    sky.zenith.value
      .setRGB(0.12, 0.3, 0.6)
      .lerp(new Color(0.18, 0.2, 0.23), storm)
      .multiplyScalar(skyLevel);
    sky.horizon.value
      .setRGB(0.55, 0.68, 0.8)
      .lerp(new Color(0.32, 0.34, 0.37), storm)
      .multiplyScalar(skyLevel);
    sky.sunDir.value.copy(sunDirection);
    sky.sunGlow.value.copy(sunColor).multiplyScalar(0.35);
    sky.flash.value.copy(flash.color).multiplyScalar(flash.intensity * 1.5);

    // Boat bobbing (no CPU wave query in the lab) and the jet ski circling.
    boat.position.set(0, Math.sin(time * 0.8) * 0.3 + 0.2, 0);
    boat.rotation.set(Math.sin(time * 0.9) * 0.05, 0, Math.sin(time * 0.6) * 0.04);
    const jetAngle = time * 0.5;
    const jetRadius = 32;
    jetSki.position.set(-24 + Math.cos(jetAngle) * jetRadius, 0.25, -18 + Math.sin(jetAngle) * jetRadius);
    jetVelocity.set(-Math.sin(jetAngle), 0, Math.cos(jetAngle)).multiplyScalar(jetRadius * 0.5);
    jetSki.lookAt(jetSki.position.clone().sub(jetVelocity)); // bow (−Z) along the motion
    jetSki.rotation.z += 0.25;
    jetSki.visible = state.jet || state.wash;

    const tail = fx.roosterTail;
    tail.enabled = state.jet;
    tail.thrust = 1;
    tail.nozzle.copy(jetSki.localToWorld(new Vector3(0, -0.15, 1.7)));
    tail.direction.set(0, 0.6, 1).normalize().transformDirection(jetSki.matrixWorld);
    tail.boatVelocity.copy(jetVelocity);
    const wash = fx.propWash;
    wash.enabled = state.wash;
    wash.throttle = 0.9;
    wash.beam = 0.9;
    wash.stern.copy(jetSki.localToWorld(new Vector3(0, -0.3, 1.8)));
    wash.boatVelocity.copy(jetVelocity);
    wash.heading.copy(jetVelocity).normalize();

    if (state.slamEvery > 0 && time >= nextSlam) {
      slam(4 + Math.random() * 4);
      nextSlam = time + state.slamEvery;
    }
    if (!struck && Number.isFinite(state.strikeAt) && time >= state.strikeAt) {
      struck = true;
      strike();
    }
    if (state.stress && dt > 0) {
      fx.spawn({
        kind: 'droplet',
        count: fx.particles.activeCapacity / (4.2 * 60),
        position: { x: 0, y: 45, z: -20 },
        positionRadius: 60,
        velocity: { x: 0, y: 0, z: 0 },
        velocitySpread: 2,
        size: [0.03, 0.06],
        life: [4, 4.5],
        drag: 0.002,
      });
    }

    fromDirectionToVelocity(state.windFrom * DEG, state.wind, wind);
    ocean.update(renderer, time, dt);
    foamDetail.ensure(renderer);
    oceanMesh.update(camera);
    if (state.fx) {
      fx.update(renderer, camera, dt, {
        time,
        wind: { x: wind.x, y: 0, z: wind.z },
        sunDirection,
        sunColor,
        ambientColor: ambient,
        rainIntensity: state.rain,
        lightningRate: state.lightning,
        // The dev spectrum is gentler than the real one, so its crests break at a higher Jacobian.
        breakingThreshold: 0.5 + Math.min(state.wind, 50) * 0.007,
      });
    }
    controls.update();
    if (state.bloom) pipeline.render();
    else renderer.render(scene, camera);

    frames++;
    fpsTime += realDt;
    if (fpsTime > 0.5) {
      fps = frames / fpsTime;
      frames = 0;
      fpsTime = 0;
      if (state.fx) void fx.particles.debugLiveCount(renderer).then((count) => (live = count));
    }
    // Timestamp pools sum every pass since the previous resolve, so average over the frames between.
    if (++timedFrames >= 30) {
      const n = timedFrames;
      timedFrames = 0;
      void renderer.resolveTimestampsAsync('compute').then((ms) => (gpuCompute = (ms ?? 0) / n));
      void renderer.resolveTimestampsAsync('render').then((ms) => (gpuRender = (ms ?? 0) / n));
    }
    stats.textContent =
      `${fps.toFixed(0)} fps  t=${time.toFixed(2)}${paused ? ' (paused)' : ''}\n` +
      `gpu compute ${gpuCompute.toFixed(2)} ms  render ${gpuRender.toFixed(2)} ms\n` +
      `particles ${live} / ${fx.particles.activeCapacity}\n` +
      `flash ${flash.intensity.toFixed(2)}  ${lastThunder}`;
  };

  // Exposed for scripted checks from DevTools.
  Object.assign(window, {
    fxLab: { state, fx: () => fx, slam, strike, camera, controls, renderer },
  });
  void renderer.setAnimationLoop(frame);
}

void main();
