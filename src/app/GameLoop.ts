// requestAnimationFrame driver: advances simulation time, asks the sim host to
// catch up, and renders at a smoothed time that trails the newest snapshot.

import type { AdvanceRequest, BoatControls, SimCommand, Snapshot } from '../sim/world/protocol';
import type { SimHost } from '../sim/world/SimHost';
import { RenderClock, SnapshotBuffer } from './RenderClock';

export interface FrameInfo {
  realDt: number; // seconds since the previous frame
  renderTime: number; // simulation time to draw
  snapshots: SnapshotBuffer<Snapshot>;
}

export interface LoopHooks {
  // Gathered just before each advance request.
  collectControls(): Record<string, BoatControls>;
  collectCommands(): SimCommand[];
  collectProbes(): Float64Array;
  render(frame: FrameInfo): void;
}

export class GameLoop {
  simTime = 0;
  paused = false;
  // Simulation seconds per real second (photo mode's slow motion: 1, 0.25 or 0 for frozen).
  timeScale = 1;
  readonly snapshots = new SnapshotBuffer<Snapshot>();
  private clock = new RenderClock();
  private lastFrame = 0;
  private handle = 0;
  private host: SimHost;
  private hooks: LoopHooks;
  private lastStepMs = 0;
  private lastSteps = 0;
  // Wake-grid buffers of the snapshots received since the last request: the renderer copies each
  // grid as it arrives (WakeLayer.setGrids), so the next request hands them back to the worker.
  private spent: ArrayBuffer[] = [];
  lastRealDt = 1 / 60;

  constructor(host: SimHost, hooks: LoopHooks) {
    this.host = host;
    this.hooks = hooks;
    host.onSnapshot((snapshot) => {
      this.snapshots.push(snapshot);
      for (const grid of snapshot.wakes ?? []) {
        if (grid.height.byteLength > 0) this.spent.push(grid.height.buffer as ArrayBuffer);
      }
      this.lastStepMs = snapshot.stepMs;
      this.lastSteps = snapshot.steps;
    });
  }

  get simStepMs(): number {
    return this.lastStepMs;
  }

  get simSteps(): number {
    return this.lastSteps;
  }

  // Drives its own requestAnimationFrame loop; alternatively call tick() from an outer loop.
  start(): void {
    this.lastFrame = performance.now();
    const frame = (now: number): void => {
      this.handle = requestAnimationFrame(frame);
      this.tick(now);
    };
    this.handle = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.handle);
  }

  tick(now: number): void {
    if (this.lastFrame === 0) this.lastFrame = now;
    // Clamp so a hidden tab or a breakpoint doesn't produce a giant step.
    const realDt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.lastRealDt = realDt;

    const commands = this.hooks.collectCommands();
    if (!this.paused) this.simTime += realDt * this.timeScale;
    const request: AdvanceRequest = {
      type: 'advance',
      targetTime: this.simTime,
      controls: this.hooks.collectControls(),
      commands,
      probes: this.hooks.collectProbes(),
    };
    if (this.spent.length > 0) {
      request.spent = this.spent;
      this.spent = [];
    }
    this.host.advance(request);

    const latest = this.snapshots.latest;
    if (!latest) return;
    const renderTime = this.paused
      ? this.clock.time
      : this.clock.update(realDt * this.timeScale, latest.time);
    this.hooks.render({ realDt, renderTime, snapshots: this.snapshots });
  }

  // Forget timing so the first tick after a long gap (menus, a new session) isn't a giant step.
  resetTiming(): void {
    this.lastFrame = 0;
  }
}
