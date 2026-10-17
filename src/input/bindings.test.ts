import { describe, expect, it } from 'vite-plus/test';

import { BOAT_KINDS } from '../sim/world/protocol';
import { type Binding, BINDINGS, describeBindings, findConflicts, isCameraAxis, keyName } from './bindings';
import { activeContexts, BOAT_CONTEXTS, contextForBoat, POLL_CONTEXTS } from './contexts';

const row = (context: Parameters<typeof describeBindings>[0], id: string) =>
  describeBindings(context).find((r) => r.id === id);

describe('contexts', () => {
  it('maps every boat kind to a helm class', () => {
    expect(contextForBoat('cargo')).toBe('ship');
    expect(contextForBoat('crab')).toBe('ship');
    expect(contextForBoat('cruise')).toBe('cruise');
    expect(contextForBoat('powerboat')).toBe('powerboat');
    expect(contextForBoat('pwc')).toBe('pwc');
    expect(contextForBoat('sail')).toBe('sail');
    for (const kind of BOAT_KINDS) expect(BOAT_CONTEXTS).toContain(contextForBoat(kind));
  });

  it('keeps menus exclusive', () => {
    expect(activeContexts('menu')).toEqual(['menu']);
    expect(activeContexts('sail')).toEqual(['global', 'camera', 'sail']);
  });
});

describe('bindings table', () => {
  it.each(POLL_CONTEXTS)('has no conflicts in %s', (context) => {
    expect(findConflicts(context)).toEqual([]);
  });

  it('detects a conflict', () => {
    const clash: Binding[] = [
      {
        kind: 'button',
        id: 'horn',
        contexts: ['global'],
        label: '',
        description: '',
        keys: ['KeyB'],
        pad: [],
      },
      {
        kind: 'button',
        id: 'furl',
        contexts: ['sail'],
        label: '',
        description: '',
        keys: ['KeyB'],
        pad: [{ button: 'A', mode: 'press' }],
      },
      {
        kind: 'button',
        id: 'reefIn',
        contexts: ['sail'],
        label: '',
        description: '',
        keys: [],
        pad: [{ button: 'A', mode: 'hold' }],
      },
    ];
    const found = findConflicts('sail', clash);
    expect(found.map((c) => c.input)).toEqual(['KeyB', 'A:hold']);
    expect(findConflicts('ship', clash)).toEqual([]);
  });

  it('puts the five light switches on the number keys and the D-pad', () => {
    const lights = ['navLights', 'deckLights', 'cabinLights', 'signals', 'extraLights'];
    lights.forEach((id, i) => expect(row('ship', id)?.keyboard.split(' / ')[0]).toBe(String(i + 1)));
    expect(row('ship', 'deckLights')).toMatchObject({ keyboard: '2 / L', gamepad: 'D-pad ↓ (tap)' });
    expect(row('ship', 'cabinLights')?.gamepad).toBe('D-pad ↓ (hold)');
    expect(row('ship', 'signals')).toMatchObject({ keyboard: '4', gamepad: 'D-pad ↑ (hold)' });
    expect(row('ship', 'extraLights')?.gamepad).toBe('D-pad ← (hold) / D-pad → (hold)');
    expect(row('ship', 'nextBoat')?.gamepad).toBe('D-pad → (tap)');
    // Global, so the same on every helm and in photo mode.
    for (const context of POLL_CONTEXTS.filter((c) => c !== 'menu'))
      for (const id of lights) expect(row(context, id), `${context}:${id}`).toBeDefined();
  });

  it('centres the helm with a click of the steering stick on every boat', () => {
    expect(row('ship', 'midships')?.gamepad).toBe('X / L3 (tap)');
    expect(row('pwc', 'midships')?.gamepad).toBe('X / L3 (tap)');
    expect(row('sail', 'midships')?.gamepad).toBe('L3 (tap)');
    expect(row('sail', 'autoTrim')?.gamepad).toBe('L3 (hold)');
    expect(row('sail', 'letFly')).toMatchObject({ keyboard: 'Space', gamepad: '—' });
    expect(row('ship', 'zoom')?.gamepad).toBe('Y (hold)');
    expect(row('ship', 'cameraNext')?.gamepad).toBe('Y (tap)');
  });

  it('allows tap and hold on one button', () => {
    expect(row('ship', 'hud')?.gamepad).toBe('View (tap)');
    expect(row('ship', 'recover')?.gamepad).toBe('View (hold)');
  });

  it('gives every action a keyboard or mouse binding, a label and a description', () => {
    for (const binding of BINDINGS) {
      expect(binding.label, binding.id).not.toBe('');
      expect(binding.description, binding.id).not.toBe('');
    }
    for (const context of POLL_CONTEXTS) {
      for (const r of describeBindings(context)) expect(r.keyboard, r.id).not.toBe('—');
    }
  });

  it('gives every boat and camera action a gamepad binding', () => {
    const keyboardOnly = new Set([
      'help',
      'telemetry',
      'perf',
      'timeEarlier',
      'timeLater',
      'timeScale',
      'cameraPrev', // tap Y cycles forward; hold Y steps the zoom
      'letFly', // LT and LB ease both sheets
    ]);
    for (const context of POLL_CONTEXTS) {
      for (const r of describeBindings(context)) {
        if (!keyboardOnly.has(r.id)) expect(r.gamepad, `${context}:${r.id}`).not.toBe('—');
      }
    }
  });

  it('gives boat axes a feel for every context they are used in', () => {
    for (const binding of BINDINGS) {
      if (binding.kind !== 'axis' || isCameraAxis(binding.id)) continue;
      for (const context of binding.contexts) expect(binding.specs, binding.id).toHaveProperty(context);
    }
  });
});

describe('describeBindings', () => {
  it('uses friendly names', () => {
    expect(row('ship', 'telegraph')).toMatchObject({ keyboard: 'W / S', gamepad: 'RT / LT', group: 'ship' });
    expect(row('pwc', 'steer')).toMatchObject({ keyboard: 'A / D', gamepad: 'Left stick X' });
    expect(row('sail', 'jibSheet')).toMatchObject({ keyboard: 'Q / E', gamepad: 'LB / RB' });
    expect(row('ship', 'navLights')).toMatchObject({ keyboard: '1 / N', gamepad: 'D-pad ↑ (tap)' });
    expect(row('ship', 'help')?.keyboard).toBe('? / F1');
    expect(row('ship', 'pause')?.keyboard).toBe('P / Esc');
    expect(row('ship', 'look')).toMatchObject({ gamepad: 'Right stick' });
    expect(row('ship', 'look')?.keyboard).toContain('Mouse');
    expect(row('ship', 'zoom')?.keyboard).toBe('Wheel · = / -');
    expect(row('menu', 'menuNavigate')?.gamepad).toBe('D-pad / Left stick');
    expect(row('sail', 'reefOut')?.keyboard).toBe('Shift+R');
  });

  it('lists photo mode controls on top of the camera and global ones', () => {
    const rows = describeBindings('photo');
    expect(rows[0].group).toBe('photo');
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining(['photoMove', 'photoRise', 'photoAperture', 'photoSlowMo', 'photoMode', 'look']),
    );
    expect(rows.some((r) => r.id === 'steer' || r.id === 'telegraph')).toBe(false);
    expect(row('photo', 'photoMove')).toMatchObject({ keyboard: 'W S A D', gamepad: 'Left stick' });
    expect(row('photo', 'photoRise')).toMatchObject({ keyboard: 'Q / E', gamepad: 'LT / RT' });
    expect(row('photo', 'photoAperture')).toMatchObject({ keyboard: 'Wheel', gamepad: 'LB / RB' });
    expect(row('ship', 'photoMode')).toMatchObject({ keyboard: 'K', gamepad: 'R3 (hold)' });
    expect(row('ship', 'cameraReset')?.gamepad).toBe('R3 (tap)');
  });

  it('lists only the live contexts, boat controls first', () => {
    const rows = describeBindings('sail');
    expect(rows[0].group).toBe('sail');
    expect(rows.some((r) => r.id === 'telegraph')).toBe(false);
    expect(rows.some((r) => r.id === 'menuAccept')).toBe(false);
    expect(rows.at(-1)?.group).toBe('global');
  });

  it('names keys', () => {
    expect(keyName('KeyW')).toBe('W');
    expect(keyName('Digit3')).toBe('3');
    expect(keyName('BracketLeft')).toBe('[');
    expect(keyName('Backslash')).toBe('\\');
    expect(keyName('Shift+Tab')).toBe('Shift+Tab');
  });
});
