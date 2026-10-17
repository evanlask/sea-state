// Spawn sweep: drops boats into the real FFT ocean and wind of the weather presets at a set of headings
// relative to the wind, and records whether and when each capsizes, how far it rolls, how far it yaws by
// itself and (sailboat) whether it sails off or ends up in irons. Each (weather, seed, mode) is one world
// with every case in it, 900 m apart (no wakes), run in its own child process. The measurements behind
// src/app/spawnPlan.ts; too slow for a test (minutes), its regression test lives in spawnPlan.test.ts.
//
// Usage: node scripts/spawn-sweep.ts [--seconds 60] [--seeds 1,2,3] [--modes arcade,realistic]
//          [--weather gale,storm,cross] [--kinds sail,pwc] [--rel 0,20,45,90,135,180]
//          [--variants old,rest,way,motor,plan,planway,planmotor] [--sails 3:0.67:20:0,a:a:0:0]
//          [--trim 0.5] [--jobs 8] [--out rows.json]
// Variants: `old` the spawn before the plan (heading north, default sails); `rest` dead in the water at
// --rel off the wind, nobody at the helm; `way` the same with a little steerage way; `motor` with a helm
// holding that heading at 40% power; `plan` / `planway` (plus steerage way) / `planmotor` the spawn plan
// (--rel is ignored). --sails sets the sailboat's reef:furl:mainEase:jibEase (deg past trim; `a` = as the
// plan advises) for the rest/way/motor cases, sheets trimmed for the wind at --trim × the polar speed.
// `cross` is a 40 kn, 5 m wind sea with a 6 m, 14 s swell from 90° to its right.

import './register-ts.ts';
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { attitudeFromQuat } = await import('../src/sim/core/attitude.ts');
const { DEG, signedAngle } = await import('../src/sim/core/conventions.ts');
const { knotsToMs } = await import('../src/sim/core/units.ts');
const { BOAT_SPECS } = await import('../src/sim/boats/specs/index.ts');
const { polarSpeed } = await import('../src/sim/sail/orcPolar.ts');
const { trimmedSheets } = await import('../src/sim/sail/SailRig.ts');
const { SAIL_KEYS } = await import('../src/sim/sail/telemetry.ts');
const { getWeatherPreset } = await import('../src/sim/weather/presets.ts');
const { neutralControls } = await import('../src/sim/world/protocol.ts');
const { SimWorld } = await import('../src/sim/world/SimWorld.ts');
const { sailSetupFor, spawnPlan } = await import('../src/app/spawnPlan.ts');

type BoatKind = import('../src/sim/world/protocol.ts').BoatKind;
type BoatSpawn = import('../src/sim/world/protocol.ts').BoatSpawn;
type PhysicsMode = import('../src/sim/world/protocol.ts').PhysicsMode;
type SimCommand = import('../src/sim/world/protocol.ts').SimCommand;
type SimConfig = import('../src/sim/world/protocol.ts').SimConfig;
type WindConfig = import('../src/sim/world/protocol.ts').WindConfig;
type SeaStateSettings = import('../src/sim/weather/seaState.ts').SeaStateSettings;

interface Weather {
  wind: WindConfig;
  seaState: SeaStateSettings;
}

const CROSS: Weather = {
  wind: { speed: knotsToMs(40), from: 250 * DEG, gustFactor: 1.3 },
  seaState: {
    mode: 'manual',
    height: { kind: 'hs', hs: 5 },
    tp: null,
    choppiness: 1,
    crestLength: 'normal',
    directionOffset: 0,
    swell: { height: 6, period: 14, from: 340 * DEG },
  },
};

function weatherFor(id: string): Weather {
  if (id === 'cross') return CROSS;
  const p = getWeatherPreset(id);
  return { wind: { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor }, seaState: p.seaState };
}

// A little steerage way: enough for the rudder to bite, gone in seconds with the engine stopped.
const WAY: Record<BoatKind, number> = {
  cargo: 3,
  cruise: 3,
  crab: 2.5,
  sail: 2,
  powerboat: 3,
  pwc: 3,
  hydro: 3,
};

type Variant = 'old' | 'rest' | 'way' | 'motor' | 'plan' | 'planway' | 'planmotor';

interface Case {
  kind: BoatKind;
  variant: Variant;
  rel: number; // deg off the wind (+ wind on the starboard bow); NaN for the plan
  sail?: number[]; // reef, furl ('a' / NaN: as the plan advises), main and jib sheets eased past trim (deg)
}

interface Job {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  seconds: number;
  trim: number;
  cases: Case[];
}

interface Row {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  variant: Variant;
  kind: BoatKind;
  sail: string; // reef:furl
  rel: number; // deg off the wind at spawn
  capsizeAt: number | null; // s
  maxRoll: number; // deg, until any capsize
  meanRoll: number; // deg, mean |roll| (until any capsize)
  over45: number; // share of the run heeled past 45°
  rel10: number; // deg off the wind after 10 s
  relEnd: number;
  speed: number; // m/s, mean through the water over the second half
  irons: number; // sailboat: share of the run in irons
  ironsAt: number | null; // s, first in irons
  upright: boolean; // at the end
}

function runJob(job: Job): Row[] {
  const w = weatherFor(job.weather);
  const spawns: BoatSpawn[] = [];
  const motor: boolean[] = [];
  job.cases.forEach((c, i) => {
    const x = (i % 8) * 900;
    const z = Math.floor(i / 8) * 900;
    const id = `${c.kind}-${i}`;
    if (c.variant === 'plan' || c.variant === 'planway' || c.variant === 'planmotor') {
      const plan = spawnPlan(c.kind, w.wind, w.seaState, job.mode);
      spawns.push({
        id,
        kind: c.kind,
        x,
        z,
        ...plan,
        ...(c.variant === 'planway' ? { speed: WAY[c.kind] } : {}),
      });
    } else if (c.variant === 'old') {
      spawns.push({ id, kind: c.kind, x, z, heading: 0 });
    } else {
      const twa = c.rel * DEG;
      const spawn: BoatSpawn = { id, kind: c.kind, x, z, heading: w.wind.from - twa };
      if (c.variant === 'way') spawn.speed = WAY[c.kind];
      if (c.kind === 'sail' && c.sail) {
        const advised = sailSetupFor(w.wind.speed, twa);
        const [r = NaN, f = NaN, mainEase = 0, jibEase = 0] = c.sail;
        const reef = Number.isNaN(r) ? advised.reef : r;
        const furl = Number.isNaN(f) ? advised.furl : f;
        const v = job.trim * polarSpeed(w.wind.speed, twa);
        const sheets = trimmedSheets(w.wind.speed, twa, v, reef, furl);
        const main = sheets.main + mainEase * DEG;
        const jib = sheets.jib + jibEase * DEG;
        spawn.sail = { reef, furl, mainSheet: main, jibSheet: jib };
      }
      spawns.push(spawn);
    }
    motor.push(c.variant === 'motor' || c.variant === 'planmotor');
  });
  const config: SimConfig = {
    seed: job.seed,
    physicsMode: job.mode,
    boats: spawns,
    wind: w.wind,
    seaState: w.seaState,
    oceanQuality: 'low',
    wakes: false,
  };
  const world = new SimWorld(config);
  const controls: Record<string, ReturnType<typeof neutralControls>> = {};
  // The world puts every boat but the first on station-keeping, which also turns a sailboat's
  // auto-trim on: unattended boats are left as the player's boat would be (auto-trim by mode).
  const commands: SimCommand[] = [];
  world.boats.forEach((b, i) => {
    if (!motor[i]) {
      controls[b.id] = neutralControls();
      b.setAutopilot(null);
      commands.push({ type: 'autoTrim', boatId: b.id, enabled: job.mode === 'arcade' });
    } else {
      const p = BOAT_SPECS[b.kind].propulsion;
      b.setAutopilot({
        mode: 'hold',
        heading: spawns[i]!.heading,
        speed: 0.4 * (p.serviceSpeed ?? p.topSpeed),
      });
    }
  });
  const att = { heading: 0, pitch: 0, roll: 0 };
  const stats = spawns.map(() => ({
    capsizeAt: null as number | null,
    maxRoll: 0,
    sumRoll: 0,
    over45: 0,
    n: 0,
    rel10: 0,
    speed: 0,
    ns: 0,
    irons: 0,
    ironsAt: null as number | null,
  }));
  const dt = 0.25;
  for (let step = 1; step * dt <= job.seconds + 1e-9; step++) {
    const t = step * dt;
    const snap = world.advance({
      type: 'advance',
      targetTime: t,
      controls,
      commands: step === 1 ? commands : [],
      probes: new Float64Array(),
    });
    for (const e of snap.events) {
      if (e.type !== 'capsized') continue;
      const st = stats[world.boats.findIndex((b) => b.id === e.boatId)];
      if (st && st.capsizeAt === null) st.capsizeAt = t;
    }
    snap.boats.forEach((b, k) => {
      const st = stats[k]!;
      attitudeFromQuat(b.orientation, att);
      const roll = Math.abs(att.roll) / DEG;
      if (st.capsizeAt === null) {
        st.maxRoll = Math.max(st.maxRoll, roll);
        st.sumRoll += roll;
        st.n++;
      }
      if (roll > 45 || st.capsizeAt !== null) st.over45++;
      if ((b.telemetry[SAIL_KEYS.inIrons] ?? 0) > 0.5) {
        st.irons++;
        st.ironsAt ??= t;
      }
      if (t > job.seconds / 2) {
        st.speed += b.telemetry['speedThroughWater'] ?? 0;
        st.ns++;
      }
      if (Math.abs(t - 10) < 1e-6) st.rel10 = signedAngle(w.wind.from - att.heading) / DEG;
    });
  }
  const steps = Math.round(job.seconds / dt);
  return world.boats.map((b, k) => {
    const st = stats[k]!;
    const c = job.cases[k]!;
    attitudeFromQuat(b.dyn.body.orientation, att);
    const s = spawns[k]!;
    return {
      weather: job.weather,
      seed: job.seed,
      mode: job.mode,
      variant: c.variant,
      kind: c.kind,
      sail: c.sail ? c.sail.join(':') : s.sail ? `${s.sail.reef}:${s.sail.furl.toFixed(2)}` : '',
      rel: Math.round(signedAngle(w.wind.from - s.heading) / DEG),
      capsizeAt: st.capsizeAt,
      maxRoll: Math.round(st.maxRoll),
      meanRoll: Math.round(st.sumRoll / Math.max(1, st.n)),
      over45: st.over45 / steps,
      rel10: Math.round(st.rel10),
      relEnd: Math.round(signedAngle(w.wind.from - att.heading) / DEG),
      speed: st.speed / Math.max(1, st.ns),
      irons: st.irons / steps,
      ironsAt: st.ironsAt,
      upright: !b.capsized && Math.abs(att.roll) < 60 * DEG,
    };
  });
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};

if (args[0] === '--job') {
  process.stdout.write(JSON.stringify(runJob(JSON.parse(args[1]!) as Job)));
} else {
  const seconds = Number(arg('seconds', '60'));
  const seeds = arg('seeds', '1,2,3').split(',').map(Number);
  const modes = arg('modes', 'arcade').split(',') as PhysicsMode[];
  const weathers = arg(
    'weather',
    'squalls,near-gale,gale,storm,hurricane-1,hurricane-3,hurricane-5,long-swell,cross-seas,cross',
  ).split(',');
  const kinds = arg('kinds', 'cargo,cruise,crab,sail,powerboat,pwc').split(',') as BoatKind[];
  const rels = arg('rel', '0,20,45,90,135,180').split(',').map(Number);
  const variants = arg('variants', 'rest').split(',') as Variant[];
  const sails = args.includes('--sails')
    ? arg('sails', '')
        .split(',')
        .map((s) => s.split(':').map((v) => (v === 'a' ? NaN : Number(v))))
    : [undefined];
  const trim = Number(arg('trim', '0.5'));
  const parallel = Number(arg('jobs', '14'));
  const out = arg('out', '');
  const cases: Case[] = [];
  for (const kind of kinds)
    for (const variant of variants) {
      if (variant === 'plan' || variant === 'planway' || variant === 'planmotor' || variant === 'old') {
        cases.push({ kind, variant, rel: NaN });
        continue;
      }
      for (const rel of rels)
        for (const sail of kind === 'sail' ? sails : [undefined]) cases.push({ kind, variant, rel, sail });
    }
  const jobs: Job[] = [];
  for (const weather of weathers)
    for (const seed of seeds)
      for (const mode of modes) jobs.push({ weather, seed, mode, seconds, trim, cases });
  const self = fileURLToPath(import.meta.url);
  const rows: Row[] = [];
  let next = 0;
  let done = 0;
  const started = Date.now();
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const text = await new Promise<string>((resolve, reject) => {
        const child = spawnChild(process.execPath, [self, '--job', JSON.stringify(job)], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let buf = '';
        child.stdout.on('data', (d: Buffer) => (buf += d.toString()));
        child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(`job failed: ${code}`))));
      });
      rows.push(...(JSON.parse(text) as Row[]));
      done++;
      process.stderr.write(`\r${done}/${jobs.length} jobs, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  process.stderr.write('\n');
  if (out) writeFileSync(out, JSON.stringify(rows));
  // One line per case over the seeds: capsizes / runs (earliest), worst roll, mean roll, share heeled
  // past 45°, heading off the wind after 10 s and at the end (means), speed, share in irons.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const rel = ['plan', 'planway', 'planmotor', 'old'].includes(r.variant) ? 'plan' : r.rel;
    const key = [r.weather, r.mode, r.variant, r.kind, r.sail, rel].join('\t');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  console.log(
    'weather\tmode\tvariant\tkind\tsail\trel\tcapsized\tmaxRoll\tmeanRoll\tover45\trel10\trelEnd\tspeed\tirons\tironsAt',
  );
  const mean = (g: Row[], f: (r: Row) => number): number => g.reduce((a, r) => a + f(r), 0) / g.length;
  const median = (v: number[]): string =>
    v.length ? v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!.toFixed(0) : '-';
  for (const [key, g] of groups) {
    const caps = g.filter((r) => r.capsizeAt !== null).map((r) => r.capsizeAt!);
    console.log(
      [
        key + (key.endsWith('plan') ? `(${g[0]!.rel})` : ''),
        `${caps.length}/${g.length}${caps.length ? `@${Math.min(...caps).toFixed(0)}` : ''}`,
        Math.max(...g.map((r) => r.maxRoll)),
        mean(g, (r) => r.meanRoll).toFixed(0),
        mean(g, (r) => r.over45).toFixed(2),
        mean(g, (r) => r.rel10).toFixed(0),
        mean(g, (r) => r.relEnd).toFixed(0),
        mean(g, (r) => r.speed).toFixed(1),
        mean(g, (r) => r.irons).toFixed(2),
        `${g.filter((r) => r.ironsAt !== null).length}/${g.length}@${median(g.flatMap((r) => (r.ironsAt === null ? [] : [r.ironsAt])))}`,
      ].join('\t'),
    );
  }
}
