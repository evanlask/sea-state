import { describe, expect, it } from 'vite-plus/test';

import { collisionParams } from '../audio/curves';
import { capsizeCard, CollisionAlert, WinchTracker } from './feedback';

describe('winch clicks', () => {
  const tel = (main: number, jib = 5, reef = 0, furl = 0) => ({
    'sail.mainSheetLength': main,
    'sail.jibSheetLength': jib,
    'sail.reefProgress': reef,
    'sail.jibFurl': furl,
  });

  it('clicks while a sheet is ground in, not while it is eased', () => {
    const w = new WinchTracker();
    let clicks = 0;
    w.update(tel(10), 0);
    for (let i = 1; i <= 60; i++) clicks += w.update(tel(10 - i * 0.05), 1 / 60); // 3 m in over 1 s
    expect(clicks).toBeGreaterThanOrEqual(4);
    expect(clicks).toBeLessThanOrEqual(10);
    let eased = 0;
    for (let i = 1; i <= 60; i++) eased += w.update(tel(7 + i * 0.05), 1 / 60);
    expect(eased).toBe(0);
  });

  it('clicks for a reef tucked in and the genoa furled', () => {
    const w = new WinchTracker();
    w.update(tel(10), 0);
    let clicks = 0;
    for (let i = 1; i <= 120; i++) clicks += w.update(tel(10, 5, i / 120, i / 240), 1 / 60);
    expect(clicks).toBeGreaterThan(3);
  });
});

describe('collision alert', () => {
  it('names the other boat, reddens on a hard hit and clears after a few seconds', () => {
    const alert = new CollisionAlert();
    expect(alert.update(0.1)).toBeNull();
    alert.hit('MS Celestine', 4.2);
    const shown = alert.update(0.1)!;
    expect(shown.text).toMatch(/^Hit MS Celestine at 8(\.\d)? kn$/);
    expect(shown.severity).toBe('danger');
    expect(alert.update(5)).toBeNull();
  });

  it('gives the impact speed in the HUD speed unit', () => {
    const alert = new CollisionAlert();
    alert.hit('Aurora', 2, 'kmh');
    expect(alert.update(0.1)!.text).toMatch(/km\/h$/);
  });
});

describe('capsize card', () => {
  it('summarises the voyage with the recover key', () => {
    const card = capsizeCard({ survived: 125, maxRoll: Math.PI / 2, slams: 7 });
    expect(card.title).toBe('Capsized');
    expect(card.rows).toEqual([
      { label: 'Time afloat', value: '2:05' },
      { label: 'Max roll', value: '90°' },
      { label: 'Slams', value: '7' },
    ]);
    expect(card.hint).toContain('Backspace');
    const sunk = capsizeCard({ survived: 1, maxRoll: 0, slams: 0 }, { sunk: true });
    expect(sunk.title).toBe('Sunk');
    const best = capsizeCard({ survived: 1, maxRoll: 0, slams: 0 }, { survival: { isBest: true } });
    expect(best.rows.at(-1)?.value).toBe('New best!');
  });
});

describe('collision sound', () => {
  it('is silent for a touch, louder for a harder hit, and deeper for a big hull', () => {
    const out = { gain: 0, rate: 1, cutoff: 0, groan: 0 };
    expect(collisionParams(0.1, 0, out).gain).toBe(0);
    const soft = collisionParams(1, 0, { ...out }).gain;
    expect(collisionParams(4, 0, out).gain).toBeGreaterThan(soft);
    expect(collisionParams(2, 1, { ...out }).rate).toBeLessThan(collisionParams(2, 0, { ...out }).rate);
  });
});
