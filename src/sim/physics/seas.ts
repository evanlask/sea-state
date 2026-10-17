// Deterministic analytic irregular sea for tests and tools: a sum of Airy
// components sampled from a JONSWAP spectrum (γ = 3.3) with cos² spreading,
// heights evaluated Eulerian, plus the Jacobian the same components would give
// as a choppy (Gerstner) surface, so breaking crests show up as on the FFT
// ocean. Implements both the hull-side WaterSampler and the OceanSurface-style
// SurfaceQuery (for HullWater).

import { GRAVITY } from '../core/units';
import { SEAS_MIN_WAVELENGTH } from '../ocean/cascades';
import type { SurfaceSample } from '../ocean/OceanSurface';
import type { SurfaceQuery } from './hullWater';
import type { WaterSample, WaterSampler } from './water';

const SEAS_K_MAX = (2 * Math.PI) / SEAS_MIN_WAVELENGTH;

export interface IrregularSeaParams {
  hs: number; // significant wave height, m
  tp: number; // peak period, s
  towards: number; // mean direction the waves travel toward, rad (heading convention)
  components?: number; // default 48
  spread?: number; // directional half-width, rad (default 0.5)
  seed?: number;
  minWavelength?: number; // shortest component, m (default 3)
}

export class IrregularSea implements WaterSampler, SurfaceQuery {
  readonly n: number;
  private readonly amp: Float64Array;
  private readonly k: Float64Array;
  private readonly omega: Float64Array;
  private readonly dx: Float64Array;
  private readonly dz: Float64Array;
  private readonly phase: Float64Array;

  constructor(p: IrregularSeaParams) {
    const n = p.components ?? 48;
    this.n = n;
    this.amp = new Float64Array(n);
    this.k = new Float64Array(n);
    this.omega = new Float64Array(n);
    this.dx = new Float64Array(n);
    this.dz = new Float64Array(n);
    this.phase = new Float64Array(n);
    let seed = (p.seed ?? 1) >>> 0;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const wp = (2 * Math.PI) / p.tp;
    const wMax = Math.sqrt((GRAVITY * 2 * Math.PI) / (p.minWavelength ?? 3));
    const wMin = 0.5 * wp;
    const dw = (wMax - wMin) / n;
    const spectrum = (w: number): number => {
      const sigma = w <= wp ? 0.07 : 0.09;
      const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
      return (GRAVITY ** 2 / w ** 5) * Math.exp(-1.25 * (wp / w) ** 4) * 3.3 ** r;
    };
    let m0 = 0;
    for (let i = 0; i < n; i++) m0 += spectrum(wMin + (i + 0.5) * dw) * dw;
    // Scale to the requested Hs = 4√m0.
    const scale = (p.hs / 4) ** 2 / m0;
    const spread = p.spread ?? 0.5;
    for (let i = 0; i < n; i++) {
      const w = wMin + (i + rand()) * dw;
      const s = spectrum(wMin + (i + 0.5) * dw) * scale;
      this.amp[i] = Math.sqrt(2 * s * dw);
      this.omega[i] = w;
      this.k[i] = (w * w) / GRAVITY;
      const dir = p.towards + (rand() - 0.5) * 2 * spread * Math.sqrt(rand());
      this.dx[i] = Math.sin(dir);
      this.dz[i] = -Math.cos(dir);
      this.phase[i] = rand() * 2 * Math.PI;
    }
  }

  query(x: number, z: number, time: number, out: SurfaceSample, depth = 0): SurfaceSample {
    let eta = 0;
    let gx = 0;
    let gz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let pd = 0;
    let jxx = 0;
    let jzz = 0;
    let jxz = 0;
    let steepness = 0;
    let crestVx = 0;
    let crestVz = 0;
    const d = depth > 0 ? depth : 0;
    for (let i = 0; i < this.n; i++) {
      const k = this.k[i]!;
      const a = this.amp[i]!;
      const ux = this.dx[i]!;
      const uz = this.dz[i]!;
      const th = k * (ux * x + uz * z) - this.omega[i]! * time + this.phase[i]!;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const att = d > 0 ? Math.exp(-k * d) : 1;
      eta += a * c;
      pd += a * c * att;
      gx -= a * k * s * ux;
      gz -= a * k * s * uz;
      const h = a * this.omega[i]! * att;
      vx += h * c * ux;
      vz += h * c * uz;
      vy += h * s;
      const kac = k * a * c;
      jxx += kac * ux * ux;
      jzz += kac * uz * uz;
      jxz += kac * ux * uz;
      // The seas' steepness and crest velocity, as on the FFT ocean (WaterSample.steepness).
      if (k <= SEAS_K_MAX) {
        steepness += kac;
        crestVx += a * this.omega[i]! * c * ux;
        crestVz += a * this.omega[i]! * c * uz;
      }
    }
    const inv = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
    out.height = eta;
    out.normalX = -gx * inv;
    out.normalY = inv;
    out.normalZ = -gz * inv;
    out.velocityX = vx;
    out.velocityY = vy;
    out.velocityZ = vz;
    out.jacobian = (1 - jxx) * (1 - jzz) - jxz * jxz;
    out.steepness = steepness;
    out.crestVelocityX = crestVx;
    out.crestVelocityZ = crestVz;
    out.pressureHead = pd;
    out.lagrangianX = x;
    out.lagrangianZ = z;
    out.iterations = 0;
    out.converged = true;
    return out;
  }

  private readonly scratch = {
    height: 0,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    jacobian: 1,
    pressureHead: 0,
    steepness: 0,
    crestVelocityX: 0,
    crestVelocityZ: 0,
    lagrangianX: 0,
    lagrangianZ: 0,
    iterations: 0,
    converged: true,
  };

  sample(x: number, y: number, z: number, time: number, out: WaterSample): WaterSample {
    const s = this.query(x, z, time, this.scratch, 0);
    const d = s.height - y;
    if (d > 0) this.query(x, z, time, this.scratch, d);
    out.height = s.height;
    out.normalX = s.normalX;
    out.normalY = s.normalY;
    out.normalZ = s.normalZ;
    out.velocityX = s.velocityX;
    out.velocityY = s.velocityY;
    out.velocityZ = s.velocityZ;
    out.jacobian = s.jacobian;
    out.steepness = s.steepness;
    out.crestVelocityX = s.crestVelocityX;
    out.crestVelocityZ = s.crestVelocityZ;
    out.pressureHead = d > 0 ? -y + s.pressureHead : d;
    return out;
  }
}
