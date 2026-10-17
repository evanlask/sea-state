// Large-angle hazards as force modules:
//  - DeckWater: green water shipped into open wells and cockpits over the
//    bulwark/coaming (and poured in by a breaking crest's roller), drained by
//    freeing ports/scuppers (outflow ∝ √head) and, for an open cockpit heeling,
//    over its low rim, its free surface lagging toward the low side (cuts the
//    righting moment);
//  - Flooding: downflooding through openings (doors, vents, companionway,
//    engine intakes) that go under, into internal compartments, with the same
//    free-surface model, slow bilge pumps, progressive sinking/capsize;
//  - BreakingWaves: where a crest is steep enough to break and it meets the
//    hull side, transom or bow, the breaking crest's water, moving at the
//    crest's speed, hits the hull along the wave's travel (how small craft get
//    rolled lying beam-on, pitchpoled or broached from astern).
//
// Telemetry
//   DeckWater: deckWater (0..1 of the largest well's capacity), deckWaterMass (kg)
//   Flooding: flooding (0..1 of the floodable volume), floodWaterMass (kg),
//     downflooding (0/1 an opening is under water now)
//   BreakingWaves: breaking (N, crest impact force this substep)

import type { CompartmentSpec, OpeningSpec } from '../boats/BoatSpec';
import { qRotate, qRotateInverse, type Vec3, vec3 } from '../core/math';
import { GRAVITY, RHO_SEAWATER } from '../core/units';
import type { HullBuild } from './hull/generateHull';
import type { OpenVolumeSpec } from './hull/types';
import type { ForceContext, ForceModule } from './modules';
import type { RigidBody } from './RigidBody';
import { type WaterSample, waterSample } from './water';

const RHO = RHO_SEAWATER;
const SQRT_2G = Math.sqrt(2 * GRAVITY);
const DOWN = vec3(0, -1, 0);
const UP = vec3(0, 1, 0);
// Tilts (cosines, of the body's up from the vertical) over which the breaking crests' geometry turns
// from upright to upside down: from 120° to 150°, the roll-over a capsize counts at. On its beam ends a
// boat is still struck as if upright.
const INVERTED_FROM = Math.cos((120 * Math.PI) / 180);
const INVERTED_TO = Math.cos((150 * Math.PI) / 180);
const gBody = vec3();
const pBody = vec3();
const pWorld = vec3();
const tmp = vec3();
const pv = vec3();
const side = vec3();

// A box of water in the body frame whose centroid follows gravity with a lag. An open-topped one (a
// recessed cockpit) has a free surface even when brimming, and heeled it only holds what lies below its
// lowest rim (heldVolume).
export class FreeSurfaceTank {
  readonly cx: number;
  readonly cy: number; // box centre, body
  readonly cz: number;
  readonly ax: number; // half sizes
  readonly ay: number;
  readonly az: number;
  readonly capacity: number; // m³
  readonly open: boolean;
  volume = 0;
  offX = 0;
  offY = 0;
  offZ = 0;

  constructor(
    cx: number,
    cy: number,
    cz: number,
    width: number,
    height: number,
    length: number,
    capacity: number,
    open = false,
  ) {
    this.open = open;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
    this.ax = width / 2;
    this.ay = height / 2;
    this.az = length / 2;
    this.capacity = capacity;
    this.offY = -this.ay;
  }

  get mass(): number {
    return RHO * this.volume;
  }

  get fill(): number {
    return this.capacity > 0 ? this.volume / this.capacity : 0;
  }

  // Free-surface transverse inertia ρ·i, kg·m² (zero when empty or pressed full).
  get freeSurfaceMoment(): number {
    const f = this.fill;
    if (f <= 0.001 || (f >= 0.98 && !this.open)) return 0;
    return (RHO * (2 * this.az) * (2 * this.ax) ** 3) / 12;
  }

  // Gravity in body axes; the slope of the free surface relative to the tank.
  update(body: RigidBody, dt: number): void {
    qRotateInverse(gBody, body.orientation, DOWN);
    const f = Math.min(1, this.fill);
    const ax = this.ax;
    const ay = this.ay;
    const az = this.az;
    // Upright: water on the floor, centroid at (1 − f)·ay below the box centre;
    // tilted: the free-surface shift a²·tanφ/(6·ay·f), capped at the wedge limit.
    const vert = Math.max(0.2, Math.abs(gBody.y));
    const fs = Math.max(f, 0.02);
    // A closed tank pressed full cannot shift; an open well's water runs to its low side, at most as a
    // full wedge (centroid a third of the half-breadth out).
    const limit = this.open ? Math.max((1 - f) * 0.8, 1 / 3) : (1 - f) * 0.8;
    const tx = clampAbs(((gBody.x / vert) * ax * ax) / (6 * ay * fs), limit * ax);
    const tz = clampAbs(((gBody.z / vert) * az * az) / (6 * ay * fs), limit * az);
    const ty = gBody.y * (1 - f) * ay;
    const depth = Math.max(0.05, 2 * ay * f);
    const tau = (0.5 * 2 * ax) / Math.sqrt(GRAVITY * depth);
    const a = Math.min(1, dt / tau);
    this.offX += (tx - this.offX) * a;
    this.offZ += (tz - this.offZ) * Math.min(1, dt / ((tau * az) / Math.max(ax, 1e-3)));
    this.offY += (ty - this.offY) * a;
  }

  // m³ an open well holds at this tilt (gravity in body axes): the water level through its lowest rim
  // corner. Over a box of depth d tilted by slopes tx, tz, with S = ax·tx + az·tz: a level of mean depth
  // d − S while the floor stays covered (S ≤ d/2), else a wedge, ax·az·d²/S.
  heldVolume(g: Vec3): number {
    const vert = Math.max(1e-3, Math.abs(g.y));
    if (g.y > -0.05) return 0;
    const d = 2 * this.ay;
    const S = (this.ax * Math.abs(g.x) + this.az * Math.abs(g.z)) / vert;
    if (S <= d / 2) return 4 * this.ax * this.az * (d - S);
    return (this.ax * this.az * d * d) / S;
  }

  applyWeight(body: RigidBody): void {
    if (this.volume <= 0) return;
    pBody.x = this.cx + this.offX;
    pBody.y = this.cy + this.offY;
    pBody.z = this.cz + this.offZ;
    body.bodyToWorldPoint(pWorld, pBody);
    body.addForceAtPointXYZ(0, -this.mass * GRAVITY, 0, pWorld.x, pWorld.y, pWorld.z);
  }
}

// [E] A weathertight door or hatch, dogged shut at sea, still weeps under a sea: this fraction of its
// area floods (a door left open is an ordinary opening).
const WEATHERTIGHT_LEAK = 0.03;

const SPILL_TIME = 0.5; // s

const clampAbs = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v);

interface Well {
  tank: FreeSurfaceTank;
  rim: Vec3[]; // body points on the rim
  exterior: boolean[]; // rim points on the hull's edge (a side or an end), where a breaking sea reaches
  rimSpan: number; // m of rim per point
  floorY: number;
  drainArea: number;
  drainBackflow: number; // fraction of drainArea open to inflow
  drains: Vec3[]; // port and starboard, at the floor
  // Bulwark wells only: floor points, one per equal cell of a 3×3 grid, where the sea's column over
  // the deck is measured (DeckWater.discountSea). Empty for recessed cockpits.
  floor: Vec3[];
  cellArea: number; // m² of floor per point
  depth: number; // bulwark height, m
}

export class DeckWater implements ForceModule {
  readonly wells: Well[];
  breakingSteepness = BREAKING_STEEPNESS;
  private readonly sample = waterSample();

  constructor(volumes: readonly OpenVolumeSpec[], hull: HullBuild) {
    this.wells = volumes.map((v) => {
      const x = v.x ?? 0;
      const deck = hull.deckHeightAt(v.z);
      const floorY = v.recessed ? deck - v.depth : deck;
      const rimY = floorY + v.depth;
      const hx = v.width / 2;
      const hz = v.length / 2;
      const rim: Vec3[] = [];
      for (const [px, pz] of [
        [-1, -1],
        [0, -1],
        [1, -1],
        [1, 0],
        [1, 1],
        [0, 1],
        [-1, 1],
        [-1, 0],
      ] as const) {
        rim.push(vec3(x + px * hx, rimY, v.z + pz * hz));
      }
      // On the deck edge (the sheer, the transom or the stem) rather than inboard against the console.
      const exterior = rim.map(
        (p) =>
          Math.abs(p.x) > 0.75 * hull.deckHalfBreadthAt(p.z) || p.z > hull.zStern - 1 || p.z < hull.zBow + 1,
      );
      return {
        tank: new FreeSurfaceTank(
          x,
          floorY + v.depth / 2,
          v.z,
          v.width,
          v.depth,
          v.length,
          v.width * v.length * v.depth,
          v.recessed,
        ),
        rim,
        exterior,
        rimSpan: (2 * (v.width + v.length)) / rim.length,
        floorY,
        drainArea: v.drainArea,
        drainBackflow: v.drainBackflow ?? 1,
        drains: [vec3(x - hx, floorY, v.z), vec3(x + hx, floorY, v.z)],
        floor: v.recessed
          ? []
          : [-1, 0, 1].flatMap((i) =>
              [-1, 0, 1].map((j) => vec3(x + (i * 2 * hx) / 3, floorY, v.z + (j * 2 * hz) / 3)),
            ),
        cellArea: (v.width * v.length) / 9,
        depth: v.depth,
      };
    });
  }

  get carriedMass(): number {
    let m = 0;
    for (const w of this.wells) m += w.tank.mass;
    return m;
  }

  apply(ctx: ForceContext): void {
    const { body, water, time, dt } = ctx;
    const s = this.sample;
    for (const well of this.wells) {
      const tank = well.tank;
      let q = 0;
      qRotateInverse(gBody, body.orientation, DOWN);
      let lowest = -Infinity;
      let lowestHead = 0;
      // Over the rim: broad-crested weir per rim segment. Where a crest is breaking, its roller (the
      // breaking top that BreakingWaves throws at the side) stands on the sea surface and pours over the
      // rim it meets on the up-wave side (the hull's edge, not inboard): green water that fills a cockpit
      // lying beam- or stern-on.
      for (let r = 0; r < well.rim.length; r++) {
        const p = well.rim[r]!;
        body.bodyToWorldPoint(pWorld, p);
        water.sample(pWorld.x, pWorld.y, pWorld.z, time, s);
        let h = s.pressureHead;
        const roller = breakerRoller(s, this.breakingSteepness);
        if (roller > 0 && well.exterior[r]) {
          // Outward from the well's centre, world, against the crest's travel: the side it hits.
          tmp.x = p.x - well.tank.cx;
          tmp.y = 0;
          tmp.z = p.z - well.tank.cz;
          qRotate(side, body.orientation, tmp);
          if (side.x * s.crestVelocityX + side.z * s.crestVelocityZ < 0) h += roller;
        }
        if (h > 0) q += 0.4 * well.rimSpan * h * Math.sqrt(h) * SQRT_2G;
        const down = p.x * gBody.x + p.y * gBody.y + p.z * gBody.z;
        if (down > lowest) {
          lowest = down;
          lowestHead = h;
        }
      }
      // Freeing ports both sides: outflow by the head difference (inflow if the sea is higher).
      const depth = tank.volume / (2 * tank.ax * (2 * tank.az));
      for (let i = 0; i < 2; i++) {
        const p = well.drains[i]!;
        body.bodyToWorldPoint(pWorld, p);
        water.sample(pWorld.x, pWorld.y, pWorld.z, time, s);
        const outside = Math.max(0, s.pressureHead);
        // The low side holds more head.
        const side = i === 0 ? -1 : 1;
        const inside = Math.max(0, depth * (1 + (2 * side * tank.offX) / tank.ax));
        const dh = inside - outside;
        const area = dh > 0 ? well.drainArea : well.drainArea * well.drainBackflow;
        q -= 0.6 * 0.5 * area * Math.sign(dh) * Math.sqrt(Math.abs(dh)) * SQRT_2G;
      }
      // [E] An open cockpit brimming as it heels pours over its lowest rim (if that is out of the sea)
      // down to what it holds at that tilt, in about half a second.
      if (tank.open && lowestHead <= 0) {
        const held = tank.heldVolume(gBody);
        if (tank.volume > held) q -= (tank.volume - held) / SPILL_TIME;
      }
      // Heeled past ~70° (or inverted) an open well cannot hold water: it pours out.
      if (gBody.y > -0.35) q = -tank.volume / 0.7;
      tank.volume = Math.min(tank.capacity, Math.max(0, tank.volume + q * dt));
      tank.update(body, dt);
      tank.applyWeight(body);
      if (well.floor.length > 0 && tank.volume > 0) this.discountSea(ctx, well);
    }
  }

  // A bulwark well sits on the hull's deck, which the hull's pressure model (Kerner) already loads
  // with the sea standing over it wherever the deck is below the surface. Water in the well up to
  // that level is the same water, so weighing it again would double-count. The sea's
  // column over the floor (capped at the bulwark) is lifted back off at its centroid,
  // never more than the water actually in the well: only water above the sea outside, shipped
  // and trapped, is extra weight. (A recessed cockpit is inside the closed hull: no overlap.)
  private discountSea(ctx: ForceContext, well: Well): void {
    const { body, water, time } = ctx;
    const s = this.sample;
    let vol = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;
    for (const p of well.floor) {
      body.bodyToWorldPoint(pWorld, p);
      water.sample(pWorld.x, pWorld.y, pWorld.z, time, s);
      const h = Math.min(well.depth, s.pressureHead);
      if (h <= 0) continue;
      const v = h * well.cellArea;
      vol += v;
      mx += v * p.x;
      my += v * (p.y + h / 2);
      mz += v * p.z;
    }
    if (vol <= 0) return;
    const lift = Math.min(vol, well.tank.volume) * RHO * GRAVITY;
    pBody.x = mx / vol;
    pBody.y = my / vol;
    pBody.z = mz / vol;
    body.bodyToWorldPoint(pWorld, pBody);
    body.addForceAtPointXYZ(0, lift, 0, pWorld.x, pWorld.y, pWorld.z);
  }

  writeTelemetry(out: Record<string, number>): void {
    let fill = 0;
    for (const w of this.wells) fill = Math.max(fill, w.tank.fill);
    out['deckWater'] = fill;
    out['deckWaterMass'] = this.carriedMass;
  }

  reset(): void {
    for (const w of this.wells) {
      w.tank.volume = 0;
      w.tank.offX = w.tank.offZ = 0;
    }
  }
}

export class Flooding implements ForceModule {
  readonly openings: readonly OpeningSpec[];
  readonly tanks: FreeSurfaceTank[];
  readonly pumps: number[];
  submerged = false;
  private readonly sample = waterSample();

  constructor(openings: readonly OpeningSpec[], compartments: readonly CompartmentSpec[]) {
    this.openings = openings;
    this.tanks = compartments.map(
      (c) =>
        new FreeSurfaceTank(
          c.x ?? 0,
          c.floorY + c.height / 2,
          c.z,
          c.width,
          c.height,
          c.length,
          c.width * c.length * c.height * (c.permeability ?? 0.85),
        ),
    );
    this.pumps = compartments.map((c) => c.pumpRate ?? 0);
  }

  get carriedMass(): number {
    let m = 0;
    for (const t of this.tanks) m += t.mass;
    return m;
  }

  get floodFraction(): number {
    let v = 0;
    let c = 0;
    for (const t of this.tanks) {
      v += t.volume;
      c += t.capacity;
    }
    return c > 0 ? v / c : 0;
  }

  apply(ctx: ForceContext): void {
    const { body, water, time, dt } = ctx;
    this.submerged = false;
    for (const o of this.openings) {
      body.bodyToWorldPoint(pWorld, o.position);
      water.sample(pWorld.x, pWorld.y, pWorld.z, time, this.sample);
      const h = this.sample.pressureHead;
      if (h > 0) {
        this.submerged = true;
        const t = this.tanks[o.compartment]!;
        const area = (o.weathertight ? o.area * WEATHERTIGHT_LEAK : o.area) * (o.inflow ?? 1);
        t.volume = Math.min(t.capacity, t.volume + 0.6 * area * Math.sqrt(h) * SQRT_2G * dt);
      }
    }
    for (let i = 0; i < this.tanks.length; i++) {
      const t = this.tanks[i]!;
      if (!this.submerged) t.volume = Math.max(0, t.volume - this.pumps[i]! * dt);
      t.update(body, dt);
      t.applyWeight(body);
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    out['flooding'] = this.floodFraction;
    out['floodWaterMass'] = this.carriedMass;
    out['downflooding'] = this.submerged ? 1 : 0;
  }

  reset(): void {
    for (const t of this.tanks) {
      t.volume = 0;
      t.offX = t.offZ = 0;
    }
  }
}

export interface BreakingWaveSpec {
  // Side stations (body z) and the half-breadth / freeboard there, and the body y of the side's lower
  // edge there (the chine; default 0), its top when the hull floats upside down.
  stations: { z: number; halfBreadth: number; freeboard: number; bottom?: number }[];
  // The transom and the bow, struck by a crest breaking from astern or ahead: their body z, the
  // half-breadth they present to it, the freeboard there and the share of the crest's momentum flux
  // they take (a flat transom all of it; a fine bow parts the water and takes less).
  ends?: { z: number; halfBreadth: number; freeboard: number; bottom?: number; share: number }[];
  breakingSteepness?: number; // default BREAKING_STEEPNESS
  impactCoefficient?: number; // default 2
}

// [E] A crest of the seas (the waves at least 25 m long, WaterSample.steepness) breaks where their linear
// local steepness Σ a·k·cos θ passes 0.22, fully from 0.24. The linear sum understates the highest crests
// of real seas (bound harmonics and focusing steepen them toward the Stokes limit a·k ≈ 0.44), so the
// limit is set to give the observed share of breaking dominant waves, b ≈ 22·(ε − 0.055)² for a sea of
// peak steepness ε (Banner, Babanin & Young 2000): about 1% of them in a Gale, 3% in a Storm, 7% in a
// Category 1 and 10–20% in a Category 3–5 hurricane. On the physics ocean that is none of the sea up to
// Squalls, 0.1% of it in a Gale, 0.4% in a Storm, 0.9% in a Category 1 and 2.5–3% in a Category 3–5,
// the breakers growing with the sea (crests 2.5–9 m high, moving at 10–18 m/s). The surface Jacobian
// never gets below about 0.45 even in a Category 5 hurricane, so it cannot flag breaking.
const BREAKING_STEEPNESS = 0.22;
const BREAKING_RAMP = 0.02;

// Share of a crest that is breaking at this sample (0 below the limit, 1 from limit + ramp).
function breakingShare(s: WaterSample, limit = BREAKING_STEEPNESS): number {
  return s.steepness <= limit ? 0 : Math.min(1, (s.steepness - limit) / BREAKING_RAMP);
}

// [E] Height of a breaking crest's roller above the sea surface there, m (0 where it isn't breaking):
// about half the crest height a = u·c/g, c = u/(a·k) (see BreakingWaves), scaled by the breaking share.
function breakerRoller(s: WaterSample, limit = BREAKING_STEEPNESS): number {
  const b = breakingShare(s, limit);
  if (b <= 0) return 0;
  const u2 = s.crestVelocityX * s.crestVelocityX + s.crestVelocityZ * s.crestVelocityZ;
  return (0.5 * b * u2) / (s.steepness * GRAVITY);
}

// The lowest point of the canoe body's sections at body z, body y: of the whole section (the keel), or of
// its side, where the section is still at least `share` of its widest (the chine or turn of the bilge,
// below which the bottom turns in under the hull).
function hullBottomAt(hull: HullBuild, z: number, share = 0): number {
  const p = hull.mesh.positions;
  const sections = new Map<number, { half: number; lows: [number, number][] }>();
  for (let i = 0; i < p.length; i += 3) {
    const key = Math.round(p[i + 2]! * 1e4) / 1e4;
    let s = sections.get(key);
    if (!s) sections.set(key, (s = { half: 0, lows: [] }));
    const x = Math.abs(p[i]!);
    s.half = Math.max(s.half, x);
    s.lows.push([x, p[i + 1]!]);
  }
  const low = (key: number): number => {
    const s = sections.get(key)!;
    let y = Infinity;
    for (const [x, py] of s.lows) if (x >= share * s.half - 1e-9) y = Math.min(y, py);
    return y;
  };
  const zs = [...sections.keys()].sort((a, b) => a - b);
  if (z <= zs[0]!) return low(zs[0]!);
  for (let i = 1; i < zs.length; i++) {
    if (z <= zs[i]!) {
      const t = (z - zs[i - 1]!) / (zs[i]! - zs[i - 1]!);
      return low(zs[i - 1]!) + (low(zs[i]!) - low(zs[i - 1]!)) * t;
    }
  }
  return low(zs[zs.length - 1]!);
}

// [E] The share of a section's breadth below which its side has turned into the bottom.
const SIDE_SHARE = 0.8;

export function breakingSpecFromHull(hull: HullBuild, length: number, count = 5): BreakingWaveSpec {
  const stations = [];
  for (let i = 0; i < count; i++) {
    const z = (-0.4 + (0.8 * i) / (count - 1)) * length;
    stations.push({
      z,
      halfBreadth: hull.deckHalfBreadthAt(z) * 0.95,
      freeboard: Math.max(0.2, hull.deckHeightAt(z)),
      bottom: hullBottomAt(hull, z, SIDE_SHARE),
    });
  }
  // [E] The bow presents the hull's greatest breadth to a crest from ahead, but its flare parts the
  // water: a third of the momentum flux.
  let beam = 0;
  for (const st of stations) beam = Math.max(beam, st.halfBreadth);
  const zb = hull.zBow + 0.15 * length;
  const ends = [
    {
      z: hull.zStern,
      halfBreadth: hull.deckHalfBreadthAt(hull.zStern) * 0.95,
      freeboard: Math.max(0.2, hull.deckHeightAt(hull.zStern)),
      bottom: hullBottomAt(hull, hull.zStern),
      share: 1,
    },
    {
      z: zb,
      halfBreadth: beam,
      freeboard: Math.max(0.2, hull.deckHeightAt(zb)),
      bottom: hullBottomAt(hull, zb),
      share: 1 / 3,
    },
  ];
  return { stations, ends };
}

// The breaking crest's water moves with the crest. For one wave its speed is c = u/(a·k) (u the
// orbital velocity at the crest, a·k the steepness) and its height a = u·c/g; summed waves give the
// steepness-weighted blend of the waves that make the crest steep, so a breaker hits with the speed and
// height of the sea that breaks: a 2.5 m crest at 10 m/s in a Gale, up to 9 m at 18 m/s in a Category 5.
// Its momentum flux ½·ρ·C·u_n²·h per metre of hull side (u_n the crest water's speed into the side
// relative to the hull, h the height of side its breaking top covers) acts along the crest's travel,
// and fades as the hull is swept up to the crest's speed. A crest breaking from astern
// strikes the transom in the same way, above the CG and, unless dead astern, off the centreline: it
// throws the stern up and round (pitchpole, broach); one from ahead strikes the bow.
interface Face {
  x: number; // body point at the waterline
  z: number;
  nx: number; // outward normal, body, horizontal
  nz: number;
  width: number; // m of hull the point stands for
  freeboard: number;
  bottom: number; // body y of the face's lower edge (its top when the hull floats upside down)
  share: number; // of the momentum flux
}

export class BreakingWaves implements ForceModule {
  readonly spec: BreakingWaveSpec;
  readonly segment: number;
  readonly faces: Face[] = [];
  force = 0;
  private readonly sample = waterSample();

  constructor(spec: BreakingWaveSpec, length: number) {
    this.spec = spec;
    this.segment = length / spec.stations.length;
    for (const st of spec.stations)
      for (const sgn of [-1, 1])
        this.faces.push({
          x: sgn * st.halfBreadth,
          z: st.z,
          nx: sgn,
          nz: 0,
          width: this.segment,
          freeboard: st.freeboard,
          bottom: st.bottom ?? 0,
          share: 1,
        });
    // Each end as two points, port and starboard halves.
    for (const e of spec.ends ?? [])
      for (const sgn of [-1, 1])
        this.faces.push({
          x: (sgn * e.halfBreadth) / 2,
          z: e.z,
          nx: 0,
          nz: e.z > 0 ? 1 : -1,
          width: e.halfBreadth,
          freeboard: e.freeboard,
          bottom: e.bottom ?? 0,
          share: e.share,
        });
  }

  apply(ctx: ForceContext): void {
    const { body, water, time } = ctx;
    const sb = this.spec.breakingSteepness ?? BREAKING_STEEPNESS;
    const c = this.spec.impactCoefficient ?? 2;
    const s = this.sample;
    this.force = 0;
    // Which way up the hull floats. Upright the struck side stands on the sea from the waterline up to
    // the deck edge (and what stands on the deck); upside down it is the other way round: from about
    // the deck edge, awash, up to the chine (a transom up to the keel). Above the chine the bottom
    // slopes in to the keel, near flat on an upturned V, and turns the crest's water up over the hull
    // rather than taking its push.
    qRotate(tmp, body.orientation, UP);
    const inverted = Math.min(1, Math.max(0, (tmp.y - INVERTED_FROM) / (INVERTED_TO - INVERTED_FROM)));
    for (const st of this.faces) {
      pBody.x = st.x;
      pBody.y = inverted * st.freeboard;
      pBody.z = st.z;
      const top = (1 - inverted) * 1.5 * st.freeboard + inverted * (st.freeboard - st.bottom);
      body.bodyToWorldPoint(pWorld, pBody);
      water.sample(pWorld.x, pWorld.y, pWorld.z, time, s);
      if (s.steepness <= sb) continue;
      const ux = s.crestVelocityX;
      const uz = s.crestVelocityZ;
      const u = Math.hypot(ux, uz);
      if (u < 1e-3) continue;
      // The crest's speed and height; its water moves at that speed along the orbital velocity.
      const speed = u / s.steepness;
      const crest = (u * speed) / GRAVITY;
      // [E] The breaking top of the crest (the roller, about half its height) rides on the sea surface
      // there and strikes the side from the surface (or the waterline) up, as high as the topsides go.
      const low = Math.max(0, s.pressureHead);
      const high = Math.min(s.pressureHead + 0.5 * crest, top);
      if (high <= low) continue;
      body.pointVelocity(pv, pWorld);
      const rx = (ux / u) * speed - pv.x;
      const rz = (uz / u) * speed - pv.z;
      // Outward normal, horizontal.
      tmp.x = st.nx;
      tmp.y = 0;
      tmp.z = st.nz;
      qRotate(side, body.orientation, tmp);
      const nl = Math.hypot(side.x, side.z) || 1;
      const inward = -(rx * side.x + rz * side.z) / nl;
      if (inward <= 0) continue;
      const breaking = breakingShare(s, sb);
      const height = high - low;
      const mag = 0.5 * RHO * c * st.share * inward * inward * height * st.width * breaking;
      const rl = Math.hypot(rx, rz) || 1;
      body.addForceAtPointXYZ(
        (mag * rx) / rl,
        0,
        (mag * rz) / rl,
        pWorld.x,
        pWorld.y + 0.5 * (low + high),
        pWorld.z,
      );
      this.force += mag;
    }
  }

  writeTelemetry(out: Record<string, number>): void {
    out['breaking'] = this.force;
  }
}
