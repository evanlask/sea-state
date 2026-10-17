// WebGPU renderer bootstrap. Sea State is WebGPU-only; the WebGL2 fallback
// that WebGPURenderer would otherwise pick is treated as unsupported.
import { WebGPURenderer } from 'three/webgpu';

import { installStorageRelease } from './gpuResources';
import { watchPixelRatio } from './pixelRatio';

export class UnsupportedError extends Error {}

async function checkWebGPU(): Promise<void> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new UnsupportedError('This browser does not support WebGPU.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new UnsupportedError('WebGPU is available, but no compatible graphics adapter was found.');
  }
}

export interface RendererOptions {
  container: HTMLElement;
  renderScale: number; // fraction of device pixels to render
  gpuTiming?: boolean; // GPU timestamp queries (a per-pass cost): only for the F3 overlay's GPU line
}

export class Renderer {
  readonly three: WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  private renderScale: number;
  private resizeListeners: ((width: number, height: number) => void)[] = [];
  private resizeObserver: ResizeObserver;
  private stopPixelRatioWatch: () => void;
  private container: HTMLElement;

  private constructor(three: WebGPURenderer, options: RendererOptions) {
    this.three = three;
    this.canvas = three.domElement;
    this.container = options.container;
    this.renderScale = Math.min(2, Math.max(0.25, options.renderScale));
    this.canvas.classList.add('scene-canvas');
    options.container.append(this.canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.container);
    this.stopPixelRatioWatch = watchPixelRatio(window, () => this.resize());
    this.resize();
  }

  static async create(options: RendererOptions): Promise<Renderer> {
    await checkWebGPU();
    // The ocean's fragment stage samples more than WebGPU's default 16 textures once boat wakes,
    // foam trails and water exclusion are on (OceanSurface checks what the device granted).
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    const sampled = Math.min(32, adapter?.limits.maxSampledTexturesPerShaderStage ?? 16);
    const three = new WebGPURenderer({
      antialias: false,
      requiredLimits: { maxSampledTexturesPerShaderStage: sampled },
      // Reversed-Z keeps depth precision from a 0.1 m near plane out to the horizon.
      reversedDepthBuffer: true,
      powerPreference: 'high-performance',
      trackTimestamp: options.gpuTiming === true,
    });
    await three.init();
    const backend = three.backend as { isWebGPUBackend?: boolean };
    if (!backend.isWebGPUBackend) {
      void three.dispose();
      throw new UnsupportedError('Your browser fell back to WebGL, but Sea State needs WebGPU.');
    }
    installStorageRelease(three);
    return new Renderer(three, options);
  }

  // Live: graphics.renderScale, or the dynamic-resolution controller (app/FrameRuntime).
  setRenderScale(scale: number): void {
    const next = Math.min(2, Math.max(0.25, Number.isFinite(scale) ? scale : 1));
    if (next === this.renderScale) return;
    this.renderScale = next;
    this.resize();
  }

  onResize(listener: (width: number, height: number) => void): void {
    this.resizeListeners.push(listener);
    listener(this.container.clientWidth, this.container.clientHeight);
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.three.setPixelRatio(window.devicePixelRatio * this.renderScale);
    this.three.setSize(width, height, false);
    for (const listener of this.resizeListeners) listener(width, height);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.stopPixelRatioWatch();
    void this.three.dispose();
  }
}
