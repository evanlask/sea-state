// Automatic COLREG day/night signals, from what a boat is doing: a ship lying stopped without
// propulsion shows not-under-command (Rule 27(a)); a crabber working its pots under deck lights shows
// fishing (Rule 26(c)). Pure.

import type { LightSignal } from '../ui/hud/model';

export interface SignalInput {
  kind: string;
  speed: number; // m/s through the water
  telemetry: Readonly<Record<string, number>>;
  deckLights: boolean;
}

const NUC_SPEED = 0.5; // m/s, ~1 kn: drifting
const FISHING_SPEED = 2.5; // m/s, ~5 kn: hauling or setting pots

export function autoSignals(input: SignalInput): LightSignal[] {
  const t = input.telemetry;
  if ((t['capsized'] ?? 0) > 0.5) return [];
  if (input.kind === 'cargo' || input.kind === 'cruise') {
    const load = Math.abs(t['load'] ?? 0);
    return load < 0.02 && input.speed < NUC_SPEED ? ['nuc'] : [];
  }
  if (input.kind === 'crab') return input.deckLights && input.speed < FISHING_SPEED ? ['fishing'] : [];
  return [];
}

// The player's manual signal (4) cycles Auto → At anchor → Restricted in
// ability to manoeuvre → Auto, and replaces the automatic signals while set.
export type SignalOverride = 'anchor' | 'ram' | null;

const OVERRIDE_CYCLE: readonly SignalOverride[] = [null, 'anchor', 'ram'];

export function nextSignalOverride(current: SignalOverride): SignalOverride {
  return OVERRIDE_CYCLE[(OVERRIDE_CYCLE.indexOf(current) + 1) % OVERRIDE_CYCLE.length] ?? null;
}

export function signalsWithOverride(input: SignalInput, override: SignalOverride): LightSignal[] {
  if ((input.telemetry['capsized'] ?? 0) > 0.5) return [];
  return override ? [override] : autoSignals(input);
}
