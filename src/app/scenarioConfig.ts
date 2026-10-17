// Maps scenario choices (menu setup or deep link) onto the simulation config and renderer weather,
// plus the live pause-menu changes (conditions, boats joining the fleet).

import { DEFAULT_CLOUD_BASE } from '../render/clouds/cloudTypes';
import type { SceneClouds, SceneWeather } from '../render/SeaScene';
import { getRegion } from '../sim/astro/regions';
import { DEG, fromDirectionToVelocity, headingToVector } from '../sim/core/conventions';
import { knotsToMs } from '../sim/core/units';
import type { OceanQuality, VisualDetail } from '../sim/ocean/cascades';
import { type CloudType, getWeatherPreset } from '../sim/weather/presets';
import type { SeaStateSettings, SwellSettings } from '../sim/weather/seaState';
import type {
  BoatKind,
  BoatLoad,
  BoatSpawn,
  PhysicsMode,
  SimCommand,
  SimConfig,
  WindConfig,
} from '../sim/world/protocol';
import { type Conditions, defaultSetup, type ScenarioSetup } from '../ui/menu/setup';
import { formation, joiningStation, type Scenario } from './Scenario';
import { followerPlan, spawnPlan } from './spawnPlan';

// Weather and sea choices beyond the plain Scenario (deep links use presets only).
export type ScenarioChoices = Scenario & Partial<Pick<ScenarioSetup, 'customWeather' | 'sea' | 'loading'>>;

// The setup's loading condition for a boat of this kind (the ship's cargo, the crab boat's pots).
export function loadFor(kind: BoatKind, choices: ScenarioChoices): BoatLoad | undefined {
  const loading = choices.loading ?? defaultSetup().loading;
  if (kind === 'cargo') return { cargo: loading.cargo };
  if (kind === 'crab') return { crabPots: loading.crabPots };
  return undefined;
}

export function windFor(choices: ScenarioChoices): WindConfig {
  if (choices.weather === 'custom' && choices.customWeather) {
    const custom = choices.customWeather;
    const mean = Math.max(0, custom.windKn);
    return {
      speed: knotsToMs(mean),
      from: custom.windFromDeg * DEG,
      gustFactor: mean > 0 ? Math.max(1, custom.gustKn / mean) : 1,
    };
  }
  const preset = getWeatherPreset(choices.weather);
  return { speed: preset.windSpeed, from: preset.windFrom, gustFactor: preset.gustFactor };
}

// The region's typical background swell (unknown regions: the North Atlantic's).
export function regionSwell(region: string): SwellSettings {
  const swell = getRegion(region).swell;
  return { height: swell.height, period: swell.period, from: swell.fromDeg * DEG };
}

// Auto sea state: a preset's own swell (Glassy Calm, Fog Bank, Long Ocean Swell, Cross Seas) is part
// of its scenario and stays; every other preset, and custom weather, gets the region's background
// swell under its wind sea. Anything stormy is still dominated by the wind sea (a 3 m swell under a
// 9 m storm sea adds 5% to the combined Hs). Manual sea state ignores the region: the player sets
// the swell there.
export function seaStateFor(choices: ScenarioChoices): SeaStateSettings {
  const preset = getWeatherPreset(choices.weather);
  const presetSea = preset.seaState;
  const sea = choices.sea;
  if (sea?.mode === 'manual') {
    const manual = sea.manual;
    return {
      mode: 'manual',
      height:
        manual.spec === 'hs' ? { kind: 'hs', hs: manual.hs } : { kind: 'douglas', code: manual.douglas },
      tp: manual.tp,
      choppiness: manual.choppiness,
      crestLength: manual.crest,
      directionOffset: manual.directionOffsetDeg * DEG,
      swell:
        manual.swellHeight > 0
          ? { height: manual.swellHeight, period: manual.swellPeriod, from: manual.swellFromDeg * DEG }
          : null,
    };
  }
  if (presetSea.mode !== 'auto') return presetSea;
  const swell = presetSea.swell ?? regionSwell(choices.region);
  // Deep links (no sea setup) take the preset's sea as is, plus the region's swell.
  if (!sea) return { ...presetSea, swell };
  // Auto: the player's fetch, but never longer than the preset's own (hurricanes use a short
  // storm-relative fetch to keep their seas realistic).
  return {
    mode: 'auto',
    fetch: Math.min(sea.fetchKm * 1000, presetSea.fetch),
    fullyDeveloped: sea.fullyDeveloped,
    swell,
  };
}

// oceanQuality: graphics.visualDetailCascades (or a tier); capsizeAssist: physics.capsizeAssist, which
// otherwise only reaches a running voyage as a command when it changes.
export function simConfigFor(
  choices: ScenarioChoices,
  oceanQuality: OceanQuality | VisualDetail,
  capsizeAssist = false,
): SimConfig {
  const wind = windFor(choices);
  const seaState = seaStateFor(choices);
  // The player starts where it has a chance (spawnPlan); the fleet forms up abeam on its heading.
  const player = spawnPlan(choices.playerBoat, wind, seaState, choices.physicsMode);
  const slots = formation(choices.playerBoat, choices.fleet, player.heading);
  return {
    seed: choices.seed,
    physicsMode: choices.physicsMode,
    boats: slots.map((slot, index) => ({
      id: index === 0 ? 'player' : `fleet-${index}`,
      kind: slot.kind,
      x: slot.x,
      z: slot.z,
      ...(index === 0 ? player : followerPlan(slot.kind, player.heading, wind)),
      load: loadFor(slot.kind, choices),
    })),
    wind,
    seaState,
    oceanQuality,
    capsizeAssist,
  };
}

// What the renderer needs to know about the weather (sky, rain, lightning, haze).
export function sceneWeatherFor(choices: ScenarioChoices): SceneWeather {
  const wind = windFor(choices);
  const velocity = fromDirectionToVelocity(wind.from, wind.speed);
  const custom = choices.weather === 'custom' ? choices.customWeather : undefined;
  const preset = getWeatherPreset(choices.weather);
  const coverage = custom ? custom.cloudCover : preset.clouds.coverage;
  const cloudType = custom ? custom.cloudType : preset.clouds.type;
  const layered = cloudType === 'stratus' || cloudType === 'nimbostratus' || cloudType === 'cumulonimbus';
  const visibility = custom ? custom.visibilityKm * 1000 : preset.visibility;
  return {
    windVelocity: { x: velocity.x, y: 0, z: velocity.z },
    precipitation: custom ? custom.rain : preset.precipitation,
    lightningPerMinute: custom ? custom.lightning * 6 : preset.lightningPerMinute,
    // Sky dimming for when volumetric clouds are off: thick layered cloud dims and greys the sky.
    overcast: Math.min(1, coverage * (layered ? 1 : 0.4)),
    // Visibility (m) → aerosol haze; clean sea air at 30+ km, thick in storms.
    hazeDensity: Math.min(12, Math.max(1, 30_000 / Math.max(500, visibility))),
    visibility,
    clouds: {
      type: cloudType,
      coverage: cloudType === 'clear' ? 0 : coverage,
      base: custom ? DEFAULT_CLOUD_BASE[cloudType] : preset.clouds.base,
    },
  };
}

// --- Live conditions (pause → Conditions) ---

// How long a live change takes: the wind (and the sky, which the player watches change behind the
// menu, in real seconds) and the sea, which lags the wind (in simulation seconds). Arcade answers in
// seconds; Realistic lets the sea take a minute and a half to build or lie down.
export const CONDITION_TRANSITIONS: Record<PhysicsMode, { wind: number; sky: number; sea: number }> = {
  arcade: { wind: 3, sky: 4, sea: 4 },
  realistic: { wind: 12, sky: 12, sea: 90 },
};

// What's running, as the pause menu edits it (deep links carry presets only, so the rest defaults).
export function conditionsFor(choices: ScenarioChoices): Conditions {
  const base = defaultSetup(choices);
  return structuredClone({
    weather: base.weather,
    customWeather: choices.customWeather ?? base.customWeather,
    sea: choices.sea ?? base.sea,
    timeOfDay: choices.timeOfDay,
    date: choices.date,
  });
}

export function withConditions(choices: ScenarioChoices, conditions: Conditions): ScenarioChoices {
  return { ...choices, ...structuredClone(conditions) };
}

// Whether two sets of conditions differ in anything the weather or the sea depends on.
export function weatherChanged(a: Conditions, b: Conditions): boolean {
  const key = (c: Conditions): string =>
    JSON.stringify([c.weather, c.weather === 'custom' ? c.customWeather : null, c.sea]);
  return key(a) !== key(b);
}

export function conditionsCommand(choices: ScenarioChoices, mode: PhysicsMode): SimCommand {
  const t = CONDITION_TRANSITIONS[mode];
  return {
    type: 'setConditions',
    wind: windFor(choices),
    seaState: seaStateFor(choices),
    windTransition: t.wind,
    seaTransition: t.sea,
  };
}

// Cloud type part-way (w, 0..1) from a's clouds, which may be mid-morph themselves, to `to`: carrying
// on or turning back keeps the morph continuous; heading for a third type starts from whichever of
// a's two types is nearer.
export function cloudMorph(
  a: SceneClouds,
  to: CloudType,
  w: number,
): Pick<SceneClouds, 'type' | 'morphFrom' | 'morph'> {
  let from = a.type;
  let start = 0;
  if (a.morphFrom !== undefined && a.morph !== undefined && a.morphFrom !== a.type) {
    if (to === a.morphFrom) {
      start = 1 - a.morph;
    } else if (to === a.type) {
      from = a.morphFrom;
      start = a.morph;
    } else if (a.morph < 0.5) {
      from = a.morphFrom;
    }
  }
  const morph = start + (1 - start) * Math.min(1, Math.max(0, w));
  if (from === to || morph >= 1) return { type: to };
  if (morph <= 0) return { type: from };
  return { type: to, morphFrom: from, morph };
}

// Weather part-way (w, 0..1) from a to b. Cloud coverage and base step in tenths: each step rebuilds
// the weather map and restarts the clouds' temporal history, so a per-frame blend would shimmer. The
// cloud type morphs continuously (the cloud renderer steps its weather map with the coverage).
export function blendSceneWeather(a: SceneWeather, b: SceneWeather, w: number): SceneWeather {
  const mix = (x: number, y: number, t = w): number => x + (y - x) * t;
  const c = Math.round(w * 10) / 10;
  return {
    windVelocity: {
      x: mix(a.windVelocity.x, b.windVelocity.x),
      y: mix(a.windVelocity.y, b.windVelocity.y),
      z: mix(a.windVelocity.z, b.windVelocity.z),
    },
    precipitation: mix(a.precipitation, b.precipitation, c),
    lightningPerMinute: mix(a.lightningPerMinute, b.lightningPerMinute),
    overcast: mix(a.overcast, b.overcast),
    hazeDensity: mix(a.hazeDensity, b.hazeDensity),
    visibility: mix(a.visibility, b.visibility),
    clouds: {
      ...cloudMorph(a.clouds, b.clouds.type, w),
      coverage: mix(a.clouds.coverage, b.clouds.coverage, c),
      base: mix(a.clouds.base, b.clouds.base, c),
    },
  };
}

// --- Fleet changes mid-voyage ---

export interface FleetPose {
  kind: BoatKind;
  x: number;
  z: number;
  heading: number; // rad
}

// Where a boat joining the fleet starts: abeam of the player, outboard of the current line, on the
// player's heading (a sailboat on the nearest it can sail in `wind`, sails set: followerPlan). The
// simulation then keeps it on that station.
export function joiningSpawn(
  id: string,
  kind: BoatKind,
  player: FleetPose,
  others: readonly FleetPose[],
  load?: BoatLoad,
  wind?: WindConfig,
): BoatSpawn {
  const f = headingToVector(player.heading);
  // Starboard of the player is (−f.z, f.x).
  const starboard = joiningStation(
    player.kind,
    kind,
    others.map((boat) => ({
      kind: boat.kind,
      starboard: (boat.x - player.x) * -f.z + (boat.z - player.z) * f.x,
    })),
  );
  return {
    id,
    kind,
    x: player.x - f.z * starboard,
    z: player.z + f.x * starboard,
    heading: player.heading,
    ...(wind && kind === 'sail' ? followerPlan(kind, player.heading, wind) : {}),
    ...(load ? { load } : {}),
  };
}
