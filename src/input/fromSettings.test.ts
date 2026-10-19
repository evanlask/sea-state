import { describe, expect, it } from 'vite-plus/test';

import { inputSettingsFrom } from './fromSettings';
import { DEFAULT_INPUT_SETTINGS } from './InputManager';

describe('inputSettingsFrom', () => {
  it('scales the default mouse sensitivity by the multiplier', () => {
    const s = inputSettingsFrom({ mouseSensitivity: 2, invertY: true });
    expect(s.mouseSensitivity).toBeCloseTo(DEFAULT_INPUT_SETTINGS.mouseSensitivity * 2);
    expect(s.invertY).toBe(true);
  });
});
