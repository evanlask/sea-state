// A sail as XPBD cloth: a cambered grid from the tack, clew, head and head-leech corners, with an
// optional roach (a convex leech) beyond the straight clew–head line, pinned along the luff (mast or
// forestay), along the head (a rigid headboard) and, for the main, along the foot (boom); the genoa is
// pinned at the clew only, so its foot is loose. A sail whose head-leech corner is the head (the genoa)
// comes to a point: its whole top row is pinned there, so the grid is a triangle. Each particle weighs
// its share of the sail's area. Each substep every triangle gets an aerodynamic pressure along its
// normal from the apparent wind: a plate term ½ρ·Cn·|w·n|(w·n) on the relative air (so flutter is
// damped) plus a front-loaded lift-like suction toward leeward. Their total normal force is scaled to
// the sail model's force, so the cloth carries exactly the load the physics says; when the model says
// the sail is luffing (fill < 1) the lift part fades, the luff backs and a travelling flog wave takes
// over. Runs on the render side in the boat's body frame; allocation-free per step.

import { roachShape } from '../sim/sail/rig';
import { Cloth } from './Cloth';

export type ClothQuality = 'low' | 'medium' | 'high' | 'ultra';

// cols (chordwise) × rows (up the luff) per quality preset.
const CLOTH_RESOLUTION: Readonly<Record<ClothQuality, readonly [number, number]>> = {
  low: [10, 14],
  medium: [14, 20],
  high: [18, 26],
  ultra: [24, 34],
};

// A usable grid from graphics.sailCloth: at least 3 × 4 particles so the pins and battens fit.
export function clothGrid(resolution: readonly [number, number]): [number, number] {
  const cols = Math.round(Number.isFinite(resolution[0]) ? resolution[0] : 18);
  const rows = Math.round(Number.isFinite(resolution[1]) ? resolution[1] : 26);
  return [Math.min(64, Math.max(3, cols)), Math.min(96, Math.max(4, rows))];
}

export type SailKind = 'main' | 'jib';

interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface SailFrame {
  tack: V3; // body frame corners
  clew: V3;
  head: V3;
  headLeech: V3; // the head itself for a pointed head
  // Roach (m): the leech sits roach·(roachShape(s) − (1 − v)·roachShape(roachFrom)) beyond the straight
  // clew–head-leech line, along the tack → clew direction, at s = roachFrom + v·(1 − roachFrom) for the
  // fraction v up the luff; roachFrom > 0 is a reefed sail, the top of the full one (the clew then sits
  // on the roached leech already, hence the second term). Zero or absent: a straight leech.
  roach?: number;
  roachFrom?: number;
  air: V3; // relative air at the centre of effort, body frame, m/s
  fill: number; // sail model: 0 flogging .. 1 drawing
  force: number; // sail model: aerodynamic force magnitude, N
  gravity: V3; // body-frame gravity, m/s²
}

const RHO_AIR = 1.225;
const PLATE_CN = 1.2;
const DENSITY = { main: 0.32, jib: 0.28 }; // kg/m², Dacron plus seams and battens
const DEPTH = { main: 0.1, jib: 0.12 }; // camber depth / chord of the rest shape
const MAX_SCALE = 4;
const MAX_PRESSURE = 450; // Pa on the cloth (about a 30 m/s apparent wind on a drawing sail)
const FLOG = 0.45; // flog pressure coefficient × q
const BACKING = 1.2; // how hard a luffing sail's luff is pushed to windward
// Quasi-steady aerodynamic damping: cloth moving at v_n across air at |w| meets it at v_n/|w| more
// incidence, worth about ½ρ|w|²·2π·v_n/|w| = πρ|w|·v_n per m² while the flow is attached (thin
// aerofoil). The plate term gives none where the cloth lies along the flow, so without this a roached
// leech flutters; it fades with fill, so a luffing sail still flogs.
const AERO_DAMPING = 2; // × ρ|w|, N·s/m³

// Batten heights as fractions of the luff, and their bending compliance (stiff, but not rigid).
export const MAIN_BATTENS: readonly number[] = [0.22, 0.44, 0.64, 0.83];
const BATTEN_COMPLIANCE = 2e-7;
const MIN_MASS_SHARE = 0.25; // of the mean particle mass, so the slivers near a point stay well behaved

const sm = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export class SailCloth {
  readonly kind: SailKind;
  readonly cloth: Cloth;
  readonly cols: number;
  readonly rows: number;
  readonly triangles: Uint32Array; // 3 indices per triangle, wound so the normal is chord × luff
  readonly chords: Float64Array; // rest chord (m, luff to leech) of each row, for the sailcloth shading
  shapeVersion = 0; // bumped whenever the rest shape (and chords) change
  luffing = 0; // last frame's flogging intensity, for audio/debug
  private readonly restShape: Float64Array;
  private readonly masses: Float64Array;
  private readonly chordWeight: Float64Array; // per triangle: lift distribution along the chord
  private readonly backWeight: Float64Array; // per triangle: luff-backing distribution
  private readonly triU: Float64Array;
  private readonly triV: Float64Array;
  private frame: SailFrame | null = null;
  private shapeKey = { luff: -1, foot: -1, head: -1, roach: -1, from: -1 };
  private scale = 0;
  private rawNormal = 0;
  private initialized = false;
  private substep = 1e-3; // s, the coming step's substep (bounds the explicit aero damping)
  private readonly nChord = { x: 0, y: 0, z: 0 };
  private readonly forces = (cloth: Cloth, time: number): void => this.applyAero(cloth, time);

  // quality: a preset's grid, or [cols, rows] (graphics.sailCloth).
  constructor(kind: SailKind, quality: ClothQuality | readonly [number, number] = 'high') {
    this.kind = kind;
    const [cols, rows] = typeof quality === 'string' ? CLOTH_RESOLUTION[quality] : clothGrid(quality);
    this.cols = cols;
    this.rows = rows;
    this.cloth = new Cloth({ cols, rows, particleMass: 0.05, damping: 0.8 });
    // The main's four battens hold its roach; the genoa has none.
    if (kind === 'main') {
      for (const v of MAIN_BATTENS) this.cloth.stiffenRow(this.battenRow(v), BATTEN_COMPLIANCE);
    }
    this.restShape = new Float64Array(3 * cols * rows);
    this.chords = new Float64Array(rows);
    this.masses = new Float64Array(cols * rows);
    const nTri = 2 * (cols - 1) * (rows - 1);
    this.triangles = new Uint32Array(3 * nTri);
    this.chordWeight = new Float64Array(nTri);
    this.backWeight = new Float64Array(nTri);
    this.triU = new Float64Array(nTri);
    this.triV = new Float64Array(nTri);
    let t = 0;
    for (let r = 0; r + 1 < rows; r++) {
      for (let q = 0; q + 1 < cols; q++) {
        const a = r * cols + q;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        this.setTri(t++, a, b, d, (q + 2 / 3) / (cols - 1), (r + 1 / 3) / (rows - 1));
        this.setTri(t++, a, d, c, (q + 1 / 3) / (cols - 1), (r + 2 / 3) / (rows - 1));
      }
    }
    // Lift-like suction is front-loaded (mean 1 over the chord); backing is a luff-band thing.
    let mean = 0;
    for (let i = 0; i < nTri; i++) {
      this.chordWeight[i] = 1.6 * Math.sqrt(1 - this.triU[i]!) + 0.15;
      mean += this.chordWeight[i]!;
      this.backWeight[i] = 1 - sm(this.triU[i]! / 0.35);
    }
    mean /= nTri;
    for (let i = 0; i < nTri; i++) this.chordWeight[i] = this.chordWeight[i]! / mean;
  }

  // Grid row nearest a batten's height (fraction of the luff).
  battenRow(v: number): number {
    return Math.round(v * (this.rows - 1));
  }

  private setTri(t: number, a: number, b: number, c: number, u: number, v: number): void {
    this.triangles[3 * t] = a;
    this.triangles[3 * t + 1] = b;
    this.triangles[3 * t + 2] = c;
    this.triU[t] = u;
    this.triV[t] = v;
  }

  get positions(): Float64Array {
    return this.cloth.pos;
  }

  // Rest shape from the corners: luff and leech lines (plus roach) joined row by row, cambered along
  // the sail-plane normal. Also each particle's mass, its third of the adjacent triangles' area.
  private buildRestShape(f: SailFrame): void {
    const { cols, rows } = this;
    const T = f.tack;
    const C = f.clew;
    const H = f.head;
    const L = f.headLeech;
    const n = this.nChord;
    const depth = DEPTH[this.kind];
    const gMax = 0.417 * 0.583 ** 1.4;
    const roach = f.roach ?? 0;
    const from = f.roachFrom ?? 0;
    const g0 = roachShape(from);
    const footLen = Math.hypot(C.x - T.x, C.y - T.y, C.z - T.z) || 1;
    const dx = (C.x - T.x) / footLen;
    const dy = (C.y - T.y) / footLen;
    const dz = (C.z - T.z) / footLen;
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      const lx = T.x + (H.x - T.x) * v;
      const ly = T.y + (H.y - T.y) * v;
      const lz = T.z + (H.z - T.z) * v;
      const extra = roach > 0 ? roach * (roachShape(from + v * (1 - from)) - (1 - v) * g0) : 0;
      const ex = C.x + (L.x - C.x) * v + dx * extra;
      const ey = C.y + (L.y - C.y) * v + dy * extra;
      const ez = C.z + (L.z - C.z) * v + dz * extra;
      const chord = Math.hypot(ex - lx, ey - ly, ez - lz);
      this.chords[r] = chord;
      // The main's foot is pinned straight on the boom; the camber builds up above it. The head row is
      // the (flat) headboard.
      const hv = r === rows - 1 ? 0 : this.kind === 'main' ? sm(v / 0.12) : 1 - 0.25 * v;
      for (let q = 0; q < cols; q++) {
        const u = q / (cols - 1);
        const camber = (depth * chord * hv * (u * (1 - u) ** 1.4)) / gMax;
        const j = 3 * (r * cols + q);
        this.restShape[j] = lx + (ex - lx) * u + n.x * camber;
        this.restShape[j + 1] = ly + (ey - ly) * u + n.y * camber;
        this.restShape[j + 2] = lz + (ez - lz) * u + n.z * camber;
      }
    }
    this.cloth.setRestShape(this.restShape);
    this.setMasses();
    this.shapeVersion++;
  }

  // Each particle's mass is its third of the adjacent rest triangles' area (with a floor).
  private setMasses(): void {
    const p = this.restShape;
    const tri = this.triangles;
    const m = this.masses;
    m.fill(0);
    let area = 0;
    for (let t = 0; t < tri.length; t += 3) {
      const a = 3 * tri[t]!;
      const b = 3 * tri[t + 1]!;
      const c = 3 * tri[t + 2]!;
      const e1x = p[b]! - p[a]!;
      const e1y = p[b + 1]! - p[a + 1]!;
      const e1z = p[b + 2]! - p[a + 2]!;
      const e2x = p[c]! - p[a]!;
      const e2y = p[c + 1]! - p[a + 1]!;
      const e2z = p[c + 2]! - p[a + 2]!;
      const share = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x) / 6;
      area += 3 * share;
      m[tri[t]!] = m[tri[t]!]! + share;
      m[tri[t + 1]!] = m[tri[t + 1]!]! + share;
      m[tri[t + 2]!] = m[tri[t + 2]!]! + share;
    }
    const density = DENSITY[this.kind];
    const floor = (MIN_MASS_SHARE * Math.max(area, 0.05)) / m.length;
    for (let i = 0; i < m.length; i++) m[i] = density * Math.max(m[i]!, floor);
    this.cloth.setParticleMasses(m);
  }

  private updateChordNormal(f: SailFrame): void {
    const ax = f.clew.x - f.tack.x;
    const ay = f.clew.y - f.tack.y;
    const az = f.clew.z - f.tack.z;
    const bx = f.head.x - f.tack.x;
    const by = f.head.y - f.tack.y;
    const bz = f.head.z - f.tack.z;
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    this.nChord.x = nx / len;
    this.nChord.y = ny / len;
    this.nChord.z = nz / len;
  }

  private setPins(f: SailFrame): void {
    const { cols, rows, cloth } = this;
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      cloth.pin(
        r * cols,
        f.tack.x + (f.head.x - f.tack.x) * v,
        f.tack.y + (f.head.y - f.tack.y) * v,
        f.tack.z + (f.head.z - f.tack.z) * v,
      );
    }
    // The head row is the headboard, a rigid plate on the halyard (the genoa's is just the head point).
    const top = (rows - 1) * cols;
    for (let q = 1; q < cols; q++) {
      const u = q / (cols - 1);
      cloth.pin(
        top + q,
        f.head.x + (f.headLeech.x - f.head.x) * u,
        f.head.y + (f.headLeech.y - f.head.y) * u,
        f.head.z + (f.headLeech.z - f.head.z) * u,
      );
    }
    if (this.kind === 'main') {
      for (let q = 1; q < cols; q++) {
        const u = q / (cols - 1);
        cloth.pin(
          q,
          f.tack.x + (f.clew.x - f.tack.x) * u,
          f.tack.y + (f.clew.y - f.tack.y) * u,
          f.tack.z + (f.clew.z - f.tack.z) * u,
        );
      }
    } else {
      cloth.pin(cols - 1, f.clew.x, f.clew.y, f.clew.z);
    }
  }

  // Advances the cloth by dt toward the rig pose in `frame` (body frame); maxSubsteps trades accuracy
  // for time on sails far from the camera (render/boats/clothBudget).
  update(dt: number, frame: SailFrame, time: number, maxSubsteps = 24): void {
    this.frame = frame;
    this.updateChordNormal(frame);
    const luff = Math.hypot(
      frame.head.x - frame.tack.x,
      frame.head.y - frame.tack.y,
      frame.head.z - frame.tack.z,
    );
    const foot = Math.hypot(
      frame.clew.x - frame.tack.x,
      frame.clew.y - frame.tack.y,
      frame.clew.z - frame.tack.z,
    );
    const head = Math.hypot(
      frame.headLeech.x - frame.head.x,
      frame.headLeech.y - frame.head.y,
      frame.headLeech.z - frame.head.z,
    );
    const roach = frame.roach ?? 0;
    const from = frame.roachFrom ?? 0;
    const k = this.shapeKey;
    // Reefing and furling change the cut; spar rotation doesn't (lengths are rotation invariant).
    if (
      Math.abs(luff - k.luff) > 0.01 ||
      Math.abs(foot - k.foot) > 0.01 ||
      Math.abs(head - k.head) > 0.01 ||
      Math.abs(roach - k.roach) > 0.01 ||
      Math.abs(from - k.from) > 0.001
    ) {
      k.luff = luff;
      k.foot = foot;
      k.head = head;
      k.roach = roach;
      k.from = from;
      this.buildRestShape(frame);
    }
    this.setPins(frame);
    if (!this.initialized) {
      this.initialized = true;
      this.cloth.resetToRest();
    }
    const g = this.cloth.gravity;
    g.x = frame.gravity.x;
    g.y = frame.gravity.y;
    g.z = frame.gravity.z;
    const step = Math.min(dt, 1 / 20); // a long hitch (tab in background) is not worth simulating
    const cap = Math.max(1, Math.min(24, Math.floor(maxSubsteps)));
    const substeps = Math.min(cap, Math.max(4, Math.ceil(step * 1000)));
    this.substep = step / substeps;
    this.cloth.step(step, substeps, this.forces, time);
    this.luffing = 1 - Math.min(1, Math.max(0, frame.fill));
  }

  private applyAero(cloth: Cloth, time: number): void {
    const f = this.frame;
    if (!f) return;
    const pos = cloth.pos;
    const vel = cloth.vel;
    const force = cloth.force;
    const tri = this.triangles;
    const nc = this.nChord;
    const W = f.air;
    const speed2 = W.x * W.x + W.y * W.y + W.z * W.z;
    if (!(speed2 > 1e-6)) return;
    const q = 0.5 * RHO_AIR * speed2;
    const leeward = W.x * nc.x + W.y * nc.y + W.z * nc.z >= 0 ? 1 : -1;
    const fill = Math.min(1, Math.max(0, f.fill));
    const luff = 1 - fill;
    // Flogging: a travelling wave from luff to leech, faster in more wind.
    const omega = 2 * Math.PI * Math.min(12, 1.5 + 0.25 * Math.sqrt(speed2));
    const scale = this.scale;
    // Explicit, so held under half the cloth's areal density per substep (a coarse distant sail).
    const damping =
      Math.min(AERO_DAMPING * RHO_AIR * Math.sqrt(speed2), (0.5 * DENSITY[this.kind]) / this.substep) * fill;
    let raw = 0;
    const nTri = tri.length / 3;
    for (let t = 0; t < nTri; t++) {
      const a = 3 * tri[3 * t]!;
      const b = 3 * tri[3 * t + 1]!;
      const c = 3 * tri[3 * t + 2]!;
      const e1x = pos[b]! - pos[a]!;
      const e1y = pos[b + 1]! - pos[a + 1]!;
      const e1z = pos[b + 2]! - pos[a + 2]!;
      const e2x = pos[c]! - pos[a]!;
      const e2y = pos[c + 1]! - pos[a + 1]!;
      const e2z = pos[c + 2]! - pos[a + 2]!;
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const twiceArea = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (twiceArea < 1e-12) continue;
      nx /= twiceArea;
      ny /= twiceArea;
      nz /= twiceArea;
      const area = 0.5 * twiceArea;
      const wx = W.x - (vel[a]! + vel[b]! + vel[c]!) / 3;
      const wy = W.y - (vel[a + 1]! + vel[b + 1]! + vel[c + 1]!) / 3;
      const wz = W.z - (vel[a + 2]! + vel[b + 2]! + vel[c + 2]!) / 3;
      const wn = wx * nx + wy * ny + wz * nz;
      const facing = nx * nc.x + ny * nc.y + nz * nc.z;
      const u = this.triU[t]!;
      // Plate term on the relative air along the local normal (it also damps flutter), plus a
      // lift-like suction toward leeward along the sail-plane normal (a fixed direction, so it can't
      // feed a leech flutter) that fades as the sail luffs and turns into backing along the luff.
      const plate = 0.5 * RHO_AIR * PLATE_CN * Math.abs(wn) * wn * area;
      const lift = q * area * leeward * this.chordWeight[t]! * (fill - BACKING * luff * this.backWeight[t]!);
      raw += plate * facing * leeward + lift * leeward;
      const flogWeight = luff * (1 - 0.5 * u);
      const flog =
        flogWeight > 0
          ? q * area * FLOG * flogWeight * Math.sin(omega * time - 9 * u + 3 * this.triV[t]!)
          : 0;
      // Attached-flow damping of the cloth's own normal motion (see AERO_DAMPING).
      const vn = W.x * nx + W.y * ny + W.z * nz - wn;
      let pn = scale * plate + flog - damping * vn * area;
      let pl = scale * lift;
      // Past a gale the cloth is simply bar-taut; capping the pressure keeps it from over-stretching.
      const pressure = Math.hypot(pn, pl) / area;
      if (pressure > MAX_PRESSURE) {
        const k = MAX_PRESSURE / pressure;
        pn *= k;
        pl *= k;
      }
      pn /= 3;
      pl /= 3;
      const fx = pn * nx + pl * nc.x;
      const fy = pn * ny + pl * nc.y;
      const fz = pn * nz + pl * nc.z;
      force[a] = force[a]! + fx;
      force[a + 1] = force[a + 1]! + fy;
      force[a + 2] = force[a + 2]! + fz;
      force[b] = force[b]! + fx;
      force[b + 1] = force[b + 1]! + fy;
      force[b + 2] = force[b + 2]! + fz;
      force[c] = force[c]! + fx;
      force[c + 1] = force[c + 1]! + fy;
      force[c + 2] = force[c + 2]! + fz;
    }
    // Scale for the next substep so the cloth's net normal load matches the model's force.
    this.rawNormal = raw;
    const target = raw > 1e-3 ? Math.min(MAX_SCALE, Math.max(0, f.force) / raw) : f.force > 0 ? MAX_SCALE : 0;
    this.scale += (target - this.scale) * 0.25;
  }

  // Net normal (toward leeward) aerodynamic load the cloth carried in the last substep, N.
  get normalLoad(): number {
    return this.rawNormal * this.scale;
  }
}
