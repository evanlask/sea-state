// Water drops on the camera lens or the bridge windows, simulated as a small set of drops on the
// CPU (pure, Node-testable); LensDroplets draws them and refracts the scene through them.
//
// Positions and radii are in screen heights (x right, 0..aspect; y down, 0..1). Each drop is a
// bead of volume ∝ r³:
//
//   rain      sparse small beads land at a rate set by the rain and how squarely the glass faces it
//   pinning   surface tension holds a bead in place until its weight (∝ r³ × the share of gravity
//             along the glass) beats the pinning of its contact line (∝ r): bigger beads run, faster
//             the bigger they are, meandering a little and shedding a short trail of tiny beads
//   merging   beads that touch coalesce into one, conserving volume: r = ∛(r₁³ + r₂³); a running
//             bead sweeps up the beads in its path and grows
//   drying    every bead shrinks at a steady rate, so tiny ones go in a second or two and a lens
//             clears within a few seconds of the source stopping; in a downpour the mist landing
//             on the beads outpaces it and they grow
//   splashes  spray landing on the glass: a burst of beads of mixed sizes (many tiny, a few big) and
//             one or more sheets, smeared streaks that run down fast, breaking up into beads
//
// The set is capped at LENS_DROP_CAP; when it is full a new bead replaces the smallest one if it is
// bigger, and a sheet always gets a slot.

import { Rng } from '../../sim/core/rng';
import type { LensMode } from './lensWetness';

// --- tuning ---
export const LENS_DROP_CAP = 256;
// Rain: beads per second at full rain on glass facing straight into it (scaled by rain^0.8 and the
// exposure), and their radii (skewed toward the small end).
const RAIN_DROPS_PER_S = 36;
const RAIN_R_MIN = 0.0022;
export const RAIN_R_MAX = 0.0075;
// Fine blown spray (spume in a gale): beads per second at full spume, smaller than rain.
const SPUME_DROPS_PER_S = 30;
// Beads below this radius are gone (dried); drying rate in screen heights per second, slowed in
// rain (saturated air, the glass kept wet) by RAIN_HUMIDITY × √rain.
const R_MIN = 0.0012;
const EVAPORATION = 0.0022;
const RAIN_HUMIDITY = 0.9;
// Beads on glass facing a downpour also grow, from the fine drizzle and mist landing on them, by up
// to this rate (screen heights/s, × rain × exposure), so in a storm they swell until they run.
const RAIN_ACCRETION = 0.001;
// A bead runs once r × √(gravity along the glass) exceeds this (windows: vertical, wetted glass).
export const R_SLIDE_LENS = 0.0095;
const R_SLIDE_WINDOW = 0.007;
// Running speed (screen heights/s) = SLIDE_GAIN × (r / r_slide − 1), up to SLIDE_MAX.
const SLIDE_GAIN = 0.45;
const SLIDE_MAX = 1.4;
const SLIDE_RESPONSE = 10; // s⁻¹, how quickly a bead gets going or stops
const MEANDER = 0.3; // sideways wander, share of the running speed
const MEANDER_FREQ = 55; // rad per screen height travelled
// Trail: every TRAIL_SPACING (± 40 %) travelled a running bead leaves a bead of this share of its
// radius behind (taking that volume from it).
const TRAIL_SPACING = 0.014;
const TRAIL_SHARE_MIN = 0.13;
const TRAIL_SHARE_MAX = 0.24;
// Two beads merge when their centres are closer than MERGE_REACH × (r₁ + r₂) (edges touching; the
// drawn edge is soft, so slightly inside the nominal radius).
const MERGE_REACH = 0.92;
// Splashes, at strength s (0..1): SPLASH_DROPS_MIN + SPLASH_DROPS × s beads with radii from
// SPLASH_R_MIN up to SPLASH_R_MAX + SPLASH_R_GROW × s, scattered over SPLASH_SPREAD (+ s × GROW).
const SPLASH_DROPS_MIN = 10;
const SPLASH_DROPS = 70;
const SPLASH_R_MIN = 0.0016;
const SPLASH_R_MAX = 0.011;
const SPLASH_R_GROW = 0.014;
const SPLASH_SPREAD = 0.1;
const SPLASH_SPREAD_GROW = 0.25;
// Splash sheets: half-width, length (× half-width), life, speed and the beads each breaks into.
const SHEET_WIDTH = 0.012;
const SHEET_WIDTH_GROW = 0.016;
const SHEET_STRETCH: readonly [number, number] = [2.5, 5];
const SHEET_LIFE: readonly [number, number] = [0.35, 0.8]; // s
const SHEET_SPEED = 0.7; // screen heights/s
const SHEET_BREAKUP = 14; // beads per sheet (+ as many again at full strength)
// Under water at least this long (s) before surfacing leaves the lens streaming.
const SURFACING_MIN_S = 0.25;
// Random splashes per second from waves or bow spray washing over the glass (wash = 1).
const WASH_SPLASHES_PER_S = 1.5;
// --- end tuning ---

const GRID_MAX = 48; // merge grid cells per side, at most

export interface LensDrop {
  x: number;
  y: number;
  r: number; // bead radius, or a sheet's half-width
  vx: number;
  vy: number;
  sheet: boolean;
  dirX: number; // a sheet's long axis (unit)
  dirY: number;
  stretch: number; // a sheet's length / width
  life: number; // s left (sheets)
  lifeMax: number;
  shed: number; // sheets: beads owed to the break-up
  trail: number; // distance left to the next trail bead
  travel: number; // distance run (drives the meander)
  phase: number;
}

export interface LensDrops {
  mode: LensMode;
  aspect: number;
  count: number;
  readonly drops: LensDrop[]; // the first `count` are live
  gravityX: number; // last gravity along the glass (screen units)
  gravityY: number;
  submerged: number; // s the lens has been under water (0 above it)
  rainCarry: number;
  spumeCarry: number;
  readonly rng: Rng;
  // Merge grid scratch.
  readonly cellStart: Int32Array;
  readonly cellFill: Int32Array;
  readonly cellItems: Int32Array;
  readonly cellOf: Int32Array;
}

export interface LensDropInputs {
  dt: number; // s
  mode: LensMode;
  aspect: number; // width / height
  rain: number; // 0..1 precipitation intensity
  exposure: number; // 0..1 share of the rain reaching the glass (rainExposure)
  // World down projected onto the glass, in screen units (x right, y down): (0, 1) for a level
  // camera, shorter as it looks up or down (|g| = 0 looking straight down: nothing runs).
  gravity: { x: number; y: number };
  spume: number; // 0..1 fine spray blown onto the glass
  wash: number; // 0..1 waves or bow spray washing over it (random splashes)
  splashes: readonly number[]; // splash strengths (0..1) landing this frame
  underwater: boolean; // the lens is under water (lens mode only: windows are never submerged)
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const newDrop = (): LensDrop => ({
  x: 0,
  y: 0,
  r: 0,
  vx: 0,
  vy: 0,
  sheet: false,
  dirX: 0,
  dirY: 1,
  stretch: 1,
  life: 0,
  lifeMax: 0,
  shed: 0,
  trail: 0,
  travel: 0,
  phase: 0,
});

export function createLensDrops(seed = 1): LensDrops {
  return {
    mode: 'none',
    aspect: 16 / 9,
    count: 0,
    drops: Array.from({ length: LENS_DROP_CAP }, newDrop),
    gravityX: 0,
    gravityY: 1,
    submerged: 0,
    rainCarry: 0,
    spumeCarry: 0,
    rng: new Rng(seed),
    cellStart: new Int32Array(GRID_MAX * GRID_MAX + 1),
    cellFill: new Int32Array(GRID_MAX * GRID_MAX),
    cellItems: new Int32Array(LENS_DROP_CAP),
    cellOf: new Int32Array(LENS_DROP_CAP),
  };
}

export function clearLensDrops(state: LensDrops): void {
  state.count = 0;
  state.rainCarry = 0;
  state.spumeCarry = 0;
}

const volume = (r: number): number => r * r * r;

// A slot for a new drop: a free one, or (when full) the smallest bead if `r` beats it — or any
// bead's for a sheet. Returns the drop, reset and placed, or null.
function claim(state: LensDrops, x: number, y: number, r: number, sheet: boolean): LensDrop | null {
  let d: LensDrop | undefined;
  if (state.count < LENS_DROP_CAP) d = state.drops[state.count++];
  else {
    let smallest = -1;
    let min = sheet ? Infinity : r;
    for (let i = 0; i < state.count; i++) {
      const o = state.drops[i]!;
      if (!o.sheet && o.r < min) {
        min = o.r;
        smallest = i;
      }
    }
    if (smallest < 0) return null;
    d = state.drops[smallest];
  }
  if (!d) return null;
  const rng = state.rng;
  d.x = x;
  d.y = y;
  d.r = r;
  d.vx = 0;
  d.vy = 0;
  d.sheet = sheet;
  d.dirX = 0;
  d.dirY = 1;
  d.stretch = 1;
  d.life = 0;
  d.lifeMax = 0;
  d.shed = 0;
  d.trail = TRAIL_SPACING * rng.range(0.6, 1.4);
  d.travel = 0;
  d.phase = rng.range(0, Math.PI * 2);
  return d;
}

export function addBead(state: LensDrops, x: number, y: number, r: number): LensDrop | null {
  return r < R_MIN ? null : claim(state, x, y, r, false);
}

// Rain bead radius for a uniform u in [0, 1): mostly near RAIN_R_MIN.
const rainRadius = (u: number): number => RAIN_R_MIN + (RAIN_R_MAX - RAIN_R_MIN) * u ** 2.2;

// Splash bead radius for a uniform u and strength s: log-uniform skewed small (many tiny, few big).
function splashRadius(u: number, s: number): number {
  const max = SPLASH_R_MAX + SPLASH_R_GROW * clamp01(s);
  return SPLASH_R_MIN * (max / SPLASH_R_MIN) ** (u * u);
}

// Spray landing on the glass at strength 0..1 (centred at `at`, or somewhere in the frame).
export function splash(state: LensDrops, strength: number, at?: { x: number; y: number }): void {
  const s = clamp01(strength);
  if (s <= 0 || state.mode === 'none') return;
  const rng = state.rng;
  const aspect = state.aspect;
  const cx = at?.x ?? rng.range(0.15, 0.85) * aspect;
  const cy = at?.y ?? rng.range(0.1, 0.65);
  const spread = SPLASH_SPREAD + SPLASH_SPREAD_GROW * s;
  // The spray arrives along a direction: the burst fans out along it.
  const throwAngle = rng.range(0, Math.PI * 2);
  const ax = Math.cos(throwAngle);
  const ay = Math.sin(throwAngle);
  const g = Math.hypot(state.gravityX, state.gravityY);
  const gx = g > 1e-3 ? state.gravityX / g : 0;
  const gy = g > 1e-3 ? state.gravityY / g : 1;
  // Sheets first, so a full set still makes room for them.
  const sheets = s < 0.2 ? 0 : 1 + Math.floor(s * 2.5);
  for (let k = 0; k < sheets; k++) {
    const d = claim(
      state,
      cx + rng.gaussian() * spread * 0.5,
      cy + rng.gaussian() * spread * 0.35,
      (SHEET_WIDTH + SHEET_WIDTH_GROW * s) * rng.range(0.7, 1.2),
      true,
    );
    if (!d) break;
    // Smeared along the throw, turned toward gravity as it starts to run.
    const tilt = rng.range(-0.5, 0.5);
    const c = Math.cos(tilt);
    const sn = Math.sin(tilt);
    const dx = gx * c - gy * sn + ax * 0.3;
    const dy = gx * sn + gy * c + ay * 0.3;
    const len = Math.hypot(dx, dy) || 1;
    d.dirX = dx / len;
    d.dirY = dy / len;
    d.stretch = rng.range(SHEET_STRETCH[0], SHEET_STRETCH[1]);
    d.lifeMax = d.life = rng.range(SHEET_LIFE[0], SHEET_LIFE[1]);
    d.shed = 0;
    d.vx = d.dirX * SHEET_SPEED * 0.4;
    d.vy = d.dirY * SHEET_SPEED * 0.4;
  }
  const n = Math.round(SPLASH_DROPS_MIN + SPLASH_DROPS * s);
  for (let i = 0; i < n; i++) {
    const along = rng.gaussian() * spread * 0.6;
    const across = rng.gaussian() * spread * 0.3;
    addBead(state, cx + ax * along - ay * across, cy + ay * along + ax * across, splashRadius(rng.next(), s));
  }
}

// Beads landing at random over the frame (rain, spume). On a full lens a new bead lands on one
// already there and feeds it, so a downpour grows beads until they run.
function sprinkle(state: LensDrops, count: number, scale: number): void {
  const rng = state.rng;
  for (let i = 0; i < count; i++) {
    const r = rainRadius(rng.next()) * scale;
    if (state.count < LENS_DROP_CAP) {
      addBead(state, rng.range(0, state.aspect), rng.next(), r);
      continue;
    }
    const d = state.drops[rng.int(0, state.count)]!;
    if (!d.sheet) d.r = Math.cbrt(volume(d.r) + volume(r));
  }
}

function remove(state: LensDrops, i: number): void {
  const last = state.count - 1;
  const drops = state.drops;
  if (i !== last) {
    const d = drops[i]!;
    drops[i] = drops[last]!;
    drops[last] = d;
  }
  state.count = last;
}

export function stepLensDrops(state: LensDrops, input: LensDropInputs): LensDrops {
  const dt = Math.min(Math.max(input.dt, 0), 0.1);
  state.aspect = Math.max(0.1, input.aspect);
  // A different surface (lens ↔ window) starts dry; with no glass there is nothing to wet.
  if (input.mode !== state.mode) {
    state.mode = input.mode;
    clearLensDrops(state);
  }
  if (input.mode === 'none') {
    clearLensDrops(state);
    state.submerged = 0;
    return state;
  }
  // Under water the lens is one film (no drops to see); breaking the surface after a real dunking
  // (not a frame's dip, nor ever for a window) leaves it streaming.
  if (input.underwater && input.mode === 'lens') {
    clearLensDrops(state);
    state.submerged += dt;
    return state;
  }
  state.gravityX = input.gravity.x;
  state.gravityY = input.gravity.y;
  const surfaced = state.submerged >= SURFACING_MIN_S;
  state.submerged = 0;
  if (surfaced) {
    for (let k = 0; k < 3; k++)
      splash(state, 1, { x: ((k + 0.5) / 3) * state.aspect, y: 0.2 + 0.25 * state.rng.next() });
  }

  const rng = state.rng;
  const rain = clamp01(input.rain);
  state.rainCarry += RAIN_DROPS_PER_S * rain ** 0.8 * clamp01(input.exposure) * dt;
  const rainDrops = Math.floor(state.rainCarry);
  state.rainCarry -= rainDrops;
  // Heavier rain falls in bigger drops.
  sprinkle(state, rainDrops, 0.75 + 0.5 * rain);
  state.spumeCarry += SPUME_DROPS_PER_S * clamp01(input.spume) * dt;
  const spumeDrops = Math.floor(state.spumeCarry);
  state.spumeCarry -= spumeDrops;
  sprinkle(state, spumeDrops, 0.65);
  for (const s of input.splashes) splash(state, s);
  if (rng.next() < WASH_SPLASHES_PER_S * clamp01(input.wash) * dt) splash(state, rng.range(0.25, 0.6));

  moveDrops(state, dt, rain, clamp01(input.exposure));
  mergeDrops(state);
  return state;
}

function moveDrops(state: LensDrops, dt: number, rain: number, exposure: number): void {
  const rng = state.rng;
  const g = Math.min(1, Math.hypot(state.gravityX, state.gravityY));
  const gx = g > 1e-3 ? state.gravityX / g : 0;
  const gy = g > 1e-3 ? state.gravityY / g : 1;
  const slideRadius = state.mode === 'window' ? R_SLIDE_WINDOW : R_SLIDE_LENS;
  const shrink =
    (EVAPORATION * (1 - RAIN_HUMIDITY * Math.sqrt(rain)) - RAIN_ACCRETION * rain * exposure) * dt;
  const response = Math.min(1, dt * SLIDE_RESPONSE);
  const aspect = state.aspect;
  for (let i = state.count - 1; i >= 0; i--) {
    const d = state.drops[i]!;
    if (d.sheet) {
      // A sheet runs fast along its axis, thinning and breaking up into beads as it goes.
      const speed = SHEET_SPEED * Math.max(0.35, g);
      d.vx += (d.dirX * speed - d.vx) * response;
      d.vy += (d.dirY * speed - d.vy) * response;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.life -= dt;
      d.shed += (SHEET_BREAKUP * (1 + d.r / (SHEET_WIDTH + SHEET_WIDTH_GROW)) * dt) / d.lifeMax;
      while (d.shed >= 1) {
        d.shed -= 1;
        const u = rng.range(-1, 1);
        const v = rng.range(-0.6, 0.6);
        const half = d.r * d.stretch;
        addBead(
          state,
          d.x + d.dirX * u * half - d.dirY * v * d.r,
          d.y + d.dirY * u * half + d.dirX * v * d.r,
          d.r * rng.range(0.2, 0.75),
        );
      }
      if (d.life <= 0) remove(state, i);
      continue;
    }
    d.r -= shrink;
    if (d.r < R_MIN) {
      remove(state, i);
      continue;
    }
    const excess = (d.r * Math.sqrt(g)) / slideRadius - 1;
    const speed = excess > 0 ? Math.min(SLIDE_MAX, SLIDE_GAIN * excess) : 0;
    const wander = speed * MEANDER * Math.sin(d.travel * MEANDER_FREQ + d.phase);
    d.vx += (gx * speed - gy * wander - d.vx) * response;
    d.vy += (gy * speed + gx * wander - d.vy) * response;
    const step = Math.hypot(d.vx, d.vy) * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.travel += step;
    if (speed > 0) {
      d.trail -= step;
      if (d.trail <= 0) {
        d.trail = TRAIL_SPACING * rng.range(0.6, 1.4);
        const rt = d.r * rng.range(TRAIL_SHARE_MIN, TRAIL_SHARE_MAX);
        if (rt > R_MIN * 1.2) {
          // Left just behind the bead (out of its merging reach), its volume taken from it.
          const behind = (d.r + rt) * (MERGE_REACH + 0.06);
          const vx = d.x - gx * behind;
          const vy = d.y - gy * behind;
          d.r = Math.cbrt(volume(d.r) - volume(rt));
          addBead(state, vx, vy, rt);
        }
      }
    }
    if (d.y - d.r > 1 || d.y + d.r < 0 || d.x + d.r < 0 || d.x - d.r > aspect) remove(state, i);
  }
}

// Coalesces touching beads (one pass; chains finish over the next frames), using a uniform grid
// with cells at least as wide as the largest bead, so touching beads are in neighbouring cells.
export function mergeDrops(state: LensDrops): void {
  const n = state.count;
  if (n < 2) return;
  const drops = state.drops;
  let maxR = 0;
  for (let i = 0; i < n; i++) if (!drops[i]!.sheet) maxR = Math.max(maxR, drops[i]!.r);
  const aspect = state.aspect;
  const cell = Math.max(2 * maxR, aspect / GRID_MAX, 1 / GRID_MAX, 1e-4);
  const cols = Math.min(GRID_MAX, Math.ceil(aspect / cell));
  const rows = Math.min(GRID_MAX, Math.ceil(1 / cell));
  const cells = cols * rows;
  const { cellStart, cellFill, cellItems, cellOf } = state;
  cellStart.fill(0, 0, cells + 1);
  const cellIndex = (x: number, y: number): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cell)));
    return cy * cols + cx;
  };
  // Counting sort of the beads into cells (sheets don't merge).
  for (let i = 0; i < n; i++) {
    const d = drops[i]!;
    const c = d.sheet ? -1 : cellIndex(d.x, d.y);
    cellOf[i] = c;
    if (c >= 0) cellStart[c + 1]! += 1;
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
  cellFill.set(cellStart.subarray(0, cells));
  for (let i = 0; i < n; i++) {
    const c = cellOf[i]!;
    if (c >= 0) cellItems[cellFill[c]!++] = i;
  }
  let merged = false;
  for (let i = 0; i < n; i++) {
    const a = drops[i]!;
    if (cellOf[i]! < 0 || a.r <= 0) continue;
    const c = cellOf[i]!;
    const cx = c % cols;
    const cy = (c - cx) / cols;
    for (let y = Math.max(0, cy - 1); y <= Math.min(rows - 1, cy + 1); y++) {
      for (let x = Math.max(0, cx - 1); x <= Math.min(cols - 1, cx + 1); x++) {
        const k = y * cols + x;
        for (let s = cellStart[k]!; s < cellStart[k + 1]!; s++) {
          const j = cellItems[s]!;
          if (j <= i) continue;
          const b = drops[j]!;
          if (b.r <= 0) continue;
          const reach = (a.r + b.r) * MERGE_REACH;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          if (dx * dx + dy * dy >= reach * reach) continue;
          // Volume-weighted centre and momentum; the bigger bead keeps its path.
          const va = volume(a.r);
          const vb = volume(b.r);
          const v = va + vb;
          a.x = (a.x * va + b.x * vb) / v;
          a.y = (a.y * va + b.y * vb) / v;
          a.vx = (a.vx * va + b.vx * vb) / v;
          a.vy = (a.vy * va + b.vy * vb) / v;
          if (vb > va) {
            a.travel = b.travel;
            a.phase = b.phase;
          }
          a.trail = Math.min(a.trail, b.trail);
          a.r = Math.cbrt(v);
          b.r = 0;
          merged = true;
        }
      }
    }
  }
  if (!merged) return;
  for (let i = state.count - 1; i >= 0; i--) if (!drops[i]!.sheet && drops[i]!.r <= 0) remove(state, i);
}

// Running beads stretch a little along their path.
const RUN_STRETCH = 0.35;
// Sheets are thinner than beads: they refract and show less.
const SHEET_OPACITY = 0.75;

// Writes the drops for the GPU: per drop (x, y, r, stretch) into `shape` and (axis x, axis y,
// opacity, 0) into `look`; returns how many were written.
export function packLensDrops(state: Readonly<LensDrops>, shape: Float32Array, look: Float32Array): number {
  const n = Math.min(state.count, Math.floor(shape.length / 4), Math.floor(look.length / 4));
  for (let i = 0; i < n; i++) {
    const d = state.drops[i]!;
    const o = i * 4;
    if (d.sheet) {
      const k = clamp01(d.life / d.lifeMax);
      shape[o] = d.x;
      shape[o + 1] = d.y;
      shape[o + 2] = d.r * (0.55 + 0.45 * k); // thins as it breaks up
      shape[o + 3] = d.stretch * (1 + 0.6 * (1 - k)); // and smears out
      look[o] = d.dirX;
      look[o + 1] = d.dirY;
      look[o + 2] = SHEET_OPACITY * Math.sqrt(k);
    } else {
      const speed = Math.hypot(d.vx, d.vy);
      shape[o] = d.x;
      shape[o + 1] = d.y;
      shape[o + 2] = d.r;
      shape[o + 3] = 1 + RUN_STRETCH * clamp01(speed / 0.3);
      look[o] = speed > 1e-4 ? d.vx / speed : 0;
      look[o + 1] = speed > 1e-4 ? d.vy / speed : 1;
      look[o + 2] = clamp01((d.r - R_MIN) / R_MIN); // fades out as it dries away
    }
    look[o + 3] = 0;
  }
  return n;
}
