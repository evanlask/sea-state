// Update scheduling for the environment probe: which cube faces to re-render this frame and when to
// re-convolve. A refresh cycle renders the six faces over several frames, then convolves once, so
// the cost is amortised; a large jump (teleport, time skip) refreshes everything at once. Pure TS.

export interface ProbeScheduleOptions {
  facesPerFrame: number; // 1..6
  refreshAngle: number; // rad, sun/moon movement that starts a new cycle
  immediateAngle: number; // rad, movement that forces a full same-frame refresh
  maxInterval: number; // s, refresh at least this often (exposure, slow changes)
}

const DEFAULT_PROBE_SCHEDULE: ProbeScheduleOptions = {
  facesPerFrame: 1,
  // A convolution costs ~1–4 ms of GPU (PMREM is ~25 small passes, so mostly fixed overhead). A
  // tenth of a degree keeps the sky's reflection and ambient light moving smoothly with the
  // accelerated day (about one refresh a second at an hour a day; a cycle takes six frames, so at
  // most ten a second).
  refreshAngle: 0.1 * (Math.PI / 180),
  immediateAngle: 8 * (Math.PI / 180),
  maxInterval: 8,
};

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ProbeFrameInput {
  time: number; // s, monotonic
  sunDirection: Vec3Like; // unit
  moonDirection: Vec3Like; // unit
  contentVersion: number; // bump when the atmosphere, clouds or overcast change
}

export interface ProbeFramePlan {
  beginCycle: boolean; // capture parameters (exposure) before rendering the first face
  faces: number[]; // cube faces to render this frame, in order
  convolve: boolean; // all six faces are fresh: rebuild the PMREM after rendering them
}

const angleBetween = (a: Vec3Like, b: Vec3Like): number => {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.max(-1, Math.min(1, dot)));
};

export class ProbeSchedule {
  private options: ProbeScheduleOptions;
  private nextFace = -1; // -1 = idle
  private captured = false;
  private lastSun: Vec3Like = { x: 0, y: 1, z: 0 };
  private lastMoon: Vec3Like = { x: 0, y: 1, z: 0 };
  private lastVersion = Number.NaN;
  private lastStart = Number.NEGATIVE_INFINITY;
  private forced = true;

  constructor(options: Partial<ProbeScheduleOptions> = {}) {
    this.options = { ...DEFAULT_PROBE_SCHEDULE, ...options };
    this.options.facesPerFrame = Math.min(6, Math.max(1, Math.floor(this.options.facesPerFrame)));
  }

  // Next plan forces a full, same-frame refresh.
  invalidate(): void {
    this.forced = true;
  }

  get busy(): boolean {
    return this.nextFace >= 0;
  }

  plan(input: ProbeFrameInput): ProbeFramePlan {
    const moved = Math.max(
      angleBetween(input.sunDirection, this.lastSun),
      angleBetween(input.moonDirection, this.lastMoon),
    );
    const versionChanged = input.contentVersion !== this.lastVersion;
    const immediate = this.forced || !this.captured || moved >= this.options.immediateAngle;

    if (immediate) {
      this.start(input);
      this.nextFace = -1;
      this.captured = true;
      this.forced = false;
      return { beginCycle: true, faces: [0, 1, 2, 3, 4, 5], convolve: true };
    }

    let beginCycle = false;
    if (this.nextFace < 0) {
      const stale = input.time - this.lastStart >= this.options.maxInterval;
      if (moved >= this.options.refreshAngle || versionChanged || stale) {
        this.start(input);
        this.nextFace = 0;
        beginCycle = true;
      } else {
        return { beginCycle: false, faces: [], convolve: false };
      }
    }

    const faces: number[] = [];
    while (faces.length < this.options.facesPerFrame && this.nextFace < 6) faces.push(this.nextFace++);
    const convolve = this.nextFace >= 6;
    if (convolve) this.nextFace = -1;
    return { beginCycle, faces, convolve };
  }

  private start(input: ProbeFrameInput): void {
    this.lastSun = { ...input.sunDirection };
    this.lastMoon = { ...input.moonDirection };
    this.lastVersion = input.contentVersion;
    this.lastStart = input.time;
  }
}

// Crossfade from the convolution on display to a fresh one, so a refresh (about one a second in the
// accelerated day) doesn't step glossy surfaces. A snap (first capture, teleport, time skip) shows
// the new one at once.
const PROBE_BLEND_TIME = 1; // s, time constant of the ease

// Share of the remaining difference closed over dt (frame-rate independent).
export function probeBlendWeight(dt: number, tau = PROBE_BLEND_TIME): number {
  if (!(dt > 0)) return 0;
  if (!(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

export class ProbeCrossfade {
  private remaining = 0; // share of the difference between display and fresh still to close
  private snap = false;
  private tau: number;
  private settle: number;

  constructor(tau = PROBE_BLEND_TIME, settle = 0.01) {
    this.tau = tau;
    this.settle = settle;
  }

  // A new convolution is ready.
  fresh(snap: boolean): void {
    if (snap) this.snap = true;
    this.remaining = 1;
  }

  get blending(): boolean {
    return this.snap || this.remaining > 0;
  }

  // Blend weight toward the fresh convolution this frame: 0 nothing to do, 1 copy it outright.
  step(dt: number): number {
    if (this.snap) {
      this.snap = false;
      this.remaining = 0;
      return 1;
    }
    if (this.remaining <= 0) return 0;
    const w = probeBlendWeight(dt, this.tau);
    if (w <= 0) return 0;
    this.remaining *= 1 - w;
    if (this.remaining >= this.settle) return w;
    this.remaining = 0;
    return 1; // the last percent, exactly
  }
}
