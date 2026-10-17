// Region presets: where the scenario sits on Earth, its default date, the
// inherent optical properties of the sea there, and its sea climate.
//
// Water optics are linear-RGB per-metre coefficients for a three-band (R ≈ 600–
// 700 nm, G ≈ 500–570 nm, B ≈ 430–490 nm) single-scattering water model:
//  - absorption: pure seawater (Pope & Fry 1997: ~0.45, ~0.06, ~0.015 m⁻¹ at
//    650/550/460 nm) plus phytoplankton and CDOM for the assumed chlorophyll,
//    after the Morel & Maritorena (2001) case-1 bio-optical model. Chlorophyll
//    and CDOM absorb mostly in blue, which is what greens productive seas.
//  - scattering: seawater molecular scattering (Morel 1974, ~0.001–0.005 m⁻¹)
//    plus particles (~0.3·Chl^0.62 m⁻¹ at 550 nm, Loisel & Morel 1998, λ⁻¹ slope).
//  - deepColor: the colour of optically deep water looking straight down,
//    roughly bb / (a + bb) per band and then hand-tuned against photographs,
//    so treat it as an art-directable target rather than a measured value.
//  - subsurfaceTint: the colour light picks up through thin, sunlit wave
//    crests (the turquoise/green glow in breaking waves); artistic.
// Chlorophyll values are typical surface climatologies (SeaWiFS/MODIS):
// Caribbean and eastern Mediterranean are oligotrophic (Jerlov I–IA), the
// North Atlantic and Bering Sea are productive (Jerlov II–III, coastal-ish),
// and the Southern Ocean is HNLC with moderate chlorophyll. The Norwegian Sea
// in summer sits between the North Atlantic and the Bering Sea: a productive
// Atlantic-water bloom, a little clearer than the Bering shelf.
//
// Sea climate: the background swell usually running there (from distant
// weather systems, independent of the local wind) and the weather preset that
// suits the default season. The swell runs under any weather preset that has no
// swell of its own, in Auto sea state (scenarioConfig.seaStateFor). Typical
// values, rounded from ERA5 / WaveWatch III climatologies:
//  - Caribbean: trade-wind swell from the ENE, ~1.2 m, 8 s, all year.
//  - Mediterranean (Ionian): small, short swell from the NW, ~0.5 m, 6 s.
//  - North Atlantic west of Ireland, autumn: long swell from the W, ~2.5 m, 12 s.
//  - Bering Sea, early winter: swell from the WSW out of the Aleutian lows, ~2 m, 10 s.
//  - Southern Ocean, Drake Passage: the near-permanent big swell of the
//    westerlies, ~3.5 m, 13 s, from the WSW.
//  - Norwegian Sea in summer: North Atlantic swell from the SW, ~2 m, 11 s.

type Rgb = readonly [number, number, number];

export interface WaterOptics {
  chlorophyll: number; // mg/m³, assumption that motivates the numbers below
  absorption: Rgb; // m⁻¹
  scattering: Rgb; // m⁻¹
  deepColor: Rgb; // linear RGB, 0–1
  subsurfaceTint: Rgb; // linear RGB, 0–1
}

// The region's background swell, in menu units.
interface RegionSwell {
  label: string; // what the menu calls it ("Trade-wind swell")
  height: number; // significant height of the swell alone, m
  period: number; // peak period, s
  fromDeg: number; // meteorological "from", degrees true
}

// Alphabetical by name: this is the order the setup screen lists them in.
export const REGION_IDS = [
  'arctic',
  'bering-sea',
  'caribbean',
  'mediterranean',
  'north-atlantic',
  'southern-ocean',
] as const;
export type RegionId = (typeof REGION_IDS)[number];

export interface RegionPreset {
  id: RegionId;
  name: string;
  description: string;
  latitudeDeg: number; // north positive; convert with DEG before calling astro functions
  longitudeDeg: number; // east positive
  defaultDate: string; // YYYY-MM-DD, seasonally typical and at a full moon, so nights have moonlight
  water: WaterOptics;
  swell: RegionSwell; // background swell under weather presets without one (Auto sea state)
  typicalWeather: string; // weather preset id that suits the default season
}

export const REGIONS: Readonly<Record<RegionId, RegionPreset>> = {
  arctic: {
    id: 'arctic',
    name: 'Arctic',
    description: 'Norwegian Sea off Lofoten: midnight sun in summer, polar night in winter',
    // Open water ~150 km west of Andøya (Vesterålen) and north-west of Lofoten, 2–3 km deep.
    latitudeDeg: 70,
    longitudeDeg: 10,
    // Full moon, inside the midnight-sun season (about 19 May to 25 July at 70°N). The summer full
    // moon is very low in the south there: it barely clears the horizon.
    defaultDate: '2026-06-29',
    water: {
      chlorophyll: 1.0,
      absorption: [0.48, 0.095, 0.12],
      scattering: [0.2, 0.26, 0.3],
      deepColor: [0.012, 0.05, 0.052],
      subsurfaceTint: [0.13, 0.47, 0.38],
    },
    swell: { label: 'Atlantic swell', height: 2, period: 11, fromDeg: 225 },
    typicalWeather: 'fair',
  },
  caribbean: {
    id: 'caribbean',
    name: 'Caribbean',
    description: 'Central Caribbean Sea, trade-wind season',
    latitudeDeg: 15,
    longitudeDeg: -75,
    defaultDate: '2026-03-03',
    water: {
      chlorophyll: 0.06,
      absorption: [0.45, 0.064, 0.021],
      scattering: [0.006, 0.01, 0.016],
      deepColor: [0.004, 0.07, 0.17],
      subsurfaceTint: [0.08, 0.78, 0.72],
    },
    swell: { label: 'Trade-wind swell', height: 1.2, period: 8, fromDeg: 70 },
    typicalWeather: 'breezy',
  },
  'north-atlantic': {
    id: 'north-atlantic',
    name: 'North Atlantic',
    description: 'Open ocean west of Ireland, autumn gale season',
    latitudeDeg: 50,
    longitudeDeg: -20,
    defaultDate: '2026-10-26',
    water: {
      chlorophyll: 0.8,
      absorption: [0.47, 0.085, 0.095],
      scattering: [0.17, 0.22, 0.26],
      deepColor: [0.012, 0.05, 0.058],
      subsurfaceTint: [0.12, 0.48, 0.42],
    },
    swell: { label: 'Atlantic swell', height: 2.5, period: 12, fromDeg: 270 },
    typicalWeather: 'near-gale',
  },
  'bering-sea': {
    id: 'bering-sea',
    name: 'Bering Sea',
    description: 'Southeastern Bering Sea shelf break, early winter',
    latitudeDeg: 57,
    longitudeDeg: -172,
    defaultDate: '2026-11-24',
    water: {
      chlorophyll: 1.5,
      absorption: [0.49, 0.11, 0.17],
      scattering: [0.26, 0.32, 0.38],
      deepColor: [0.016, 0.058, 0.05],
      subsurfaceTint: [0.16, 0.46, 0.34],
    },
    swell: { label: 'Aleutian swell', height: 2, period: 10, fromDeg: 250 },
    typicalWeather: 'gale',
  },
  mediterranean: {
    id: 'mediterranean',
    name: 'Mediterranean',
    description: 'Ionian Sea, early summer',
    latitudeDeg: 36,
    longitudeDeg: 18,
    defaultDate: '2026-06-30',
    water: {
      chlorophyll: 0.04,
      absorption: [0.45, 0.063, 0.024],
      scattering: [0.005, 0.008, 0.013],
      deepColor: [0.003, 0.04, 0.15],
      subsurfaceTint: [0.06, 0.55, 0.75],
    },
    swell: { label: 'Short swell', height: 0.5, period: 6, fromDeg: 315 },
    typicalWeather: 'fair',
  },
  'southern-ocean': {
    id: 'southern-ocean',
    name: 'Southern Ocean',
    description: 'Drake Passage, austral summer',
    latitudeDeg: -58,
    longitudeDeg: -64,
    defaultDate: '2026-12-24',
    water: {
      chlorophyll: 0.3,
      absorption: [0.46, 0.074, 0.05],
      scattering: [0.1, 0.13, 0.16],
      deepColor: [0.008, 0.045, 0.075],
      subsurfaceTint: [0.1, 0.5, 0.55],
    },
    swell: { label: 'Westerly swell', height: 3.5, period: 13, fromDeg: 250 },
    typicalWeather: 'near-gale',
  },
};

export const isRegionId = (value: string): value is RegionId =>
  (REGION_IDS as readonly string[]).includes(value);

// Unknown ids (e.g. a stale deep link) fall back to the North Atlantic.
export function getRegion(id: string): RegionPreset {
  return isRegionId(id) ? REGIONS[id] : REGIONS['north-atlantic'];
}
