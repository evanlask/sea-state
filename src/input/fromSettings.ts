// The player's Controls settings (sensitivities as multipliers) → the input layer's settings.

import type { ControlSettings } from '../settings/schema';
import { DEFAULT_INPUT_SETTINGS, type InputSettings } from './InputManager';

export function inputSettingsFrom(controls: Readonly<ControlSettings>): Partial<InputSettings> {
  return {
    mouseSensitivity: DEFAULT_INPUT_SETTINGS.mouseSensitivity * controls.mouseSensitivity,
    stickLookSpeed: DEFAULT_INPUT_SETTINGS.stickLookSpeed * controls.gamepadSensitivity,
    stickDeadZone: controls.gamepadDeadZone,
    invertY: controls.invertY,
    rumble: controls.rumble,
  };
}
