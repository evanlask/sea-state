// Which light switches each boat has, for the HUD and Help (keys 1-5): navigation, deck and work
// lights, cabin and accommodation, signals and extras. Read from the fittings in mounts.ts
// and the COLREG profiles, so a new fitting shows up without touching the UI. Pure TS.

import { BOAT_KINDS, type BoatKind } from '../../../sim/world/protocol';
import { VESSEL_LIGHTS } from './colregs';
import { deckGroupOf, defaultDeckMounts, defaultMounts } from './mounts';

export type LightGroup = 'nav' | 'deck' | 'cabin' | 'signals' | 'extra';

// Boats whose models have lit interiors on the cabin switch: the ships' accommodation windows and
// bridges, the crab boat's wheelhouse and portholes, the sailboat's saloon through its smoked windows.
// The center console and the jet ski have no cabin.
const CABINS: ReadonlySet<BoatKind> = new Set(['cargo', 'cruise', 'crab', 'sail']);

// What the extras switch lights, per boat (a short name for the HUD, a fuller one for Help).
export const EXTRA_LIGHTS: Readonly<Partial<Record<BoatKind, { short: string; long: string }>>> = {
  cargo: { short: 'Search', long: 'searchlights on the bridge wings' },
  cruise: { short: 'Search', long: 'bridge-wing searchlights and the funnel floodlight' },
  crab: { short: 'Search', long: 'twin searchlights on the wheelhouse roof' },
  powerboat: { short: 'Underwater', long: 'underwater lights at the transom' },
  pwc: { short: 'Headlight', long: 'headlight' },
};

export interface LightFittings {
  nav: boolean;
  deck: boolean;
  cabin: boolean;
  signals: boolean;
  extra: string | null; // the HUD's short name for the extras, null when the boat has none
}

function fittingsOf(kind: BoatKind): LightFittings {
  const groups = new Set(defaultDeckMounts(kind).map((m) => deckGroupOf(m.type)));
  return {
    nav: defaultMounts(kind).length > 0,
    deck: groups.has('deck'),
    cabin: CABINS.has(kind),
    signals: VESSEL_LIGHTS[kind].signals.some((s) => s !== 'tricolour'),
    extra: groups.has('extra') ? (EXTRA_LIGHTS[kind]?.short ?? 'Extra') : null,
  };
}

const FITTINGS = Object.fromEntries(BOAT_KINDS.map((kind) => [kind, fittingsOf(kind)])) as Record<
  BoatKind,
  Readonly<LightFittings>
>;

export const lightFittings = (kind: BoatKind): Readonly<LightFittings> => FITTINGS[kind];

export function hasLightGroup(kind: BoatKind, group: LightGroup): boolean {
  const f = FITTINGS[kind];
  return group === 'extra' ? f.extra !== null : f[group];
}
