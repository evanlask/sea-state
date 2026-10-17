import { describe, expect, it } from 'vite-plus/test';

import { inputSettingsFrom } from './fromSettings';
import { DEFAULT_INPUT_SETTINGS } from './InputManager';

describe('inputSettingsFrom', () => {
  it('scales the defaults by the sensitivity multipliers', () => {
    const s = inputSettingsFrom({
      mouseSensitivity: 2,
      invertY: true,
      gamepadDeadZone: 0.25,
      gamepadSensitivity: 0.5,
      rumble: false,
    });
    expect(s.mouseSensitivity).toBeCloseTo(DEFAULT_INPUT_SETTINGS.mouseSensitivity * 2);
    expect(s.stickLookSpeed).toBeCloseTo(DEFAULT_INPUT_SETTINGS.stickLookSpeed * 0.5);
    expect(s).toMatchObject({ stickDeadZone: 0.25, invertY: true, rumble: false });
  });
});
