import { describe, expect, it, vi } from 'vite-plus/test';

import {
  ButtonTracker,
  canRumble,
  type GamepadLike,
  GamepadReader,
  PAD_BUTTONS,
  radialDeadZone,
  Rumbler,
  triggerValue,
} from './gamepad';

function fakePad(overrides: Partial<GamepadLike> = {}, pressed: number[] = []): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: pressed.includes(i) ? 1 : 0,
  }));
  return {
    id: 'Xbox Wireless Controller',
    index: 0,
    connected: true,
    mapping: 'standard',
    buttons,
    axes: [0, 0, 0, 0],
    ...overrides,
  };
}

describe('radialDeadZone', () => {
  it('zeros inside the dead zone', () => {
    expect(radialDeadZone(0.1, 0.05, 0.15)).toEqual({ x: 0, y: 0 });
  });

  it('rescales from the dead-zone edge and keeps direction', () => {
    const s = radialDeadZone(0.575, 0, 0.15, 1);
    expect(s.x).toBeCloseTo(0.5);
    expect(s.y).toBe(0);
    const d = radialDeadZone(0.5, 0.5, 0.15, 1);
    expect(d.x).toBeCloseTo(d.y);
    expect(Math.hypot(d.x, d.y)).toBeCloseTo((Math.SQRT1_2 - 0.15) / 0.85);
  });

  it('saturates at the outer zone', () => {
    const s = radialDeadZone(0, -0.97, 0.15, 0.95);
    expect(s.y).toBe(-1);
  });
});

describe('triggerValue', () => {
  it('ignores rest noise and rescales', () => {
    expect(triggerValue(0.05, 0.08)).toBe(0);
    expect(triggerValue(0.54, 0.08)).toBeCloseTo(0.5);
    expect(triggerValue(1, 0.08)).toBe(1);
  });
});

describe('ButtonTracker', () => {
  it('reports press and release edges once', () => {
    const b = new ButtonTracker();
    b.update(true, 0.016, 0.8);
    expect(b.pressed).toBe(true);
    b.update(true, 0.016, 0.8);
    expect(b.pressed).toBe(false);
    expect(b.down).toBe(true);
    b.update(false, 0.016, 0.8);
    expect(b.released).toBe(true);
    expect(b.tapped).toBe(true);
    b.update(false, 0.016, 0.8);
    expect(b.released).toBe(false);
  });

  it('fires hold once after the hold time and suppresses the tap', () => {
    const b = new ButtonTracker();
    let holds = 0;
    b.update(true, 0.1, 0.8);
    for (let i = 0; i < 20; i++) {
      b.update(true, 0.1, 0.8);
      if (b.held) holds++;
    }
    expect(holds).toBe(1);
    b.update(false, 0.1, 0.8);
    expect(b.released).toBe(true);
    expect(b.tapped).toBe(false);
  });
});

describe('GamepadReader', () => {
  it('reads nothing when no pad is exposed yet', () => {
    const reader = new GamepadReader();
    const frame = reader.update([null, null], 0.016);
    expect(frame.connected).toBe(false);
    expect(frame.active).toBe(false);
  });

  it('reports connect and disconnect', () => {
    const reader = new GamepadReader();
    expect(reader.diffConnections([])).toEqual([]);
    expect(reader.diffConnections([fakePad()])).toEqual([
      { type: 'connected', id: 'Xbox Wireless Controller', index: 0 },
    ]);
    expect(reader.diffConnections([fakePad()])).toEqual([]);
    expect(reader.diffConnections([null])).toEqual([
      { type: 'disconnected', id: 'Xbox Wireless Controller', index: 0 },
    ]);
  });

  it('applies dead zones, trigger thresholds and digital trigger presses', () => {
    const reader = new GamepadReader();
    const pad = fakePad({ axes: [0.05, 0, 1, 0] });
    (pad.buttons as { pressed: boolean; value: number }[])[PAD_BUTTONS.RT] = { pressed: true, value: 0.3 };
    const frame = reader.update([pad], 0.016);
    expect(frame.left).toEqual({ x: 0, y: 0 });
    expect(frame.right.x).toBe(1);
    expect(frame.rt).toBeGreaterThan(0.2);
    expect(frame.buttons.RT.down).toBe(false); // below the press threshold
    expect(frame.active).toBe(true);
  });

  it('switches to the pad that was used last', () => {
    const reader = new GamepadReader();
    const a = fakePad({ index: 0, id: 'a' });
    reader.update([a, fakePad({ index: 1, id: 'b' })], 0.016);
    expect(reader.current?.id).toBe('a');
    reader.update([a, fakePad({ index: 1, id: 'b' }, [PAD_BUTTONS.A])], 0.016);
    expect(reader.current?.id).toBe('b');
  });
});

describe('Rumbler', () => {
  it('detects support and scales magnitudes', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const pad = fakePad({ vibrationActuator: { playEffect } });
    expect(canRumble(pad)).toBe(true);
    expect(canRumble(fakePad())).toBe(false);
    const rumbler = new Rumbler({ enabled: true, intensity: 0.5 });
    expect(rumbler.play(pad, 1, 0.4, 200)).toBe(true);
    expect(playEffect).toHaveBeenCalledWith('dual-rumble', {
      duration: 200,
      startDelay: 0,
      strongMagnitude: 0.5,
      weakMagnitude: 0.2,
    });
  });

  it('does nothing when disabled or unsupported', () => {
    const playEffect = vi.fn(() => Promise.resolve('complete'));
    const rumbler = new Rumbler({ enabled: false, intensity: 1 });
    expect(rumbler.play(fakePad({ vibrationActuator: { playEffect } }), 1, 1, 100)).toBe(false);
    expect(playEffect).not.toHaveBeenCalled();
    expect(new Rumbler().play(fakePad({ vibrationActuator: null }), 1, 1, 100)).toBe(false);
  });

  it('swallows rejected effects', async () => {
    const playEffect = vi.fn(() => Promise.reject(new Error('preempted')));
    expect(new Rumbler().play(fakePad({ vibrationActuator: { playEffect } }), 1, 1, 100)).toBe(true);
    await Promise.resolve();
  });
});
