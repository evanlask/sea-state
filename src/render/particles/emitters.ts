// Spray sources, all spawning into the shared ParticleSystem pool:
//   CPU-queued: hull slams / bow spray, the jet-ski and hydroplane rooster tails, prop wash.
//   GPU-side:   wind spume off breaking crests, rain splash crowns. These test random points on
//               the sea around the camera in a compute pass, so the CPU never sees the crests.
import { type ComputeNode, Vector3, type WebGPURenderer } from 'three/webgpu';

import { tsl } from '../tsl';
import { PARTICLE_KIND, type SpawnRequest, type Vec3Like } from './emissionQueue';
import type { ParticleSystem } from './ParticleSystem';
import { GpuRandom } from './shading';
import { powerLawRadiusNode } from './sprayMath';

const { Fn, If, cos, float, instanceIndex, normalize, saturate, select, sin, uint, uniform, vec2, vec3 } =
  tsl;

interface Basis {
  forward: Vec3Like;
  right: Vec3Like;
}

const horizontalBasis = (
  velocity: Vec3Like,
  heading?: Vec3Like,
  out: Basis = { forward: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } },
): Basis => {
  const source = heading ?? velocity;
  const length = Math.hypot(source.x, source.z);
  const f = out.forward;
  if (length > 1e-3) {
    f.x = source.x / length;
    f.y = 0;
    f.z = source.z / length;
  } else {
    f.x = 0;
    f.y = 0;
    f.z = -1;
  }
  // forward × up: starboard (heading north, starboard is east, +X).
  out.right.x = -f.z;
  out.right.y = 0;
  out.right.z = f.x;
  return out;
};

// Spawn requests the continuous emitters fill in every frame (the queue copies them on spawn).
const washBasis: Basis = { forward: { x: 0, y: 0, z: 0 }, right: { x: 0, y: 0, z: 0 } };
const roosterVelocity = { x: 0, y: 0, z: 0 };
const roosterDrops: SpawnRequest = {
  kind: 'droplet',
  count: 0,
  position: { x: 0, y: 0, z: 0 },
  positionRadius: 0.08,
  velocity: roosterVelocity,
  velocitySpread: 0,
  size: [0.006, 0.05],
  life: [1.2, 2.2],
  drag: 0.03, // a coherent jet barely slows
};
const roosterMist: SpawnRequest = {
  kind: 'mist',
  count: 0,
  position: { x: 0, y: 0, z: 0 },
  positionRadius: 0.12,
  velocity: roosterVelocity,
  velocitySpread: 0,
  size: [0.1, 0.3],
  life: [0.8, 1.6],
  drag: 0.25,
};
const washLine = { x: 0, y: 0, z: 0 };
const washVelocity = { x: 0, y: 0, z: 0 };
const washSize: [number, number] = [0, 0];
const washFoam: SpawnRequest = {
  kind: 'foam',
  count: 0,
  position: { x: 0, y: 0, z: 0 },
  positionRadius: 0,
  positionLine: washLine,
  velocity: washVelocity,
  velocitySpread: 0.5,
  size: washSize,
  life: [0.6, 1.3],
};

export interface SlamEvent {
  x: number;
  y: number;
  z: number;
  // Impact speed of the hull into the water, m/s (≈ 1 light slap … 8 hard slam).
  strength: number;
}

// Where a slam's sheets leave a hull: on the waterline beside the slam, port and starboard, each
// with the half-extent of the stretch of hull side they come off (world frame).
export interface SlamSides {
  port: Vec3Like;
  starboard: Vec3Like;
  portLine: Vec3Like;
  starboardLine: Vec3Like;
  clearance: number; // m outboard of the side points that clears the hull's widest beam
}

export interface SlamOptions {
  heading?: Vec3Like;
  hullLength?: number;
  scale?: number; // quality scale of the particle count
  spray?: number; // the hull's spray scale (sprayMath.hullSprayScale); default 1
  sides?: SlamSides; // default: both sheets from the event point
}

// Hull slam / bow spray: two sheets thrown out to port and starboard and up, fanned between flat and
// steep, breaking into droplets (mm to a few cm, most of them small), plus a cloud of finer mist
// that drifts downwind. The sheets and mist grow with the hull; the droplets barely do.
export function emitSlamSpray(
  particles: ParticleSystem,
  event: SlamEvent,
  boatVelocity: Vec3Like,
  options: SlamOptions = {},
): void {
  const strength = Math.max(0, event.strength);
  if (strength <= 0.05) return;
  const scale = options.scale ?? 1;
  const spray = options.spray ?? 1;
  const { forward, right } = horizontalBasis(boatVelocity, options.heading);
  // Wagner-type jets leave the hull faster than the impact itself.
  const sheet = Math.min(3 + strength * 1.5, 18);
  const amount = Math.min((strength * strength * 150 + strength * 200) * spray, 6000) * scale;
  const spread = (options.hullLength ?? 4) * 0.12;
  const along = { x: forward.x * spread, y: 0, z: forward.z * spread };
  const clump = Math.sqrt(spray);
  for (const side of [-1, 1]) {
    const sides = options.sides;
    const origin = sides ? (side < 0 ? sides.port : sides.starboard) : event;
    const line = sides ? (side < 0 ? sides.portLine : sides.starboardLine) : along;
    // Relative to the hull, which carries the sheet along (so its slow parts don't fall back into it).
    const velocity = {
      x: right.x * side * sheet * 0.8 - forward.x * sheet * 0.15,
      y: sheet * 0.6,
      z: right.z * side * sheet * 0.8 - forward.z * sheet * 0.15,
    };
    const carrier = { x: boatVelocity.x * 0.85, y: 0, z: boatVelocity.z * 0.85 };
    // A quarter as coherent sheet water, the rest broken into droplets.
    particles.spawn({
      kind: 'droplet',
      count: amount * 0.25,
      position: origin,
      positionRadius: 0.06 * spray,
      positionLine: line,
      velocity,
      velocitySpread: sheet * 0.04,
      speedVariation: 0.45,
      fanAxis: forward,
      fanAngle: 0.5 * side,
      carrier,
      size: [0.025 * clump, 0.08 * clump],
      sizeSkew: 0,
      life: [0.4, 0.9],
      drag: 0.05,
    });
    particles.spawn({
      kind: 'droplet',
      count: amount * 0.75,
      position: origin,
      positionRadius: 0.12 * spray,
      positionLine: line,
      velocity,
      velocitySpread: sheet * 0.06,
      speedVariation: 0.65,
      fanAxis: forward,
      fanAngle: 0.6 * side,
      carrier,
      size: [0.004 * clump, 0.035 * clump],
      life: [1.2, 2.6],
      drag: 0.12,
    });
    // Mist streams aft with the air: start it outboard of the hull's widest beam.
    const out = (options.sides?.clearance ?? 0) + 0.4 * spray;
    particles.spawn({
      kind: 'mist',
      count: amount * 0.05,
      position: {
        x: origin.x + right.x * side * out,
        y: origin.y + 0.6 * spray,
        z: origin.z + right.z * side * out,
      },
      positionRadius: 0.4 * spray,
      positionLine: line,
      velocity: { x: velocity.x * 0.3, y: 1.5, z: velocity.z * 0.3 },
      velocitySpread: 1,
      carrier: { x: carrier.x * 0.5, y: 0, z: carrier.z * 0.5 },
      size: [0.15 * spray, 0.5 * spray],
      life: [1.5, 3.2],
    });
  }
}

// Accumulates fractional spawn counts so low rates still emit at high frame rates.
export class RateCarry {
  private carry = 0;

  take(rate: number, dt: number): number {
    this.carry += Math.max(rate, 0) * dt;
    const whole = Math.floor(this.carry);
    this.carry -= whole;
    return whole;
  }
}

// Jet ski rooster tail: a plume of bulk water from the jet nozzle, breaking into
// droplets and a little mist, at a rate proportional to thrust.
export class RoosterTail {
  enabled = true;
  readonly nozzle = new Vector3();
  readonly direction = new Vector3(0, 0.12, 1).normalize(); // aft and a little up, world space
  readonly boatVelocity = new Vector3();
  thrust = 0; // 0..1
  rate = 2500; // particles per second at full thrust
  mistShare = 0.06; // of the rate, as mist
  private droplets = new RateCarry();
  private mist = new RateCarry();

  update(particles: ParticleSystem, dt: number, scale = 1): void {
    if (!this.enabled || this.thrust <= 0.02) return;
    const thrust = Math.min(this.thrust, 1);
    const d = this.direction;
    const b = this.boatVelocity;
    // The jet leaves the nozzle faster than the craft moves (that's what drives it), so the plume
    // stands behind the boat in the world instead of travelling along with it.
    const speed = Math.max(8 + 10 * Math.sqrt(thrust), 1.15 * Math.hypot(b.x, b.z));
    roosterVelocity.x = b.x + d.x * speed;
    roosterVelocity.y = b.y + d.y * speed;
    roosterVelocity.z = b.z + d.z * speed;
    roosterDrops.count = this.droplets.take(this.rate * thrust * scale, dt);
    roosterDrops.position = this.nozzle;
    roosterDrops.velocitySpread = speed * 0.09;
    particles.spawn(roosterDrops);
    roosterMist.count = this.mist.take(this.rate * this.mistShare * thrust * scale, dt);
    roosterMist.position = this.nozzle;
    roosterMist.velocitySpread = speed * 0.12;
    particles.spawn(roosterMist);
  }
}

// The hydroplane's rooster tail: the surface-piercing propeller, partly out of the water and turning
// ~160 times a second, flings a column of water up behind the boat. The water leaves the blades about
// as fast aft as the boat goes ahead, so in the world it goes up and hangs there while the boat races
// on: a wall along the track, rising behind the transom to 15 m or more at 200 mph and falling back
// over three or four seconds. Three parts: droplets thrown up fast against a lot of drag (broken
// water) so they climb steeply and hang, fanned out sideways; a thin short-lived veil of mist; and
// the low churned sheet at the root. Spawned along the stretch the propeller covered this frame, so
// even at 90 m/s it's a wall, not beads. Up close the particles are the detail; the sheet
// (roosterSheet.ts) is its body, and all of it from afar. Only planing: at rest and off the plane the
// propeller is under water and just churns (prop wash).
const HYDRO_ROOSTER_RATE = 12_000; // particles/s at full height
export const HYDRO_ROOSTER_LIFE = 3.2; // s, its particles' mean life (most land before they expire)
const ROOSTER_DRAG = 0.05; // 1/m: broken water (terminal speed ~14 m/s)
const VEIL_DRAG = 0.08;
const VEIL_SHARE = 0.12;
const ROOT_SHARE = 0.15;
// Share of top speed where the propeller starts throwing a tail (~20 mph) and its full rate (~55 mph).
const TAIL_FROM = 0.1;
const TAIL_FULL = 0.28;

export interface RoosterShape {
  height: number; // m, the top of the tail
  launch: number; // m/s, upward speed of its tallest water
  rate: number; // particles/s
}

// The tail's height and output for the boat's speed over its top speed (0..1) and the propeller's
// thrust over full (0..1): it grows with the propeller's tip speed (so with the boat's speed) and with
// how hard the blades bite.
export function roosterShape(speedShare: number, thrust: number): RoosterShape {
  const s = Math.min(Math.max(speedShare, 0), 1);
  const planing = Math.min(1, Math.max(0, (s - TAIL_FROM) / (TAIL_FULL - TAIL_FROM)));
  const bite = Math.sqrt(Math.min(Math.max(thrust, 0), 1)) * planing * planing * (3 - 2 * planing);
  const height = (0.6 + 17 * s ** 1.5) * bite;
  // Launch speed for that height against quadratic drag: h = ln(1 + k v²/g) / 2k.
  const launch = Math.sqrt((9.81 / ROOSTER_DRAG) * (Math.exp(2 * ROOSTER_DRAG * height) - 1));
  return { height, launch, rate: HYDRO_ROOSTER_RATE * bite * (0.25 + 0.75 * s) };
}

const tailRequest = (
  o: Partial<SpawnRequest> & Pick<SpawnRequest, 'kind' | 'size' | 'life'>,
): SpawnRequest => ({
  count: 0,
  position: { x: 0, y: 0, z: 0 },
  positionRadius: 0.15,
  positionLine: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  velocitySpread: 0,
  speedVariation: 0.55,
  fanAxis: { x: 0, y: 0, z: -1 },
  fanAngle: 0.32,
  carrier: { x: 0, y: 0, z: 0 },
  ...o,
});
const tailCore = tailRequest({
  kind: 'droplet',
  size: [0.025, 0.11],
  sizeSkew: 1.5,
  life: [2.4, 4.2],
  drag: ROOSTER_DRAG,
});
const tailVeil = tailRequest({
  kind: 'mist',
  positionRadius: 0.3,
  speedVariation: 0.6,
  fanAngle: 0.45,
  size: [0.25, 0.6],
  life: [1.4, 2.6],
  drag: VEIL_DRAG,
});
const tailRoot = tailRequest({
  kind: 'droplet',
  positionRadius: 0.2,
  speedVariation: 0.5,
  fanAngle: 0.6,
  size: [0.03, 0.1],
  life: [0.8, 1.6],
  drag: 0.05,
});
// Request, share of the rate, launch speed (of the tallest water, share of the tail's) and how fast
// it drifts aft over the ground (share of the boat's speed).
const TAIL_PARTS: readonly [SpawnRequest, number, number, number][] = [
  [tailCore, 1 - VEIL_SHARE - ROOT_SHARE, 1, 0.1],
  [tailVeil, VEIL_SHARE, 0.8, 0.12],
  [tailRoot, ROOT_SHARE, 0.3, 0.25],
];

export class HydroRoosterTail {
  enabled = true;
  readonly propeller = new Vector3(); // world, the hub
  readonly boatVelocity = new Vector3();
  readonly heading = new Vector3(0, 0, -1); // bow direction, horizontal, unit
  speedShare = 0; // speed over the boat's top speed
  thrust = 0; // 0..1
  private carries = TAIL_PARTS.map(() => new RateCarry());

  update(particles: ParticleSystem, dt: number, scale = 1): void {
    if (!this.enabled || this.thrust <= 0.02 || dt <= 0) return;
    const shape = roosterShape(this.speedShare, this.thrust);
    if (shape.height < 0.2) return;
    const b = this.boatVelocity;
    const f = this.heading;
    const speed = Math.max(0, b.x * f.x + b.z * f.z);
    TAIL_PARTS.forEach(([r, share, launch, aft], i) => {
      r.count = this.carries[i]!.take(shape.rate * share * scale, dt);
      if (r.count <= 0) return;
      // Along the stretch the hub covered this frame.
      const line = r.positionLine as Vec3Like;
      line.x = -b.x * dt * 0.5;
      line.y = 0;
      line.z = -b.z * dt * 0.5;
      const p = r.position as Vec3Like;
      p.x = this.propeller.x + line.x;
      p.y = this.propeller.y + 0.12; // where the blades break out of the water
      p.z = this.propeller.z + line.z;
      // Straight up (fanned out sideways about the heading), carried with the boat's speed taken off
      // and a little more: the water hangs where it was thrown and drifts aft.
      const v = r.velocity as Vec3Like;
      v.x = 0;
      v.y = shape.launch * launch;
      v.z = 0;
      r.velocitySpread = v.y * 0.16;
      const c = r.carrier as Vec3Like;
      c.x = b.x - f.x * speed * (1 + aft);
      c.y = 0;
      c.z = b.z - f.z * speed * (1 + aft);
      const axis = r.fanAxis as Vec3Like;
      axis.x = f.x;
      axis.y = 0;
      axis.z = f.z;
      particles.spawn(r);
    });
  }
}

export const WASH_RATE = 320;

// Wash spawn rate per unit of PropWash.rate: more churn with throttle and speed, and with the width
// of the strip (a narrow outboard fizz throws far less than a ship's boil).
export function washRate(beam: number, throttle: number, speed: number): number {
  const churn = 0.6 + Math.min(speed / 10, 1.5);
  return Math.min(Math.max(throttle, 0), 1) * churn * Math.min(2, Math.max(0.3, beam / 2));
}

// Size of the white-water lumps for a churned strip this wide (1 for a 1 m strip).
export function washLump(beam: number): number {
  return Math.min(6, Math.max(0.6, beam)) ** 0.6;
}

// Prop wash / wake churn: low, short-lived white water boiling up behind a stern, in lumps that
// scale with the propeller (an outboard's is a narrow fizz, a ship's a broad boil).
export class PropWash {
  enabled = true;
  readonly stern = new Vector3();
  readonly boatVelocity = new Vector3();
  readonly heading = new Vector3(0, 0, -1); // bow direction
  beam = 2; // m, width of the churned strip
  throttle = 0; // 0..1
  rate = WASH_RATE; // particles/s, times washRate (the ocean's wake foam carries the trail)
  private carry = new RateCarry();

  update(particles: ParticleSystem, dt: number, scale = 1): void {
    if (!this.enabled || this.throttle <= 0.02) return;
    const { forward, right } = horizontalBasis(this.boatVelocity, this.heading, washBasis);
    const throttle = Math.min(this.throttle, 1);
    const speed = Math.hypot(this.boatVelocity.x, this.boatVelocity.z);
    const b = this.boatVelocity;
    const lump = washLump(this.beam);
    const request = washFoam;
    request.count = this.carry.take(this.rate * washRate(this.beam, throttle, speed) * scale, dt);
    request.position = this.stern;
    request.positionRadius = 0.1 + 0.05 * this.beam;
    washLine.x = right.x * this.beam * 0.5;
    washLine.z = right.z * this.beam * 0.5;
    washVelocity.x = b.x * 0.35 - forward.x * 2 * throttle;
    washVelocity.y = 0.15 + 0.35 * throttle; // churned water heaving at the surface, not a cloud
    washVelocity.z = b.z * 0.35 - forward.z * 2 * throttle;
    washSize[0] = 0.06 * lump;
    washSize[1] = 0.16 * lump;
    particles.spawn(request);
  }
}

// ---------------------------------------------------------------------------
// GPU emitters

interface GpuEmitterInputs {
  particles: ParticleSystem;
  maxCandidates: number;
}

// Wind spume: torn off breaking crests once the wind passes ~15 m/s and blown
// downwind as streaky sheets of mist and droplets.
export class SpumeEmitter {
  readonly uniforms = {
    windSpeed: uniform(0),
    probability: uniform(0), // spawn chance on a fully breaking crest
    viewYaw: uniform(0), // camera look direction on the sea plane (atan2 of x, z)
    // Combined Jacobian below which a crest counts as breaking (match the ocean's foam threshold).
    threshold: uniform(0.4),
    innerRadius: uniform(6),
    outerRadius: uniform(280),
  };
  private node: ComputeNode | null;
  private maxCandidates: number;

  constructor(inputs: GpuEmitterInputs) {
    this.maxCandidates = inputs.maxCandidates;
    this.node = inputs.particles.ocean ? this.build(inputs.particles) : null;
  }

  // Wind strength above the spume threshold, 0..1.
  static windFactor(windSpeed: number): number {
    return Math.min(Math.max((windSpeed - 14) / 22, 0), 1) ** 1.3;
  }

  update(renderer: WebGPURenderer, windSpeed: number, viewYaw: number, threshold: number, scale = 1): void {
    if (!this.node) return;
    this.uniforms.threshold.value = threshold;
    const factor = SpumeEmitter.windFactor(windSpeed);
    const count = Math.round(this.maxCandidates * Math.min(1, factor * 2.5) * scale);
    if (count <= 0) return;
    this.uniforms.windSpeed.value = windSpeed;
    this.uniforms.probability.value = 0.25 + 0.75 * factor;
    this.uniforms.viewYaw.value = viewYaw;
    this.node.count = count;
    void renderer.compute(this.node);
  }

  dispose(): void {
    this.node?.dispose();
  }

  private build(particles: ParticleSystem): ComputeNode {
    const ocean = particles.ocean;
    if (!ocean) throw new Error('SpumeEmitter needs an ocean');
    const pu = particles.uniforms;
    const u = this.uniforms;
    const node: ComputeNode = Fn(() => {
      const random = new GpuRandom(instanceIndex.mul(uint(747796405)).bitXor(pu.frame.mul(uint(2891336453))));
      // Mostly in front of the camera; log-uniform radius gives even screen density.
      const ahead = random.next().lessThan(0.8);
      const yaw = select(ahead, u.viewYaw.add(random.range(-0.9, 0.9)), random.range(0, Math.PI * 2));
      const radius = u.innerRadius.mul(u.outerRadius.div(u.innerRadius).pow(random.next()));
      const xz = pu.cameraPosition.xz.add(vec2(sin(yaw), cos(yaw)).mul(radius));
      const grid = xz.sub(ocean.displacement(xz, 5).xz);
      const surface = ocean.displacement(grid, 5);
      const crest = ocean.breaking(grid, 10);
      const breaking = saturate(u.threshold.sub(crest.y).mul(4)).mul(saturate(crest.x.mul(0.6).add(0.5)));
      const wind = pu.wind;
      const windDir = normalize(vec3(wind.x, 0, wind.z).add(vec3(1e-4, 0, 0)));
      const position = vec3(xz.x, surface.y.add(0.15), xz.y)
        .add(windDir.mul(random.range(-1.5, 1.5)))
        .toVar();
      // No spume off the water inside a hull (the sea is kept out of it, but its crests aren't).
      If(
        random.next().lessThan(breaking.mul(u.probability)).and(particles.insideHull(position).not()),
        () => {
          const index = particles.allocate();
          If(index.greaterThanEqual(0), () => {
            const isMist = random.next().lessThan(0.45);
            // Far spume is drawn as larger sheets so it still reads at a distance.
            const distanceScale = float(1).add(radius.div(120));
            const droplet = powerLawRadiusNode(float(0.006), float(0.06), 2.2, random.next());
            const size = select(isMist, random.range(0.25, 0.9), droplet).mul(distanceScale);
            const lift = select(isMist, random.range(0.4, 2), random.range(1, 4));
            const carry = select(isMist, random.range(0.45, 0.85), random.range(0.2, 0.5));
            const velocity = wind
              .mul(carry)
              .add(vec3(0, lift, 0))
              .add(windDir.mul(random.range(-1, 1)));
            const kind = select(isMist, float(PARTICLE_KIND.mist), float(PARTICLE_KIND.droplet));
            particles.write(index, {
              position,
              velocity,
              size,
              life: select(isMist, random.range(1.2, 3.2), random.range(0.8, 1.6)),
              kind,
              seed: random.next(),
              drag: particles.kindDrag(kind, random),
            });
          });
        },
      );
    })().compute(this.maxCandidates, [64]);
    node.setName('fx-spume-emit');
    return node;
  }
}

const SPLASH_DROPLETS = 3;

// Rain splashes: tiny crowns of droplets on the water around the camera. A raindrop (1–3 mm)
// throws a crown a few centimetres across and high, and secondary droplets of about a millimetre
// that are back in the water within a fifth of a second; they fade with distance as they shrink
// below a pixel.
export class RainSplashEmitter {
  readonly uniforms = { radius: uniform(18), strength: uniform(1) };
  private node: ComputeNode;
  private maxCandidates: number;

  constructor(inputs: GpuEmitterInputs) {
    this.maxCandidates = inputs.maxCandidates;
    this.node = this.build(inputs.particles);
  }

  update(renderer: WebGPURenderer, intensity: number, scale = 1): void {
    const count = Math.round(this.maxCandidates * Math.min(Math.max(intensity, 0), 1) * scale);
    if (count <= 0) return;
    this.uniforms.strength.value = 0.7 + 0.5 * intensity; // bigger, faster drops in heavier rain
    this.node.count = count;
    void renderer.compute(this.node);
  }

  dispose(): void {
    this.node.dispose();
  }

  private build(particles: ParticleSystem): ComputeNode {
    const pu = particles.uniforms;
    const u = this.uniforms;
    const ocean = particles.ocean;
    const node: ComputeNode = Fn(() => {
      const random = new GpuRandom(instanceIndex.mul(uint(2654435761)).bitXor(pu.frame.mul(uint(97531))));
      // An exponent of 0.5 would be uniform by area; 0.6 biases the crowns towards the camera.
      const radius = u.radius.mul(random.next().pow(0.6));
      const angle = random.range(0, Math.PI * 2);
      const xz = pu.cameraPosition.xz.add(vec2(cos(angle), sin(angle)).mul(radius));
      const surface = ocean ? ocean.height(xz, 5) : float(0);
      const position = vec3(xz.x, surface.add(0.005), xz.y).toVar();
      const spin = random.range(0, Math.PI * 2);
      // Not on the water inside a hull (a cockpit, under a deck).
      If(particles.insideHull(position).not(), () => {
        for (let k = 0; k < SPLASH_DROPLETS; k++) {
          const index = particles.allocate();
          If(index.greaterThanEqual(0), () => {
            const a = spin.add((k / SPLASH_DROPLETS) * Math.PI * 2).add(random.range(-0.5, 0.5));
            const out = random.range(0.15, 0.45);
            const velocity = vec3(cos(a).mul(out), random.range(0.35, 0.8).mul(u.strength), sin(a).mul(out));
            particles.write(index, {
              position,
              velocity,
              size: powerLawRadiusNode(float(0.0012), float(0.004), 2.5, random.next()),
              life: random.range(0.15, 0.3),
              kind: float(PARTICLE_KIND.splash),
              seed: random.next(),
              drag: float(0.4),
            });
          });
        }
      });
    })().compute(this.maxCandidates, [64]);
    node.setName('fx-rain-splash-emit');
    return node;
  }
}

// atan2-style yaw of a camera's view direction on the sea plane, for SpumeEmitter.
export function viewYaw(direction: Vec3Like): number {
  return Math.atan2(direction.x, direction.z);
}
