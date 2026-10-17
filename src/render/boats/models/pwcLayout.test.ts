import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import {
  BAR,
  GRIP,
  gripAt,
  gripAxis,
  SEAT_BASE,
  seatSection,
  seatSurfaceY,
  SEAT_Z0,
  SEAT_Z1,
} from './pwcLayout';

describe('jet ski layout', () => {
  it('tops the driver’s seat at 0.62 m and rounds it off at the sides', () => {
    expect(seatSurfaceY(0, 0)).toBeCloseTo(0.62, 9);
    expect(seatSurfaceY(0.2, 0)).toBeLessThan(0.62);
    expect(seatSurfaceY(0.2, 0)).toBeGreaterThan(SEAT_BASE);
    expect(seatSurfaceY(0.3, 0)).toBe(-Infinity);
    expect(seatSurfaceY(0, SEAT_Z0 - 0.01)).toBe(-Infinity);
    expect(seatSurfaceY(0, SEAT_Z1 + 0.01)).toBe(-Infinity);
    // The passenger steps are higher.
    expect(seatSurfaceY(0, 0.5)).toBeGreaterThan(seatSurfaceY(0, 0));
    expect(seatSection(0).hw).toBeCloseTo(0.27, 9);
  });

  it('puts the grips on the raked bar column, mirrored', () => {
    const right = gripAt(1, 0, new Vector3());
    const left = gripAt(-1, 0, new Vector3());
    expect(right.x).toBeCloseTo(GRIP[0], 9);
    expect(left.x).toBeCloseTo(-GRIP[0], 9);
    expect(right.y).toBeCloseTo(left.y, 12);
    expect(right.y).toBeCloseTo(BAR.y + GRIP[1] * Math.cos(BAR.tilt) - GRIP[2] * Math.sin(BAR.tilt), 9);
    expect(right.z).toBeCloseTo(BAR.z + GRIP[1] * Math.sin(BAR.tilt) + GRIP[2] * Math.cos(BAR.tilt), 9);
  });

  it('swings the grips with the steer angle', () => {
    // A negative yaw (turning to starboard) pulls the right grip back and pushes the left forward.
    const steer = -0.4;
    expect(gripAt(1, steer, new Vector3()).z).toBeGreaterThan(gripAt(1, 0, new Vector3()).z);
    expect(gripAt(-1, steer, new Vector3()).z).toBeLessThan(gripAt(-1, 0, new Vector3()).z);
    for (const side of [-1, 1]) {
      const axis = gripAxis(side, steer, new Vector3());
      expect(axis.length()).toBeCloseTo(1, 12);
      expect(Math.sign(axis.x)).toBe(side);
    }
  });
});
