// Simulation worker benchmark: builds SimWorld exactly as the app does (simConfigFor: spawn plan,
// formation, loading) and advances it in frame-sized requests with one probe and wakes on, as the
// worker does, then reports ms per 120 Hz master step with a breakdown (per boat kind, the CPU ocean
// FFT, the hull water grids, wakes, collisions and the rest of the step, snapshot building).
// A fingerprint of the final boat states is printed so optimisations can be checked for unchanged
// physics (same numbers to the printed precision).
//
// Usage: node scripts/sim-bench.ts [--cases hurricane-fleet,fair-fleet,crab-fair,sail-gale]
//          [--seconds 20] [--warmup 3] [--fps 36] [--no-breakdown]
// Profile: node --cpu-prof --cpu-prof-dir=/tmp/prof scripts/sim-bench.ts --cases hurricane-fleet
//          --no-breakdown, then node scripts/sim-bench.ts --profile /tmp/prof/<file>.cpuprofile
//          lists the top self-time functions.

import './register-ts.ts';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    cases: { type: 'string', default: 'hurricane-fleet,fair-fleet,crab-fair,sail-gale' },
    seconds: { type: 'string', default: '20' },
    warmup: { type: 'string', default: '3' },
    fps: { type: 'string', default: '36' },
    'no-breakdown': { type: 'boolean', default: false },
    profile: { type: 'string' },
    top: { type: 'string', default: '40' },
  },
});

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

// Self time per function from a V8 .cpuprofile (sampled: samples × interval).
function reportProfile(path: string, top: number): void {
  const profile = JSON.parse(readFileSync(path, 'utf8')) as {
    nodes: ProfileNode[];
    samples: number[];
    timeDeltas: number[];
  };
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const dt = profile.timeDeltas[i] ?? 0;
    total += dt;
    if (!node) return;
    const f = node.callFrame;
    const file = f.url.replace(/^.*\/src\//, '').replace(/^file:\/\/.*\//, '');
    const key = `${f.functionName || '(anonymous)'}  ${file}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`total ${(total / 1000).toFixed(0)} ms sampled`);
  for (const [key, us] of rows)
    console.log(
      `${((100 * us) / total).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)} ms  ${key}`,
    );
}

if (args.profile) {
  reportProfile(args.profile, Number(args.top));
  process.exit(0);
}

const { simConfigFor } = await import('../src/app/scenarioConfig.ts');
const { defaultScenario } = await import('../src/app/Scenario.ts');
const { SimWorld, MASTER_STEP } = await import('../src/sim/world/SimWorld.ts');
const { OceanSurface } = await import('../src/sim/ocean/OceanSurface.ts');
const { neutralControls } = await import('../src/sim/world/protocol.ts');

type BoatKind = import('../src/sim/world/protocol.ts').BoatKind;

interface BenchCase {
  player: BoatKind;
  fleet: BoatKind[];
  weather: string;
  throttle: number;
}

const FLEET: BoatKind[] = ['cruise', 'crab', 'sail', 'powerboat', 'pwc', 'crab', 'powerboat'];
const CASES: Record<string, BenchCase> = {
  // Measured in Chrome on Apple Silicon: ~4.5 ms per master step.
  'hurricane-fleet': { player: 'cargo', fleet: FLEET, weather: 'hurricane-3', throttle: 0.6 },
  'fair-fleet': { player: 'cargo', fleet: FLEET, weather: 'fair', throttle: 0.6 },
  'crab-fair': { player: 'crab', fleet: [], weather: 'fair', throttle: 0.6 },
  'sail-gale': { player: 'sail', fleet: [], weather: 'gale', throttle: 0 },
};

// Wraps obj[name] to add its wall time to timers[key].
const timers = new Map<string, number>();
function time<T extends object>(obj: T, name: keyof T & string, key: string): void {
  const fn = obj[name] as unknown as (...a: unknown[]) => unknown;
  (obj as Record<string, unknown>)[name] = function (this: unknown, ...a: unknown[]) {
    const t0 = performance.now();
    try {
      return fn.apply(this, a);
    } finally {
      timers.set(key, (timers.get(key) ?? 0) + performance.now() - t0);
    }
  };
}

function run(name: string, c: BenchCase, breakdown: boolean): void {
  const scenario = { ...defaultScenario(), playerBoat: c.player, fleet: c.fleet, weather: c.weather };
  const config = simConfigFor(scenario, 'ultra');
  const built = performance.now();
  const world = new SimWorld(config);
  const buildMs = performance.now() - built;
  const controls = { player: { ...neutralControls(), throttle: c.throttle } };
  const frame = 1 / Number(args.fps);
  let target = 0;
  const advance = () => {
    target += frame;
    return world.advance({
      type: 'advance',
      targetTime: target,
      controls,
      commands: [],
      probes: new Float64Array([20, 30]),
    });
  };
  const warmupEnd = Number(args.warmup);
  while (target < warmupEnd) advance();

  timers.clear();
  if (breakdown) {
    for (const boat of world.boats) {
      time(boat, 'step', `boat ${boat.kind}`);
      time(boat.water, 'update', 'hull water grids (incl. FFT)');
      time(boat.dyn.kerner, 'apply', 'kerner hull');
      for (const m of boat.dyn.modules) time(m, 'apply', `module ${m.constructor.name}`);
    }
    if (world.wakes) time(world.wakes, 'update', 'wakes');
    const ocean = world.oceanField;
    if (ocean instanceof OceanSurface)
      time(ocean.ocean as unknown as { computeSample: () => void }, 'computeSample', 'ocean FFT');
    time(world as unknown as { step: () => void }, 'step', 'master steps');
  }
  let steps = 0;
  let stepMs = 0;
  const started = performance.now();
  const end = warmupEnd + Number(args.seconds);
  while (target < end) {
    const snap = advance();
    steps += snap.steps;
    stepMs += snap.stepMs;
  }
  const wall = performance.now() - started;
  console.log(
    `\n${name}: ${config.boats.map((b) => b.kind).join(',')} in ${c.weather}, built in ${buildMs.toFixed(0)} ms`,
  );
  console.log(
    `  ${(stepMs / steps).toFixed(3)} ms/step (advance incl. snapshot), ${(wall / steps).toFixed(3)} ms/step wall, ${steps} steps`,
  );
  if (breakdown) {
    const rows = [...timers.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, ms] of rows) console.log(`    ${(ms / steps).toFixed(3).padStart(7)} ms/step  ${key}`);
  }
  // FNV-1a over the bits of every boat's state: equal only if the runs are bit-identical.
  const bits = new Float64Array(13 * world.boats.length);
  world.boats.forEach((b, i) => {
    const { position: p, orientation: q, velocity: v, angularVelocity: w } = b.dyn.body;
    bits.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z], 13 * i);
  });
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(bits.buffer)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const where = world.boats
    .map((b) => {
      const p = b.dyn.body.position;
      return `${b.kind}(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;
    })
    .join(' ');
  console.log(`  state ${hash.toString(16).padStart(8, '0')}: ${where}`);
}

for (const name of args.cases.split(',')) {
  const c = CASES[name];
  if (!c) throw new Error(`unknown case ${name}; known: ${Object.keys(CASES).join(', ')}`);
  run(name, c, !args['no-breakdown']);
}
void MASTER_STEP;
