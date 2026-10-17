// How many scene lights the boat lights may add, per quality preset. Every unshadowed point/spot
// light is evaluated by every lit fragment (ocean included) under three's forward lighting, and every
// shadowed spot light re-renders the shadow casters each frame, so the budget is per *local* boat
// (the player, maybe the nearest fleet boat); the rest show lamps and glows only. Pure TS.

import type { QualityPreset } from '../../../app/Scenario';

export interface LightBudget {
  navSpill: number; // nav-light spill lights (red/green on the bow, glints on the water)
  deckLights: number; // deck/work/courtesy scene lights
  deckShadows: number; // of which shadow-casting spot lights
  shadowMapSize: number;
}

export const LIGHT_BUDGET: Readonly<Record<QualityPreset, LightBudget>> = {
  low: { navSpill: 0, deckLights: 1, deckShadows: 0, shadowMapSize: 512 },
  medium: { navSpill: 2, deckLights: 2, deckShadows: 1, shadowMapSize: 512 },
  high: { navSpill: 3, deckLights: 4, deckShadows: 2, shadowMapSize: 1024 },
  ultra: { navSpill: 4, deckLights: 6, deckShadows: 3, shadowMapSize: 1024 },
};

// Unshadowed spot lights lent to the nearest fleet boats with their deck lights on, one beam each
// (fleetLighting.ts, FleetLightPool), on top of the helm boat's budget above. Every lit fragment pays
// for each, lit or dark, so a handful; Low has none.
export const FLEET_LIGHTS: Readonly<Record<QualityPreset, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  ultra: 3,
};

// Remote boats (fleet, far away) get no scene lights of their own (FLEET_LIGHTS lends them a few).
export const REMOTE_BUDGET: Readonly<LightBudget> = {
  navSpill: 0,
  deckLights: 0,
  deckShadows: 0,
  shadowMapSize: 512,
};

// Picks which candidates get scene lights and shadows: by priority, shadows to the first eligible.
export function allocateLights<T extends { priority: number; shadow: boolean; light: string }>(
  candidates: readonly T[],
  lights: number,
  shadows: number,
): { item: T; shadow: boolean }[] {
  const sorted = candidates.filter((c) => c.light !== 'none').sort((a, b) => a.priority - b.priority);
  const picked: { item: T; shadow: boolean }[] = [];
  let shadowLeft = shadows;
  for (const item of sorted.slice(0, Math.max(0, lights))) {
    const shadow = item.shadow && shadowLeft > 0;
    if (shadow) shadowLeft--;
    picked.push({ item, shadow });
  }
  return picked;
}

// Assigns candidates to a fixed pool of spot-light slots (LightPool.ts): `shadowed` shadow-casting
// slots (0..shadowed−1), then `plain` unshadowed ones. By priority, shadow-eligible spots take
// shadowed slots first and everything else takes plain slots; spots overflow into spare shadowed
// slots (casting shadows, which the budget allows). Point lights never take a shadowed slot (a
// hemisphere has no shadow frustum).
export function assignPoolSlots<T extends { priority: number; shadow: boolean; light: string }>(
  candidates: readonly T[],
  shadowed: number,
  plain: number,
): { item: T; slot: number; shadow: boolean }[] {
  const sorted = candidates.filter((c) => c.light !== 'none').sort((a, b) => a.priority - b.priority);
  const out: { item: T; slot: number; shadow: boolean }[] = [];
  let nextShadowed = 0;
  let nextPlain = 0;
  for (const item of sorted) {
    if (nextShadowed >= shadowed && nextPlain >= plain) break;
    const spot = item.light === 'spot';
    if (spot && item.shadow && nextShadowed < shadowed) {
      out.push({ item, slot: nextShadowed++, shadow: true });
    } else if (nextPlain < plain) {
      out.push({ item, slot: shadowed + nextPlain++, shadow: false });
    } else if (spot && nextShadowed < shadowed) {
      out.push({ item, slot: nextShadowed++, shadow: true });
    }
  }
  return out;
}
