// How wet the boats are (boatEnvironment.wetness, 0..1), from the rain and the spray coming over the
// helm boat: soaks in within seconds, dries over about a minute and a half. Pure TS.

const WET_SECONDS = 4; // time constant of soaking
export const DRY_SECONDS = 90; // soaked to dry

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

// The wetness the weather and spray would settle at. precipitation 0..1 (drizzle 0.2 already wets
// decks well), spray: the helm boat's spray level 0..1 (boatSpray.ts).
export function wetnessTarget(precipitation: number, spray: number): number {
  const rain = clamp01(precipitation * 2.5) ** 0.7;
  return clamp01(Math.max(rain, spray));
}

export function stepWetness(current: number, target: number, dt: number): number {
  const step = Math.max(0, dt);
  if (target > current) return current + (target - current) * (1 - Math.exp(-step / WET_SECONDS));
  return Math.max(target, current - step / DRY_SECONDS);
}
