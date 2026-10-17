// Frame statistics for the F3 performance overlay: smoothed FPS, frame-time average and
// maximum over a sliding window, and the values fed in from the sim and renderer. Pure, so
// it is tested without a DOM; the overlay only reads it a few times a second.

export interface PerfReadout {
  fps: number;
  frameAvgMs: number;
  frameMaxMs: number;
  simStepMs: number | null;
  stepsPerFrame: number | null;
  gpuMs: number | null;
  drawCalls: number | null;
  triangles: number | null;
  heapUsedMB: number | null;
  heapLimitMB: number | null;
  resolution: { scale: number; width: number; height: number; dynamic: boolean } | null;
}

interface Timed {
  time: number;
  value: number;
}

// Values older than the window drop out; arrays stay short (a second of frames).
class TimedWindow {
  readonly items: Timed[] = [];
  push(time: number, value: number): void {
    this.items.push({ time, value });
  }
  trim(now: number, span: number): void {
    let drop = 0;
    while (drop < this.items.length && now - this.items[drop].time > span) drop++;
    if (drop > 0) this.items.splice(0, drop);
  }
  mean(): number | null {
    if (this.items.length === 0) return null;
    return this.items.reduce((sum, item) => sum + item.value, 0) / this.items.length;
  }
  max(): number | null {
    return this.items.length === 0 ? null : Math.max(...this.items.map((item) => item.value));
  }
  sum(): number {
    return this.items.reduce((total, item) => total + item.value, 0);
  }
  clear(): void {
    this.items.length = 0;
  }
}

export class PerfStats {
  private readonly windowMs: number;
  private readonly smoothing: number;
  private lastFrame: number | null = null;
  private frames = new TimedWindow();
  private simMs = new TimedWindow();
  private steps = new TimedWindow();
  private gpuMs = new TimedWindow();
  private smoothedFps: number | null = null;
  private drawCalls: number | null = null;
  private triangles: number | null = null;
  private heapUsed: number | null = null;
  private heapLimit: number | null = null;
  private res: PerfReadout['resolution'] = null;

  constructor(options: { windowMs?: number; fpsSmoothing?: number } = {}) {
    this.windowMs = options.windowMs ?? 1000;
    // Weight given to each new reading; lower is steadier.
    this.smoothing = options.fpsSmoothing ?? 0.35;
  }

  // Call once per rendered frame with its timestamp in ms.
  frame(nowMs: number): void {
    if (this.lastFrame !== null) {
      const dt = nowMs - this.lastFrame;
      // A hidden tab or a breakpoint isn't a frame time worth reporting.
      if (dt > 0 && dt < 1000) this.frames.push(nowMs, dt);
    }
    this.lastFrame = nowMs;
    this.frames.trim(nowMs, this.windowMs);
  }

  // Sim step cost and how many fixed steps ran this frame.
  sim(nowMs: number, stepMs: number, stepsThisFrame: number): void {
    this.simMs.push(nowMs, stepMs);
    this.steps.push(nowMs, stepsThisFrame);
  }

  gpu(nowMs: number, ms: number): void {
    this.gpuMs.push(nowMs, ms);
  }

  render(drawCalls: number, triangles: number): void {
    this.drawCalls = drawCalls;
    this.triangles = triangles;
  }

  resolution(res: PerfReadout['resolution']): void {
    this.res = res;
  }

  heap(usedBytes: number, limitBytes: number | null): void {
    this.heapUsed = usedBytes;
    this.heapLimit = limitBytes;
  }

  read(nowMs: number): PerfReadout {
    for (const series of [this.frames, this.simMs, this.steps, this.gpuMs]) series.trim(nowMs, this.windowMs);
    const frameAvg = this.frames.mean();
    const rawFps = frameAvg && frameAvg > 0 ? 1000 / frameAvg : 0;
    this.smoothedFps =
      this.smoothedFps === null ? rawFps : this.smoothedFps + (rawFps - this.smoothedFps) * this.smoothing;
    const frameCount = this.frames.items.length;
    return {
      fps: this.smoothedFps,
      frameAvgMs: frameAvg ?? 0,
      frameMaxMs: this.frames.max() ?? 0,
      simStepMs: this.simMs.mean(),
      // Per rendered frame, so 0.5 means a step every other frame.
      stepsPerFrame: this.steps.items.length === 0 ? null : this.steps.sum() / Math.max(1, frameCount),
      gpuMs: this.gpuMs.mean(),
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      heapUsedMB: this.heapUsed === null ? null : this.heapUsed / 1048576,
      heapLimitMB: this.heapLimit === null ? null : this.heapLimit / 1048576,
      resolution: this.res,
    };
  }

  reset(): void {
    this.lastFrame = null;
    this.smoothedFps = null;
    for (const series of [this.frames, this.simMs, this.steps, this.gpuMs]) series.clear();
  }
}

function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} k`;
  return String(Math.round(value));
}

// Fixed-width lines for the monospace panel.
export function formatReadout(readout: PerfReadout): string[] {
  const lines = [
    `FPS   ${readout.fps.toFixed(0).padStart(5)}`,
    `frame ${readout.frameAvgMs.toFixed(1).padStart(5)} ms  max ${readout.frameMaxMs.toFixed(1)} ms`,
  ];
  if (readout.simStepMs !== null) {
    const steps = readout.stepsPerFrame === null ? '' : `  ×${readout.stepsPerFrame.toFixed(2)}/frame`;
    lines.push(`sim   ${readout.simStepMs.toFixed(2).padStart(5)} ms${steps}`);
  }
  if (readout.gpuMs !== null)
    lines.push(`gpu   ${readout.gpuMs.toFixed(2).padStart(5)} ms (overstated on Apple GPUs)`);
  const res = readout.resolution;
  if (res) {
    const pct = `${Math.round(res.scale * 100)}%`.padStart(5);
    lines.push(`res   ${pct}  ${res.width}×${res.height}${res.dynamic ? '  dynamic' : ''}`);
  }
  if (readout.drawCalls !== null) {
    lines.push(`draws ${String(readout.drawCalls).padStart(5)}    tris ${compact(readout.triangles ?? 0)}`);
  }
  if (readout.heapUsedMB !== null) {
    const limit = readout.heapLimitMB === null ? '' : ` / ${readout.heapLimitMB.toFixed(0)}`;
    lines.push(`heap  ${readout.heapUsedMB.toFixed(0).padStart(5)}${limit} MB`);
  }
  return lines;
}
