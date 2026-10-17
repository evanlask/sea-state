// Pre-exposed HDR and auto-exposure.
//
// Design (no CPU readback on the critical path):
//   1. Every frame the CPU picks a pre-exposure multiplier and every light and sky node multiplies
//      physical units (lux, cd/m²) by it, keeping the HDR target well inside fp16 range.
//   2. A one-workgroup compute kernel reads the previous frame's HDR colour (8192 centre-weighted
//      samples), reduces the average log-luminance in shared memory, divides out that frame's
//      pre-exposure, and adapts an EV100 held in a GPU storage buffer (eye adaptation with separate
//      up/down rates, min/max clamps and the night-darkening curve).
//   3. The output node multiplies by exposure(adapted EV) / preExposure, read straight from that
//      buffer, so the image follows the GPU meter exactly with one frame of latency.
//   4. An async readback (~4 Hz, never awaited) feeds the measured EV back to the CPU adaptation,
//      so the pre-exposure tracks the GPU and the residual stays close to 1. Without a measurement
//      source (or before the first readback) the CPU uses a clear-sky illuminance model instead.
//
// Tone mapping is the renderer's (AgX by default) applied by the RenderPipeline output transform.

import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  type ComputeNode,
  NeutralToneMapping,
  type Node,
  type StorageBufferAttribute,
  type Texture,
  type ToneMapping,
  type WebGPURenderer,
} from 'three/webgpu';

import { releaseBuffer } from '../gpuResources';
import { type N, tsl } from '../tsl';
import {
  adaptEv100,
  DEFAULT_EXPOSURE_SETTINGS,
  HIGHLIGHT_HEADROOM_EV,
  HIGHLIGHT_SAMPLE_MAX,
  estimateIlluminance,
  ev100FromIlluminance,
  exposureFromEv100,
  type ExposureSettings,
  nightDarkening,
  targetEv100,
} from './exposureMath';

const {
  Fn,
  If,
  Loop,
  attributeArray,
  clamp,
  dot,
  exp,
  exp2,
  float,
  fract,
  invocationLocalIndex,
  length,
  log,
  max,
  min,
  mix,
  screenCoordinate,
  select,
  smoothstep,
  storage,
  texture,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
  workgroupArray,
  workgroupBarrier,
} = tsl;

export type ToneMappingMode = 'agx' | 'aces' | 'neutral';

const TONE_MAPPING: Record<ToneMappingMode, ToneMapping> = {
  agx: AgXToneMapping,
  aces: ACESFilmicToneMapping,
  neutral: NeutralToneMapping,
};

export interface ExposureOptions extends Partial<ExposureSettings> {
  toneMapping?: ToneMappingMode;
  purkinje?: boolean; // blue-shifted, desaturated night vision
}

export interface ExposureFrame {
  dt: number; // s
  sunElevation: number; // rad
  moonElevation: number; // rad
  moonIlluminance: number; // lux outside the atmosphere for the current phase
  overcast: number; // 0..1
  dimming?: number; // EV darker than metered (e.g. under a cloud), on top of the compensation
}

const THREADS = 256;
const SAMPLES_PER_THREAD = 32;
const GRID_X = 128; // THREADS × SAMPLES_PER_THREAD = GRID_X × GRID_Y
const GRID_Y = 64;
const READBACK_INTERVAL = 0.25; // s
const GPU_FRESH = 1.5; // s; older readbacks fall back to the CPU model
// State buffer layout.
const S_ADAPTED = 0;
const S_MEASURED = 1;
const S_READY = 2;
const S_TARGET = 3;

export class Exposure {
  readonly settings: ExposureSettings;
  // Pre-exposure for this frame; share with SkySystem.preExposure and light intensities.
  readonly preExposureNode: N = uniform(1);
  private toneMappingMode: ToneMappingMode;
  private purkinje: N = uniform(1);
  private cpuEv = Number.NaN;
  private snapNext = true;
  private state: N; // read-write, compute
  private stateRead: N; // read-only, fragment
  private stateAttribute: StorageBufferAttribute;
  private meter: ComputeNode | null = null;
  private meterSource: Texture | null = null;
  private framesMeasured = 0;
  private uniforms = {
    meterPreExposure: uniform(1),
    dt: uniform(0),
    minEv: uniform(DEFAULT_EXPOSURE_SETTINGS.minEv100),
    maxEv: uniform(DEFAULT_EXPOSURE_SETTINGS.maxEv100),
    darkening: uniform(0),
    bias: uniform(0),
    speedUp: uniform(DEFAULT_EXPOSURE_SETTINGS.speedUp),
    speedDown: uniform(DEFAULT_EXPOSURE_SETTINGS.speedDown),
    manual: uniform(0),
    manualEv: uniform(DEFAULT_EXPOSURE_SETTINGS.manualEv100),
    reset: uniform(1),
    gpuActive: uniform(0),
    cpuEv: uniform(10),
  };
  private readbackTimer = 0;
  private readbackPending = false;
  private gpuMeasured: number | null = null;
  private gpuAdapted: number | null = null;
  private gpuAge = Number.POSITIVE_INFINITY;
  private lastMetered = 10;

  constructor(options: ExposureOptions = {}) {
    const { toneMapping, purkinje, ...settings } = options;
    this.settings = { ...DEFAULT_EXPOSURE_SETTINGS, ...settings };
    this.toneMappingMode = toneMapping ?? 'agx';
    this.purkinje.value = purkinje === false ? 0 : 1;
    this.state = attributeArray(4, 'float');
    this.stateAttribute = this.state.value as StorageBufferAttribute;
    this.stateRead = storage(this.stateAttribute, 'float', 4).toReadOnly();
  }

  get preExposure(): number {
    return this.preExposureNode.value as number;
  }

  // Current EV100 of the image (GPU-adapted when metering, else the CPU estimate).
  get ev100(): number {
    return this.gpuAdapted !== null && this.gpuAge < GPU_FRESH ? this.gpuAdapted : this.cpuEv;
  }

  // EV100 the meter last measured (GPU readback or CPU model).
  get meteredEv100(): number {
    return this.lastMetered;
  }

  get gpuMetering(): boolean {
    return this.meterSource !== null;
  }

  get toneMapping(): ToneMappingMode {
    return this.toneMappingMode;
  }

  setToneMapping(renderer: WebGPURenderer, mode: ToneMappingMode): void {
    this.toneMappingMode = mode;
    this.applyToneMapping(renderer);
  }

  // Exposure lives in the pre-exposure and residual, so the tone mapper sees exposure 1.
  applyToneMapping(renderer: WebGPURenderer): void {
    renderer.toneMapping = TONE_MAPPING[this.toneMappingMode];
    renderer.toneMappingExposure = 1;
  }

  setPurkinje(enabled: boolean): void {
    this.purkinje.value = enabled ? 1 : 0;
  }

  // Adapt instantly on the next update (scene cuts, time jumps, first frame).
  snap(): void {
    this.snapNext = true;
  }

  // The linear HDR colour of the rendered frame (e.g. a PassNode's output texture), or null to
  // disable GPU metering.
  setMeasureSource(source: Texture | null): void {
    if (source === this.meterSource) return;
    this.meter?.dispose();
    this.meter = source ? this.buildMeter(source) : null;
    this.meterSource = source;
    this.framesMeasured = 0;
    this.uniforms.gpuActive.value = 0;
    this.gpuMeasured = null;
    this.gpuAdapted = null;
    this.snapNext = true;
  }

  // Wraps the scene's HDR colour: applies the GPU residual exposure and night vision. Use as the
  // RenderPipeline output (tone mapping follows via outputColorTransform).
  createOutputNode(color: Node): Node {
    const c: N = color;
    const u = this.uniforms;
    const adapted = this.stateRead.element(S_ADAPTED);
    const live = u.gpuActive.greaterThan(0.5).and(this.stateRead.element(S_READY).greaterThan(0.5));
    const ev = select(live, adapted, u.cpuEv);
    const residual = select(live, float(1).div(exp2(adapted).mul(1.2).mul(this.preExposureNode)), float(1));
    const rgb = c.rgb.mul(residual).toVar();
    // Purkinje shift: rods take over below ~EV 0 — bluer, desaturated, no colour at starlight.
    const night = smoothstep(1.5, -4, ev).mul(this.purkinje).mul(0.75);
    const scotopic = dot(rgb, vec3(0.02, 0.56, 0.42));
    const shifted = mix(rgb, vec3(scotopic).mul(vec3(0.74, 0.9, 1.22)), night);
    // Multiplicative dither, ~±½ LSB after AgX/ACES (interleaved gradient noise), against
    // 8-bit banding in smooth skies.
    const pixel = screenCoordinate.xy;
    const noise = fract(fract(dot(pixel, vec2(0.06711056, 0.00583715))).mul(52.9829189));
    const dithered = shifted.mul(noise.sub(0.5).mul(0.02).add(1));
    return vec4(dithered, c.a) as Node;
  }

  // Call once per frame before rendering. Meters the previous frame on the GPU (if a source is
  // set), adapts, and publishes this frame's pre-exposure.
  update(renderer: WebGPURenderer, frame: ExposureFrame): void {
    const s = this.settings;
    const u = this.uniforms;
    const dt = Math.min(Math.max(frame.dt, 0), 0.25);
    const darkening = s.nightDarkening ? nightDarkening(frame.sunElevation) : 0;

    // GPU metering of last frame, against the pre-exposure it was rendered with.
    if (this.meter) {
      u.meterPreExposure.value = this.preExposure;
      u.dt.value = dt;
      u.minEv.value = s.minEv100;
      u.maxEv.value = s.maxEv100;
      u.darkening.value = darkening;
      u.bias.value = s.compensation - (frame.dimming ?? 0);
      u.speedUp.value = s.speedUp;
      u.speedDown.value = s.speedDown;
      u.manual.value = s.mode === 'manual' ? 1 : 0;
      u.manualEv.value = s.manualEv100;
      u.reset.value = this.snapNext || this.framesMeasured === 0 ? 1 : 0;
      if (this.framesMeasured > 0) {
        void renderer.compute(this.meter);
        u.gpuActive.value = 1;
      }
      this.framesMeasured++;
      this.readback(renderer, dt);
    }

    // CPU adaptation: GPU meter when fresh, else the illuminance model.
    this.gpuAge += dt;
    const metered =
      this.gpuMeasured !== null && this.gpuAge < GPU_FRESH
        ? this.gpuMeasured
        : ev100FromIlluminance(estimateIlluminance(frame));
    this.lastMetered = metered;
    const target =
      targetEv100(metered, frame.sunElevation, s) + (s.mode === 'manual' ? 0 : (frame.dimming ?? 0));
    this.cpuEv = this.snapNext || Number.isNaN(this.cpuEv) ? target : adaptEv100(this.cpuEv, target, dt, s);
    this.snapNext = false;
    this.preExposureNode.value = exposureFromEv100(this.cpuEv);
    u.cpuEv.value = this.cpuEv;
  }

  dispose(): void {
    this.meter?.dispose();
    this.meter = null;
    releaseBuffer(this.stateAttribute);
  }

  private readback(renderer: WebGPURenderer, dt: number): void {
    this.readbackTimer += dt;
    if (this.readbackPending || this.readbackTimer < READBACK_INTERVAL || this.framesMeasured < 3) return;
    this.readbackTimer = 0;
    this.readbackPending = true;
    void renderer
      .getArrayBufferAsync(this.stateAttribute)
      .then((buffer) => {
        const data = new Float32Array(buffer as ArrayBuffer);
        if ((data[S_READY] ?? 0) > 0.5 && Number.isFinite(data[S_MEASURED])) {
          this.gpuMeasured = data[S_MEASURED] ?? null;
          this.gpuAdapted = data[S_ADAPTED] ?? null;
          this.gpuAge = 0;
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.readbackPending = false;
      });
  }

  private buildMeter(source: Texture): ComputeNode {
    const u = this.uniforms;
    const state = this.state;
    const ln2 = Math.LN2;
    const kernel = Fn(() => {
      const shared = workgroupArray('vec4', THREADS);
      const thread = invocationLocalIndex;
      // x: Σ w·ln L, y: Σ w, z: Σ w·L with L capped (highlight protection), all physical units.
      const sum = vec4(0).toVar();
      Loop(SAMPLES_PER_THREAD, ({ i }: { i: N }) => {
        const index = thread.mul(uint(SAMPLES_PER_THREAD)).add(uint(i));
        const gx = index.mod(uint(GRID_X));
        const gy = index.div(uint(GRID_X));
        const uv = vec2(float(gx).add(0.5).div(GRID_X), float(gy).add(0.5).div(GRID_Y));
        const rgb = texture(source, uv).level(0).rgb;
        const preExposed = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        const physical = preExposed.div(u.meterPreExposure);
        const capped = min(preExposed, HIGHLIGHT_SAMPLE_MAX).div(u.meterPreExposure);
        const lnL = clamp(log(max(physical, 1e-6)), Math.log(1e-6), Math.log(1e6));
        // Centre-weighted: 1 in the middle, ~0.36 in the corners.
        const weight = float(1).sub(length(uv.sub(0.5)).mul(0.9));
        sum.addAssign(vec4(lnL.mul(weight), weight, capped.mul(weight), 0));
      });
      shared.element(thread).assign(sum);
      workgroupBarrier();
      for (let stride = THREADS / 2; stride >= 1; stride /= 2) {
        If(thread.lessThan(uint(stride)), () => {
          shared.element(thread).addAssign(shared.element(thread.add(uint(stride))));
        });
        workgroupBarrier();
      }
      If(thread.equal(uint(0)), () => {
        const total = shared.element(uint(0));
        const weights = max(total.y, 1e-6);
        const avgLn = total.x.div(weights);
        const meanLn = log(max(total.z.div(weights), 1e-6));
        // EV100 = log2(L · 100 / K), K = 12.5; see highlightProtectedEv100.
        const offset = Math.log2(100 / 12.5);
        const measured = max(avgLn.div(ln2), meanLn.div(ln2).sub(HIGHLIGHT_HEADROOM_EV)).add(offset);
        const automatic = clamp(measured, u.minEv, u.maxEv).add(u.darkening).sub(u.bias);
        const target = select(u.manual.greaterThan(0.5), u.manualEv, automatic);
        const current = state.element(S_ADAPTED);
        const rate = select(target.greaterThan(current), u.speedUp, u.speedDown);
        const adapted = current.add(target.sub(current).mul(float(1).sub(exp(u.dt.mul(rate).negate()))));
        const fresh = u.reset.greaterThan(0.5).or(state.element(S_READY).lessThan(0.5));
        state.element(S_ADAPTED).assign(select(fresh, target, adapted));
        state.element(S_MEASURED).assign(measured);
        state.element(S_READY).assign(1);
        state.element(S_TARGET).assign(target);
      });
    });
    const node: ComputeNode = kernel().compute([1, 1, 1], [THREADS]);
    node.setName('exposure-meter');
    return node;
  }
}
