import { describe, expect, it } from 'vite-plus/test';

import { DEG } from '../../sim/core/conventions';
import { knotsToMs } from '../../sim/core/units';
import type { SailingState } from './model';
import {
  idealSheetAngles,
  isGybeZone,
  isNoGo,
  manoeuvreHint,
  pointOfSail,
  reefAdvice,
  tackOf,
  trimAdvice,
} from './sailing';

describe('point of sail', () => {
  it('classifies by true wind angle on either tack', () => {
    expect(pointOfSail(20 * DEG)).toBe('in-irons');
    expect(pointOfSail(-45 * DEG)).toBe('close-hauled');
    expect(pointOfSail(65 * DEG)).toBe('close-reach');
    expect(pointOfSail(-90 * DEG)).toBe('beam-reach');
    expect(pointOfSail(135 * DEG)).toBe('broad-reach');
    expect(pointOfSail(175 * DEG)).toBe('run');
    expect(pointOfSail(Math.PI)).toBe('run');
  });

  it('wraps angles outside (-π, π]', () => {
    expect(pointOfSail((360 + 45) * DEG)).toBe('close-hauled');
    expect(pointOfSail(-270 * DEG)).toBe('beam-reach');
  });
});

describe('zones and tacks', () => {
  it('flags the no-go zone within ±40° of the wind', () => {
    expect(isNoGo(39 * DEG)).toBe(true);
    expect(isNoGo(-39 * DEG)).toBe(true);
    expect(isNoGo(41 * DEG)).toBe(false);
  });

  it('flags the gybe zone within 15° of dead downwind', () => {
    expect(isGybeZone(170 * DEG)).toBe(true);
    expect(isGybeZone(-172 * DEG)).toBe(true);
    expect(isGybeZone(160 * DEG)).toBe(false);
  });

  it('names the tack from the side the wind comes over', () => {
    expect(tackOf(50 * DEG)).toBe('starboard');
    expect(tackOf(-50 * DEG)).toBe('port');
  });
});

describe('ideal sheeting angle', () => {
  it('sheets to leeward, opposite the apparent wind', () => {
    const stbd = idealSheetAngles(30 * DEG);
    expect(stbd.boom).toBeLessThan(0);
    expect(stbd.jib).toBeLessThan(0);
    const port = idealSheetAngles(-30 * DEG);
    expect(port.boom).toBeCloseTo(-stbd.boom);
  });

  it('eases out as the wind goes aft and stays within the rig limits', () => {
    const angles = [25, 45, 90, 135, 180].map((a) => Math.abs(idealSheetAngles(a * DEG).boom) / DEG);
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThanOrEqual(angles[i - 1]);
    expect(angles[0]).toBeGreaterThanOrEqual(3);
    expect(angles[angles.length - 1]).toBeLessThanOrEqual(85);
    expect(Math.abs(idealSheetAngles(25 * DEG).jib) / DEG).toBeCloseTo(8);
  });
});

describe('reef advice', () => {
  it('recommends reefs at 18, 24 and 30 knots of true wind', () => {
    expect(reefAdvice(knotsToMs(17), 0, 0).recommended).toBe(0);
    expect(reefAdvice(knotsToMs(18), 0, 0).recommended).toBe(1);
    expect(reefAdvice(knotsToMs(25), 0, 0).recommended).toBe(2);
    expect(reefAdvice(knotsToMs(35), 0, 0).recommended).toBe(3);
  });

  it('is overpowered with too few reefs or too much heel', () => {
    expect(reefAdvice(knotsToMs(20), 10 * DEG, 0).overpowered).toBe(true);
    expect(reefAdvice(knotsToMs(20), 10 * DEG, 1).overpowered).toBe(false);
    expect(reefAdvice(knotsToMs(10), 28 * DEG, 0).overpowered).toBe(true);
  });

  it('suggests shaking out only with a margin below the threshold', () => {
    expect(reefAdvice(knotsToMs(17), 10 * DEG, 1).shakeOut).toBe(false);
    expect(reefAdvice(knotsToMs(14), 10 * DEG, 1).shakeOut).toBe(true);
    expect(reefAdvice(knotsToMs(14), 27 * DEG, 1).shakeOut).toBe(false);
  });
});

describe('trim and manoeuvre hints', () => {
  it('trims a luffing sail and eases a stalled one', () => {
    expect(trimAdvice('luffing')).toBe('trim');
    expect(trimAdvice('stalled')).toBe('ease');
    expect(trimAdvice('optimal')).toBe('hold');
  });

  const base = { twa: 90 * DEG, inIrons: false, gybeDanger: false } as SailingState;

  it('prioritises in irons, then gybe danger, then the point of sail', () => {
    expect(manoeuvreHint({ ...base, inIrons: true, gybeDanger: true })?.tone).toBe('danger');
    expect(manoeuvreHint({ ...base, gybeDanger: true })?.text).toMatch(/Gybe danger/);
    expect(manoeuvreHint({ ...base, twa: 45 * DEG })?.text).toMatch(/Tack/);
    expect(manoeuvreHint({ ...base, twa: 170 * DEG })?.text).toMatch(/Gybe:/);
    expect(manoeuvreHint(base)).toBeNull();
  });
});
