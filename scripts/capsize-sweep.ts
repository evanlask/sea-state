// Capsize sweep: each boat in the real FFT ocean and wind of the weather presets, driven sensibly and
// carelessly for a couple of minutes, counting capsizes. Each (weather, seed, mode, kind) is one world with
// every scenario in it, 10 km apart (no wakes), run in its own child process. Too slow for a test
// (minutes); the regression tests encoding the results are in src/app/capsizeRule.test.ts.
//
// Usage: node scripts/capsize-sweep.ts [--kinds sail,powerboat,pwc] [--weather fair,breezy,near-gale,cross-seas,squalls,gale,storm,hurricane-1]
//          [--modes arcade,realistic] [--seeds 1,2] [--seconds 120] [--scen a,b] [--jobs 6] [--out rows.json]
//          [--trim auto|manual] [--reef a|0..3]
// TRACE=<scenario> prints that scenario's heel,
// pitch, heading, speed, breaking load and deck water whenever it heels past 30° or a breaker hits.
// Powered boats' scenarios (headings against the wind, which the sea runs with):
//   drift-head / drift-beam / drift-follow   engines stopped, nobody at the helm
//   full-head / full-beam / full-follow      full throttle, a helm holding the heading (small craft:
//                                            with at most a third of the helm)
//   hardover                                 full throttle, hard over from 5 s on
//   zigzag                                   full throttle, hard over one way then the other (ships every
//                                            20 s, small craft every 6 s)
// Small craft, careless and careful (a helm holding the heading, the throttle on a speed target):
//   slow-beam                                lying beam-on to the seas at steerage way (3 m/s)
//   slow-follow                              stern to the seas at steerage way: waves break over the transom
//   sea-bow                                  seamanlike: the seas 35° on the bow at a moderate speed (pwc
//                                            5 m/s, powerboat 7 m/s), easing off as the bow climbs a steep
//                                            face so it doesn't launch off the crest
//   sea-quarter                              seamanlike running off: the seas 150° off the bow, slower than
//                                            the waves (pwc 6 m/s, powerboat 8 m/s), easing off on a steep face
//   fast-turn / fast-zigzag                  full throttle with the seas 45° on the bow for 20 s, then hard
//                                            over and held / hard over one way then the other every 6 s
// Sailboat (reefed and the genoa furled as the HUD advises unless --reef; --trim manual: the sheets set at
// spawn for the course and left there, else auto-trim):
//   drift-beam                               sails set for a beam reach, nobody at the helm
//   beat / reach / broad / run               a helm holding 45 / 90 / 135 / 165° off the wind
//   hardover                                 from a beam reach, hard over from 5 s on (round and round)
//   zigzag                                   from a beam reach, hard over one way then the other every 8 s

import './register-ts.ts';
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { attitudeFromQuat } = await import('../src/sim/core/attitude.ts');
const { DEG, headingToVector, signedAngle } = await import('../src/sim/core/conventions.ts');
const { createSurfaceSample } = await import('../src/sim/ocean/OceanSurface.ts');
const { getWeatherPreset } = await import('../src/sim/weather/presets.ts');
const { neutralControls } = await import('../src/sim/world/protocol.ts');
const { SimWorld } = await import('../src/sim/world/SimWorld.ts');
const { sailSetupFor } = await import('../src/app/spawnPlan.ts');
const { trimmedSheets } = await import('../src/sim/sail/SailRig.ts');
const { polarSpeed } = await import('../src/sim/sail/orcPolar.ts');
const { FURL_BY_REEF, SHEET_SPEED } = await import('../src/app/spawnPlan.ts');
const { BOAT_SPECS } = await import('../src/sim/boats/specs/index.ts');
// Diagnostics: SPEC='{"pwc": {...}}' patches the specs (shallow) before the boats are built.
if (process.env['SPEC'])
  for (const [k, v] of Object.entries(JSON.parse(process.env['SPEC']) as Record<string, object>))
    Object.assign(BOAT_SPECS[k as BoatKind], v);

type BoatKind = import('../src/sim/world/protocol.ts').BoatKind;
type BoatSpawn = import('../src/sim/world/protocol.ts').BoatSpawn;
type PhysicsMode = import('../src/sim/world/protocol.ts').PhysicsMode;
type SimCommand = import('../src/sim/world/protocol.ts').SimCommand;
type BoatControls = import('../src/sim/world/protocol.ts').BoatControls;
type Snapshot = import('../src/sim/world/protocol.ts').Snapshot;

const SHIPS = new Set<BoatKind>(['cargo', 'cruise', 'crab']);
const POWER_SCEN = [
  'drift-head',
  'drift-beam',
  'drift-follow',
  'full-head',
  'full-beam',
  'full-follow',
  'hardover',
  'zigzag',
];
const SMALL_SCEN = ['slow-beam', 'slow-follow', 'sea-bow', 'sea-quarter', 'fast-turn', 'fast-zigzag'];
// Heading off the wind (and sea) of each powered scenario, deg; speed target of the throttled ones, m/s.
const POWER_REL: Record<string, number> = {
  'sea-bow': 35,
  'sea-quarter': 150,
  'fast-turn': 45,
  'fast-zigzag': 45,
};
const STEER_POWER = 0.2; // throttle the outboards and the jet need to steer
const FAST = 20; // s flat out before the fast-turn and fast-zigzag cases put the helm over
function speedTarget(kind: BoatKind, sc: string): number | null {
  if (sc.startsWith('slow')) return 3;
  if (sc === 'sea-bow') return kind === 'pwc' ? 5 : 7;
  if (sc === 'sea-quarter') return kind === 'pwc' ? 6 : 8;
  return null;
}
const SAIL_SCEN = ['drift-beam', 'beat', 'reach', 'broad', 'run', 'hardover', 'zigzag'];
const SAIL_TWA: Record<string, number> = { beat: 45, reach: 90, broad: 135, run: 165 };

interface Job {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  kind: BoatKind;
  seconds: number;
  scen: string[];
  trim: 'auto' | 'manual';
  reef: number | null;
}

interface Row {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  kind: BoatKind;
  scen: string;
  capsizeAt: number | null;
  maxHeel: number; // deg, until any capsize
  over45: number; // share of the run heeled past 45°
  knockdowns: number; // excursions past 70° that came back
  deck: number; // kg, worst deck water
  flood: number; // kg, worst flood water
  downflooding: number; // times an opening went under
  speed: number; // m/s mean through the water
  breaking: number; // worst breaking-crest impact, in boat weights
  breakingShare: number; // share of the samples with a crest breaking on the hull
  upright: boolean; // at the end
}

function twaFor(scen: string): number {
  return (SAIL_TWA[scen] ?? 90) * DEG;
}

function runJob(job: Job): Row[] {
  const p = getWeatherPreset(job.weather);
  const wind = { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor };
  const sail = job.kind === 'sail';
  const spawns: BoatSpawn[] = job.scen.map((sc, i) => {
    const id = `${job.kind}|${sc}`;
    // 10 km apart: a jet ski flat out covers 3 km in two minutes, and a collision is not a capsize.
    const x = i * 10_000;
    const z = 0;
    if (sail) {
      // + wind from starboard: heading = from − twa.
      const twa = twaFor(sc);
      const setup = sailSetupFor(wind.speed, twa);
      if (job.reef !== null) {
        const furl = FURL_BY_REEF[job.reef] ?? 2 / 3;
        const sheets = trimmedSheets(
          wind.speed,
          twa,
          SHEET_SPEED * polarSpeed(wind.speed, twa),
          job.reef,
          furl,
        );
        Object.assign(setup, { reef: job.reef, furl, mainSheet: sheets.main, jibSheet: sheets.jib });
      }
      return { id, kind: job.kind, x, z, heading: wind.from - twa, sail: setup };
    }
    const rel = (POWER_REL[sc] ?? (sc.endsWith('beam') ? 90 : sc.endsWith('follow') ? 180 : 0)) * DEG;
    // The crab boat with the setup's default deck load (CRAB_POTS overrides).
    const load = job.kind === 'crab' ? { crabPots: Number(process.env['CRAB_POTS'] ?? 120) } : undefined;
    return { id, kind: job.kind, x, z, heading: wind.from + rel, load };
  });
  const world = new SimWorld({
    seed: job.seed,
    physicsMode: job.mode,
    boats: spawns,
    wind,
    seaState: p.seaState,
    oceanQuality: 'low',
    wakes: false,
  });
  const commands: SimCommand[] = [];
  world.boats.forEach((b, i) => {
    b.setAutopilot(null);
    const sc = job.scen[i]!;
    if (sail && SAIL_TWA[sc] !== undefined) b.setAutopilot({ mode: 'windAngle', twa: twaFor(sc) });
    if (sail) commands.push({ type: 'autoTrim', boatId: b.id, enabled: job.trim === 'auto' });
  });
  const zig = SHIPS.has(job.kind) ? 20 : sail ? 8 : 6;
  const att = { heading: 0, pitch: 0, roll: 0 };
  const st = spawns.map((s) => ({
    heading: s.heading,
    throttle: 0.3,
    alert: 0, // s left squared up to a breaking sea the helm saw coming
    capsizeAt: null as number | null,
    maxHeel: 0,
    over45: 0,
    knockdowns: 0,
    down: false,
    deck: 0,
    flood: 0,
    dfl: 0,
    dfPrev: false,
    speed: 0,
    n: 0,
    brk: 0,
    brkN: 0,
  }));
  const controls: Record<string, BoatControls> = {};
  // The careful helm watches the sea up-wind (where the seas come from) 30–120 m off: a crest about to
  // break there (steepness past 0.16, the breaking limit being 0.22) has it square up for 6 s.
  const sea = world.oceanField as import('../src/sim/ocean/OceanSurface.ts').OceanSurface;
  const look = createSurfaceSample();
  const up = headingToVector(wind.from);
  const watchUpSea = (i: number, t: number): void => {
    const x = st[i]!;
    x.alert = Math.max(0, x.alert - dt);
    if (Math.round(t / dt) % 5 !== 0 || typeof sea.query !== 'function') return;
    const p = snap!.boats[i]!.position;
    for (const d of [30, 60, 90, 120]) {
      sea.query(p.x + up.x * d, p.z + up.z * d, t, look);
      if (look.steepness > 0.16) x.alert = 6;
    }
  };
  const dt = SHIPS.has(job.kind) ? 0.25 : 0.1;
  let snap: Snapshot | null = null;
  for (let step = 1; step * dt <= job.seconds + 1e-9; step++) {
    const t = step * dt;
    world.boats.forEach((b, i) => {
      const sc = job.scen[i]!;
      if (sc.startsWith('drift') || (sail && SAIL_TWA[sc] !== undefined)) {
        delete controls[b.id];
        return;
      }
      const c = neutralControls();
      c.throttle = sail ? 0 : 1;
      let target = speedTarget(job.kind, sc);
      const careful = sc.startsWith('sea-');
      if (careful && snap) watchUpSea(i, t);
      const squared = careful && st[i]!.alert > 0;
      if (squared && target !== null) target += sc === 'sea-bow' ? 2 : 4;
      if (target !== null && snap) {
        // A throttle hand on a speed target (integral), never below the power the drive needs to steer,
        // easing off while the bow climbs a steep face.
        const s = snap.boats[i]!;
        attitudeFromQuat(s.orientation, att);
        const x = st[i]!;
        const u = s.telemetry['surge'] ?? 0;
        x.throttle = Math.max(STEER_POWER, Math.min(1, x.throttle + dt * 0.15 * (target - u)));
        c.throttle = att.pitch > 12 * DEG ? Math.min(x.throttle, 0.25) : x.throttle;
      }
      if (sc === 'hardover') c.steer = t > 5 ? 1 : 0;
      else if (sc === 'zigzag') c.steer = t > 5 ? (Math.floor((t - 5) / zig) % 2 ? -1 : 1) : 0;
      else if (sc === 'fast-turn' && t > FAST) c.steer = 1;
      else if (sc === 'fast-zigzag' && t > FAST) c.steer = Math.floor((t - FAST) / zig) % 2 ? -1 : 1;
      else if (snap) {
        // A helm holding the spawn heading; flat out on the small craft a sensible one, correcting with
        // up to a third of the helm (full lock at 40 kn in a seaway is the hardover and zigzag cases);
        // at the slow and seamanlike speeds as much helm as it takes.
        const s = snap.boats[i]!;
        attitudeFromQuat(s.orientation, att);
        const yaw = s.telemetry['yawRate'] ?? 0;
        const ship = SHIPS.has(job.kind);
        // The seamanlike helm squares up to a breaking sea it sees coming: bow (or stern) to it.
        const want = squared ? wind.from + (sc === 'sea-bow' ? 0 : Math.PI) : st[i]!.heading;
        const err = signedAngle(want - att.heading - yaw * (ship ? 25 : 1.5));
        const max = ship || target !== null ? 1 : 0.3;
        c.steer = Math.max(-max, Math.min(max, err * (ship ? 2.5 : target !== null ? 2 : 1)));
        // The careful helm steers with the throttle too: outboards and jets steer by their thrust.
        if (careful && Math.abs(err) > 15 * DEG) c.throttle = Math.max(c.throttle, 0.6);
      }
      controls[b.id] = c;
    });
    snap = world.advance({
      type: 'advance',
      targetTime: t,
      controls,
      commands: step === 1 ? commands : [],
      probes: new Float64Array(),
    });
    for (const e of snap.events) {
      if (e.type === 'collision') console.error(`collision ${e.boatId} ${e.otherId} at ${t}`);
      if (e.type !== 'capsized') continue;
      const x = st[world.boats.findIndex((b) => b.id === e.boatId)];
      if (x && x.capsizeAt === null) x.capsizeAt = t;
    }
    snap.boats.forEach((b, i) => {
      const x = st[i]!;
      attitudeFromQuat(b.orientation, att);
      const heel = Math.abs(att.roll) / DEG;
      if (heel > 45 || x.capsizeAt !== null) x.over45++;
      if (x.capsizeAt !== null) return;
      x.maxHeel = Math.max(x.maxHeel, heel);
      if (heel > 70) x.down = true;
      else if (x.down && heel < 30) {
        x.down = false;
        x.knockdowns++;
      }
      const tel = b.telemetry;
      x.deck = Math.max(x.deck, tel['deckWaterMass'] ?? 0);
      x.flood = Math.max(x.flood, tel['floodWaterMass'] ?? 0);
      const df = (tel['downflooding'] ?? 0) > 0.5;
      if (df && !x.dfPrev) x.dfl++;
      x.dfPrev = df;
      x.speed += tel['speedThroughWater'] ?? 0;
      x.n++;
      const brk = (tel['breaking'] ?? 0) / ((tel['mass'] ?? 1) * 9.81);
      if (process.env['TRACE'] === job.scen[i] && (heel > 30 || brk > 0.3))
        console.error(
          `${job.scen[i]} t=${t.toFixed(1)} heel=${heel.toFixed(0)} pitch=${(att.pitch / DEG).toFixed(0)} rel=${(signedAngle(att.heading - wind.from) / DEG).toFixed(0)} u=${(tel['surge'] ?? 0).toFixed(1)} brk=${brk.toFixed(2)} deck=${(tel['deckWaterMass'] ?? 0).toFixed(0)} alert=${x.alert.toFixed(1)}`,
        );
      x.brk = Math.max(x.brk, brk);
      if (brk > 0) x.brkN++;
    });
  }
  const steps = Math.round(job.seconds / dt);
  return world.boats.map((b, i) => {
    const x = st[i]!;
    attitudeFromQuat(b.dyn.body.orientation, att);
    return {
      weather: job.weather,
      seed: job.seed,
      mode: job.mode,
      kind: job.kind,
      scen: job.scen[i]!,
      capsizeAt: x.capsizeAt,
      maxHeel: Math.round(x.maxHeel),
      over45: x.over45 / steps,
      knockdowns: x.knockdowns,
      deck: x.deck,
      flood: x.flood,
      downflooding: x.dfl,
      speed: x.speed / Math.max(1, x.n),
      breaking: x.brk,
      breakingShare: x.brkN / Math.max(1, x.n),
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
  const kinds = arg('kinds', 'sail,powerboat,pwc').split(',') as BoatKind[];
  const weathers = arg('weather', 'fair,breezy,near-gale,cross-seas,squalls,gale,storm,hurricane-1').split(
    ',',
  );
  const modes = arg('modes', 'arcade,realistic').split(',') as PhysicsMode[];
  const seeds = arg('seeds', '1,2').split(',').map(Number);
  const seconds = Number(arg('seconds', '120'));
  const scenArg = arg('scen', '');
  const trim = arg('trim', 'auto') as 'auto' | 'manual';
  const reefArg = arg('reef', 'a');
  const reef = reefArg === 'a' ? null : Number(reefArg);
  const parallel = Number(arg('jobs', '6'));
  const out = arg('out', '');
  const jobs: Job[] = [];
  for (const weather of weathers)
    for (const mode of modes)
      for (const kind of kinds)
        for (const seed of seeds) {
          const all =
            kind === 'sail' ? SAIL_SCEN : SHIPS.has(kind) ? POWER_SCEN : [...POWER_SCEN, ...SMALL_SCEN];
          const scen = scenArg ? scenArg.split(',').filter((s) => all.includes(s)) : all;
          jobs.push({ weather, seed, mode, kind, seconds, scen, trim, reef });
        }
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
  // Per scenario over the seeds: capsizes / runs (times), worst heel per run, knock-downs, share past 45°,
  // worst deck and flood water, downflooding events, mean speed.
  const groups = new Map<string, Row[]>();
  const cells = new Map<string, Row[]>();
  for (const r of rows) {
    const key = [r.kind, r.weather, r.mode, r.scen].join('\t');
    groups.set(key, [...(groups.get(key) ?? []), r]);
    const cell = [r.kind, r.weather, r.mode].join('\t');
    cells.set(cell, [...(cells.get(cell) ?? []), r]);
  }
  console.log(
    'kind\tweather\tmode\tscen\tcapsized\theel\tknock\tover45\tdeck kg\tflood kg\tdfl\tspeed\tbrk g\tbrk %',
  );
  for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const caps = g.filter((r) => r.capsizeAt !== null);
    console.log(
      [
        key,
        `${caps.length}/${g.length}${caps.length ? `@${caps.map((r) => r.capsizeAt!.toFixed(0)).join('/')}` : ''}`,
        g.map((r) => r.maxHeel).join('/'),
        g.map((r) => r.knockdowns).join('/'),
        (g.reduce((a, r) => a + r.over45, 0) / g.length).toFixed(2),
        g.map((r) => r.deck.toFixed(0)).join('/'),
        g.map((r) => r.flood.toFixed(0)).join('/'),
        g.map((r) => r.downflooding).join('/'),
        (g.reduce((a, r) => a + r.speed, 0) / g.length).toFixed(1),
        g.map((r) => r.breaking.toFixed(2)).join('/'),
        g.map((r) => (100 * r.breakingShare).toFixed(1)).join('/'),
      ].join('\t'),
    );
  }
  console.log('\nkind\tweather\tmode\tcapsized');
  for (const [key, g] of [...cells].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(`${key}\t${g.filter((r) => r.capsizeAt !== null).length}/${g.length}`);
}
