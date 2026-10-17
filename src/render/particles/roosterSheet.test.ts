import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vite-plus/test';

import { RoosterSheets, SHEET_LIFE, sheetTop } from './roosterSheet';
import { FxLighting } from './shading';

const DT = 1 / 60;

// Runs a boat north at `speed`, its propeller throwing a tail `height` m tall, for `seconds`.
function run(sheets: RoosterSheets, speed: number, height: number, seconds: number, from = 0): number {
  let z = from;
  for (let t = 0; t < seconds; t += DT) {
    z -= speed * DT;
    sheets.push('hydro', { x: 0, y: 0, z }, { x: 0, y: 0, z: -1 }, height, speed);
    sheets.update(DT);
  }
  return z;
}

const positionsOf = (sheets: RoosterSheets): Float32Array => {
  const mesh = sheets.meshes()[0] as unknown as {
    geometry: { getAttribute(n: string): { array: Float32Array } };
  };
  return mesh.geometry.getAttribute('position').array;
};

describe('rooster tail sheet', () => {
  it('climbs fast behind the transom, hangs, then rains back down', () => {
    expect(sheetTop(17, 0)).toBe(0);
    expect(sheetTop(17, 0.3)).toBeGreaterThan(0.5 * 17); // ~25 m behind at 200 mph
    expect(sheetTop(17, 1)).toBeGreaterThan(0.95 * 17);
    expect(sheetTop(17, 2.5)).toBeLessThan(sheetTop(17, 1));
    expect(sheetTop(17, SHEET_LIFE - 0.2)).toBe(0);
    expect(sheetTop(0, 1)).toBe(0);
  });

  it('stands as a wall hundreds of metres long behind a boat at speed', () => {
    const sheets = new RoosterSheets(new FxLighting());
    const z = run(sheets, 80, 17, 4);
    expect(sheets.count).toBe(1);
    expect(sheets.meshes()[0]!.visible).toBe(true);
    const p = positionsOf(sheets);
    let top = 0;
    let far = z;
    for (let i = 0; i < p.length; i += 3) {
      top = Math.max(top, p[i + 1]!);
      if (p[i + 1]! > 5) far = Math.max(far, p[i + 2]!);
    }
    expect(top).toBeGreaterThan(16);
    expect(top).toBeLessThan(17.5);
    expect(far - z).toBeGreaterThan(120); // more than 5 m tall 120 m back
    // The head is at the propeller, with no height yet.
    expect(p[2]).toBeCloseTo(z, 0);
    expect(p[4]! - p[1]!).toBeLessThan(1.2);
  });

  it('fades out and goes once the propeller stops throwing water', () => {
    const sheets = new RoosterSheets(new FxLighting());
    const z = run(sheets, 80, 17, 2);
    run(sheets, 5, 0, SHEET_LIFE + 0.5, z);
    expect(sheets.meshes()[0]?.visible ?? false).toBe(false);
    run(sheets, 5, 0, SHEET_LIFE + 0.5, z);
    expect(sheets.count).toBe(0);
    // Nothing for a boat that never throws one.
    sheets.push('idle', new Vector3(), { x: 0, y: 0, z: -1 }, 0, 0);
    expect(sheets.count).toBe(0);
    sheets.dispose();
  });
});
