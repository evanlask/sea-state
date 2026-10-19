// The player's Controls settings (sensitivity as a multiplier) → the input layer's settings.

import type { ControlSettings } from '../settings/schema';
import { DEFAULT_INPUT_SETTINGS, type InputSettings } from './InputManager';

export function inputSettingsFrom(controls: Readonly<ControlSettings>): Partial<InputSettings> {
  return {
    mouseSensitivity: DEFAULT_INPUT_SETTINGS.mouseSensitivity * controls.mouseSensitivity,
    invertY: controls.invertY,
  };
}
