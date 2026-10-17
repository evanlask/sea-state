import { BufferAttribute, CylinderGeometry } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { buildVestShell, SUIT, suitRegion, VEST, vestDistance, vestThickness } from './outfit';

// Points on the bind pose (standing, facing +Z, arms out along ±X).
describe('wetsuit regions', () => {
  it('leaves the head, neck and hands bare and covers the rest', () => {
    expect(suitRegion(0, 1.7, 0.05).skin).toBe(true); // face
    expect(suitRegion(0, 1.56, -0.05).skin).toBe(true); // nape, above the collar
    expect(suitRegion(0.8, 1.45, -0.05).skin).toBe(true); // hand
    expect(suitRegion(-0.8, 1.45, -0.05).skin).toBe(true);
    expect(suitRegion(0.6, 1.45, -0.05).skin).toBe(false); // forearm
    expect(suitRegion(0, 1.3, 0.12).skin).toBe(false); // chest
    expect(suitRegion(0.1, 0.6, 0.03).skin).toBe(false); // knee
  });

  it('dips the collar at the throat', () => {
    expect(suitRegion(0, (SUIT.collarFront + SUIT.collarBack) / 2, 0.08).skin).toBe(true);
    expect(suitRegion(0, (SUIT.collarFront + SUIT.collarBack) / 2, -0.08).skin).toBe(false);
  });

  it('puts booties on the feet with a sole', () => {
    expect(suitRegion(0.11, 0.08, 0.05).bootie).toBe(true);
    expect(suitRegion(0.11, 0.01, 0.05).sole).toBe(true);
    expect(suitRegion(0.11, 0.3, -0.08).bootie).toBe(false);
  });

  it('runs stripes along the top of the sleeves and down the outside of the legs', () => {
    expect(suitRegion(0.45, SUIT.arm.y + 0.05, SUIT.arm.z).stripe).toBe(true); // sleeve top
    expect(suitRegion(0.45, SUIT.arm.y - 0.05, SUIT.arm.z).stripe).toBe(false); // underarm
    expect(suitRegion(SUIT.leg.x + 0.08, 0.75, -0.04).stripe).toBe(true); // outer thigh
    expect(suitRegion(-(SUIT.leg.x + 0.08), 0.75, -0.04).stripe).toBe(true);
    expect(suitRegion(SUIT.leg.x - 0.08, 0.75, -0.04).stripe).toBe(false); // inner thigh
    expect(suitRegion(SUIT.leg.x + 0.07, 0.08, -0.09).stripe).toBe(false); // not on the booties
  });

  it('pads the front of the knees', () => {
    expect(suitRegion(SUIT.leg.x, 0.55, 0.05).knee).toBe(true);
    expect(suitRegion(SUIT.leg.x, 0.55, -0.2).knee).toBe(false);
  });
});

describe('life vest outline', () => {
  it('covers the chest and back between the hem and the shoulders', () => {
    expect(vestDistance(0, 1.3, 0.15)).toBeGreaterThan(0.05);
    expect(vestDistance(0, 1.3, -0.17)).toBeGreaterThan(0.05);
    expect(vestDistance(0.12, 1.52, 0)).toBeGreaterThan(0); // over the shoulder
  });

  it('leaves openings for the neck and arms and stops above the hips', () => {
    expect(vestDistance(0, 1.55, 0.05)).toBeLessThan(0); // neck
    expect(vestDistance(0.3, 1.43, -0.07)).toBeLessThan(0); // upper arm
    expect(vestDistance(0.1, VEST.hem - 0.02, 0.1)).toBeLessThan(0);
    expect(vestDistance(0, 1.7, 0)).toBeLessThan(0); // head
  });

  it('is symmetric', () => {
    for (const [x, y, z] of [
      [0.1, 1.2, 0.1],
      [0.18, 1.35, -0.1],
      [0.05, 1.5, 0.02],
    ] as const)
      expect(vestDistance(-x, y, z)).toBeCloseTo(vestDistance(x, y, z), 12);
  });

  it('is thickest on the chest and rounds down to the edge', () => {
    expect(vestThickness(1, 0.1)).toBeGreaterThan(vestThickness(-1, 0.1));
    expect(vestThickness(-1, 0.1)).toBeGreaterThan(vestThickness(0, 0.1));
    expect(vestThickness(1, 0)).toBeCloseTo(VEST.thickness.edge, 12);
    expect(vestThickness(1, -0.01)).toBeCloseTo(VEST.thickness.edge, 12);
  });
});

describe('life vest shell', () => {
  // A stand-in torso: an open cylinder round the spine, skinned to two joints.
  function torso() {
    const g = new CylinderGeometry(0.15, 0.15, 0.7, 32, 14, true).translate(0, 1.25, 0);
    const n = g.getAttribute('position').count;
    const index = new Uint16Array(n * 4);
    const weight = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      index.set([3, 4, 0, 0], i * 4);
      const t = (g.getAttribute('position').getY(i) - 0.9) / 0.7;
      weight.set([1 - t, t, 0, 0], i * 4);
    }
    g.setAttribute('skinIndex', new BufferAttribute(index, 4));
    g.setAttribute('skinWeight', new BufferAttribute(weight, 4));
    return g;
  }

  it('wraps the vest region at least the edge thickness off the body, skinned like it', () => {
    const shell = buildVestShell(torso());
    expect(shell).not.toBeNull();
    const p = shell!.getAttribute('position');
    const w = shell!.getAttribute('skinWeight');
    const j = shell!.getAttribute('skinIndex');
    let minY = Infinity;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot(p.getX(i), p.getZ(i));
      expect(r).toBeGreaterThan(0.15 + VEST.thickness.edge - 1e-4);
      expect(r).toBeLessThan(0.15 + VEST.thickness.base + VEST.thickness.front + 0.01);
      expect(j.getX(i)).toBe(3);
      expect(j.getY(i)).toBe(4);
      expect(w.getX(i) + w.getY(i)).toBeCloseTo(1, 6);
      minY = Math.min(minY, p.getY(i));
    }
    // Only the band round the vest (plus the margin trimmed per fragment).
    expect(minY).toBeGreaterThan(VEST.hem - 0.08);
    // Welded: the cylinder's UV seam doesn't split the shell.
    expect(shell!.getAttribute('normal').count).toBe(p.count);
  });

  it('needs skin weights', () => {
    expect(buildVestShell(new CylinderGeometry(0.15, 0.15, 0.7))).toBeNull();
  });
});
