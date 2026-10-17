// Baked ambient occlusion as a body-space volume. The model's triangles (and
// solid boxes such as container stacks) are voxelised, the closed interior is
// found by flood-filling the outside, and every empty voxel near a surface
// ray-marches a set of directions to measure how open it is. Materials sample
// the volume a little off the surface (p + n·offset), so one small 3D texture
// shades merged and instanced meshes alike, at any triangle density.
//
// A voxel beside a flat open wall sees half the sphere, so openness is doubled
// and clamped: flat = 1, a two-wall corner ≈ 0.5, deep crevices toward 0.

export interface AoBox {
  min: [number, number, number];
  max: [number, number, number];
}

export interface AoBakeInput {
  min: [number, number, number];
  max: [number, number, number];
  voxel: number; // m
  triangles: readonly Float32Array[]; // 9 floats per triangle, body frame
  boxes?: readonly AoBox[]; // solid volumes
  rays?: number; // directions per voxel (default 24)
  distance?: number; // max occluder distance, m (default 8 voxels)
}

export interface AoVolumeData {
  nx: number;
  ny: number;
  nz: number;
  min: [number, number, number];
  size: [number, number, number]; // world extent covered by the texture
  data: Uint8Array; // x fastest, then y, then z
}

const EMPTY = 0;
const SOLID = 1;
const OUTSIDE = 2;

export function fibonacciDirections(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * golden;
    out[i * 3] = Math.cos(phi) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(phi) * r;
  }
  return out;
}

export function bakeAoVolume(input: AoBakeInput): AoVolumeData {
  const v = input.voxel;
  const pad = 2;
  const min: [number, number, number] = [
    input.min[0] - pad * v,
    input.min[1] - pad * v,
    input.min[2] - pad * v,
  ];
  const nx = Math.ceil((input.max[0] - input.min[0]) / v) + 2 * pad;
  const ny = Math.ceil((input.max[1] - input.min[1]) / v) + 2 * pad;
  const nz = Math.ceil((input.max[2] - input.min[2]) / v) + 2 * pad;
  const total = nx * ny * nz;
  const grid = new Uint8Array(total);
  const idx = (x: number, y: number, z: number): number => x + nx * (y + ny * z);
  const mark = (px: number, py: number, pz: number): void => {
    const x = Math.floor((px - min[0]) / v);
    const y = Math.floor((py - min[1]) / v);
    const z = Math.floor((pz - min[2]) / v);
    if (x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz) grid[idx(x, y, z)] = SOLID;
  };

  // Conservative-enough surface voxelisation: sample each triangle at half-voxel spacing.
  const step = 0.5 * v;
  for (const tris of input.triangles) {
    for (let t = 0; t + 8 < tris.length; t += 9) {
      const ax = tris[t]!;
      const ay = tris[t + 1]!;
      const az = tris[t + 2]!;
      const bx = tris[t + 3]! - ax;
      const by = tris[t + 4]! - ay;
      const bz = tris[t + 5]! - az;
      const cx = tris[t + 6]! - ax;
      const cy = tris[t + 7]! - ay;
      const cz = tris[t + 8]! - az;
      const lb = Math.hypot(bx, by, bz);
      const lc = Math.hypot(cx, cy, cz);
      const ld = Math.hypot(cx - bx, cy - by, cz - bz);
      const n = Math.max(1, Math.ceil(Math.max(lb, lc, ld) / step));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const s = i / n;
          const r = j / n;
          mark(ax + bx * s + cx * r, ay + by * s + cy * r, az + bz * s + cz * r);
        }
      }
    }
  }
  for (const box of input.boxes ?? []) {
    const x0 = Math.max(0, Math.floor((box.min[0] - min[0]) / v));
    const y0 = Math.max(0, Math.floor((box.min[1] - min[1]) / v));
    const z0 = Math.max(0, Math.floor((box.min[2] - min[2]) / v));
    const x1 = Math.min(nx - 1, Math.floor((box.max[0] - min[0]) / v));
    const y1 = Math.min(ny - 1, Math.floor((box.max[1] - min[1]) / v));
    const z1 = Math.min(nz - 1, Math.floor((box.max[2] - min[2]) / v));
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) grid[idx(x, y, z)] = SOLID;
  }

  // Flood the outside from the padded boundary (6-connected); anything enclosed becomes solid.
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;
  const push = (i: number): void => {
    if (grid[i] === EMPTY) {
      grid[i] = OUTSIDE;
      queue[tail++] = i;
    }
  };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      push(idx(0, y, z));
      push(idx(nx - 1, y, z));
    }
    for (let x = 0; x < nx; x++) {
      push(idx(x, 0, z));
      push(idx(x, ny - 1, z));
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      push(idx(x, y, 0));
      push(idx(x, y, nz - 1));
    }
  }
  const sxy = nx * ny;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % nx;
    const y = Math.floor(i / nx) % ny;
    const z = Math.floor(i / sxy);
    if (x > 0) push(i - 1);
    if (x < nx - 1) push(i + 1);
    if (y > 0) push(i - nx);
    if (y < ny - 1) push(i + nx);
    if (z > 0) push(i - sxy);
    if (z < nz - 1) push(i + sxy);
  }

  // Openness of outside voxels within two voxels of a solid.
  const near = new Uint8Array(total);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = idx(x, y, z);
        if (grid[c] === OUTSIDE) continue;
        // Only solids on the boundary seed the band.
        const boundary =
          (x > 0 && grid[c - 1] === OUTSIDE) ||
          (x < nx - 1 && grid[c + 1] === OUTSIDE) ||
          (y > 0 && grid[c - nx] === OUTSIDE) ||
          (y < ny - 1 && grid[c + nx] === OUTSIDE) ||
          (z > 0 && grid[c - sxy] === OUTSIDE) ||
          (z < nz - 1 && grid[c + sxy] === OUTSIDE);
        if (!boundary) continue;
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const X = x + dx;
              const Y = y + dy;
              const Z = z + dz;
              if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz) near[idx(X, Y, Z)] = 1;
            }
          }
        }
      }
    }
  }
  const rays = input.rays ?? 24;
  const dirs = fibonacciDirections(rays);
  const maxSteps = Math.max(2, Math.round((input.distance ?? 8 * v) / v));
  const out = new Uint8Array(total).fill(255);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = idx(x, y, z);
        if (grid[i] !== OUTSIDE || !near[i]) continue;
        let occlusion = 0;
        for (let r = 0; r < rays; r++) {
          const dx = dirs[r * 3]!;
          const dy = dirs[r * 3 + 1]!;
          const dz = dirs[r * 3 + 2]!;
          for (let s = 1; s <= maxSteps; s++) {
            const X = Math.round(x + dx * s);
            const Y = Math.round(y + dy * s);
            const Z = Math.round(z + dz * s);
            if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) break;
            if (grid[idx(X, Y, Z)] !== OUTSIDE) {
              occlusion += 1 - (s - 1) / maxSteps;
              break;
            }
          }
        }
        const open = 1 - occlusion / rays;
        out[i] = Math.round(Math.min(1, Math.max(0, 2 * open)) * 255);
      }
    }
  }
  // Solid voxels take the mean of their open neighbours so trilinear filtering doesn't darken surfaces.
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const i = idx(x, y, z);
        if (grid[i] === OUTSIDE) continue;
        let sum = 0;
        let count = 0;
        for (const j of [i - 1, i + 1, i - nx, i + nx, i - sxy, i + sxy]) {
          if (grid[j] === OUTSIDE) {
            sum += out[j]!;
            count++;
          }
        }
        out[i] = count > 0 ? Math.round(sum / count) : 200;
      }
    }
  }
  // Separable [1 2 1] blur: hides the voxel staircase on oblique and thin geometry.
  const tmp = new Float32Array(total);
  const blur = (stride: number, n: number, coord: (i: number) => number): void => {
    for (let i = 0; i < total; i++) {
      const c = coord(i);
      const a = c > 0 ? out[i - stride]! : out[i]!;
      const b = c < n - 1 ? out[i + stride]! : out[i]!;
      tmp[i] = (a + 2 * out[i]! + b) / 4;
    }
    for (let i = 0; i < total; i++) out[i] = Math.round(tmp[i]!);
  };
  blur(1, nx, (i) => i % nx);
  blur(nx, ny, (i) => Math.floor(i / nx) % ny);
  blur(sxy, nz, (i) => Math.floor(i / sxy));
  return { nx, ny, nz, min, size: [nx * v, ny * v, nz * v], data: out };
}

// Trilinear lookup (for tests and CPU-side tinting of instances).
export function sampleAo(volume: AoVolumeData, x: number, y: number, z: number): number {
  const fx = ((x - volume.min[0]) / volume.size[0]) * volume.nx - 0.5;
  const fy = ((y - volume.min[1]) / volume.size[1]) * volume.ny - 0.5;
  const fz = ((z - volume.min[2]) / volume.size[2]) * volume.nz - 0.5;
  const clampI = (a: number, n: number): number => Math.min(n - 1, Math.max(0, a));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const z0 = Math.floor(fz);
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const X = clampI(x0 + (k & 1), volume.nx);
    const Y = clampI(y0 + ((k >> 1) & 1), volume.ny);
    const Z = clampI(z0 + ((k >> 2) & 1), volume.nz);
    const w =
      (k & 1 ? fx - x0 : 1 - (fx - x0)) *
      ((k >> 1) & 1 ? fy - y0 : 1 - (fy - y0)) *
      ((k >> 2) & 1 ? fz - z0 : 1 - (fz - z0));
    sum += w * volume.data[X + volume.nx * (Y + volume.ny * Z)]!;
  }
  return sum / 255;
}
