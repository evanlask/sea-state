// XPBD cloth with "small steps" (Macklin et al. 2019, "Small Steps in Physics Simulation"): many
// substeps per frame, one Gauss-Seidel constraint pass each, so the Lagrange multipliers start from
// zero every substep and the solve is unconditionally stable for any compliance. A rectangular
// particle grid (cols along the chord, rows up the luff) with distance constraints for stretch
// (grid edges), shear (diagonals) and bending (skip-one neighbours). Pinned particles are kinematic:
// their targets are interpolated across the substeps so a moving spar drags the cloth smoothly.
// Everything lives in preallocated typed arrays; stepping allocates nothing.

interface ClothCompliance {
  stretch: number; // m/N (XPBD compliance α; 0 is rigid)
  shear: number;
  bend: number;
}

export interface ClothOptions {
  cols: number;
  rows: number;
  particleMass: number; // kg per free particle
  compliance?: ClothCompliance;
  damping?: number; // 1/s, velocity damping
  maxAcceleration?: number; // m/s², clamp on external force per particle
  maxSpeed?: number; // m/s
}

// External forces for one substep: write N into cloth.force (already zeroed).
export type ClothForceFn = (cloth: Cloth, substepTime: number) => void;

const DEFAULT_COMPLIANCE: ClothCompliance = { stretch: 1e-6, shear: 1e-5, bend: 1e-3 };

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  readonly count: number;
  readonly pos: Float64Array;
  readonly prev: Float64Array;
  readonly vel: Float64Array;
  readonly force: Float64Array;
  readonly mass: Float64Array; // kg per particle (a pinned particle keeps its mass for when it's let go)
  readonly invMass: Float64Array;
  readonly rest: Float64Array; // rest-shape positions the constraint lengths come from
  readonly pinned: Uint8Array;
  readonly pinFrom: Float64Array;
  readonly pinTo: Float64Array;
  readonly gravity = { x: 0, y: -9.81, z: 0 };
  readonly conA: Int32Array;
  readonly conB: Int32Array;
  readonly conRest: Float64Array;
  readonly conCompliance: Float64Array;
  readonly constraintCount: number;
  particleMass: number;
  damping: number;
  maxAcceleration: number;
  maxSpeed: number;
  resets = 0; // times the NaN guard fired

  constructor(options: ClothOptions) {
    const { cols, rows } = options;
    this.cols = cols;
    this.rows = rows;
    const n = cols * rows;
    this.count = n;
    this.pos = new Float64Array(3 * n);
    this.prev = new Float64Array(3 * n);
    this.vel = new Float64Array(3 * n);
    this.force = new Float64Array(3 * n);
    this.mass = new Float64Array(n);
    this.invMass = new Float64Array(n);
    this.rest = new Float64Array(3 * n);
    this.pinned = new Uint8Array(n);
    this.pinFrom = new Float64Array(3 * n);
    this.pinTo = new Float64Array(3 * n);
    this.particleMass = options.particleMass;
    this.damping = options.damping ?? 0.4;
    this.maxAcceleration = options.maxAcceleration ?? 4000;
    this.maxSpeed = options.maxSpeed ?? 80;
    this.mass.fill(options.particleMass);
    this.invMass.fill(1 / options.particleMass);
    const c = options.compliance ?? DEFAULT_COMPLIANCE;
    // Edges, both diagonals, skip-one bending in both directions.
    const total =
      (cols - 1) * rows +
      cols * (rows - 1) +
      2 * (cols - 1) * (rows - 1) +
      Math.max(0, cols - 2) * rows +
      cols * Math.max(0, rows - 2);
    this.conA = new Int32Array(total);
    this.conB = new Int32Array(total);
    this.conRest = new Float64Array(total);
    this.conCompliance = new Float64Array(total);
    let k = 0;
    const add = (a: number, b: number, compliance: number): void => {
      this.conA[k] = a;
      this.conB[k] = b;
      this.conCompliance[k] = compliance;
      k++;
    };
    const id = (col: number, row: number): number => row * cols + col;
    for (let r = 0; r < rows; r++) for (let q = 0; q + 1 < cols; q++) add(id(q, r), id(q + 1, r), c.stretch);
    for (let r = 0; r + 1 < rows; r++) for (let q = 0; q < cols; q++) add(id(q, r), id(q, r + 1), c.stretch);
    for (let r = 0; r + 1 < rows; r++) {
      for (let q = 0; q + 1 < cols; q++) {
        add(id(q, r), id(q + 1, r + 1), c.shear);
        add(id(q + 1, r), id(q, r + 1), c.shear);
      }
    }
    for (let r = 0; r < rows; r++) for (let q = 0; q + 2 < cols; q++) add(id(q, r), id(q + 2, r), c.bend);
    for (let r = 0; r + 2 < rows; r++) for (let q = 0; q < cols; q++) add(id(q, r), id(q, r + 2), c.bend);
    this.constraintCount = k;
  }

  // Stiffens one row chordwise (a batten or headboard): its edge and skip-one bending constraints.
  stiffenRow(row: number, compliance: number): void {
    const { cols, rows } = this;
    for (let q = 0; q + 1 < cols; q++) this.conCompliance[row * (cols - 1) + q] = compliance;
    const bendBase = (cols - 1) * rows + cols * (rows - 1) + 2 * (cols - 1) * (rows - 1);
    for (let q = 0; q + 2 < cols; q++) this.conCompliance[bendBase + row * (cols - 2) + q] = compliance;
  }

  index(col: number, row: number): number {
    return row * this.cols + col;
  }

  // Sets the rest shape (and the constraint lengths from it). Does not move the particles.
  setRestShape(shape: Float64Array): void {
    this.rest.set(shape);
    const p = this.rest;
    for (let k = 0; k < this.constraintCount; k++) {
      const a = 3 * this.conA[k]!;
      const b = 3 * this.conB[k]!;
      this.conRest[k] = Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
    }
  }

  // Puts every particle at rest on the rest shape.
  resetToRest(): void {
    this.pos.set(this.rest);
    this.prev.set(this.rest);
    this.vel.fill(0);
    for (let i = 0; i < this.count; i++) {
      if (!this.pinned[i]) continue;
      for (let d = 0; d < 3; d++) this.pos[3 * i + d] = this.pinFrom[3 * i + d] = this.pinTo[3 * i + d]!;
    }
  }

  // Pins particle i; its target for the coming step is (x, y, z), reached at the end of the step.
  pin(i: number, x: number, y: number, z: number): void {
    const j = 3 * i;
    if (!this.pinned[i]) {
      this.pinned[i] = 1;
      this.invMass[i] = 0;
      this.pinFrom[j] = this.pinTo[j] = x;
      this.pinFrom[j + 1] = this.pinTo[j + 1] = y;
      this.pinFrom[j + 2] = this.pinTo[j + 2] = z;
      this.pos[j] = x;
      this.pos[j + 1] = y;
      this.pos[j + 2] = z;
      return;
    }
    this.pinTo[j] = x;
    this.pinTo[j + 1] = y;
    this.pinTo[j + 2] = z;
  }

  unpin(i: number): void {
    this.pinned[i] = 0;
    this.invMass[i] = 1 / this.mass[i]!;
  }

  setParticleMass(mass: number): void {
    this.particleMass = mass;
    this.mass.fill(mass);
    for (let i = 0; i < this.count; i++) if (!this.pinned[i]) this.invMass[i] = 1 / mass;
  }

  // Per-particle masses (kg), e.g. each particle's share of the cloth area; particleMass becomes the mean.
  setParticleMasses(masses: Float64Array): void {
    this.mass.set(masses);
    let sum = 0;
    for (let i = 0; i < this.count; i++) {
      sum += masses[i]!;
      if (!this.pinned[i]) this.invMass[i] = 1 / masses[i]!;
    }
    this.particleMass = sum / this.count;
  }

  step(dt: number, substeps: number, forces?: ClothForceFn, time = 0): void {
    const n = Math.max(1, Math.floor(substeps));
    const h = dt / n;
    if (!(h > 0)) return;
    const pos = this.pos;
    const prev = this.prev;
    const vel = this.vel;
    const f = this.force;
    const w = this.invMass;
    const g = this.gravity;
    const maxA = this.maxAcceleration;
    const maxV = this.maxSpeed;
    const damp = Math.max(0, 1 - this.damping * h);
    for (let s = 0; s < n; s++) {
      f.fill(0);
      forces?.(this, time + s * h);
      const t = (s + 1) / n;
      for (let i = 0; i < this.count; i++) {
        const j = 3 * i;
        if (this.pinned[i]) {
          const pf = this.pinFrom;
          const pt = this.pinTo;
          prev[j] = pos[j]!;
          prev[j + 1] = pos[j + 1]!;
          prev[j + 2] = pos[j + 2]!;
          pos[j] = pf[j]! + (pt[j]! - pf[j]!) * t;
          pos[j + 1] = pf[j + 1]! + (pt[j + 1]! - pf[j + 1]!) * t;
          pos[j + 2] = pf[j + 2]! + (pt[j + 2]! - pf[j + 2]!) * t;
          continue;
        }
        let ax = f[j]! * w[i]!;
        let ay = f[j + 1]! * w[i]!;
        let az = f[j + 2]! * w[i]!;
        const a2 = ax * ax + ay * ay + az * az;
        if (a2 > maxA * maxA) {
          const k = maxA / Math.sqrt(a2);
          ax *= k;
          ay *= k;
          az *= k;
        }
        let vx = vel[j]! + (ax + g.x) * h;
        let vy = vel[j + 1]! + (ay + g.y) * h;
        let vz = vel[j + 2]! + (az + g.z) * h;
        const v2 = vx * vx + vy * vy + vz * vz;
        if (v2 > maxV * maxV) {
          const k = maxV / Math.sqrt(v2);
          vx *= k;
          vy *= k;
          vz *= k;
        }
        prev[j] = pos[j]!;
        prev[j + 1] = pos[j + 1]!;
        prev[j + 2] = pos[j + 2]!;
        pos[j] = pos[j]! + vx * h;
        pos[j + 1] = pos[j + 1]! + vy * h;
        pos[j + 2] = pos[j + 2]! + vz * h;
      }
      this.solveConstraints(h);
      const inv = 1 / h;
      for (let i = 0; i < this.count; i++) {
        const j = 3 * i;
        vel[j] = (pos[j]! - prev[j]!) * inv * damp;
        vel[j + 1] = (pos[j + 1]! - prev[j + 1]!) * inv * damp;
        vel[j + 2] = (pos[j + 2]! - prev[j + 2]!) * inv * damp;
      }
    }
    // Pins have arrived; the next step starts from here.
    this.pinFrom.set(this.pinTo);
    this.guard();
  }

  private solveConstraints(h: number): void {
    const pos = this.pos;
    const w = this.invMass;
    const invH2 = 1 / (h * h);
    for (let k = 0; k < this.constraintCount; k++) {
      const ia = this.conA[k]!;
      const ib = this.conB[k]!;
      const wa = w[ia]!;
      const wb = w[ib]!;
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const a = 3 * ia;
      const b = 3 * ib;
      const dx = pos[a]! - pos[b]!;
      const dy = pos[a + 1]! - pos[b + 1]!;
      const dz = pos[a + 2]! - pos[b + 2]!;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const c = len - this.conRest[k]!;
      const dl = -c / (wsum + this.conCompliance[k]! * invH2);
      const s = dl / len;
      pos[a] = pos[a]! + dx * s * wa;
      pos[a + 1] = pos[a + 1]! + dy * s * wa;
      pos[a + 2] = pos[a + 2]! + dz * s * wa;
      pos[b] = pos[b]! - dx * s * wb;
      pos[b + 1] = pos[b + 1]! - dy * s * wb;
      pos[b + 2] = pos[b + 2]! - dz * s * wb;
    }
  }

  // Any non-finite value (it should never happen thanks to the clamps) puts the cloth back to rest.
  private guard(): void {
    const p = this.pos;
    for (let i = 0; i < p.length; i++) {
      if (!Number.isFinite(p[i]!) || !Number.isFinite(this.vel[i]!)) {
        this.resets++;
        this.resetToRest();
        return;
      }
    }
  }

  // Largest relative stretch over the stretch (edge) constraints, for tests and diagnostics.
  maxStrain(): number {
    let worst = 0;
    const edges = (this.cols - 1) * this.rows + this.cols * (this.rows - 1);
    const p = this.pos;
    for (let k = 0; k < edges; k++) {
      const a = 3 * this.conA[k]!;
      const b = 3 * this.conB[k]!;
      const len = Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
      const rest = this.conRest[k]!;
      if (rest > 1e-9) worst = Math.max(worst, Math.abs(len / rest - 1));
    }
    return worst;
  }
}
