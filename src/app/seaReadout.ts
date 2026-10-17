// The sea on screen part-way through a live weather change: Hs and Tp for the HUD and audio, and the
// wind the foam follows (whitecap threshold, streaks, spume, spray drift). All of them blend with
// the h0 crossfade's weight in simulation time, so they move with the waves, not ahead of them, and
// stand still while the game is paused.

import { fromDirectionToVelocity } from '../sim/core/conventions';
import { transitionBlend } from '../sim/ocean/h0';
import { blendWind } from '../sim/weather/wind';
import type { SpectrumMessage, WindConfig } from '../sim/world/protocol';

export interface SeaReadout {
  hs: number; // m
  tp: number; // s
  wind: WindConfig; // the mean wind the sea is built for
}

// A spectrum fully blended in.
export const seaReadoutOf = (spectrum: SpectrumMessage): SeaReadout => ({
  hs: spectrum.significantHeight,
  tp: spectrum.peakPeriod,
  wind: { ...spectrum.wind },
});

// From `from` (the readout when this spectrum arrived) towards the spectrum, at simulation time `time`.
export function blendSeaReadout(from: SeaReadout, spectrum: SpectrumMessage, time: number): SeaReadout {
  const w = transitionBlend(spectrum.activationTime, spectrum.transitionDuration, time);
  return {
    hs: from.hs + (spectrum.significantHeight - from.hs) * w,
    tp: from.tp + (spectrum.peakPeriod - from.tp) * w,
    wind: blendWind(from.wind, spectrum.wind, w),
  };
}

// The foam's wind as the renderer takes it: a 10 m velocity, m/s toward.
export function foamWindVelocity(readout: SeaReadout): { x: number; y: number; z: number } {
  const v = fromDirectionToVelocity(readout.wind.from, readout.wind.speed);
  return { x: v.x, y: 0, z: v.z };
}
