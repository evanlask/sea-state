// Camera-local rain: instanced streaks wrapped through a box around the camera.
//
// Every drop's position is a hash of its instance index advected by the wind
// and fall speed, wrapped into a box that follows the camera, so the rain is
// world-stable (parallax is right) yet needs no buffers and no per-frame CPU
// work beyond a few uniforms. Drops come in four fall-speed classes; the CPU
// keeps each class's advection offset modulo the box size in float64, which
// keeps the shader's numbers small however long the game runs.
import {
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type PerspectiveCamera,
  Vector2,
  Vector3,
  Vector4,
  type WebGPURenderer,
} from 'three/webgpu';

import type { Vec3Like } from '../particles/emissionQueue';
import type { HullVolumes } from '../particles/hullVolumes';
import { type FxLighting, henyeyGreenstein, pcg } from '../particles/shading';
import { type N, tsl } from '../tsl';
import {
  RAIN_EXPOSURE,
  RAIN_MAX_STREAK,
  rainDropFraction,
  rainFallSpeed,
  rainStreak,
  rainStreakOpacity,
} from './rainMath';

const {
  Fn,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cross,
  dot,
  exp,
  float,
  instanceIndex,
  int,
  length,
  max,
  mix,
  mod,
  normalize,
  positionGeometry,
  saturate,
  select,
  smoothstep,
  uint,
  uniform,
  uniformArray,
  varyingProperty,
  vec3,
  vec4,
} = tsl;

const SPEED_CLASSES = [0.8, 0.93, 1.07, 1.2];
const DROP_RADIUS = 0.0012; // m, visual half-width of a streak (drops are 1–3 mm across)
const MIN_PIXELS = 1; // narrower streaks widen to this half-width and fade instead
// Streaks show between these distances (m): nearer, a drop is an out-of-focus blur; further, the
// rain is the visibility haze the atmosphere already draws.
const NEAR = [0.6, 2.5] as const;
const FAR = [11, 19] as const;

export interface RainOptions {
  maxDrops: number;
  lighting: FxLighting;
  hulls?: HullVolumes | null; // no rain inside these (a wheelhouse seen from its helm)
  boxSize?: number; // m, edge of the wrapping volume
}

export class Rain {
  readonly mesh: Mesh;
  readonly boxSize: number;
  readonly uniforms = {
    opacity: uniform(0),
    boxSize: uniform(36),
    cameraWrap: uniform(new Vector3()), // camera position modulo the box (float64 on the CPU)
    pixelScale: uniform(1000),
  };
  warm = false; // warm-up: drawn even when empty (FxSystem.setWarmup)
  private maxDrops: number;
  private offsets: Vector4[] = SPEED_CLASSES.map(() => new Vector4());
  private streaks: Vector4[] = SPEED_CLASSES.map(() => new Vector4(0, -0.2, 0, 0));
  private offsetArray: N;
  private streakArray: N;
  private offsetsF64 = SPEED_CLASSES.map(() => [0, 0, 0]);

  constructor(options: RainOptions) {
    this.maxDrops = options.maxDrops;
    this.boxSize = options.boxSize ?? 2 * FAR[1] + 6;
    this.uniforms.boxSize.value = this.boxSize;
    this.offsetArray = uniformArray(this.offsets, 'vec4');
    this.streakArray = uniformArray(this.streaks, 'vec4');
    this.mesh = this.build(options.lighting, options.hulls ?? null);
  }

  setMaxDrops(count: number): void {
    this.maxDrops = count;
  }

  // wind and cameraVelocity in m/s, world frame.
  update(
    renderer: WebGPURenderer,
    camera: PerspectiveCamera,
    dt: number,
    intensity: number,
    wind: Vec3Like,
    cameraVelocity: Vec3Like,
  ): void {
    const fraction = rainDropFraction(intensity);
    const geometry = this.mesh.geometry as InstancedBufferGeometry;
    geometry.instanceCount = Math.floor(this.maxDrops * fraction);
    // During warm-up the (maybe empty) rain is drawn so its pipeline exists before the first shower.
    this.mesh.visible = geometry.instanceCount > 0 || this.warm;
    if (geometry.instanceCount === 0) return;

    const box = this.boxSize;
    const wrap = (value: number): number => ((value % box) + box) % box;
    const fall = rainFallSpeed(intensity);
    const step = Math.min(Math.max(dt, 0), 0.1);
    SPEED_CLASSES.forEach((factor, k) => {
      const offset = this.offsetsF64[k];
      const target = this.offsets[k];
      const streakTarget = this.streaks[k];
      if (!offset || !target || !streakTarget) return;
      const speed = fall * factor;
      offset[0] = wrap((offset[0] ?? 0) + wind.x * step);
      offset[1] = wrap((offset[1] ?? 0) - speed * step);
      offset[2] = wrap((offset[2] ?? 0) + wind.z * step);
      target.set(offset[0], offset[1], offset[2], 0);
      const streak = rainStreak(wind, cameraVelocity, speed, RAIN_EXPOSURE, RAIN_MAX_STREAK);
      const length = Math.max(streak.length, 0.03);
      streakTarget.set(streak.dx * length, streak.dy * length, streak.dz * length, rainStreakOpacity(length));
    });
    this.uniforms.cameraWrap.value.set(
      wrap(camera.position.x),
      wrap(camera.position.y),
      wrap(camera.position.z),
    );
    // Lighter in drizzle; heavy rain also gets denser, so opacity rises gently.
    this.uniforms.opacity.value = 0.38 + 0.52 * Math.min(Math.max(intensity, 0), 1);
    const size = renderer.getDrawingBufferSize(scratch);
    this.uniforms.pixelScale.value = (camera.projectionMatrix.elements[5] ?? 1) * size.y * 0.5;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as NodeMaterial).dispose();
  }

  private build(light: FxLighting, hulls: HullVolumes | null): Mesh {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.instanceCount = 0;

    const u = this.uniforms;
    const vColor = varyingProperty('vec4', 'v_rainColor');
    const vUv = varyingProperty('vec2', 'v_rainUv');

    const material = new NodeMaterial();
    material.name = 'fx-rain';
    material.transparent = true;
    material.depthWrite = false;
    material.side = DoubleSide;
    material.fog = false;
    material.blending = CustomBlending;
    material.blendSrc = OneFactor;
    material.blendDst = OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = OneFactor;
    material.blendDstAlpha = OneMinusSrcAlphaFactor;

    material.vertexNode = Fn(() => {
      const i = instanceIndex;
      const h0 = pcg(i.add(uint(0x9e3779b9)));
      const h1 = pcg(h0);
      const h2 = pcg(h1);
      const h3 = pcg(h2);
      const unit = (h: N): N => float(h.shiftRight(uint(8))).mul(1 / 16_777_216);
      const box = u.boxSize;
      const base = vec3(unit(h0), unit(h1), unit(h2)).mul(box);
      const cls = int(i.mod(uint(SPEED_CLASSES.length)));
      const offset = this.offsetArray.element(cls).xyz;
      // Position relative to the camera, wrapped into [−box/2, box/2)³.
      const local = mod(base.add(offset).sub(u.cameraWrap), box).sub(box.mul(0.5));
      const streakClass = this.streakArray.element(cls);
      const streak = streakClass.xyz.mul(unit(h3).mul(0.3).add(0.85));
      const corner = positionGeometry.xy;
      const point = local.add(streak.mul(corner.y.mul(0.5)));
      // The view matrix's rotation only: the camera translation is already removed.
      const viewPoint = cameraViewMatrix.mul(vec4(point, 0)).xyz;
      const viewAxis = cameraViewMatrix.mul(vec4(streak, 0)).xyz;
      const depth = max(viewPoint.z.negate(), 0.05);
      const halfWidth = max(float(DROP_RADIUS), depth.mul(MIN_PIXELS).div(u.pixelScale));
      const side = normalize(cross(viewAxis, viewPoint).add(vec3(1e-6, 0, 0)));
      const viewPosition = viewPoint.add(side.mul(corner.x.mul(halfWidth)));

      const distance = length(local);
      const fade = smoothstep(NEAR[0], NEAR[1], distance).mul(
        float(1).sub(smoothstep(FAR[0], FAR[1], distance)),
      );
      // A drop shows what is behind it, refracted: against the sky it stands out, seen from above
      // against the darker sea much less.
      const view = normalize(point);
      const against = mix(float(1), float(0.65), saturate(view.y.negate().mul(1.5)));
      const variation = unit(pcg(h3)).mul(0.5).add(0.75);
      const alpha = u.opacity
        .mul(fade)
        .mul(streakClass.w)
        .mul(against)
        .mul(variation)
        .mul(float(DROP_RADIUS).div(halfWidth));
      // Drops refract the sky and glint forward when backlit; flashes light them hard.
      const cosTheta = dot(view, light.sunDirection);
      const sunUp = smoothstep(-0.05, 0.05, light.sunDirection.y);
      const radiance = light.ambientColor
        .mul(1.3)
        .add(light.sunColor.mul(henyeyGreenstein(cosTheta, 0.7).mul(4 * Math.PI * 0.35)).mul(sunUp))
        .add(light.flashColor.mul(1.6));
      vColor.assign(vec4(radiance, alpha));
      vUv.assign(corner);
      // Drops outside the visible shell, and inside a boat, collapse to nothing.
      const sheltered = hulls ? hulls.inside(cameraPosition.add(local)) : tsl.bool(false);
      return select(
        fade.greaterThan(0).and(sheltered.not()),
        cameraProjectionMatrix.mul(vec4(viewPosition, 1)),
        vec4(0, 0, 2, 1),
      );
    })();

    // outputNode (not fragmentNode) so MRT passes (TRAA velocity) still get every attachment.
    material.outputNode = Fn(() => {
      const across = exp(vUv.x.mul(vUv.x).mul(-2.5));
      const along = saturate(float(1).sub(vUv.y.mul(vUv.y))).sqrt();
      const alpha = vColor.a.mul(across).mul(along);
      return vec4(vColor.rgb.mul(alpha), alpha.mul(0.85));
    })();

    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.name = 'fx-rain';
    mesh.renderOrder = 11;
    return mesh;
  }
}

const scratch = new Vector2();
