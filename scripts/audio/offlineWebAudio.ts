// A small offline Web Audio graph for Node: enough of the API for the game's AudioEngine (gains,
// biquads, buffer sources, oscillators and periodic waves, panners, stereo panners, channel
// splitters and mergers, wave shapers; the compressor and analysers pass audio through) to render
// it block by block without a browser. Pull-based: rendering a quantum asks the destination for its
// input, which asks its inputs, and so on, each node computing each 128-frame quantum once. Close
// enough to the spec for level measurements (scripts/audio-levels.ts), not for listening: panners
// are equal-power (the game defaults to HRTF), oscillators aren't band-limited, filters update
// their coefficients once per quantum.

export const QUANTUM = 128;

type Channels = Float32Array[];

const silence = (channels: number): Channels =>
  Array.from({ length: channels }, () => new Float32Array(QUANTUM));

// ---------------------------------------------------------------------------------------------
// Buffers and periodic waves

export class OfflineBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];

  constructor(channels: number, length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.data = Array.from({ length: channels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.data[channel]!;
  }

  copyToChannel(source: Float32Array, channel: number): void {
    this.data[channel]!.set(source.subarray(0, this.length));
  }
}

const TABLE = 4096;

export class OfflinePeriodicWave {
  readonly table: Float32Array;

  constructor(real: ArrayLike<number>, imag: ArrayLike<number>, normalize: boolean) {
    const table = new Float32Array(TABLE + 1);
    const n = Math.max(real.length, imag.length);
    let peak = 0;
    for (let i = 0; i <= TABLE; i++) {
      const phase = (2 * Math.PI * i) / TABLE;
      let v = 0;
      for (let k = 1; k < n; k++) {
        v += (real[k] ?? 0) * Math.cos(k * phase) + (imag[k] ?? 0) * Math.sin(k * phase);
      }
      table[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    if (normalize && peak > 0) for (let i = 0; i <= TABLE; i++) table[i]! /= peak;
    this.table = table;
  }
}

function basicWave(type: string): OfflinePeriodicWave {
  const harmonics = 64;
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let k = 1; k < harmonics; k++) {
    if (type === 'sine') imag[k] = k === 1 ? 1 : 0;
    else if (type === 'square') imag[k] = k % 2 ? 4 / (Math.PI * k) : 0;
    else if (type === 'sawtooth') imag[k] = ((k % 2 ? 1 : -1) * 2) / (Math.PI * k);
    else if (type === 'triangle')
      imag[k] = k % 2 ? (8 / (Math.PI * Math.PI * k * k)) * (k % 4 === 1 ? 1 : -1) : 0;
  }
  return new OfflinePeriodicWave(real, imag, type !== 'sine');
}

// ---------------------------------------------------------------------------------------------
// Parameters

type ParamEvent =
  | { kind: 'set'; time: number; value: number }
  | { kind: 'target'; time: number; value: number; tau: number }
  | { kind: 'ramp' | 'exp'; time: number; value: number }
  | { kind: 'curve'; time: number; curve: Float32Array; duration: number };

export class OfflineParam {
  readonly inputs: OfflineNode[] = [];
  private readonly ctx: OfflineContext;
  private events: ParamEvent[] = [];
  private current: ParamEvent | null = null; // the event in effect
  private startValue = 0; // value when `current` began
  private lastTime = 0; // when the previous event ended (ramps start there)
  private lastValue = 0;
  private now: number;
  private readonly out = new Float32Array(QUANTUM);

  constructor(ctx: OfflineContext, value: number) {
    this.ctx = ctx;
    this.now = value;
    this.lastValue = value;
  }

  get value(): number {
    return this.now;
  }

  set value(v: number) {
    if (this.events.length === 0 && (this.current === null || this.current.kind === 'set')) {
      this.now = v;
      this.lastValue = v;
      this.current = null;
    } else {
      this.setValueAtTime(v, this.ctx.currentTime);
    }
  }

  private insert(event: ParamEvent): this {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.time > event.time) i--;
    this.events.splice(i, 0, event);
    return this;
  }

  setValueAtTime(value: number, time: number): this {
    return this.insert({ kind: 'set', time, value });
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    return this.insert({ kind: 'target', time, value, tau });
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.insert({ kind: 'ramp', time, value });
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    return this.insert({ kind: 'exp', time, value });
  }

  setValueCurveAtTime(curve: ArrayLike<number>, time: number, duration: number): this {
    return this.insert({ kind: 'curve', time, curve: Float32Array.from(curve), duration });
  }

  cancelScheduledValues(time: number): this {
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }

  // The intrinsic value of `current` at time t.
  private evaluate(t: number): number {
    const e = this.current;
    if (!e) return this.lastValue;
    if (e.kind === 'target') {
      return e.value + (this.startValue - e.value) * Math.exp(-(t - e.time) / Math.max(e.tau, 1e-6));
    }
    if (e.kind === 'curve') {
      const n = e.curve.length;
      if (t >= e.time + e.duration || n === 0) return e.curve[n - 1] ?? 0;
      const x = ((t - e.time) / e.duration) * (n - 1);
      const i = Math.floor(x);
      const a = e.curve[i] ?? 0;
      const b = e.curve[Math.min(i + 1, n - 1)] ?? a;
      return a + (b - a) * (x - i);
    }
    return e.value;
  }

  // Values for the quantum starting at `start` (seconds), plus any connected inputs.
  render(start: number, quantum: number): Float32Array {
    const out = this.out;
    const dt = 1 / this.ctx.sampleRate;
    const constant = this.events.length === 0 && (this.current === null || this.current.kind === 'set');
    if (constant) {
      out.fill(this.current ? (this.current as { value: number }).value : this.lastValue);
    } else {
      for (let s = 0; s < QUANTUM; s++) {
        const t = start + s * dt;
        let next = this.events[0];
        while (next && next.time <= t) {
          this.events.shift();
          const before = this.evaluate(next.time);
          if (next.kind === 'ramp' || next.kind === 'exp') {
            this.current = { kind: 'set', time: next.time, value: next.value };
          } else {
            this.current = next;
            this.startValue = before;
          }
          const end = next.kind === 'curve' ? next.time + next.duration : next.time;
          this.lastTime = end;
          this.lastValue = next.kind === 'curve' ? (next.curve[next.curve.length - 1] ?? 0) : before;
          if (next.kind === 'set' || next.kind === 'ramp' || next.kind === 'exp') this.lastValue = next.value;
          next = this.events[0];
        }
        let v: number;
        if (next && (next.kind === 'ramp' || next.kind === 'exp')) {
          const t0 = this.lastTime;
          const v0 = this.current ? this.evaluate(t0) : this.lastValue;
          const f = next.time > t0 ? (t - t0) / (next.time - t0) : 1;
          v =
            next.kind === 'exp' && v0 * next.value > 0
              ? v0 * Math.pow(next.value / v0, f)
              : v0 + (next.value - v0) * f;
        } else {
          v = this.evaluate(t);
        }
        out[s] = v;
      }
      const c = this.current;
      const settled = c?.kind === 'target' && start - c.time > 30 * c.tau;
      if (c && (c.kind === 'set' || settled) && this.events.length === 0) {
        this.lastValue = c.value;
        this.current = null;
      }
    }
    for (const input of this.inputs) {
      const channels = input.output(quantum, 0);
      const k = 1 / channels.length;
      for (const ch of channels)
        for (let s = 0; s < QUANTUM; s++) out[s]! += ch[s]! * (channels.length > 1 ? k : 1);
    }
    this.now = out[QUANTUM - 1]!;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Nodes

type Connection = { node: OfflineNode; output: number };

export class OfflineNode {
  readonly context: OfflineContext;
  readonly inputs: Connection[][];
  readonly numberOfOutputs: number;
  channelCount = 2;
  channelCountMode: 'max' | 'clamped-max' | 'explicit' = 'max';
  channelInterpretation: 'speakers' | 'discrete' = 'speakers';
  private readonly targets = new Set<{ disconnect(): void }>();
  private cacheQuantum = -1;
  private cache: Channels[] = [];

  constructor(context: OfflineContext, inputs = 1, outputs = 1) {
    this.context = context;
    this.inputs = Array.from({ length: inputs }, () => []);
    this.numberOfOutputs = outputs;
  }

  connect<T>(destination: T, output = 0, input = 0): T {
    if (destination instanceof OfflineParam) {
      destination.inputs.push(this);
      this.targets.add({
        disconnect: () => {
          const i = destination.inputs.indexOf(this);
          if (i >= 0) destination.inputs.splice(i, 1);
        },
      });
    } else if (destination instanceof OfflineNode) {
      const list = destination.inputs[input]!;
      const connection = { node: this, output };
      list.push(connection);
      this.targets.add({
        disconnect: () => {
          const i = list.indexOf(connection);
          if (i >= 0) list.splice(i, 1);
        },
      });
    }
    return destination;
  }

  disconnect(): void {
    for (const t of this.targets) t.disconnect();
    this.targets.clear();
  }

  // This node's output `index` for a quantum, computed once.
  output(quantum: number, index = 0): Channels {
    if (this.cacheQuantum !== quantum) {
      this.cacheQuantum = quantum;
      this.cache = this.process(quantum);
    }
    return this.cache[index] ?? silence(1);
  }

  // Input `index` mixed to the node's computed channel count.
  protected mixInput(quantum: number, index = 0): Channels {
    const sources = (this.inputs[index] ?? []).map((c) => c.node.output(quantum, c.output));
    let channels: number;
    const widest = sources.reduce((m, s) => Math.max(m, s.length), 1);
    if (this.channelCountMode === 'explicit') channels = this.channelCount;
    else if (this.channelCountMode === 'clamped-max') channels = Math.min(widest, this.channelCount);
    else channels = widest;
    const out = silence(channels);
    for (const src of sources) mixInto(out, src, this.channelInterpretation);
    return out;
  }

  protected process(quantum: number): Channels[] {
    return [this.mixInput(quantum)];
  }
}

function mixInto(out: Channels, src: Channels, interpretation: 'speakers' | 'discrete'): void {
  const n = out.length;
  const m = src.length;
  if (interpretation === 'speakers' && m === 1 && n === 2) {
    for (let s = 0; s < QUANTUM; s++) {
      out[0]![s]! += src[0]![s]!;
      out[1]![s]! += src[0]![s]!;
    }
  } else if (interpretation === 'speakers' && m === 2 && n === 1) {
    for (let s = 0; s < QUANTUM; s++) out[0]![s]! += 0.5 * (src[0]![s]! + src[1]![s]!);
  } else {
    for (let c = 0; c < Math.min(n, m); c++) for (let s = 0; s < QUANTUM; s++) out[c]![s]! += src[c]![s]!;
  }
}

export class OfflineGain extends OfflineNode {
  readonly gain: OfflineParam;

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.gain = new OfflineParam(ctx, 1);
  }

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    const g = this.gain.render(this.context.timeOf(quantum), quantum);
    for (const ch of input) for (let s = 0; s < QUANTUM; s++) ch[s]! *= g[s]!;
    return [input];
  }
}

export class OfflineBiquad extends OfflineNode {
  type = 'lowpass';
  readonly frequency: OfflineParam;
  readonly Q: OfflineParam;
  readonly gain: OfflineParam;
  readonly detune: OfflineParam;
  private state: Float64Array[] = [];

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.frequency = new OfflineParam(ctx, 350);
    this.Q = new OfflineParam(ctx, 1);
    this.gain = new OfflineParam(ctx, 0);
    this.detune = new OfflineParam(ctx, 0);
  }

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    const t = this.context.timeOf(quantum);
    const sr = this.context.sampleRate;
    const f0 = Math.min(Math.max(this.frequency.render(t, quantum)[0]!, 1), sr / 2 - 1);
    const q = this.Q.render(t, quantum)[0]!;
    const dbGain = this.gain.render(t, quantum)[0]!;
    this.detune.render(t, quantum);
    const w0 = (2 * Math.PI * f0) / sr;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (this.type === 'lowpass' || this.type === 'highpass') {
      const alpha = sin / (2 * Math.pow(10, q / 20));
      const sign = this.type === 'lowpass' ? 1 : -1;
      b0 = (1 - sign * cos) / 2;
      b1 = sign * (1 - sign * cos);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (this.type === 'bandpass') {
      const alpha = sin / (2 * Math.max(q, 1e-4));
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
    } else if (this.type === 'peaking') {
      const A = Math.pow(10, dbGain / 40);
      const alpha = sin / (2 * Math.max(q, 1e-4));
      b0 = 1 + alpha * A;
      b1 = -2 * cos;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cos;
      a2 = 1 - alpha / A;
    } else {
      throw new Error(`biquad type ${this.type} not emulated`);
    }
    b0 /= a0;
    b1 /= a0;
    b2 /= a0;
    a1 /= a0;
    a2 /= a0;
    while (this.state.length < input.length) this.state.push(new Float64Array(4));
    input.forEach((ch, c) => {
      const st = this.state[c]!;
      let [x1, x2, y1, y2] = st as unknown as [number, number, number, number];
      for (let s = 0; s < QUANTUM; s++) {
        const x = ch[s]!;
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = Math.abs(y) < 1e-30 ? 0 : y;
        ch[s] = y1;
      }
      st[0] = x1;
      st[1] = x2;
      st[2] = y1;
      st[3] = y2;
    });
    return [input];
  }
}

abstract class OfflineSource extends OfflineNode {
  onended: (() => void) | null = null;
  protected startTime = Infinity;
  protected stopTime = Infinity;
  private ended = false;

  constructor(ctx: OfflineContext) {
    super(ctx, 0, 1);
  }

  start(when = 0, ..._rest: number[]): void {
    this.startTime = Math.max(when, this.context.currentTime);
    this.context.sources.add(this);
  }

  stop(when = 0): void {
    this.stopTime = Math.max(when, this.context.currentTime);
  }

  protected finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.context.sources.delete(this);
    this.context.later(() => this.onended?.());
  }

  // Called by the context after each quantum, so sources nobody listens to still end.
  tick(quantum: number): void {
    if (this.context.timeOf(quantum + 1) >= this.stopTime) this.finish();
  }
}

export class OfflineBufferSource extends OfflineSource {
  buffer: OfflineBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate: OfflineParam;
  readonly detune: OfflineParam;
  private position = -1; // in buffer frames; -1 = not started

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.playbackRate = new OfflineParam(ctx, 1);
    this.detune = new OfflineParam(ctx, 0);
  }

  private offset = 0;

  override start(when = 0, offset = 0): void {
    super.start(when);
    this.offset = offset;
  }

  protected override process(quantum: number): Channels[] {
    const buffer = this.buffer;
    const t = this.context.timeOf(quantum);
    const rate = this.playbackRate.render(t, quantum)[0]!;
    const out = silence(buffer?.numberOfChannels ?? 1);
    if (!buffer) return [out];
    const sr = this.context.sampleRate;
    const step = (rate * buffer.sampleRate) / sr;
    const data = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const len = buffer.length;
    const loopOn = this.loop;
    let ls = 0;
    let le = len;
    if (loopOn && this.loopEnd > this.loopStart && this.loopStart >= 0) {
      ls = Math.round(this.loopStart * buffer.sampleRate);
      le = Math.min(len, Math.round(this.loopEnd * buffer.sampleRate));
    }
    for (let s = 0; s < QUANTUM; s++) {
      const time = t + s / sr;
      if (time < this.startTime) continue;
      if (time >= this.stopTime) {
        this.finish();
        break;
      }
      if (this.position < 0) this.position = this.offset * buffer.sampleRate;
      let p = this.position;
      if (loopOn) {
        const span = le - ls;
        if (p >= le) p = ls + ((p - ls) % span);
      } else if (p >= len) {
        this.finish();
        break;
      }
      const i = Math.floor(p);
      const frac = p - i;
      const j = loopOn ? (i + 1 >= le ? ls : i + 1) : i + 1;
      for (let c = 0; c < data.length; c++) {
        const d = data[c]!;
        const a = d[i] ?? 0;
        out[c]![s] = a + ((d[j] ?? 0) - a) * frac;
      }
      this.position = p + step;
    }
    return [out];
  }
}

export class OfflineOscillator extends OfflineSource {
  readonly frequency: OfflineParam;
  readonly detune: OfflineParam;
  private wave = basicWave('sine');
  private phase = 0;
  private kind = 'sine';

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.frequency = new OfflineParam(ctx, 440);
    this.detune = new OfflineParam(ctx, 0);
  }

  get type(): string {
    return this.kind;
  }

  set type(type: string) {
    this.kind = type;
    this.wave = basicWave(type);
  }

  setPeriodicWave(wave: OfflinePeriodicWave): void {
    this.kind = 'custom';
    this.wave = wave;
  }

  protected override process(quantum: number): Channels[] {
    const t = this.context.timeOf(quantum);
    const f = this.frequency.render(t, quantum);
    const out = silence(1);
    const o = out[0]!;
    const sr = this.context.sampleRate;
    const table = this.wave.table;
    for (let s = 0; s < QUANTUM; s++) {
      const time = t + s / sr;
      if (time < this.startTime) continue;
      if (time >= this.stopTime) {
        this.finish();
        break;
      }
      const x = this.phase * TABLE;
      const i = Math.floor(x);
      o[s] = table[i]! + (table[i + 1]! - table[i]!) * (x - i);
      this.phase += f[s]! / sr;
      this.phase -= Math.floor(this.phase);
    }
    return [out];
  }
}

export class OfflineStereoPanner extends OfflineNode {
  readonly pan: OfflineParam;

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.channelCountMode = 'clamped-max';
    this.pan = new OfflineParam(ctx, 0);
  }

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    const pan = Math.min(1, Math.max(-1, this.pan.render(this.context.timeOf(quantum), quantum)[0]!));
    return [panStereo(input, pan)];
  }
}

// Equal-power panning of a mono or stereo input, as StereoPannerNode and equal-power panners do.
function panStereo(input: Channels, pan: number): Channels {
  const out = silence(2);
  const [L, R] = out as [Float32Array, Float32Array];
  if (input.length === 1) {
    const x = (pan + 1) / 2;
    const gl = Math.cos((x * Math.PI) / 2);
    const gr = Math.sin((x * Math.PI) / 2);
    const m = input[0]!;
    for (let s = 0; s < QUANTUM; s++) {
      L[s] = m[s]! * gl;
      R[s] = m[s]! * gr;
    }
  } else {
    const il = input[0]!;
    const ir = input[1]!;
    const x = pan <= 0 ? pan + 1 : pan;
    const gl = Math.cos((x * Math.PI) / 2);
    const gr = Math.sin((x * Math.PI) / 2);
    for (let s = 0; s < QUANTUM; s++) {
      if (pan <= 0) {
        L[s] = il[s]! + ir[s]! * gl;
        R[s] = ir[s]! * gr;
      } else {
        L[s] = il[s]! * gl;
        R[s] = ir[s]! + il[s]! * gr;
      }
    }
  }
  return out;
}

export class OfflinePanner extends OfflineNode {
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  refDistance = 1;
  rolloffFactor = 1;
  maxDistance = 10000;
  readonly positionX: OfflineParam;
  readonly positionY: OfflineParam;
  readonly positionZ: OfflineParam;

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.channelCountMode = 'clamped-max';
    this.positionX = new OfflineParam(ctx, 0);
    this.positionY = new OfflineParam(ctx, 0);
    this.positionZ = new OfflineParam(ctx, 0);
  }

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    const t = this.context.timeOf(quantum);
    const px = this.positionX.render(t, quantum)[0]!;
    const py = this.positionY.render(t, quantum)[0]!;
    const pz = this.positionZ.render(t, quantum)[0]!;
    const l = this.context.listener.pose(t, quantum);
    const dx = px - l.x;
    const dy = py - l.y;
    const dz = pz - l.z;
    const d = Math.min(Math.hypot(dx, dy, dz), this.maxDistance);
    const ref = this.refDistance;
    const gain = ref / (ref + this.rolloffFactor * (Math.max(d, ref) - ref));
    // Azimuth in the listener's frame: right = forward × up.
    const rx = l.fy * l.uz - l.fz * l.uy;
    const ry = l.fz * l.ux - l.fx * l.uz;
    const rz = l.fx * l.uy - l.fy * l.ux;
    const rn = Math.hypot(rx, ry, rz) || 1;
    const n = Math.hypot(dx, dy, dz) || 1;
    const right = (dx * rx + dy * ry + dz * rz) / (rn * n);
    let azimuth = Math.asin(Math.min(1, Math.max(-1, right))) * (180 / Math.PI); // −90..90 (front/back folded)
    if (!Number.isFinite(azimuth)) azimuth = 0;
    const pan = azimuth / 90;
    const out = panStereo(input, input.length === 1 ? pan : pan);
    for (const ch of out) for (let s = 0; s < QUANTUM; s++) ch[s]! *= gain;
    return [out];
  }
}

export class OfflineListener {
  readonly positionX: OfflineParam;
  readonly positionY: OfflineParam;
  readonly positionZ: OfflineParam;
  readonly forwardX: OfflineParam;
  readonly forwardY: OfflineParam;
  readonly forwardZ: OfflineParam;
  readonly upX: OfflineParam;
  readonly upY: OfflineParam;
  readonly upZ: OfflineParam;
  private quantum = -1;
  private cached = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };

  constructor(ctx: OfflineContext) {
    this.positionX = new OfflineParam(ctx, 0);
    this.positionY = new OfflineParam(ctx, 0);
    this.positionZ = new OfflineParam(ctx, 0);
    this.forwardX = new OfflineParam(ctx, 0);
    this.forwardY = new OfflineParam(ctx, 0);
    this.forwardZ = new OfflineParam(ctx, -1);
    this.upX = new OfflineParam(ctx, 0);
    this.upY = new OfflineParam(ctx, 1);
    this.upZ = new OfflineParam(ctx, 0);
  }

  pose(t: number, quantum: number): typeof this.cached {
    if (this.quantum !== quantum) {
      this.quantum = quantum;
      const v = (p: OfflineParam): number => p.render(t, quantum)[0]!;
      this.cached = {
        x: v(this.positionX),
        y: v(this.positionY),
        z: v(this.positionZ),
        fx: v(this.forwardX),
        fy: v(this.forwardY),
        fz: v(this.forwardZ),
        ux: v(this.upX),
        uy: v(this.upY),
        uz: v(this.upZ),
      };
    }
    return this.cached;
  }
}

export class OfflineSplitter extends OfflineNode {
  constructor(ctx: OfflineContext, outputs: number) {
    super(ctx, 1, outputs);
    this.channelCount = outputs;
    this.channelCountMode = 'explicit';
    this.channelInterpretation = 'discrete';
  }

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    return input.map((ch) => [ch]);
  }
}

export class OfflineMerger extends OfflineNode {
  constructor(ctx: OfflineContext, inputs: number) {
    super(ctx, inputs, 1);
    this.channelCount = 1;
    this.channelCountMode = 'explicit';
  }

  protected override process(quantum: number): Channels[] {
    return [this.inputs.map((_, i) => this.mixInput(quantum, i)[0]!)];
  }
}

export class OfflineWaveShaper extends OfflineNode {
  curve: Float32Array | null = null;
  oversample = 'none';

  protected override process(quantum: number): Channels[] {
    const input = this.mixInput(quantum);
    const curve = this.curve;
    if (!curve) return [input];
    const n = curve.length;
    for (const ch of input) {
      for (let s = 0; s < QUANTUM; s++) {
        const x = Math.min(1, Math.max(-1, ch[s]!));
        const p = ((x + 1) / 2) * (n - 1);
        const i = Math.floor(p);
        const a = curve[i]!;
        ch[s] = a + ((curve[Math.min(i + 1, n - 1)] ?? a) - a) * (p - i);
      }
    }
    return [input];
  }
}

// Passes audio through (the limiter is measured around, not emulated).
export class OfflineCompressor extends OfflineNode {
  readonly threshold: OfflineParam;
  readonly knee: OfflineParam;
  readonly ratio: OfflineParam;
  readonly attack: OfflineParam;
  readonly release: OfflineParam;
  readonly reduction = 0;

  constructor(ctx: OfflineContext) {
    super(ctx);
    this.threshold = new OfflineParam(ctx, -24);
    this.knee = new OfflineParam(ctx, 30);
    this.ratio = new OfflineParam(ctx, 12);
    this.attack = new OfflineParam(ctx, 0.003);
    this.release = new OfflineParam(ctx, 0.25);
  }
}

export class OfflineAnalyser extends OfflineNode {
  fftSize = 2048;

  getFloatTimeDomainData(data: Float32Array): void {
    data.fill(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Context

export class OfflineContext {
  readonly sampleRate: number;
  readonly destination: OfflineNode;
  readonly listener: OfflineListener;
  readonly sources = new Set<OfflineSource>();
  state: 'running' | 'suspended' | 'closed' = 'suspended';
  private quantum = 0;
  private readonly pending: (() => void)[] = [];

  constructor(sampleRate = 48_000) {
    this.sampleRate = sampleRate;
    this.destination = new OfflineNode(this);
    this.destination.channelCountMode = 'explicit';
    this.listener = new OfflineListener(this);
  }

  get currentTime(): number {
    return this.timeOf(this.quantum);
  }

  timeOf(quantum: number): number {
    return (quantum * QUANTUM) / this.sampleRate;
  }

  later(run: () => void): void {
    this.pending.push(run);
  }

  // Renders one quantum and returns the destination's (stereo) output.
  renderQuantum(): Channels {
    const q = this.quantum;
    const out = this.destination.output(q);
    for (const source of this.sources) {
      source.output(q); // sources nobody hears still advance and end
      source.tick(q);
    }
    this.quantum++;
    for (const run of this.pending.splice(0)) run();
    return out;
  }

  get renderedQuantum(): number {
    return this.quantum - 1;
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  addEventListener(): void {}

  createGain(): OfflineGain {
    return new OfflineGain(this);
  }

  createBiquadFilter(): OfflineBiquad {
    return new OfflineBiquad(this);
  }

  createBufferSource(): OfflineBufferSource {
    return new OfflineBufferSource(this);
  }

  createOscillator(): OfflineOscillator {
    return new OfflineOscillator(this);
  }

  createPanner(): OfflinePanner {
    return new OfflinePanner(this);
  }

  createStereoPanner(): OfflineStereoPanner {
    return new OfflineStereoPanner(this);
  }

  createChannelSplitter(outputs = 6): OfflineSplitter {
    return new OfflineSplitter(this, outputs);
  }

  createChannelMerger(inputs = 6): OfflineMerger {
    return new OfflineMerger(this, inputs);
  }

  createWaveShaper(): OfflineWaveShaper {
    return new OfflineWaveShaper(this);
  }

  createDynamicsCompressor(): OfflineCompressor {
    return new OfflineCompressor(this);
  }

  createAnalyser(): OfflineAnalyser {
    return new OfflineAnalyser(this);
  }

  createBuffer(channels: number, length: number, sampleRate: number): OfflineBuffer {
    return new OfflineBuffer(channels, length, sampleRate);
  }

  createPeriodicWave(
    real: ArrayLike<number>,
    imag: ArrayLike<number>,
    options?: { disableNormalization?: boolean },
  ): OfflinePeriodicWave {
    return new OfflinePeriodicWave(real, imag, !options?.disableNormalization);
  }
}

// graph.ts tells spatial panners from stereo ones with `instanceof PannerNode`.
export function installGlobals(): void {
  (globalThis as unknown as { PannerNode: unknown }).PannerNode = OfflinePanner;
}
