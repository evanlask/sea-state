// After a capsize: does the boat stay upside down, or keep rolling over in the seas? Each boat kind in
// the real FFT ocean and wind of the weather presets, (a) driven carelessly until it capsizes, then
// simulated on for --after seconds with the helm still at it (or, --helm off, let go), and (b) spawned
// upside down at four headings to the sea and left for --after seconds. Counts the flips after the
// capsize (crossings between upright, tilt < 60°, and inverted, tilt > 120°): those of the capsize
// tumble itself, in its first SETTLE seconds ('crash'), and those after it, with the full roll-overs
// (two flips: inverted → upright → inverted again, or the reverse), what each flip came with (a
// breaking crest, the hull buried or thrown clear, or just the sea), and the share of the time after
// the tumble spent inverted (tilt > 90°).
//
// Usage: node scripts/capsize-rolls.ts [--kinds pwc,powerboat,sail] [--weather storm,hurricane-1,hurricane-3]
//          [--modes realistic] [--seeds 1,2,3] [--after 120] [--limit 180] [--helm on|off] [--jobs 8]
//          [--only inv|full|...] [--out rows.json]
// --limit: seconds the careless cases have to capsize. TRACE=<scenario> prints that scenario's tilt
// once a second after the capsize (and every step while it is on its side or a crest is breaking on it);
// FLIPS=1 prints every flip. SPEC='{"pwc": {...}}' patches the specs.

import './register-ts.ts';
import { spawn as spawnChild } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { DEG } = await import('../src/sim/core/conventions.ts');
const { getWeatherPreset } = await import('../src/sim/weather/presets.ts');
const { neutralControls } = await import('../src/sim/world/protocol.ts');
const { SimWorld } = await import('../src/sim/world/SimWorld.ts');
const { sailSetupFor } = await import('../src/app/spawnPlan.ts');
const { BOAT_SPECS } = await import('../src/sim/boats/specs/index.ts');
// Diagnostics: SPEC='{"pwc": {...}}' patches the specs (shallow) before the boats are built.
if (process.env['SPEC'])
  for (const [k, v] of Object.entries(JSON.parse(process.env['SPEC']) as Record<string, object>))
    Object.assign(BOAT_SPECS[k as BoatKind], v);

type BoatKind = import('../src/sim/world/protocol.ts').BoatKind;
type BoatSpawn = import('../src/sim/world/protocol.ts').BoatSpawn;
type PhysicsMode = import('../src/sim/world/protocol.ts').PhysicsMode;
type BoatControls = import('../src/sim/world/protocol.ts').BoatControls;

// Careless driving (throttle flat out) and the upside-down spawns, by heading off the wind (deg).
const CARELESS: Record<string, number> = {
  'full-beam': 90,
  'full-follow': 180,
  hardover: 0,
  zigzag: 0,
  'fast-zigzag': 45,
  'slow-beam': 90,
};
// s after the capsize (or the upside-down spawn) left out of the flips and the time inverted: the
// capsize tumble itself (a ski thrown over at 40 kn cartwheels for a few seconds) and the spawn's drop.
const SETTLE = 5;
const INVERTED: Record<string, number> = {
  'inv-head': 0,
  'inv-beam': 90,
  'inv-follow': 180,
  'inv-quarter': 135,
};

interface Job {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  kind: BoatKind;
  after: number;
  limit: number;
  helm: boolean;
  only: string; // scenarios starting with this ('' all)
}

interface Row {
  weather: string;
  seed: number;
  mode: PhysicsMode;
  kind: BoatKind;
  scen: string;
  capsizeAt: number | null;
  crash: number; // hemisphere crossings in the first SETTLE s after the capsize (the tumble itself)
  flips: number; // hemisphere crossings after that
  rollOvers: number; // full roll-overs (two flips) after the SETTLE s
  inverted: number; // share of the time after the SETTLE s past 90°
  endInverted: boolean; // at the end of the time after the capsize
  causes: { breaker: number; buried: number; airborne: number; sea: number };
}

function runJob(job: Job): Row[] {
  const p = getWeatherPreset(job.weather);
  const wind = { speed: p.windSpeed, from: p.windFrom, gustFactor: p.gustFactor };
  const sail = job.kind === 'sail';
  const scen = [...Object.keys(CARELESS), ...Object.keys(INVERTED)].filter(
    (sc) => !job.only || sc.startsWith(job.only),
  );
  const spawns: BoatSpawn[] = scen.map((sc, i) => {
    const rel = (CARELESS[sc] ?? INVERTED[sc] ?? 0) * DEG;
    const heading = wind.from + rel;
    return {
      id: `${job.kind}|${sc}`,
      kind: job.kind,
      x: i * 10_000,
      z: 0,
      heading,
      sail: sail ? sailSetupFor(wind.speed, rel) : undefined,
    };
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
  world.boats.forEach((b, i) => {
    b.setAutopilot(null);
    const sc = scen[i]!;
    if (INVERTED[sc] !== undefined) {
      const s = spawns[i]!;
      b.dyn.placeAtRest(s.x, s.z, s.heading, Math.PI, 0.4);
      b.water.reset();
    }
  });
  const dt = 0.1;
  const st = scen.map((sc) => ({
    capsizeAt: INVERTED[sc] !== undefined ? 0 : (null as number | null),
    side: 0, // +1 inverted, −1 upright, 0 not yet seen either way
    crash: 0, // flips in the first SETTLE s (the capsize tumble itself)
    flips: 0, // after that
    inv: 0,
    n: 0,
    tilt: 0,
    // What each flip came with over the 1.5 s before it: a breaking crest on the hull (> 0.3 boat
    // weights), the hull buried (immersion > 0.97), thrown clear (< 0.05), or none of those (the sea).
    recent: [] as { brk: number; imm: number }[],
    causes: { breaker: 0, buried: 0, airborne: 0, sea: 0 },
  }));
  const controls: Record<string, BoatControls> = {};
  const total = job.limit + job.after;
  for (let step = 1; step * dt <= total + 1e-9; step++) {
    const t = step * dt;
    world.boats.forEach((b, i) => {
      const sc = scen[i]!;
      const x = st[i]!;
      if (INVERTED[sc] !== undefined || (x.capsizeAt !== null && !job.helm) || sail) {
        delete controls[b.id];
        return;
      }
      const c = neutralControls();
      c.throttle = sc === 'slow-beam' ? 0.3 : 1;
      if (sc === 'hardover') c.steer = t > 5 ? 1 : 0;
      else if (sc === 'zigzag') c.steer = t > 5 ? (Math.floor((t - 5) / 6) % 2 ? -1 : 1) : 0;
      else if (sc === 'fast-zigzag' && t > 20) c.steer = Math.floor((t - 20) / 6) % 2 ? -1 : 1;
      controls[b.id] = c;
    });
    const snap = world.advance({
      type: 'advance',
      targetTime: t,
      controls,
      commands: [],
      probes: new Float64Array(),
    });
    for (const e of snap.events) {
      if (e.type !== 'capsized') continue;
      const x = st[world.boats.findIndex((b) => b.id === e.boatId)];
      if (x && x.capsizeAt === null) x.capsizeAt = t;
    }
    snap.boats.forEach((b, i) => {
      const x = st[i]!;
      const q = b.orientation;
      // Body up in the world: its y component is 1 − 2(qx² + qz²).
      const tilt = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z)))) / DEG;
      if (x.capsizeAt === null || t < x.capsizeAt || t > x.capsizeAt + job.after) return;
      x.tilt = tilt;
      const brkNow = (b.telemetry['breaking'] ?? 0) / ((b.telemetry['mass'] ?? 1) * 9.81);
      x.recent.push({ brk: brkNow, imm: b.telemetry['immersion'] ?? 0 });
      if (x.recent.length > 15) x.recent.shift();
      const side = tilt > 120 ? 1 : tilt < 60 ? -1 : 0;
      const settled = t >= x.capsizeAt + SETTLE;
      if (side !== 0 && x.side !== 0 && side !== x.side) {
        if (process.env['FLIPS'])
          console.error(`flip ${scen[i]} seed ${job.seed} ${job.weather} +${(t - x.capsizeAt).toFixed(1)}s`);
        if (!settled) x.crash++;
        else {
          x.flips++;
          const r = x.recent;
          if (r.some((e) => e.brk > 0.3)) x.causes.breaker++;
          else if (r.some((e) => e.imm > 0.97)) x.causes.buried++;
          else if (r.some((e) => e.imm < 0.05)) x.causes.airborne++;
          else x.causes.sea++;
        }
      }
      if (side !== 0) x.side = side;
      if (settled) {
        if (tilt > 90) x.inv++;
        x.n++;
      }
      if (process.env['TRACE'] === scen[i]) {
        const brk = (b.telemetry['breaking'] ?? 0) / ((b.telemetry['mass'] ?? 1) * 9.81);
        if (Math.round(t * 10) % 10 === 0 || (tilt > 45 && tilt < 135) || brk > 0.2)
          console.error(
            `${scen[i]} t=${t.toFixed(1)} tilt=${tilt.toFixed(0)} y=${b.position.y.toFixed(2)} brk=${brk.toFixed(2)} thrust=${(b.telemetry['thrust'] ?? 0).toFixed(0)} imm=${(b.telemetry['immersion'] ?? 0).toFixed(2)} flood=${(b.telemetry['floodWaterMass'] ?? 0).toFixed(0)}`,
          );
      }
    });
    // Done once every boat has had its time after the capsize (or can't capsize any more).
    if (st.every((x) => (x.capsizeAt === null ? t > job.limit : t > x.capsizeAt + job.after))) break;
  }
  return st.map((x, i) => ({
    weather: job.weather,
    seed: job.seed,
    mode: job.mode,
    kind: job.kind,
    scen: scen[i]!,
    capsizeAt: x.capsizeAt,
    crash: x.crash,
    flips: x.flips,
    rollOvers: Math.floor(x.flips / 2),
    inverted: x.n ? x.inv / x.n : 0,
    endInverted: x.tilt > 90,
    causes: x.causes,
  }));
}

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1]! : fallback;
};

if (args[0] === '--job') {
  process.stdout.write(JSON.stringify(runJob(JSON.parse(args[1]!) as Job)));
} else {
  const kinds = arg('kinds', 'pwc').split(',') as BoatKind[];
  const weathers = arg('weather', 'storm,hurricane-1,hurricane-3').split(',');
  const modes = arg('modes', 'realistic').split(',') as PhysicsMode[];
  const seeds = arg('seeds', '1,2,3').split(',').map(Number);
  const after = Number(arg('after', '120'));
  const limit = Number(arg('limit', '180'));
  const helm = arg('helm', 'on') === 'on';
  const only = arg('only', '');
  const parallel = Number(arg('jobs', '8'));
  const out = arg('out', '');
  const jobs: Job[] = [];
  for (const weather of weathers)
    for (const mode of modes)
      for (const kind of kinds)
        for (const seed of seeds) jobs.push({ weather, seed, mode, kind, after, limit, helm, only });
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
  const median = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : 0;
  };
  // Per scenario over the seeds (only the runs that capsized): flips, roll-overs, share inverted.
  console.log('kind\tweather\tmode\tscen\tcapsized\tcrash\tflips\trollovers\tinverted\tend inv');
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = [r.kind, r.weather, r.mode, r.scen].join('\t');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const c = g.filter((r) => r.capsizeAt !== null);
    console.log(
      [
        key,
        `${c.length}/${g.length}`,
        c.map((r) => r.crash).join('/'),
        c.map((r) => r.flips).join('/'),
        c.map((r) => r.rollOvers).join('/'),
        c.map((r) => (100 * r.inverted).toFixed(0)).join('/'),
        `${c.filter((r) => r.endInverted).length}/${c.length}`,
      ].join('\t'),
    );
  }
  console.log(
    '\nkind\tweather\tmode\tgroup\truns\tmean crash\tmedian flips\tmean flips\tmedian rollovers\tmean rollovers\tinverted %\tflips: breaker/buried/airborne/sea',
  );
  const cells = new Map<string, Row[]>();
  for (const r of rows) {
    if (r.capsizeAt === null) continue;
    const key = [r.kind, r.weather, r.mode, r.scen.startsWith('inv-') ? 'spawned inverted' : 'careless'].join(
      '\t',
    );
    cells.set(key, [...(cells.get(key) ?? []), r]);
  }
  for (const [key, g] of [...cells].sort((a, b) => a[0].localeCompare(b[0])))
    console.log(
      [
        key,
        g.length,
        (g.reduce((a, r) => a + r.crash, 0) / g.length).toFixed(2),
        median(g.map((r) => r.flips)),
        (g.reduce((a, r) => a + r.flips, 0) / g.length).toFixed(2),
        median(g.map((r) => r.rollOvers)),
        (g.reduce((a, r) => a + r.rollOvers, 0) / g.length).toFixed(2),
        ((100 * g.reduce((a, r) => a + r.inverted, 0)) / g.length).toFixed(0),
        (['breaker', 'buried', 'airborne', 'sea'] as const)
          .map((k) => g.reduce((a, r) => a + r.causes[k], 0))
          .join('/'),
      ].join('\t'),
    );
}
