// Audio lab (dev only, /dev/audio-lab.html): drives the AudioEngine with sliders for wind, sea,
// rain, environment and one boat (or the whole fleet), with buttons for slams, thunder, horn and
// winch, and live parameter and level readouts. URL params preset the sliders, e.g.
// ?wind=35&hs=6&rain=0.6&kind=crab&rpm=0.8&distance=40&orbit=1&fleet=1. The engine is exposed
// as `window.audioLab` for scripted checks.

import { loadRecordings } from '../app/loadRecordings';
import { AudioEngine } from '../audio/AudioEngine';
import { BOAT_AUDIO } from '../audio/boatProfiles';
import { SampleBank } from '../audio/SampleBank';
import type { AudioFrame, BoatAudioState } from '../audio/types';
import { type AudioSettings, defaultSettings } from '../settings/schema';
import { DEG } from '../sim/core/conventions';
import { gasGeneratorSpeed } from '../sim/physics/propulsion/surfaceProp';
import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number): number => {
  const value = params.get(key);
  return value === null || value === '' || Number.isNaN(Number(value)) ? fallback : Number(value);
};
const flag = (key: string, fallback: boolean): boolean =>
  params.has(key) ? params.get(key) !== '0' : fallback;

const initialKind = params.get('kind');
const defaults = defaultSettings().audio;
const state = {
  master: num('master', defaults.master),
  ambience: num('ambience', defaults.ambience),
  effects: num('effects', defaults.effects),
  engines: num('engines', defaults.engines),
  muteWhenHidden: flag('mute', defaults.muteWhenHidden),
  wind: num('wind', 8),
  windFrom: num('dir', 225),
  gust: num('gust', 1.3),
  hs: num('hs', 1),
  tp: num('tp', 0),
  rain: num('rain', 0),
  deck: num('deck', 0.5),
  kind: (BOAT_KINDS as readonly string[]).includes(initialKind ?? '')
    ? (initialKind as BoatKind)
    : 'powerboat',
  rpm: num('rpm', 0.3), // fraction of idle..max
  load: num('load', 0.5),
  speed: num('speed', 8),
  luffing: num('luff', 0),
  apparentWind: num('aw', 10),
  motion: num('motion', 0.1),
  airborne: flag('air', false),
  distance: num('distance', 15),
  orbit: flag('orbit', false),
  fleet: flag('fleet', false),
  enclosed: num('enclosed', 0),
  underwater: num('underwater', 0),
  slam: num('slamStrength', 5),
};

const samples = new SampleBank();
const audio = new AudioEngine({ settings: settingsOf(), meter: true, samples });
(window as unknown as { audioLab: AudioEngine }).audioLab = audio;
void loadRecordings(samples, null).then(() => audio.refreshRecordings());

function settingsOf(): AudioSettings {
  return {
    master: state.master,
    ambience: state.ambience,
    effects: state.effects,
    engines: state.engines,
    muteWhenHidden: state.muteWhenHidden,
  };
}

// ---------------------------------------------------------------------------------------------
// UI

type NumericKey = {
  [K in keyof typeof state]: (typeof state)[K] extends number ? K : never;
}[keyof typeof state];
type BooleanKey = {
  [K in keyof typeof state]: (typeof state)[K] extends boolean ? K : never;
}[keyof typeof state];

function section(parent: HTMLElement, title: string): HTMLElement {
  const el = document.createElement('section');
  const h = document.createElement('h2');
  h.textContent = title;
  el.append(h);
  parent.append(el);
  return el;
}

function slider(
  parent: HTMLElement,
  key: NumericKey,
  label: string,
  min: number,
  max: number,
  step: number,
  format: (v: number) => string = (v) => v.toFixed(step < 0.1 ? 2 : step < 1 ? 1 : 0),
  onChange?: () => void,
): void {
  const row = document.createElement('label');
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(state[key]);
  input.dataset.key = key;
  input.name = key;
  const value = document.createElement('span');
  value.textContent = format(state[key]);
  input.addEventListener('input', () => {
    state[key] = Number(input.value);
    value.textContent = format(state[key]);
    onChange?.();
  });
  row.append(name, input, value);
  parent.append(row);
}

function checkbox(parent: HTMLElement, key: BooleanKey, label: string, onChange?: () => void): void {
  const row = document.createElement('label');
  row.className = 'check';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = state[key];
  input.dataset.key = key;
  input.name = key;
  input.addEventListener('change', () => {
    state[key] = input.checked;
    onChange?.();
  });
  row.append(input, document.createTextNode(` ${label}`));
  parent.append(row);
}

function button(parent: HTMLElement, label: string, onClick: () => void, id?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (id) b.id = id;
  b.addEventListener('click', onClick);
  parent.append(b);
  return b;
}

const colA = document.getElementById('col-a') as HTMLElement;
const colB = document.getElementById('col-b') as HTMLElement;
const applySettings = (): void => audio.applySettings(settingsOf());

const volumes = section(colA, 'Volume');
slider(volumes, 'master', 'Master', 0, 1, 0.01, undefined, applySettings);
slider(volumes, 'ambience', 'Ambience', 0, 1, 0.01, undefined, applySettings);
slider(volumes, 'effects', 'Effects', 0, 1, 0.01, undefined, applySettings);
slider(volumes, 'engines', 'Engines', 0, 1, 0.01, undefined, applySettings);
checkbox(volumes, 'muteWhenHidden', 'Mute when tab hidden', applySettings);

const weather = section(colA, 'Weather');
slider(weather, 'wind', 'Wind m/s', 0, 70, 0.5, (v) => `${v.toFixed(1)}`);
slider(weather, 'windFrom', 'Wind from °', 0, 359, 1);
slider(weather, 'gust', 'Gust factor', 1, 2, 0.05, (v) => v.toFixed(2));
slider(weather, 'hs', 'Hs m', 0, 18, 0.1, (v) => v.toFixed(1));
slider(weather, 'tp', 'Tp s (0 auto)', 0, 16, 0.5, (v) => (v === 0 ? 'auto' : v.toFixed(1)));
slider(weather, 'rain', 'Rain', 0, 1, 0.01);
slider(weather, 'deck', 'Deck ↔ water', 0, 1, 0.01);

const env = section(colA, 'Environment');
slider(env, 'enclosed', 'Enclosed', 0, 1, 0.01);
slider(env, 'underwater', 'Underwater', 0, 1, 0.01);

const boat = section(colB, 'Boat');
const kindRow = document.createElement('label');
const kindName = document.createElement('span');
kindName.textContent = 'Kind';
const kindSelect = document.createElement('select');
kindSelect.name = 'kind';
for (const kind of BOAT_KINDS) kindSelect.add(new Option(kind, kind, false, kind === state.kind));
kindSelect.addEventListener('change', () => {
  state.kind = kindSelect.value as BoatKind;
});
kindRow.append(kindName, kindSelect);
boat.append(kindRow);
slider(boat, 'rpm', 'Throttle', 0, 1, 0.01, (v) => `${Math.round(rpmOf(state.kind, v))}`);
slider(boat, 'load', 'Load', 0, 1, 0.01);
slider(boat, 'speed', 'Speed m/s', 0, 30, 0.1, (v) => v.toFixed(1));
slider(boat, 'luffing', 'Luffing', 0, 1, 0.01);
slider(boat, 'apparentWind', 'App. wind m/s', 0, 40, 0.5, (v) => v.toFixed(1));
slider(boat, 'motion', 'Motion rad/s', 0, 0.6, 0.01);
checkbox(boat, 'airborne', 'Airborne (jet drive ventilating)');
slider(boat, 'distance', 'Distance m', 0, 3000, 1);
checkbox(boat, 'orbit', 'Orbit the listener (Doppler, panning)');
checkbox(boat, 'fleet', 'Whole fleet (one of each kind)');

const events = section(colB, 'Events');
slider(events, 'slam', 'Slam m/s', 0.5, 15, 0.5, (v) => v.toFixed(1));
const eventButtons = document.createElement('div');
eventButtons.className = 'buttons';
events.append(eventButtons);
button(eventButtons, 'Slam', () => audio.slam(activeId(), state.slam), 'slam');
button(eventButtons, 'Thunder near', () => thunder(600, true), 'thunder-near');
button(eventButtons, 'Thunder far', () => thunder(8000, true), 'thunder-far');
button(eventButtons, 'Cloud flash', () => thunder(3000, false), 'thunder-cloud');
button(eventButtons, 'Winch', () => audio.winch(activeId(), 2), 'winch');
const horn = button(eventButtons, 'Horn (hold)', () => undefined, 'horn');
horn.addEventListener('pointerdown', () => audio.horn(activeId(), true));
for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
  horn.addEventListener(type, () => audio.horn(activeId(), false));
}

const unlockButton = document.getElementById('unlock') as HTMLButtonElement;
unlockButton.addEventListener('click', () => {
  void audio.unlock().then((ok) => {
    unlockButton.textContent = ok ? 'Audio running' : 'Unlock failed — click again';
  });
});

function rpmOf(kind: BoatKind, throttle: number): number {
  const engine = BOAT_AUDIO[kind].engine;
  // The hydroplane's propeller (its turbine: turbineOf).
  if (BOAT_AUDIO[kind].turbine) return throttle * 9500;
  if (!engine) return 0;
  // Throttle 0 is engine off; above that, idle to max.
  return throttle <= 0.005 ? 0 : engine.idleRpm + (engine.maxRpm - engine.idleRpm) * throttle;
}

// The hydroplane's turbine for the rpm slider (as a share of full power) and the load slider as
// the propeller's bite: N1 from the gas power, the power turbine geared to the propeller.
function turbineOf(throttle: number, load: number): BoatAudioState['turbine'] {
  const power = throttle <= 0.005 ? 0 : 0.04 + 0.96 * throttle;
  return {
    n1: gasGeneratorSpeed(power, 0.04),
    power,
    turbineRpm: throttle * 16_000,
    propRpm: throttle * 9500,
    thrust: load * 15_000,
    propEmersion: 0.5,
  };
}

const activeId = (): string => `lab-${state.kind}`;

function thunder(distance: number, cloudToGround: boolean): void {
  const angle = Math.random() * Math.PI * 2;
  audio.thunder({
    x: Math.cos(angle) * distance,
    y: cloudToGround ? 0 : 1800,
    z: Math.sin(angle) * distance,
    time: performance.now() / 1000,
    intensity: cloudToGround ? 1 : 0.55,
    cloudToGround,
  });
}

// ---------------------------------------------------------------------------------------------
// Frame loop (one frame object, reused)

const boatStates: BoatAudioState[] = BOAT_KINDS.map((kind) => ({
  id: `lab-${kind}`,
  kind,
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  rpm: 0,
  load: 0,
  speedThroughWater: 0,
  luffing: 0,
  airborne: 0,
  apparentWind: 0,
  motion: 0,
}));
const activeBoats: BoatAudioState[] = [];
const frame: AudioFrame = {
  listener: {
    position: { x: 0, y: 2, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    up: { x: 0, y: 1, z: 0 },
  },
  environment: { enclosed: 0, underwater: 0 },
  wind: { speed: 0, from: 0, gustFactor: 1 },
  sea: { hs: 0 },
  rain: { intensity: 0, deck: 0 },
  boats: activeBoats,
  simTime: 0,
};

let orbitAngle = 0;
let last = performance.now();

function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame.simTime = now / 1000;
  frame.wind.speed = state.wind;
  frame.wind.from = state.windFrom * DEG;
  frame.wind.gustFactor = state.gust;
  frame.sea.hs = state.hs;
  frame.sea.tp = state.tp > 0 ? state.tp : undefined;
  if (frame.rain) {
    frame.rain.intensity = state.rain;
    frame.rain.deck = state.deck;
  }
  if (frame.environment) {
    frame.environment.enclosed = state.enclosed;
    frame.environment.underwater = state.underwater;
  }

  activeBoats.length = 0;
  const kinds = state.fleet ? BOAT_KINDS : [state.kind];
  kinds.forEach((kind, i) => {
    const b = boatStates[BOAT_KINDS.indexOf(kind)];
    if (!b) return;
    const radius = Math.max(state.distance, 0.5) * (1 + i * 0.6);
    const speed = state.speed;
    if (state.orbit) {
      // Circle the listener at the boat's speed, so Doppler and panning move.
      if (i === 0) orbitAngle += (speed / Math.max(radius, 1)) * dt;
      const a = orbitAngle + (i * Math.PI * 2) / kinds.length;
      b.position.x = Math.cos(a) * radius;
      b.position.z = Math.sin(a) * radius;
      b.velocity.x = -Math.sin(a) * speed;
      b.velocity.z = Math.cos(a) * speed;
    } else {
      const a = (i * Math.PI * 2) / kinds.length - Math.PI / 2;
      b.position.x = Math.cos(a) * radius;
      b.position.z = Math.sin(a) * radius;
      b.velocity.x = 0;
      b.velocity.z = -speed;
    }
    b.position.y = 1;
    b.rpm = rpmOf(kind, state.rpm);
    b.load = state.load;
    if (BOAT_AUDIO[kind].turbine) b.turbine = turbineOf(state.rpm, state.load);
    b.speedThroughWater = speed;
    b.luffing = state.luffing;
    b.apparentWind = state.apparentWind;
    b.motion = state.motion;
    b.airborne = state.airborne ? 1 : 0;
    activeBoats.push(b);
  });

  audio.update(dt, frame);
  render();
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------------------------
// Readouts

const readout = document.getElementById('readout') as HTMLElement;
const meterPre = document.getElementById('meter-pre') as HTMLElement;
const meterPost = document.getElementById('meter-post') as HTMLElement;
let renderTimer = 0;

const f = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : '−∞');
const meterWidth = (db: number): string => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;

function render(): void {
  if (++renderTimer % 6 !== 0) return; // ~10 Hz is plenty for text
  const d = audio.debug();
  const lines: string[] = [];
  lines.push(`state ${d.state}   sampleRate ${d.sampleRate}`);
  if (d.levels) {
    const l = d.levels;
    lines.push(
      `levels  peak ${f(l.peakDb, 1)} dBFS  rms ${f(l.rmsDb, 1)} dBFS  out ${f(l.outPeakDb, 1)} dBFS  ` +
        `limiter ${f(l.reductionDb, 1)} dB`,
    );
    meterPre.style.width = meterWidth(l.peakDb);
    meterPost.style.width = meterWidth(l.outPeakDb);
  }
  const w = d.wind;
  lines.push(
    '',
    `wind  heard ${f(d.gustSpeed, 1)} m/s  loud ${f(w.loudness)}  rush ${f(w.rushGain, 3)} @ ${f(w.rushCutoff, 0)} Hz`,
    `      howl ${f(w.howlGain, 3)} @ ${f(w.howlFreq, 0)} Hz Q ${f(w.howlQ, 1)}  ` +
      `whistle ${f(w.whistleGain, 3)} @ ${f(w.whistleFreq, 0)} Hz`,
  );
  const s = d.sea;
  if (s.loudness !== undefined) {
    lines.push(
      `sea   loud ${f(s.loudness)}  lap ${f(s.lapGain, 3)}  wash ${f(s.washGain, 3)} @ ${f(s.washCenter, 0)} Hz  ` +
        `roar ${f(s.roarGain, 3)} @ ${f(s.roarCutoff, 0)} Hz`,
      `      swell ${f(s.swellRate, 3)} Hz  crests ${f(s.crestRate)}/s × ${f(s.crestGain)}  laps ${f(s.lapRate)}/s`,
    );
  }
  const r = d.rain;
  if (r.deckHiss !== undefined) {
    lines.push(
      `rain  deck hiss ${f(r.deckHiss, 3)} drops ${f(r.deckDrops, 3)}  water hiss ${f(r.waterHiss, 3)} ` +
        `drops ${f(r.waterDrops, 3)}  dense ${f(r.denseMix)}`,
    );
  }
  const e = d.environment;
  lines.push(
    `recorded  ${d.recordedBeds.join(', ') || 'none'}`,
    `env   cutoff ${f(e.cutoff, 0)} Hz  Q ${f(e.q)}  exterior ${f(e.exteriorGain)}  hum ${f(e.interiorHum, 3)}  ` +
      `under ${f(e.underwaterBed, 3)}`,
    '',
    `one-shots  effects ${d.oneShots.effects}  ambience ${d.oneShots.ambience}`,
    '',
  );
  for (const b of d.boats) {
    lines.push(
      `${b.kind.padEnd(9)} ${f(b.distance, 0).padStart(5)} m  doppler ${f(b.doppler, 3)}  air ${f(b.airCutoff, 0)} Hz`,
      `          f0 ${f(b.f0, 1)} Hz  cutoff ${f(b.cutoff, 0)} Hz  engine ${f(b.engineGain, 3)}  ` +
        `effort ${f(b.effort)}  boost ${f(b.boost)}  rush ${f(b.rush)}  flog ${f(b.flog, 3)}${b.horn ? '  HORN' : ''}`,
    );
  }
  if (d.thunder.length) {
    lines.push('', 'thunder');
    const ctxNow = audio.context?.currentTime ?? 0;
    for (const t of d.thunder) {
      const eta = t.at - ctxNow;
      lines.push(
        `  ${f(t.plan.distance, 0).padStart(5)} m  delay ${f(t.plan.delay, 1)} s  ` +
          `${eta > 0 ? `arrives in ${f(eta, 1)} s` : 'arrived'}  gain ${f(t.plan.gain, 3)}  ` +
          `crack ${f(t.plan.crackGain, 3)}  roll ${f(t.plan.duration, 1)} s`,
      );
    }
  }
  readout.textContent = lines.join('\n');
}

requestAnimationFrame(tick);
