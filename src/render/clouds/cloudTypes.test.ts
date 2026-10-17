import { describe, expect, it } from 'vite-plus/test';

import { getWeatherPreset } from '../../sim/weather/presets';
import {
  airLightFromCover,
  blendCloudLayers,
  cellDome,
  cellType,
  CLOUD_PROFILES,
  type CloudLayer,
  cloudLayerFor,
  type CloudWeather,
  columnScale,
  deckAirRadiance,
  type DeckLight,
  deckOpticalDepth,
  DIFFUSION,
  MAP_MORPH_STEPS,
  MAX_COLUMN_SCALE,
  MIN_CLOUD_BASE,
  mixProfiles,
  murkExtinction,
  MURK_MAX,
  overcastAirWeight,
  profileDensity,
  type ProfileName,
  shellTop,
  steppedMorph,
  TROPOPAUSE_CAP,
  windAloft,
} from './cloudTypes';

const NAMES = Object.keys(CLOUD_PROFILES) as ProfileName[];

const sample = (name: ProfileName, n = 101): number[] =>
  Array.from({ length: n }, (_, i) => profileDensity(i / (n - 1), CLOUD_PROFILES[name]));

const weather = (w: Partial<CloudWeather>): CloudWeather => ({
  type: 'cumulus',
  coverage: 0.5,
  base: 800,
  precipitation: 0,
  ...w,
});

describe('profileDensity', () => {
  it('is zero outside the column and within 0..1 inside, peaking near 1', () => {
    for (const name of NAMES) {
      const p = CLOUD_PROFILES[name];
      expect(profileDensity(-0.1, p)).toBe(0);
      expect(profileDensity(0, p)).toBe(0);
      expect(profileDensity(1, p)).toBe(0);
      const values = sample(name);
      for (const v of values) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Math.max(...values)).toBeGreaterThan(0.95);
    }
  });

  it('keeps stratus full almost to the top but tapers cumulus earlier', () => {
    expect(profileDensity(0.6, CLOUD_PROFILES.stratus)).toBeGreaterThan(0.95);
    expect(profileDensity(0.8, CLOUD_PROFILES.cumulus)).toBeLessThan(0.85);
    expect(profileDensity(0.8, CLOUD_PROFILES.cumulus)).toBeLessThan(
      profileDensity(0.8, CLOUD_PROFILES.stratus),
    );
  });

  it('rounds the tops of heaped clouds off as domes, not points', () => {
    for (const name of ['cumulus', 'congestus', 'cumulonimbus'] as const) {
      const p = { ...CLOUD_PROFILES[name], anvil: 0 };
      // Full body up to the taper, then a cap that is still wide just below the top: a circle
      // keeps ~14% of the width 1% of the cap's height below the apex, an ogive only ~2%.
      expect(profileDensity(p.taperStart, p)).toBeGreaterThan(0.95);
      const nearTop = 1 - 0.01 * (1 - p.taperStart);
      expect(profileDensity(nearTop, p)).toBeGreaterThan(0.1);
      // The cap is convex: the width lost per step grows toward the apex.
      const at = (t: number): number => profileDensity(p.taperStart + t * (1 - p.taperStart), p);
      expect(at(0.5) - at(0.75)).toBeLessThan(at(0.75) - at(1 - 1e-6));
    }
  });

  it('gives the cumulonimbus an anvil near the top', () => {
    const cb = CLOUD_PROFILES.cumulonimbus;
    const noAnvil = { ...cb, anvil: 0 };
    expect(profileDensity(0.88, cb)).toBeGreaterThan(profileDensity(0.88, noAnvil) + 0.2);
    expect(profileDensity(0.999, cb)).toBeLessThan(0.1);
  });

  it('keeps the anvil at the tropopause, with no shelf at mid height', () => {
    const cb = CLOUD_PROFILES.cumulonimbus;
    const noAnvil = { ...cb, anvil: 0 };
    for (const z of [0.3, 0.5, 0.65, 0.7]) expect(profileDensity(z, cb)).toBe(profileDensity(z, noAnvil));
  });

  it('billows only the heaped convective profiles', () => {
    for (const name of ['stratus', 'stratocumulus', 'cumulus', 'nimbostratus'] as const) {
      expect(CLOUD_PROFILES[name].billow).toBe(0);
    }
    expect(CLOUD_PROFILES.congestus.billow).toBeGreaterThan(0);
    expect(CLOUD_PROFILES.cumulonimbus.billow).toBe(1);
  });

  it('orders typical depths from stratus to cumulonimbus', () => {
    const t = (n: ProfileName): number => CLOUD_PROFILES[n].thickness;
    expect(t('stratus')).toBeLessThan(t('cumulus'));
    expect(t('cumulus')).toBeLessThan(t('congestus'));
    expect(t('nimbostratus')).toBeGreaterThan(2);
    expect(t('cumulonimbus')).toBeGreaterThan(8);
  });

  it('blends profiles linearly and clamps the blend', () => {
    const { cumulus, congestus } = CLOUD_PROFILES;
    expect(mixProfiles(cumulus, congestus, 0.5).thickness).toBeCloseTo(
      (cumulus.thickness + congestus.thickness) / 2,
    );
    expect(mixProfiles(cumulus, congestus, 2)).toEqual(congestus);
  });
});

describe('cloud shell', () => {
  it('ends a cumulonimbus layer at its tropopause cap and leaves room for billowing crowns', () => {
    const squalls = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 0.6, base: 700 }));
    const cb = CLOUD_PROFILES.cumulonimbus;
    expect(squalls.topKm).toBeGreaterThanOrEqual(squalls.baseKm + cb.thickness * TROPOPAUSE_CAP);
    expect(squalls.topKm).toBeLessThan(squalls.baseKm + cb.thickness * MAX_COLUMN_SCALE);
    const { cumulus, congestus } = CLOUD_PROFILES;
    expect(shellTop(1, cumulus, cumulus)).toBeCloseTo(1 + cumulus.thickness * MAX_COLUMN_SCALE);
    expect(shellTop(1, cumulus, congestus)).toBeGreaterThan(1 + congestus.thickness * MAX_COLUMN_SCALE);
  });
});

describe('weather-map cells', () => {
  const fair = cloudLayerFor(weather({ coverage: 0.25 })).map;
  const breezy = cloudLayerFor(weather({ coverage: 0.5 })).map;

  it('keeps fair-weather cumulus near profile A and lets breezy skies grow towers', () => {
    // The strongest spots on the map: sheets and cluster fields at their 99th percentiles.
    expect(cellType(0.66, 0.71, fair)).toBeLessThan(0.45);
    expect(cellType(0.5, 0.5, fair)).toBe(0);
    expect(cellType(0.66, 0.71, breezy)).toBeGreaterThan(cellType(0.66, 0.71, fair) + 0.2);
  });

  it('domes each cell: rim and saddles low, the grown centre full height', () => {
    const rim = fair.threshold - fair.softness;
    expect(cellDome(rim, 1, fair)).toBe(0);
    expect(cellDome(1, 0.4, fair)).toBe(0); // a saddle between cells
    expect(cellDome(1, 1, fair)).toBeCloseTo(1);
    const centre = columnScale(0.5, 1, fair.cellWeight);
    const edge = columnScale(0.5, 0, fair.cellWeight);
    expect(edge).toBeLessThan(centre * 0.6);
    expect(centre * MAX_COLUMN_SCALE).toBeCloseTo(1);
    // Within 0..1 for the 8-bit channel, and level for sheets.
    expect(columnScale(1, 1, 1)).toBeCloseTo(1);
    expect(columnScale(0.5, 0, 0)).toBeCloseTo(centre);
  });

  it('keeps fair-weather cumulus broader than tall: about 0.5–1.5 km deep', () => {
    const layer = cloudLayerFor(weather({ coverage: 0.25 }));
    const { profileA, profileB } = layer;
    const strongest = cellType(0.66, 0.71, fair);
    const deepest =
      (profileA.thickness + (profileB.thickness - profileA.thickness) * strongest) * MAX_COLUMN_SCALE;
    expect(profileA.thickness).toBeGreaterThan(0.5);
    expect(profileA.thickness).toBeLessThan(1.2);
    expect(deepest).toBeLessThan(2.5);
  });
});

describe('cloudLayerFor', () => {
  it('maps fair-weather cumulus to a shallow, open layer', () => {
    const layer = cloudLayerFor(weather({ coverage: 0.25, base: 900 }));
    expect(layer.enabled).toBe(true);
    expect(layer.baseKm).toBeCloseTo(0.9);
    expect(layer.topKm).toBeGreaterThan(layer.baseKm + 1);
    expect(layer.topKm).toBeLessThan(6);
    expect(layer.map.deck).toBe(0);
  });

  it('raises the map threshold as coverage falls', () => {
    const sparse = cloudLayerFor(weather({ coverage: 0.2 })).map.threshold;
    const dense = cloudLayerFor(weather({ coverage: 0.8 })).map.threshold;
    expect(sparse).toBeGreaterThan(dense);
  });

  it('turns full stratus and nimbostratus into decks', () => {
    expect(cloudLayerFor(weather({ type: 'stratus', coverage: 0.95 })).map.deck).toBeGreaterThan(0.6);
    expect(cloudLayerFor(weather({ type: 'nimbostratus', coverage: 1 })).map.deck).toBeGreaterThan(0.8);
  });

  it('embeds cumulonimbus towers in a nimbostratus deck at hurricane coverage', () => {
    const squall = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 0.6 }));
    const hurricane = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 1, precipitation: 1 }));
    expect(squall.profileA).toBe(CLOUD_PROFILES.congestus);
    expect(hurricane.profileA).toBe(CLOUD_PROFILES.nimbostratus);
    expect(hurricane.profileB).toBe(CLOUD_PROFILES.cumulonimbus);
    expect(hurricane.topKm).toBeGreaterThan(10);
    expect(hurricane.map.precipitation).toBe(1);
  });

  it('clamps low bases and leaves clear and cirrus skies without volumetric cloud', () => {
    expect(cloudLayerFor(weather({ type: 'stratus', base: 80 })).baseKm).toBe(MIN_CLOUD_BASE);
    expect(cloudLayerFor(weather({ type: 'clear', coverage: 0.4 })).enabled).toBe(false);
    const cirrus = cloudLayerFor(weather({ type: 'cirrus', coverage: 0.1 }));
    expect(cirrus.enabled).toBe(false);
    expect(cirrus.cirrus).toBeGreaterThanOrEqual(0.3);
  });
});

describe('cloud type morphs', () => {
  const PROFILE_KEYS = [
    'thickness',
    'bottomFade',
    'taperStart',
    'roundness',
    'density',
    'anvil',
    'billow',
  ] as const;
  const MAP_KEYS = ['cellWeight', 'threshold', 'softness', 'deck', 'typeBias', 'typeSpread'] as const;
  const morphing = (from: CloudWeather['type'], to: CloudWeather['type'], morph: number): CloudLayer =>
    cloudLayerFor(weather({ type: to, morphFrom: from, morph, coverage: 0.6, precipitation: 0.5 }));
  // Weight of the cell layout with this many cells in the map's crossfade.
  const layoutWeight = (l: CloudLayer, cells: number): number =>
    (l.map.cellsPerTile === cells ? 1 - l.map.cellsMix : 0) +
    (l.map.cellsPerTileTo === cells ? l.map.cellsMix : 0);
  // Largest change of anything visible between two layers (cells: the target type's layout). The
  // shapes only matter while there is volumetric cloud to draw.
  const jump = (a: CloudLayer, b: CloudLayer, cells: number): number => {
    const cover = Math.max(
      Math.abs(a.map.threshold - b.map.threshold),
      Math.abs(a.map.deck - b.map.deck),
      Math.abs(a.coverage - b.coverage),
      Math.abs(a.cirrus - b.cirrus),
    );
    if (!a.enabled || !b.enabled) return cover;
    return Math.max(
      cover,
      ...PROFILE_KEYS.flatMap((k) => [
        Math.abs(a.profileA[k] - b.profileA[k]),
        Math.abs(a.profileB[k] - b.profileB[k]),
      ]),
      ...MAP_KEYS.map((k) => Math.abs(a.map[k] - b.map[k])),
      Math.abs(a.topKm - b.topKm),
      Math.abs(layoutWeight(a, cells) - layoutWeight(b, cells)),
    );
  };

  it('starts and ends exactly on the two types', () => {
    const cumulus = cloudLayerFor(weather({ type: 'cumulus', coverage: 0.6, precipitation: 0.5 }));
    const cb = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 0.6, precipitation: 0.5 }));
    expect(morphing('cumulus', 'cumulonimbus', 0)).toEqual(cumulus);
    expect(morphing('cumulus', 'cumulonimbus', 1)).toEqual(cb);
    expect(morphing('cumulonimbus', 'cumulonimbus', 0.4)).toEqual(cb);
  });

  it('interpolates the height profiles, shell and map parameters, crossfading the cell layouts', () => {
    const a = cloudLayerFor(weather({ type: 'cumulus', coverage: 0.6 }));
    const b = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 0.6 }));
    const mid = blendCloudLayers(a, b, 0.3);
    expect(mid.profileA).toEqual(mixProfiles(a.profileA, b.profileA, 0.3));
    expect(mid.profileB).toEqual(mixProfiles(a.profileB, b.profileB, 0.3));
    expect(mid.map.typeBias).toBeCloseTo(a.map.typeBias + (b.map.typeBias - a.map.typeBias) * 0.3);
    expect(mid.map.cellsPerTile).toBe(a.map.cellsPerTile);
    expect(mid.map.cellsPerTileTo).toBe(b.map.cellsPerTile);
    expect(mid.map.cellsMix).toBeCloseTo(0.3);
    // The shell holds the tallest column the morph has grown so far.
    expect(mid.topKm).toBeGreaterThan(a.topKm);
    expect(mid.topKm).toBeLessThan(b.topKm);
    expect(mid.topKm).toBeCloseTo(mid.baseKm + mid.profileB.thickness * 1.3);
  });

  it('morphs without a jump anywhere along the way', () => {
    const pairs: [CloudWeather['type'], CloudWeather['type']][] = [
      ['cumulus', 'cumulonimbus'],
      ['stratus', 'nimbostratus'],
      ['stratocumulus', 'cumulus'],
      ['cirrus', 'cumulus'],
      ['nimbostratus', 'clear'],
    ];
    for (const [from, to] of pairs) {
      let previous = morphing(from, to, 0);
      const cells = morphing(from, to, 1).map.cellsPerTile;
      for (let i = 1; i <= 200; i++) {
        const next = morphing(from, to, i / 200);
        expect(jump(previous, next, cells), `${from} → ${to} at ${i / 200}`).toBeLessThan(0.1);
        previous = next;
      }
    }
  });

  it('grows clouds into a clear or cirrus sky in the new type’s shapes, from no cover', () => {
    const cumulus = cloudLayerFor(weather({ type: 'cumulus', coverage: 0.6 }));
    const early = morphing('cirrus', 'cumulus', 0.1);
    expect(early.profileA).toEqual(cumulus.profileA);
    expect(early.profileB).toEqual(cumulus.profileB);
    expect(early.map.cellsMix).toBe(0);
    expect(early.map.threshold).toBeGreaterThan(cumulus.map.threshold + 0.5 * (1 - cumulus.map.threshold));
    expect(early.enabled).toBe(true);
    expect(early.cirrus).toBeGreaterThan(cumulus.cirrus);
    const late = morphing('cirrus', 'cumulus', 0.9);
    expect(late.map.threshold).toBeLessThan(early.map.threshold);
  });

  it('steps the weather map in tenths of the morph', () => {
    expect(MAP_MORPH_STEPS).toBe(10);
    expect(steppedMorph(0.04)).toBe(0);
    expect(steppedMorph(0.46)).toBe(0.5);
    expect(steppedMorph(1.2)).toBe(1);
  });

  it('thickens a cumulonimbus field into its deck smoothly as the coverage rises', () => {
    let previous = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: 0.7 })).profileA;
    for (let c = 0.71; c <= 1; c += 0.01) {
      const next = cloudLayerFor(weather({ type: 'cumulonimbus', coverage: c })).profileA;
      for (const k of PROFILE_KEYS) expect(Math.abs(next[k] - previous[k])).toBeLessThan(0.2);
      previous = next;
    }
  });
});

describe('windAloft and airLightFromCover', () => {
  it('strengthens the surface wind aloft, capped, keeping its direction', () => {
    const w = windAloft({ x: 6, z: 8 });
    expect(Math.hypot(w.x, w.z)).toBeCloseTo(15);
    expect(w.x / w.z).toBeCloseTo(0.75);
    expect(windAloft({ x: 70, z: 0 }).x).toBe(35);
    expect(windAloft({ x: 0, z: 0 })).toEqual({ x: 0, z: 0 });
  });

  it('dims the haze light monotonically with cover', () => {
    expect(airLightFromCover(0)).toBe(1);
    expect(airLightFromCover(0.5)).toBeLessThan(airLightFromCover(0.25));
    expect(airLightFromCover(1)).toBeCloseTo(0.15);
  });
});

describe('overcast air', () => {
  const presetWeight = (id: string): number => {
    const p = getWeatherPreset(id);
    return overcastAirWeight(p.clouds.coverage, p.precipitation, p.visibility);
  };
  const saturation = (c: readonly number[]): number => (Math.max(...c) - Math.min(...c)) / Math.max(...c);

  it('leaves clear, fair and breezy skies to the clear-sky haze', () => {
    for (const id of ['glassy-calm', 'fair', 'breezy', 'long-swell']) expect(presetWeight(id)).toBe(0);
    expect(overcastAirWeight(0, 1, 100)).toBe(0); // fog under a clear sky is sunlit, not deck-lit
  });

  it('lights the air by the deck under overcast, rain and storms', () => {
    for (const id of [
      'overcast-drizzle',
      'gale',
      'storm',
      'hurricane-1',
      'hurricane-3',
      'hurricane-5',
      'fog-bank',
    ])
      expect(presetWeight(id)).toBeGreaterThan(0.99);
    expect(presetWeight('night-thunderstorm')).toBeGreaterThan(0.9);
    // Showers between sunny gaps: a little grey murk, mostly clear-sky haze.
    expect(presetWeight('squalls')).toBeGreaterThan(0.05);
    expect(presetWeight('squalls')).toBeLessThan(0.3);
  });

  it('rises with cover, rain and murk, within 0..1', () => {
    let previous = -1;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const w = overcastAirWeight(c, 0, 30_000);
      expect(w).toBeGreaterThanOrEqual(previous);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      previous = w;
    }
    expect(overcastAirWeight(0.6, 0.8, 30_000)).toBeGreaterThan(overcastAirWeight(0.6, 0, 30_000));
    expect(overcastAirWeight(0.6, 0, 500)).toBeGreaterThan(overcastAirWeight(0.6, 0, 30_000));
  });

  it('measures the deck column the march sees: none without cloud, thin stratus, thick nimbostratus', () => {
    expect(deckOpticalDepth(cloudLayerFor(weather({ type: 'clear', coverage: 0 })))).toBe(0);
    const stratus = deckOpticalDepth(cloudLayerFor(weather({ type: 'stratus', coverage: 0.95 })));
    const nimbostratus = deckOpticalDepth(cloudLayerFor(weather({ type: 'nimbostratus', coverage: 1 })));
    expect(stratus).toBeGreaterThan(5);
    expect(nimbostratus).toBeGreaterThan(stratus * 4);
  });

  // Daylight at a 50° sun: a blue clear sky above the deck, white sunlight.
  const day: DeckLight = {
    above: [830, 1600, 3000],
    sunlight: [95_000, 92_000, 88_000],
    mu: Math.sin((50 * Math.PI) / 180),
    depth: 65,
  };

  it('is grey under a thick deck in daylight, not clear-sky blue', () => {
    const air = deckAirRadiance(day);
    expect(saturation(air)).toBeLessThan(0.1);
    expect(saturation(day.above)).toBeGreaterThan(0.6);
    // Lit, but darker than a thin deck's (more light diffuses through thin stratus).
    expect(air[1]).toBeGreaterThan(200);
    expect(deckAirRadiance({ ...day, depth: 10 })[1]).toBeGreaterThan(air[1] * 2);
  });

  it('is about half the cloud base it hangs under (the overcast horizon)', () => {
    const air = deckAirRadiance(day);
    // The light diffused down through the deck: a lower bound on the base's radiance.
    const diffuse = 1 / (1 + DIFFUSION * day.depth);
    const sun = (day.mu / (2 * Math.PI)) * (diffuse - Math.exp(-day.depth / day.mu)) * (0.5 * diffuse + 0.5);
    for (let c = 0; c < 3; c++) {
      const through = (day.above[c] ?? 0) * 0.5 * diffuse + (day.sunlight[c] ?? 0) * sun;
      expect(air[c] / through).toBeGreaterThan(0.5);
      expect(air[c] / through).toBeLessThan(0.6);
    }
  });

  it('does not glow at night or with the sun down', () => {
    const night: DeckLight = {
      above: [1e-4, 1.2e-4, 1.5e-4],
      sunlight: [0, 0, 0],
      mu: -0.3,
      depth: 65,
    };
    for (const c of deckAirRadiance(night)) expect(c).toBeLessThan(1e-4);
    // Below the horizon the light adds nothing, whatever its illuminance.
    const set = deckAirRadiance({ ...night, sunlight: [1e5, 1e5, 1e5] });
    for (const c of set) expect(c).toBeLessThan(1e-4);
  });

  it('thickens the murk under a deck with poorer visibility, none in fair weather', () => {
    expect(murkExtinction(0, 500)).toBe(0);
    const p = (id: string): number => {
      const w = getWeatherPreset(id);
      return murkExtinction(presetWeight(id), w.visibility);
    };
    expect(p('fair')).toBe(0);
    expect(p('breezy')).toBe(0);
    expect(p('squalls')).toBeLessThan(0.1);
    expect(p('overcast-drizzle')).toBeGreaterThan(0.2);
    expect(p('storm')).toBeGreaterThan(p('overcast-drizzle'));
    expect(p('hurricane-5')).toBeLessThanOrEqual(MURK_MAX);
    // Thin overhead (a 350 m base stays readable), opaque toward the horizon.
    const storm = p('storm');
    expect(Math.exp(-storm * 0.35)).toBeGreaterThan(0.8);
    expect(Math.exp(-storm * (0.35 / Math.sin((3 * Math.PI) / 180)))).toBeLessThan(0.1);
  });
});
