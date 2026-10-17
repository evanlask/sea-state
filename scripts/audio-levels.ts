// Audio levels: renders the game's AudioEngine offline (scripts/audio/offlineWebAudio.ts) in typical
// scenes and measures each volume bus's loudness at 100 %, the numbers behind BUS_TRIM_DB in
// src/audio/AudioEngine.ts and the audio volume defaults in src/settings/schema.ts.
//
//   ambience  wind, sea and rain beds in Fair, Breezy, Gale and Storm (no thunder), heard from the
//             powerboat's chase camera; "typical" is the mean of Breezy and Gale
//   engines   the player's engine at cruise from the chase camera, each powered boat cruising in
//             Breezy and Gale (the real sim drives rpm and load); typical is the mean over boats. The
//             hydroplane races on flat water only (a Breezy sea flips it at speed): Glassy calm and the
//             Fog bank's light air and long swell
//   effects   the same runs' hull water rush, bow splashes, creaks and slams (the sim's), plus a
//             scripted slam and two horn blasts (and winch clicks on the sailboat), all six boats
//   thunder   strikes at 2, 3.5 and 5 km in the Storm (ambience bus, reported on its own)
//
// Loudness is ITU-R BS.1770 integrated loudness (K-weighted, 400 ms blocks, absolute and relative
// gates) in LUFS of each bus's stereo output; the relative gate drops the gaps between one-shots,
// so effects and thunder read as loud as they are while they sound. Per-boat and per-preset
// numbers are averaged in dB. Usage: node scripts/audio-levels.ts [--seconds 30] [--json out.json]
// [--boats hydro,powerboat] (only those boats' runs, no ambience or thunder)

import './register-ts.ts';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { installGlobals, OfflineBuffer, OfflineContext } = await import('./audio/offlineWebAudio.ts');
const { AudioEngine, BUS_TRIM_DB } = await import('../src/audio/AudioEngine.ts');
const { BOAT_AUDIO } = await import('../src/audio/boatProfiles.ts');
const { volumeToGain } = await import('../src/audio/curves.ts');
const { defaultSettings } = await import('../src/settings/schema.ts');
const { recordingPlan } = await import('../src/audio/recordings.ts');
const { SampleBank } = await import('../src/audio/SampleBank.ts');
const { boatAudioState } = await import('../src/app/audioFrame.ts');
const { spawnPlan } = await import('../src/app/spawnPlan.ts');
const { BOAT_CAMERA_INFO } = await import('../src/camera/boatCameraInfo.ts');
const { signedAngle } = await import('../src/sim/core/conventions.ts');
const { knotsToMs } = await import('../src/sim/core/units.ts');
const { BOAT_SPECS } = await import('../src/sim/boats/specs/index.ts');
const { getWeatherPreset } = await import('../src/sim/weather/presets.ts');
const { resolveSeaState } = await import('../src/sim/weather/seaState.ts');
const { BOAT_KINDS } = await import('../src/sim/world/protocol.ts');
const { SimWorld } = await import('../src/sim/world/SimWorld.ts');

type BoatKind = import('../src/sim/world/protocol.ts').BoatKind;
type BoatSnapshot = import('../src/sim/world/protocol.ts').BoatSnapshot;
type AudioFrame = import('../src/audio/types.ts').AudioFrame;
type OfflineNode = import('./audio/offlineWebAudio.ts').OfflineNode;
type Bus = 'ambience' | 'effects' | 'engines';

installGlobals();

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const SECONDS = Number(arg('seconds', '30'));
const SCRIPTED = !args.includes('--no-script'); // the scripted slam, horn blasts and winch
const ONLY = arg('boats', '') ? new Set(arg('boats', '').split(',')) : null;
// Where each boat cruises: the hydroplane only on flat water.
const cruiseWeathers = (kind: BoatKind): readonly string[] =>
  kind === 'hydro' ? ['glassy-calm', 'fog-bank'] : ['breezy', 'gale'];
const powered = (kind: BoatKind): boolean =>
  BOAT_AUDIO[kind].engine !== null || BOAT_AUDIO[kind].turbine !== undefined;
const WARMUP = 5; // s before measuring: beds ramp up from silence, boats settle
const SR = 48_000;
const FPS = 60;
const REST_PITCH = 0.18; // CameraRig's chase elevation

// ---------------------------------------------------------------------------------------------
// Loudness (ITU-R BS.1770-4 at 48 kHz)

function kWeight(x: Float32Array): Float64Array {
  const stages = [
    { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
    { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
  ];
  let input: ArrayLike<number> = x;
  let out = new Float64Array(x.length);
  for (const { b, a } of stages) {
    out = new Float64Array(x.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = input[i]!;
      const y = b[0]! * v + b[1]! * x1 + b[2]! * x2 - a[0]! * y1 - a[1]! * y2;
      x2 = x1;
      x1 = v;
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    input = out;
  }
  return out;
}

function loudness(channels: readonly Float32Array[]): number {
  const weighted = channels.map(kWeight);
  const n = weighted[0]?.length ?? 0;
  const block = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const powers: number[] = [];
  for (let start = 0; start + block <= n; start += hop) {
    let z = 0;
    for (const ch of weighted) {
      let sum = 0;
      for (let i = start; i < start + block; i++) sum += ch[i]! * ch[i]!;
      z += sum / block;
    }
    powers.push(z);
  }
  const lk = (z: number): number => -0.691 + 10 * Math.log10(z);
  const mean = (zs: number[]): number => zs.reduce((s, z) => s + z, 0) / Math.max(1, zs.length);
  const absolute = powers.filter((z) => lk(z) > -70);
  if (absolute.length === 0) return -Infinity;
  const relative = lk(mean(absolute)) - 10;
  return lk(mean(absolute.filter((z) => lk(z) > relative)));
}

const peakDb = (channels: readonly Float32Array[]): number => {
  let peak = 0;
  for (const ch of channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  return 20 * Math.log10(peak || 1e-12);
};

const meanDb = (values: readonly number[]): number => values.reduce((s, v) => s + v, 0) / values.length;

// ---------------------------------------------------------------------------------------------
// Recordings: the shipped Opus loops, decoded with ffmpeg.

const root = fileURLToPath(new URL('..', import.meta.url));
const listing = (
  JSON.parse(readFileSync(`${root}public/assets-manifest.json`, 'utf8')) as {
    assets: Record<string, { bytes: number; loop?: { start: number; end: number } }>;
  }
).assets;
const plan = recordingPlan((path) => listing[path] ?? null, 'webm', '/');
const decoded = new Map<string, InstanceType<typeof OfflineBuffer>>();
for (const [id, entry] of Object.entries(plan.manifest.sounds)) {
  const file = `${root}public/audio/${entry.variants[0]!.file}.webm`;
  const pcm = execFileSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'],
    {
      maxBuffer: 1 << 28,
    },
  );
  const data = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
  const buffer = new OfflineBuffer(1, data.length, SR);
  buffer.copyToChannel(data, 0);
  decoded.set(id, buffer);
}

function sampleBank(): InstanceType<typeof SampleBank> {
  const bank = new SampleBank({ canPlayType: () => '' });
  for (const [id, entry] of Object.entries(plan.manifest.sounds)) {
    const buffer = decoded.get(id);
    if (buffer) bank.set(id as never, { entry, buffers: [buffer as never] });
  }
  return bank;
}

if (decoded.size !== 5) console.warn(`only ${decoded.size} recordings decoded`);

// ---------------------------------------------------------------------------------------------
// Scenes

interface Weather {
  id: string;
  wind: { speed: number; from: number; gustFactor: number };
  seaState: import('../src/sim/weather/seaState.ts').SeaStateSettings;
  hs: number;
  tp: number;
  rain: number;
}

function weather(id: string): Weather {
  const p = getWeatherPreset(id);
  const sea = resolveSeaState(p.seaState, p.windSpeed, p.windFrom);
  return {
    id,
    wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor },
    seaState: p.seaState,
    hs: sea.totalHs,
    tp: sea.tp,
    rain: p.precipitation,
  };
}

type Taps = Record<Bus, Float32Array[]>;

interface SceneHooks {
  // Called each frame before audio.update; returns the frame's boats and listener.
  step(t: number, frame: AudioFrame, audio: InstanceType<typeof AudioEngine>): void;
}

// Runs the engine with every volume at 100 % for WARMUP + SECONDS and records each bus's output.
async function render(w: Weather, hooks: SceneHooks, seed = 1): Promise<Taps> {
  const ctx = new OfflineContext(SR);
  const audio = new AudioEngine({
    settings: { master: 1, ambience: 1, effects: 1, engines: 1, muteWhenHidden: false },
    samples: sampleBank(),
    panningModel: 'equalpower',
    seed,
    unlockTarget: null,
    createContext: () => ctx as never,
  });
  await audio.unlock();
  const graph = (audio as unknown as { graph: Record<string, OfflineNode> }).graph;
  const taps: Record<Bus, OfflineNode[]> = {
    ambience: [graph['ambienceBus']!, graph['ambienceDry']!],
    effects: [graph['effectsBus']!],
    engines: [graph['enginesBus']!],
  };
  const total = Math.round((WARMUP + SECONDS) * SR);
  const skip = Math.round(WARMUP * SR);
  const out: Taps = {
    ambience: [new Float32Array(total - skip), new Float32Array(total - skip)],
    effects: [new Float32Array(total - skip), new Float32Array(total - skip)],
    engines: [new Float32Array(total - skip), new Float32Array(total - skip)],
  };
  const frame: AudioFrame = {
    listener: { position: { x: 0, y: 4.9, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } },
    environment: { enclosed: 0, underwater: 0 },
    wind: { speed: w.wind.speed, from: w.wind.from, gustFactor: w.wind.gustFactor },
    sea: { hs: w.hs, tp: w.tp },
    rain: { intensity: w.rain, deck: 0 },
    boats: [],
  };
  let written = 0;
  for (let f = 0; written < total; f++) {
    const t = f / FPS;
    frame.simTime = t;
    hooks.step(t, frame, audio);
    audio.update(1 / FPS, frame);
    const until = Math.min(total, Math.round(((f + 1) / FPS) * SR));
    while (written < until) {
      ctx.renderQuantum();
      const q = ctx.renderedQuantum;
      for (const bus of ['ambience', 'effects', 'engines'] as const) {
        const [L, R] = out[bus] as [Float32Array, Float32Array];
        for (const node of taps[bus]) {
          const chans = node.output(q);
          const l = chans[0]!;
          const r = chans[1] ?? l;
          for (let s = 0; s < 128; s++) {
            const i = written + s - skip;
            if (i < 0 || i >= L.length) continue;
            L[i]! += l[s]!;
            R[i]! += r[s]!;
          }
        }
      }
      written += 128;
    }
  }
  audio.dispose();
  return out;
}

const ambienceOnly = (): SceneHooks => ({ step: () => undefined });

// The chase camera behind a boat: CameraRig's distance and rest pitch, yaw smoothed like the rig's.
function chaseListener(kind: BoatKind) {
  const info = BOAT_CAMERA_INFO[kind];
  const distance = info.length * 1.25 + 8;
  let yaw: number | null = null;
  return (boat: BoatSnapshot, dt: number, frame: AudioFrame): void => {
    const q = boat.orientation;
    // Bow direction: the body's −z axis.
    const fx = -(2 * (q.x * q.z + q.w * q.y));
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const boatYaw = Math.atan2(-fx, -fz); // yaw of the stern direction
    yaw = yaw === null ? boatYaw : yaw + signedAngle(boatYaw - yaw) * (1 - Math.exp(-dt * 1.8));
    const focusY = boat.position.y + Math.min(info.height * 0.35, 12);
    const p = {
      x: boat.position.x + Math.sin(yaw) * Math.cos(REST_PITCH) * distance,
      y: focusY + Math.sin(REST_PITCH) * distance,
      z: boat.position.z + Math.cos(yaw) * Math.cos(REST_PITCH) * distance,
    };
    const dx = boat.position.x - p.x;
    const dy = focusY - p.y;
    const dz = boat.position.z - p.z;
    const n = Math.hypot(dx, dy, dz) || 1;
    frame.listener = {
      position: p,
      forward: { x: dx / n, y: dy / n, z: dz / n },
      up: { x: 0, y: 1, z: 0 },
    };
  };
}

// Cruise: service speed where the spec has one, else a fast cruise for the center console.
function cruiseSpeed(kind: BoatKind): number {
  const p = BOAT_SPECS[kind].propulsion as { serviceSpeed?: number; topSpeed: number };
  if (kind === 'powerboat') return knotsToMs(30);
  return p.serviceSpeed ?? p.topSpeed * 0.7;
}

// One boat cruising under autopilot in the real sim, heard from its chase camera.
interface CruiseStats {
  rpm: number;
  load: number;
  speed: number; // m/s through the water
  slams: number;
  frames: number;
}

function boatScene(kind: BoatKind, w: Weather, stats: CruiseStats): SceneHooks {
  const spawn = spawnPlan(kind, w.wind, w.seaState, 'arcade');
  const speed = kind === 'sail' ? 3 : cruiseSpeed(kind);
  const world = new SimWorld({
    seed: 1,
    physicsMode: 'arcade',
    boats: [{ id: 'player', kind, x: 0, z: 0, ...spawn, speed }],
    wind: w.wind,
    seaState: w.seaState,
    oceanQuality: 'low',
    wakes: false,
  });
  const boat = world.boats[0]!;
  if (kind === 'sail') {
    boat.setAutopilot({ mode: 'windAngle', twa: signedAngle(w.wind.from - spawn.heading) });
  } else {
    boat.setAutopilot({ mode: 'hold', heading: spawn.heading, speed });
  }
  const listen = chaseListener(kind);
  const scripted = new Set<string>();
  const once = (key: string, run: () => void): void => {
    if (!scripted.has(key)) {
      scripted.add(key);
      run();
    }
  };
  return {
    step(t, frame, audio) {
      const snap = world.advance({
        type: 'advance',
        targetTime: t + 1 / FPS,
        controls: {},
        commands: [],
        probes: new Float64Array(),
      });
      const b = snap.boats[0]!;
      listen(b, 1 / FPS, frame);
      const state = boatAudioState(b);
      frame.boats = [state];
      if (t >= WARMUP) {
        stats.rpm += state.rpm;
        stats.load += state.load;
        stats.speed += state.speedThroughWater;
        stats.slams += snap.events.filter((e) => e.type === 'slam').length;
        stats.frames++;
      }
      // The first frame only creates the voice; events need it to exist.
      if (t > 0) audio.handleSimEvents(snap.events);
      const at = SCRIPTED ? t - WARMUP : -Infinity;
      if (at >= 8) once('slam', () => audio.slam('player', 5));
      if (at >= 12) once('horn-on', () => audio.horn('player', true));
      if (at >= 14) once('horn-off', () => audio.horn('player', false));
      if (at >= 24) once('horn2-on', () => audio.horn('player', true));
      if (at >= 25) once('horn2-off', () => audio.horn('player', false));
      if (kind === 'sail' && at >= 18) once('winch', () => audio.winch('player', 3));
    },
  };
}

// Strikes at a few km, every ~8 s, alternating cloud-to-ground and cloud-to-cloud.
const FEW_KM = [
  { at: 1, d: 2000, cg: true },
  { at: 9, d: 3500, cg: false },
  { at: 17, d: 5000, cg: true },
  { at: 25, d: 3000, cg: true },
];

function thunderScene(strikes = FEW_KM): SceneHooks {
  const fired = new Set<number>();
  return {
    step(t, _frame, audio) {
      strikes.forEach((s, i) => {
        // Flash early enough that the sound lands inside the measured window.
        const flash = WARMUP + s.at - s.d / 343;
        if (t >= flash && !fired.has(i)) {
          fired.add(i);
          const angle = i * 2.1;
          audio.thunder({
            x: Math.cos(angle) * s.d,
            y: s.cg ? 0 : 3000,
            z: Math.sin(angle) * s.d,
            time: t,
            intensity: s.cg ? 1 : 0.55,
            cloudToGround: s.cg,
          });
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------

const report: Record<string, unknown> = { seconds: SECONDS, trimsDb: BUS_TRIM_DB };
const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '  -inf');

console.log(`Bus loudness at 100 % (LUFS, ${SECONDS} s each, current trims ${JSON.stringify(BUS_TRIM_DB)})`);
const ambience: Record<string, number> = {};
let stormTaps: Taps | null = null;
for (const id of ONLY ? [] : ['fair', 'breezy', 'gale', 'storm']) {
  const taps = await render(weather(id), ambienceOnly());
  ambience[id] = loudness(taps.ambience);
  if (id === 'storm') stormTaps = taps;
  console.log(`  ambience ${id.padEnd(8)} ${fmt(ambience[id]!)}  peak ${fmt(peakDb(taps.ambience))} dBFS`);
}
// Thunder draws on its own random streams, so the storm with thunder less the storm without is
// the thunder alone.
let thunder = -Infinity;
if (!ONLY) {
  const thunderTaps = await render(weather('storm'), thunderScene());
  const thunderOnly = thunderTaps.ambience.map((ch, c) => ch.map((v, i) => v - stormTaps!.ambience[c]![i]!));
  thunder = loudness(thunderOnly);
  console.log(
    `  ambience storm+thunder ${fmt(loudness(thunderTaps.ambience))}  peak ${fmt(peakDb(thunderTaps.ambience))} dBFS;` +
      ` thunder alone ${fmt(thunder)}  peak ${fmt(peakDb(thunderOnly))} dBFS`,
  );
}

const engines: Record<string, number[]> = {};
const effects: Record<string, number[]> = {};
for (const kind of BOAT_KINDS) {
  if (ONLY && !ONLY.has(kind)) continue;
  for (const id of cruiseWeathers(kind)) {
    const stats: CruiseStats = { rpm: 0, load: 0, speed: 0, slams: 0, frames: 0 };
    const taps = await render(weather(id), boatScene(kind, weather(id), stats));
    const n = Math.max(1, stats.frames);
    (effects[kind] ??= []).push(loudness(taps.effects));
    if (powered(kind)) (engines[kind] ??= []).push(loudness(taps.engines));
    console.log(
      `  ${kind.padEnd(9)} ${id.padEnd(7)} engines ${fmt(powered(kind) ? loudness(taps.engines) : -Infinity)}` +
        `  effects ${fmt(loudness(taps.effects))}  (peaks ${fmt(peakDb(taps.engines))} / ${fmt(peakDb(taps.effects))} dBFS;` +
        ` ${(stats.rpm / n).toFixed(0)} rpm, load ${(stats.load / n).toFixed(2)}, ${(stats.speed / n / 0.5144).toFixed(1)} kn,` +
        ` ${stats.slams} slams)`,
    );
  }
}

const typical = {
  ambience: ONLY ? NaN : meanDb([ambience['breezy']!, ambience['gale']!]),
  engines: meanDb(Object.values(engines).map(meanDb)),
  effects: meanDb(Object.values(effects).map(meanDb)),
};
console.log(
  'Typical:',
  Object.entries(typical)
    .map(([b, v]) => `${b} ${v.toFixed(1)}`)
    .join(', '),
);

// Headroom: the powerboat slamming through a Storm with close thunder (a crack at 800 m), its
// horn and a scripted slam, mixed at the default volumes and with every volume at 100 %. The
// limiter (threshold −4 dB, 6 dB knee) starts to act around −7 dBFS before the master fader. And
// the loudest thing on flat water: a hydroplane flat out (200 mph) passing 12 m from a listener
// standing on the water, its Doppler drop and all.
const defaults = defaultSettings().audio;
const peaks: Record<string, { peakDb: number; overKnee: number; lufs: number }> = {};
const mixes: [string, Record<Bus, number>, number][] = [
  ['defaults', defaults, defaults.master],
  ['all 100 %, default master', { ambience: 1, effects: 1, engines: 1 }, defaults.master],
  ['all 100 %, master 100 %', { ambience: 1, effects: 1, engines: 1 }, 1],
];

function headroom(label: string, taps: Taps): void {
  console.log(`${label}, pre-limiter:`);
  for (const [name, volumes, master] of mixes) {
    const n = taps.ambience[0]!.length;
    const mix = [new Float32Array(n), new Float32Array(n)];
    for (const bus of ['ambience', 'effects', 'engines'] as const) {
      const g = volumeToGain(volumes[bus]) * volumeToGain(master);
      taps[bus].forEach((ch, c) => {
        const m = mix[c]!;
        for (let i = 0; i < n; i++) m[i]! += g * ch[i]!;
      });
    }
    const knee = Math.pow(10, -7 / 20);
    let over = 0;
    for (let i = 0; i < n; i++) if (Math.max(Math.abs(mix[0]![i]!), Math.abs(mix[1]![i]!)) > knee) over++;
    peaks[`${label}: ${name}`] = { peakDb: peakDb(mix), overKnee: over / n, lufs: loudness(mix) };
    console.log(
      `  ${name.padEnd(26)} ${fmt(loudness(mix))} LUFS, peak ${fmt(peakDb(mix))} dBFS,` +
        ` ${((100 * over) / n).toFixed(2)} % of samples past −7 dBFS`,
    );
  }
}

if (!ONLY) {
  const storm = weather('storm');
  const stormBoat = boatScene('powerboat', storm, { rpm: 0, load: 0, speed: 0, slams: 0, frames: 0 });
  const stormThunder = thunderScene([
    { at: 3, d: 800, cg: true },
    { at: 11, d: 2000, cg: true },
    { at: 19, d: 1200, cg: true },
    { at: 26, d: 3500, cg: false },
  ]);
  const busy = await render(storm, {
    step(t, frame, audio) {
      stormBoat.step(t, frame, audio);
      stormThunder.step(t, frame, audio);
    },
  });
  headroom('Busy storm', busy);
}

if (!ONLY || ONLY.has('hydro')) {
  const fair = weather('fair');
  const top = BOAT_SPECS.hydro.propulsion.topSpeed;
  const passAt = WARMUP + 8; // s
  const world = new SimWorld({
    seed: 1,
    physicsMode: 'arcade',
    boats: [{ id: 'player', kind: 'hydro', x: 0, z: top * passAt, heading: 0 }],
    wind: fair.wind,
    seaState: fair.seaState,
    oceanQuality: 'low',
    wakes: false,
  });
  world.boat('player')!.underWay(top, 1);
  const controls = {
    player: {
      throttle: 1,
      steer: 0,
      thruster: 0,
      trim: 0,
      mainSheet: 0,
      jibSheet: 0,
      brake: false,
      letFly: false,
    },
  };
  const flyby = await render(fair, {
    step(t, frame, audio) {
      const snap = world.advance({
        type: 'advance',
        targetTime: t + 1 / FPS,
        controls: controls as never,
        commands: [],
        probes: new Float64Array(),
      });
      frame.listener = {
        position: { x: 12, y: 2, z: 0 },
        forward: { x: -1, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
      };
      frame.boats = [boatAudioState(snap.boats[0]!)];
      if (t > 0) audio.handleSimEvents(snap.events);
    },
  });
  headroom('Hydroplane flyby at 12 m', flyby);
}
Object.assign(report, { ambience, thunder, engines, effects, typical, peaks });
const json = arg('json', '');
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
