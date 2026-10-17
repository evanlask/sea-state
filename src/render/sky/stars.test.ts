import { describe, expect, it } from 'vite-plus/test';

import {
  buildStarGrid,
  bvToTemperature,
  cubeCell,
  DEFAULT_STAR_GRID,
  decodeStar,
  equatorialToWorld,
  generateProceduralStars,
  STAR_ENTRY_FLOATS,
  STAR_RECORD_FLOATS,
  starIlluminance,
  temperatureToLinearRgb,
} from './stars';

const DEG = Math.PI / 180;

const apply = (m: number[], v: [number, number, number]): number[] =>
  [0, 1, 2].map((r) => (m[r * 3] ?? 0) * v[0] + (m[r * 3 + 1] ?? 0) * v[1] + (m[r * 3 + 2] ?? 0) * v[2]);

describe('star records', () => {
  it('decodes RA/Dec to a unit equatorial vector', () => {
    const records = new Float32Array([Math.PI / 2, 30 * DEG, 1, 0.6]);
    const star = decodeStar(records, 0);
    expect(star).not.toBeNull();
    if (!star) return;
    expect(star.x).toBeCloseTo(0, 6);
    expect(star.y).toBeCloseTo(Math.cos(30 * DEG), 6);
    expect(star.z).toBeCloseTo(0.5, 6);
    expect(star.illuminance).toBeCloseTo(starIlluminance(1), 12);
  });

  it('rejects malformed records', () => {
    expect(decodeStar(new Float32Array([0, Number.NaN, 1, 0]), 0)).toBeNull();
    expect(decodeStar(new Float32Array([0, 0]), 0)).toBeNull();
  });

  it('scales illuminance by 2.512 per magnitude', () => {
    expect(starIlluminance(0) / starIlluminance(1)).toBeCloseTo(10 ** 0.4, 6);
    expect(starIlluminance(0)).toBeGreaterThan(1.5e-6);
    expect(starIlluminance(0)).toBeLessThan(3e-6);
  });

  it('colours stars by B−V: blue-white to orange', () => {
    expect(bvToTemperature(0.65)).toBeGreaterThan(5500);
    expect(bvToTemperature(0.65)).toBeLessThan(6100);
    const hot = temperatureToLinearRgb(bvToTemperature(-0.2));
    const cool = temperatureToLinearRgb(bvToTemperature(1.5));
    expect(hot[2]).toBeGreaterThan(hot[0]);
    expect(cool[0]).toBeGreaterThan(cool[2]);
    const lum = 0.2126 * cool[0] + 0.7152 * cool[1] + 0.0722 * cool[2];
    expect(lum).toBeCloseTo(1, 6);
  });
});

describe('procedural star field', () => {
  it('is deterministic per seed', () => {
    expect(generateProceduralStars(500, 7)).toEqual(generateProceduralStars(500, 7));
    expect(generateProceduralStars(500, 7)).not.toEqual(generateProceduralStars(500, 8));
  });

  it('follows a naked-eye magnitude distribution', () => {
    const records = generateProceduralStars(6000, 1);
    let bright = 0;
    let faint = 0;
    for (let i = 0; i < 6000; i++) {
      const magnitude = records[i * STAR_RECORD_FLOATS + 2] ?? 99;
      if (magnitude < 2) bright++;
      if (magnitude > 5) faint++;
    }
    expect(bright).toBeGreaterThan(10);
    expect(bright).toBeLessThan(150);
    expect(faint).toBeGreaterThan(3000);
  });
});

describe('star grid', () => {
  it('maps directions to cube cells within range', () => {
    const g = 16;
    const cells = new Set<number>();
    for (const v of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ] as const) {
      const cell = cubeCell(v[0], v[1], v[2], g);
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThan(6 * g * g);
      cells.add(Math.floor(cell / (g * g)));
    }
    expect(cells.size).toBe(6);
  });

  it('lists every star in the cell containing it', () => {
    const records = generateProceduralStars(2000, 3);
    const grid = buildStarGrid(records);
    expect(grid.starCount).toBe(2000);
    expect(grid.dropped).toBe(0);
    const g = DEFAULT_STAR_GRID.gridSize;
    for (let i = 0; i < 2000; i += 37) {
      const star = decodeStar(records, i);
      if (!star) continue;
      const cell = cubeCell(star.x, star.y, star.z, g);
      const start = grid.cells[cell * 2] ?? 0;
      const count = grid.cells[cell * 2 + 1] ?? 0;
      let found = false;
      for (let k = start; k < start + count; k++) {
        const o = k * STAR_ENTRY_FLOATS;
        if (
          Math.abs((grid.entries[o] ?? 9) - star.x) < 1e-6 &&
          Math.abs((grid.entries[o + 2] ?? 9) - star.z) < 1e-6
        ) {
          found = true;
        }
      }
      expect(found).toBe(true);
    }
  });
});

describe('equatorial → world rotation', () => {
  it('puts the celestial pole at altitude = latitude, due north', () => {
    const latitude = 40 * DEG;
    const pole = apply(equatorialToWorld(latitude, 1.234), [0, 0, 1]);
    expect(pole[0]).toBeCloseTo(0, 9); // east
    expect(pole[1]).toBeCloseTo(Math.sin(latitude), 9); // up
    expect(pole[2]).toBeCloseTo(-Math.cos(latitude), 9); // −Z is north
  });

  it('puts the meridian equator point due south and RA + 6h in the east', () => {
    const latitude = 40 * DEG;
    const lst = 0.7;
    const m = equatorialToWorld(latitude, lst);
    const meridian = apply(m, [Math.cos(lst), Math.sin(lst), 0]);
    expect(meridian[0]).toBeCloseTo(0, 9);
    expect(meridian[1]).toBeCloseTo(Math.cos(latitude), 9);
    expect(meridian[2]).toBeGreaterThan(0); // south
    const east = apply(m, [Math.cos(lst + Math.PI / 2), Math.sin(lst + Math.PI / 2), 0]);
    expect(east[0]).toBeCloseTo(1, 9);
  });
});
