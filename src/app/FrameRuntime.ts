// Per-frame graphics runtime: live render scale, the dynamic-resolution controller, the FPS cap and
// GPU timing (one timestamp resolve in flight at a time, covering the frames since the last).

import { DynamicResolution, dynamicTargetFps, FrameLimiter } from '../render/framePacing';
import type { Renderer } from '../render/Renderer';
import type { GraphicsSettings } from '../settings/schema';

type Graphics = Readonly<
  Pick<GraphicsSettings, 'renderScale' | 'dynamicResolution' | 'targetFps' | 'fpsCap'>
>;

export class FrameRuntime {
  private readonly renderer: Renderer;
  private readonly limiter = new FrameLimiter();
  private readonly dynamic: DynamicResolution;
  private graphics: Graphics;
  private lastFrame = 0;
  private timestamps: boolean;
  private resolving = false;
  private framesSinceResolve = 0;
  private gpu: number | null = null;
  paused = false; // warm-up and loading: no samples, no resolution changes

  constructor(renderer: Renderer, graphics: Graphics) {
    this.renderer = renderer;
    this.graphics = graphics;
    this.dynamic = new DynamicResolution({
      targetFps: dynamicTargetFps(graphics.targetFps, graphics.fpsCap),
      maxScale: graphics.renderScale,
    });
    this.limiter.cap = graphics.fpsCap;
    const three = renderer.three as {
      hasFeature?: (name: string) => boolean;
      backend?: { trackTimestamp?: boolean };
    };
    this.timestamps =
      (three.backend?.trackTimestamp ?? false) && (three.hasFeature?.('timestamp-query') ?? false);
  }

  // GPU ms per frame (render + compute passes), or null without timestamp queries.
  get gpuMs(): number | null {
    return this.gpu;
  }

  get renderScale(): number {
    return this.graphics.dynamicResolution ? this.dynamic.scale : this.graphics.renderScale;
  }

  apply(graphics: Graphics): void {
    const previous = this.graphics;
    this.graphics = graphics;
    this.limiter.cap = graphics.fpsCap;
    this.dynamic.configure({
      targetFps: dynamicTargetFps(graphics.targetFps, graphics.fpsCap),
      maxScale: graphics.renderScale,
    });
    if (
      graphics.renderScale !== previous.renderScale ||
      graphics.dynamicResolution !== previous.dynamicResolution
    ) {
      this.dynamic.reset(graphics.renderScale);
      this.renderer.setRenderScale(graphics.renderScale);
    }
  }

  // Whether this rAF callback renders (graphics.fpsCap).
  shouldRender(now: number): boolean {
    return this.limiter.shouldRender(now);
  }

  // After a rendered frame.
  afterFrame(now: number): void {
    const frameMs = this.lastFrame > 0 ? now - this.lastFrame : 0;
    this.lastFrame = now;
    this.framesSinceResolve++;
    this.resolveTimestamps();
    if (this.paused || !this.graphics.dynamicResolution || frameMs <= 0) return;
    // Steered on the frame interval alone: on Apple GPUs WebGPU timestamps overstate GPU time (25 ms
    // reported at a steady 60 FPS), which made it drop to half resolution for nothing. GPU ms is
    // still shown in the F3 overlay.
    const next = this.dynamic.update({ now, frameMs });
    if (next !== null) this.renderer.setRenderScale(next);
  }

  // After a gap (loading, a pause): forget the frame interval.
  resetTiming(): void {
    this.lastFrame = 0;
  }

  private resolveTimestamps(): void {
    if (!this.timestamps || this.resolving) return;
    this.resolving = true;
    const frames = this.framesSinceResolve;
    this.framesSinceResolve = 0;
    const three = this.renderer.three;
    Promise.all([three.resolveTimestampsAsync('render'), three.resolveTimestampsAsync('compute')])
      .then(([render, compute]) => {
        const total = (Number(render) || 0) + (Number(compute) || 0);
        if (total > 0 && frames > 0) this.gpu = total / frames;
      })
      .catch(() => {
        this.timestamps = false;
        this.gpu = null;
      })
      .finally(() => {
        this.resolving = false;
      });
  }
}
