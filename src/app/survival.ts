// Storm Survival: get through a chosen storm without capsizing. Tracks time
// survived, the worst roll, hull slams and green water shipped; the run ends
// at the first capsize and the best results are kept per boat and storm.

import { BOAT_KINDS, type BoatKind } from '../sim/world/protocol';
import type { SurvivalResult } from '../ui/menu/setup';
import { isWeatherPresetId, type WeatherPresetId } from '../ui/menu/weather';

const STORAGE_KEY = 'sea-state:survival-bests';
const GREEN_WATER_THRESHOLD = 0.15; // deck-water fraction that counts as shipping green water

export interface SurvivalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SurvivalSample {
  dt: number; // simulation seconds since the last sample
  roll: number; // rad
  deckWater: number; // 0..1
  capsized: boolean;
}

// Time afloat, worst roll, slams and green water: a Storm Survival run, or a Free Sail voyage
// since the helm boat was last righted (its capsize card).
export class RunStats {
  survived = 0;
  maxRoll = 0;
  slams = 0;
  greenWater = 0;
  private onDeck = false;

  addSlam(): void {
    this.slams++;
  }

  track(sample: SurvivalSample): void {
    this.survived += Math.max(0, sample.dt);
    this.maxRoll = Math.max(this.maxRoll, Math.abs(sample.roll));
    // Count each new episode of green water, not every frame of it.
    const wet = sample.deckWater > GREEN_WATER_THRESHOLD;
    if (wet && !this.onDeck) this.greenWater++;
    this.onDeck = wet;
  }
}

export class SurvivalRun extends RunStats {
  readonly boat: BoatKind;
  readonly weather: WeatherPresetId;
  finished = false;

  constructor(boat: BoatKind, weather: WeatherPresetId) {
    super();
    this.boat = boat;
    this.weather = weather;
  }

  override addSlam(): void {
    if (!this.finished) super.addSlam();
  }

  // Returns true on the sample that ends the run.
  sample(sample: SurvivalSample): boolean {
    if (this.finished) return false;
    this.track(sample);
    if (sample.capsized) {
      this.finished = true;
      return true;
    }
    return false;
  }

  result(date = new Date()): SurvivalResult {
    return {
      boat: this.boat,
      weather: this.weather,
      survivedS: Math.round(this.survived),
      maxRollDeg: Math.round((this.maxRoll * 180) / Math.PI),
      slams: this.slams,
      greenWater: this.greenWater,
      date: date.toISOString().slice(0, 10),
    };
  }
}

// Storage is the player's to edit, and an older build may have saved a storm that no longer exists:
// anything that isn't a well-formed result is dropped rather than crashing the menu that lists it.
function isSurvivalResult(value: unknown): value is SurvivalResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  const finite = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n);
  return (
    typeof r['boat'] === 'string' &&
    (BOAT_KINDS as readonly string[]).includes(r['boat']) &&
    isWeatherPresetId(r['weather']) &&
    finite(r['survivedS']) &&
    finite(r['maxRollDeg']) &&
    finite(r['slams']) &&
    finite(r['greenWater']) &&
    typeof r['date'] === 'string'
  );
}

export function loadSurvivalBests(storage: SurvivalStorage | null): SurvivalResult[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSurvivalResult) : [];
  } catch {
    return [];
  }
}

// Keeps the longest survival per boat and storm; returns the updated list and whether this run is a best.
export function recordSurvival(
  storage: SurvivalStorage | null,
  result: SurvivalResult,
): { bests: SurvivalResult[]; isBest: boolean } {
  const bests = loadSurvivalBests(storage);
  const index = bests.findIndex((b) => b.boat === result.boat && b.weather === result.weather);
  const previous = index >= 0 ? bests[index] : undefined;
  const isBest = !previous || result.survivedS > previous.survivedS;
  if (isBest) {
    if (index >= 0) bests[index] = result;
    else bests.push(result);
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(bests));
    } catch {
      // Storage full or disabled: the best still shows this session.
    }
  }
  return { bests, isBest };
}
