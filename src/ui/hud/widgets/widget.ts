// Shared widget contract. write() runs at ~20 Hz for text and state classes; animate() runs
// every frame and only moves smoothed needles (SVG transforms / CSS transforms).

import type { HudSettings } from '../../../settings/schema';
import type { HudUnits } from '../format';
import type { HudModel } from '../model';
import type { PeakHold, RideMeter } from '../motion';

export interface HudViewSettings extends HudSettings {
  radar: boolean; // mini radar / plotter under the fleet strip
}

export interface HudContext {
  units: HudUnits;
  settings: HudViewSettings;
  time: number; // s since the HUD was created
  peaks: { roll: PeakHold; pitch: PeakHold };
  ride: RideMeter;
}

export interface Widget {
  readonly root: HTMLElement;
  write(model: HudModel, ctx: HudContext): void;
  animate(model: HudModel, dt: number, ctx: HudContext): void;
}

// Needle time constant: fast enough to follow a rolling boat, slow enough to hide 20 Hz steps.
export const NEEDLE_TAU = 0.09;
