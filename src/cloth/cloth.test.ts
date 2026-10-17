import { describe, expect, it } from 'vite-plus/test';

import { CC115_RIG, MAIN_HEADBOARD, mainRoach } from '../sim/sail/rig';
import { Cloth } from './Cloth';
import { SailCloth, type SailFrame } from './SailCloth';

const DEG = Math.PI / 180;

function mainFrame(boomDeg: number, awaDeg: number, speed: number, fill: number, force: number): SailFrame {
  const b = boomDeg * DEG;
  const a = awaDeg * DEG;
  return {
    tack: { x: 0, y: 1.95, z: -1.1 },
    clew: { x: Math.sin(b) * 5, y: 1.95, z: -1.1 + Math.cos(b) * 5 },
    head: { x: 0, y: 16.25, z: -1.1 },
    headLeech: { x: Math.sin(b) * MAIN_HEADBOARD, y: 16.25, z: -1.1 + Math.cos(b) * MAIN_HEADBOARD },
    roach: mainRoach(CC115_RIG),
    air: { x: -Math.sin(a) * speed, y: 0, z: Math.cos(a) * speed },
    fill,
    force,
    gravity: { x: 0, y: -9.81, z: 0 },
  };
}

const finite = (a: Float64Array): boolean => a.every((x) => Number.isFinite(x));

// Mean displacement of the free particles from the luff–clew plane, toward +x (port is −x).
function meanOffset(sail: SailCloth): number {
  const p = sail.positions;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < sail.cloth.count; i++) {
    if (sail.cloth.pinned[i]) continue;
    sum += p[3 * i]!;
    n++;
  }
  return sum / n;
}

describe('XPBD cloth', () => {
  it('a hanging sheet converges: edges stay at rest length and the pins hold', () => {
    const cols = 12;
    const rows = 12;
    const cloth = new Cloth({ cols, rows, particleMass: 0.02, damping: 2 });
    const rest = new Float64Array(3 * cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let q = 0; q < cols; q++) {
        const j = 3 * (r * cols + q);
        rest[j] = q * 0.1;
        rest[j + 1] = 2 - r * 0.1;
        rest[j + 2] = 0;
      }
    }
    cloth.setRestShape(rest);
    for (let q = 0; q < cols; q++) cloth.pin(q, q * 0.1, 2, 0);
    cloth.resetToRest();
    // Swing it sideways first so it has to settle.
    for (let i = cols; i < cloth.count; i++) cloth.vel[3 * i + 2] = 1;
    for (let f = 0; f < 240; f++) cloth.step(1 / 60, 16);
    expect(finite(cloth.pos)).toBe(true);
    expect(cloth.maxStrain()).toBeLessThan(0.01);
    for (let q = 0; q < cols; q++) {
      expect(cloth.pos[3 * q]).toBeCloseTo(q * 0.1, 12);
      expect(cloth.pos[3 * q + 1]).toBeCloseTo(2, 12);
    }
    // Hanging straight down, nearly at rest.
    let maxV = 0;
    for (let i = 0; i < cloth.vel.length; i++) maxV = Math.max(maxV, Math.abs(cloth.vel[i]!));
    expect(maxV).toBeLessThan(0.05);
    expect(cloth.pos[3 * (cloth.count - 1) + 1]).toBeCloseTo(2 - 1.1, 1);
  });

  it('moving pins drag the cloth and land exactly on their targets', () => {
    const sail = new SailCloth('main', 'medium');
    for (let f = 0; f < 120; f++) {
      const frame = mainFrame(-5 - f * 0.5, 40, 6, 1, 600);
      sail.update(1 / 60, frame, f / 60);
      const p = sail.positions;
      const c = sail.cols - 1;
      expect(p[3 * c]).toBeCloseTo(frame.clew.x, 9);
      expect(p[3 * c + 2]).toBeCloseTo(frame.clew.z, 9);
      const top = 3 * (sail.rows - 1) * sail.cols;
      expect(p[top + 1]).toBeCloseTo(frame.head.y, 9);
    }
    expect(sail.cloth.maxStrain()).toBeLessThan(0.06);
  });
});

describe('sail cloth', () => {
  it('a drawing sail sets a smooth airfoil to leeward carrying the model load', () => {
    const sail = new SailCloth('main', 'high');
    // Starboard tack, close-hauled: the main bellies out to port (−x).
    for (let f = 0; f < 180; f++) sail.update(1 / 60, mainFrame(-12, 28, 8, 1, 2000), f / 60);
    expect(meanOffset(sail)).toBeLessThan(-0.6);
    expect(Math.abs(sail.normalLoad / 2000 - 1)).toBeLessThan(0.2);
    // Smooth: barely moving once set.
    let maxV = 0;
    for (let i = 0; i < sail.cloth.vel.length; i++) maxV = Math.max(maxV, Math.abs(sail.cloth.vel[i]!));
    expect(maxV).toBeLessThan(1);
  });

  it('a luffing sail flogs: it keeps moving and loses its belly', () => {
    const filled = new SailCloth('jib', 'medium');
    const flogging = new SailCloth('jib', 'medium');
    const frame = (fill: number): SailFrame => ({
      tack: { x: 0, y: 1.2, z: -5.6 },
      clew: { x: -0.9, y: 1.6, z: -0.4 },
      head: { x: 0, y: 15.8, z: -1.2 },
      headLeech: { x: 0, y: 15.8, z: -1.2 },
      air: { x: -3, y: 0, z: 7 },
      fill,
      force: fill * 1500 + 80,
      gravity: { x: 0, y: -9.81, z: 0 },
    });
    let motionFilled = 0;
    let motionFlog = 0;
    for (let f = 0; f < 240; f++) {
      filled.update(1 / 60, frame(1), f / 60);
      flogging.update(1 / 60, frame(0), f / 60);
      if (f > 120) {
        for (let i = 0; i < filled.cloth.vel.length; i++) {
          motionFilled += Math.abs(filled.cloth.vel[i]!);
          motionFlog += Math.abs(flogging.cloth.vel[i]!);
        }
      }
    }
    expect(motionFlog).toBeGreaterThan(5 * motionFilled);
    expect(meanOffset(filled)).toBeLessThan(meanOffset(flogging) - 0.15);
    expect(flogging.luffing).toBe(1);
  });

  it('stays finite and pinned through 10k substeps of 70 m/s hurricane wind', () => {
    const sail = new SailCloth('main', 'ultra');
    let substeps = 0;
    let f = 0;
    while (substeps < 10_000) {
      // Gusting, veering and flogging hard while the boom thrashes.
      const awa = 40 + 60 * Math.sin(f * 0.07);
      const frame = mainFrame(-30 + 25 * Math.sin(f * 0.11), awa, 70, f % 90 < 45 ? 1 : 0.1, 250_000);
      sail.update(1 / 60, frame, f / 60);
      substeps += Math.max(4, Math.ceil(1000 / 60));
      f++;
      expect(finite(sail.positions)).toBe(true);
      const c = 3 * (sail.cols - 1);
      expect(sail.positions[c]).toBeCloseTo(frame.clew.x, 9);
    }
    expect(sail.cloth.resets).toBe(0);
    expect(finite(sail.cloth.vel)).toBe(true);
    expect(sail.cloth.maxStrain()).toBeLessThan(0.25);
  });
});
