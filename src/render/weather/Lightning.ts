// Lightning: random strikes around the camera, each a procedural branching
// bolt drawn as glowing camera-facing ribbons (HDR, so bloom spreads it) for
// the duration of its flash envelope. Exposes the current flash so sky, clouds
// and sea can be lit by it, and emits a 'thunder' event per strike for audio
// (which adds the distance / 343 m/s delay itself).
import {
  Color,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NodeMaterial,
  OneFactor,
  type PerspectiveCamera,
  Vector2,
  Vector3,
  type WebGPURenderer,
  ZeroFactor,
} from 'three/webgpu';

import { tsl } from '../tsl';
import { generateBolt } from './bolt';
import {
  createFlashEnvelope,
  type FlashEnvelope,
  flashIntensity,
  LightningScheduler,
  type Strike,
} from './flash';

const {
  Fn,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  exp,
  float,
  max,
  mix,
  normalize,
  positionGeometry,
  select,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} = tsl;

const MAX_SEGMENTS = 2048;
const HALO = 5; // glow half-width as a multiple of the core width
const MIN_CORE_PIXELS = 1.2;
const MIN_HALO_PIXELS = 7;

export interface ThunderEvent {
  type: 'thunder';
  x: number; // strike point, world m
  y: number;
  z: number;
  time: number; // simulation time the flash began, s
  intensity: number; // 0..1, relative loudness at the source
  cloudToGround: boolean;
}

export interface LightningFlash {
  intensity: number; // current relative brightness, 0..~1.5
  position: Vector3; // where the light comes from (mid-channel, or inside the cloud)
  color: Color; // linear colour of the flash
}

interface ActiveStrike {
  envelope: FlashEnvelope;
  elapsed: number;
  position: Vector3;
  visibleBolt: boolean;
  strength: number;
}

export interface LightningOptions {
  seed?: number;
  radius?: number; // m around the camera
  minDistance?: number;
  cloudBase?: number; // m above sea level where bolts emerge
  boltBrightness?: number; // HDR multiplier of the channel core
}

export class Lightning {
  readonly mesh: Mesh;
  readonly scheduler: LightningScheduler;
  readonly flash: LightningFlash = { intensity: 0, position: new Vector3(), color: new Color(0.78, 0.84, 1) };
  cloudBase: number;
  readonly uniforms = {
    main: uniform(0), // main channel brightness
    branches: uniform(0),
    color: uniform(new Color(0.78, 0.84, 1)),
    brightness: uniform(120),
    pixelScale: uniform(1000),
  };
  private active: ActiveStrike | null = null;
  private listeners: ((event: ThunderEvent) => void)[] = [];
  private segA: InstancedBufferAttribute;
  private segB: InstancedBufferAttribute;
  private strikes: Strike[] = [];
  private time = 0;
  private warm = false;

  constructor(options: LightningOptions = {}) {
    this.scheduler = new LightningScheduler({
      seed: options.seed ?? 1,
      radius: options.radius ?? 9000,
      minDistance: options.minDistance ?? 700,
    });
    this.cloudBase = options.cloudBase ?? 1600;
    this.uniforms.brightness.value = options.boltBrightness ?? 120;
    this.segA = new InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 4), 4);
    this.segB = new InstancedBufferAttribute(new Float32Array(MAX_SEGMENTS * 4), 4);
    this.mesh = this.build();
  }

  set rate(strikesPerMinute: number) {
    this.scheduler.rate = Math.max(0, strikesPerMinute);
  }

  get rate(): number {
    return this.scheduler.rate;
  }

  onThunder(listener: (event: ThunderEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // Forces a strike now (dev tools, scripted scenes).
  strike(x: number, z: number, cloudToGround = true, seed = Math.floor(Math.random() * 2 ** 31)): void {
    this.begin({ x, z, seed, cloudToGround });
  }

  // Warm-up (loading screen): the bolt mesh is drawn with no segments, building its pipeline.
  setWarmup(on: boolean): void {
    this.warm = on;
  }

  // time: simulation seconds (for the thunder event); dt: seconds since last frame.
  update(renderer: WebGPURenderer, camera: PerspectiveCamera, dt: number, time: number): void {
    this.time = time;
    for (const strike of this.scheduler.update(dt, camera.position.x, camera.position.z, this.strikes)) {
      this.begin(strike);
    }
    const active = this.active;
    if (active) {
      active.elapsed += dt;
      const value = flashIntensity(active.envelope, active.elapsed) * active.strength;
      this.flash.intensity = value;
      this.uniforms.main.value = active.visibleBolt ? value : 0;
      // Branches mostly show in the first stroke; later strokes retrace the main channel.
      const first = active.envelope.strokes[0]?.time ?? 0;
      this.uniforms.branches.value = active.visibleBolt
        ? value * Math.exp(-Math.max(active.elapsed - first, 0) / 0.09)
        : 0;
      if (active.elapsed > active.envelope.duration) {
        this.active = null;
        this.flash.intensity = 0;
      }
    }
    // During warm-up the (empty) bolt is drawn so its pipeline exists before the first strike.
    this.mesh.visible = this.active?.visibleBolt === true || this.warm;
    const size = renderer.getDrawingBufferSize(scratch);
    this.uniforms.pixelScale.value = (camera.projectionMatrix.elements[5] ?? 1) * size.y * 0.5;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as NodeMaterial).dispose();
  }

  private begin(strike: Strike): void {
    const envelope = createFlashEnvelope(strike.seed);
    const top = this.cloudBase * (0.85 + ((strike.seed >>> 3) % 1000) / 2500);
    const strength = strike.cloudToGround ? 1 : 0.55;
    const position = new Vector3(strike.x, strike.cloudToGround ? top * 0.5 : top * 1.2, strike.z);
    this.active = { envelope, elapsed: 0, position, visibleBolt: strike.cloudToGround, strength };
    this.flash.position.copy(position);
    if (strike.cloudToGround) this.uploadBolt(strike, top);
    const event: ThunderEvent = {
      type: 'thunder',
      x: strike.x,
      y: strike.cloudToGround ? 0 : position.y,
      z: strike.z,
      time: this.time,
      intensity: strength,
      cloudToGround: strike.cloudToGround,
    };
    for (const listener of this.listeners) listener(event);
  }

  private uploadBolt(strike: Strike, top: number): void {
    const lean = ((strike.seed >>> 11) % 1000) / 1000;
    const angle = lean * Math.PI * 2;
    const bolt = generateBolt({
      start: {
        x: strike.x + Math.cos(angle) * top * 0.25,
        y: top,
        z: strike.z + Math.sin(angle) * top * 0.25,
      },
      end: { x: strike.x, y: 0, z: strike.z },
      seed: strike.seed,
      generations: 8,
      displacement: 0.17,
      maxBranches: 7,
      width: 2.5,
    });
    const a = this.segA.array as Float32Array;
    const b = this.segB.array as Float32Array;
    const count = Math.min(bolt.segments.length, MAX_SEGMENTS);
    for (let i = 0; i < count; i++) {
      const s = bolt.segments[i];
      if (!s) break;
      a.set([s.ax, s.ay, s.az, s.width], i * 4);
      // Negative intensity marks branch segments for the shader.
      b.set([s.bx, s.by, s.bz, s.branch === 0 ? s.intensity : -s.intensity], i * 4);
    }
    this.segA.needsUpdate = true;
    this.segB.needsUpdate = true;
    this.segA.clearUpdateRanges();
    this.segA.addUpdateRange(0, count * 4);
    this.segB.clearUpdateRanges();
    this.segB.addUpdateRange(0, count * 4);
    (this.mesh.geometry as InstancedBufferGeometry).instanceCount = count;
  }

  private build(): Mesh {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('segA', this.segA);
    geometry.setAttribute('segB', this.segB);
    geometry.instanceCount = 0;

    const u = this.uniforms;
    const vUv = varyingProperty('vec2', 'v_boltUv');
    const vCore = varyingProperty('float', 'v_boltCore'); // core width as a fraction of the quad
    const vGlow = varyingProperty('float', 'v_boltGlow');

    const material = new NodeMaterial();
    material.name = 'fx-lightning';
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.fog = false;
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneFactor;
    material.blendSrcAlpha = ZeroFactor;
    material.blendDstAlpha = OneFactor;

    material.vertexNode = Fn(() => {
      const a = attribute('segA', 'vec4');
      const b = attribute('segB', 'vec4');
      const corner = positionGeometry.xy;
      const viewA = cameraViewMatrix.mul(vec4(a.xyz, 1)).xyz;
      const viewB = cameraViewMatrix.mul(vec4(b.xyz, 1)).xyz;
      const along = corner.y.mul(0.5).add(0.5);
      const point = mix(viewA, viewB, along);
      const axis = normalize(viewB.sub(viewA));
      const side = normalize(cross(axis, point).add(vec3(1e-6, 0, 0)));
      const depth = max(point.z.negate(), 1);
      const metresPerPixel = depth.div(u.pixelScale);
      const core = max(a.w, metresPerPixel.mul(MIN_CORE_PIXELS));
      const halfWidth = max(core.mul(HALO), metresPerPixel.mul(MIN_HALO_PIXELS));
      // Overlap neighbouring segments so joints have no gaps.
      const position = point
        .add(side.mul(corner.x.mul(halfWidth)))
        .add(axis.mul(corner.y.mul(halfWidth.mul(0.5))));
      const isBranch = b.w.lessThan(0);
      const intensity = b.w.abs().mul(select(isBranch, u.branches, u.main));
      vUv.assign(corner);
      vCore.assign(core.div(halfWidth));
      // Thin (sub-pixel) channels spread their light over the minimum width.
      vGlow.assign(intensity.mul(a.w.div(core).sqrt()));
      return cameraProjectionMatrix.mul(vec4(position, 1));
    })();

    // outputNode (not fragmentNode) so MRT passes (TRAA velocity) still get every attachment.
    material.outputNode = Fn(() => {
      const x = vUv.x;
      const coreProfile = exp(x.div(vCore).pow(2).mul(-2));
      const halo = exp(x.mul(x).mul(-6)).mul(0.08);
      const ends = smoothstep(1, 0.6, vUv.y.abs()).mul(0.3).add(0.7);
      const energy = coreProfile.add(halo).mul(vGlow).mul(ends).mul(u.brightness);
      return vec4(u.color.mul(energy), float(0));
    })();

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.name = 'fx-lightning';
    mesh.renderOrder = 12;
    return mesh;
  }
}

const scratch = new Vector2();
