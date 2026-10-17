// Procedural lightning bolt: recursive midpoint displacement of a cloud-to-sea
// channel, with branches forking off the main channel in the early generations
// (so they are long) and subdividing along with it. Deterministic per seed.
import { Rng } from '../../sim/core/rng';
import type { Vec3Like } from '../particles/emissionQueue';

export interface BoltSegment {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  width: number; // core channel width, m
  intensity: number; // relative brightness, main channel = 1
  branch: number; // 0 = main channel, otherwise the branch id (1-based)
}

export interface BoltOptions {
  start: Vec3Like; // cloud end
  end: Vec3Like; // strike point (sea level)
  seed: number;
  generations?: number; // subdivision passes; the main channel has 2^generations segments
  displacement?: number; // lateral jitter as a fraction of segment length
  maxBranches?: number;
  branchChance?: number; // per main-channel midpoint in the branching generations
  branchGenerations?: number; // branches may fork only in generations [1, branchGenerations]
  width?: number; // main channel core width, m
}

export interface Bolt {
  segments: BoltSegment[];
  branchCount: number;
  min: Vec3Like;
  max: Vec3Like;
}

interface WorkSegment {
  a: [number, number, number];
  b: [number, number, number];
  width: number;
  intensity: number;
  branch: number;
}

export function generateBolt(options: BoltOptions): Bolt {
  const rng = new Rng(options.seed);
  const generations = options.generations ?? 7;
  const displacement = options.displacement ?? 0.2;
  const maxBranches = options.maxBranches ?? 6;
  const branchChance = options.branchChance ?? 0.45;
  const branchGenerations = options.branchGenerations ?? 4;
  const width = options.width ?? 1.5;
  const { start, end } = options;
  const floor = Math.min(start.y, end.y);
  const ceiling = Math.max(start.y, end.y);

  let list: WorkSegment[] = [
    { a: [start.x, start.y, start.z], b: [end.x, end.y, end.z], width, intensity: 1, branch: 0 },
  ];
  let branchCount = 0;

  const gaussian = (): number => Math.max(-2, Math.min(2, rng.gaussian()));

  for (let generation = 0; generation < generations; generation++) {
    const next: WorkSegment[] = [];
    for (const segment of list) {
      const [ax, ay, az] = segment.a;
      const [bx, by, bz] = segment.b;
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const length = Math.hypot(dx, dy, dz);
      // A random direction perpendicular to the segment.
      let px = rng.gaussian();
      let py = rng.gaussian();
      let pz = rng.gaussian();
      if (length > 0) {
        const along = (px * dx + py * dy + pz * dz) / (length * length);
        px -= along * dx;
        py -= along * dy;
        pz -= along * dz;
      }
      const pl = Math.hypot(px, py, pz) || 1;
      const offset = gaussian() * displacement * length;
      const mid: [number, number, number] = [
        (ax + bx) / 2 + (px / pl) * offset,
        Math.min(ceiling, Math.max(floor, (ay + by) / 2 + (py / pl) * offset)),
        (az + bz) / 2 + (pz / pl) * offset,
      ];
      next.push({ ...segment, a: segment.a, b: mid }, { ...segment, a: mid, b: segment.b });

      const canBranch =
        segment.branch === 0 &&
        generation >= 1 &&
        generation <= branchGenerations &&
        branchCount < maxBranches &&
        rng.next() < branchChance;
      if (canBranch) {
        // Fork downward-ish from the midpoint, turned 20–60° off the channel.
        const angle = rng.range(0.35, 1.05) * (rng.next() < 0.5 ? -1 : 1);
        const heading = rng.range(0, Math.PI * 2);
        const ux = dx / (length || 1);
        const uy = dy / (length || 1);
        const uz = dz / (length || 1);
        const sideX = Math.cos(heading);
        const sideZ = Math.sin(heading);
        const branchLength = length * rng.range(0.5, 1.1);
        const cos = Math.cos(angle);
        const sin = Math.abs(Math.sin(angle));
        const end: [number, number, number] = [
          mid[0] + (ux * cos + sideX * sin) * branchLength,
          Math.min(ceiling, Math.max(floor, mid[1] + uy * cos * branchLength)),
          mid[2] + (uz * cos + sideZ * sin) * branchLength,
        ];
        branchCount++;
        next.push({
          a: mid,
          b: end,
          width: width * rng.range(0.3, 0.55),
          intensity: rng.range(0.25, 0.6),
          branch: branchCount,
        });
      }
    }
    list = next;
  }

  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  const segments = list.map((s): BoltSegment => {
    for (const p of [s.a, s.b]) {
      min.x = Math.min(min.x, p[0]);
      min.y = Math.min(min.y, p[1]);
      min.z = Math.min(min.z, p[2]);
      max.x = Math.max(max.x, p[0]);
      max.y = Math.max(max.y, p[1]);
      max.z = Math.max(max.z, p[2]);
    }
    return {
      ax: s.a[0],
      ay: s.a[1],
      az: s.a[2],
      bx: s.b[0],
      by: s.b[1],
      bz: s.b[2],
      width: s.width,
      intensity: s.intensity,
      branch: s.branch,
    };
  });
  return { segments, branchCount, min, max };
}
