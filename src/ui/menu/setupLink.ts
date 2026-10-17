// Deep links for debugging and getting straight to a scenario: Scenario's keys (boat, weather,
// time…) plus the setup-only choices, written only when they differ from the defaults:
//   &mode=storm-survival &cargo=ballast &pots=60
//   &wx=windKn:30,windFromDeg:250,…        (weather=custom)
//   &sea=mode:manual,spec:hs,hs:4,tp:9,…   (sea mode, fetch and the manual controls)

import { type Scenario, parseLaunchOptions, scenarioSearch } from '../../app/Scenario';
import { buildScenarioSetup, defaultSea, defaultSetup, sanitizeSetup, type ScenarioSetup } from './setup';

type Flat = Record<string, string | number | boolean>;

// A running voyage's choices (the setup fields are optional: a bare deep link has none).
export type LinkableSetup = Scenario &
  Partial<Pick<ScenarioSetup, 'mode' | 'loading' | 'customWeather' | 'sea'>>;

const SETUP_KEYS = ['mode', 'cargo', 'pots', 'wx', 'sea'];

const round = (v: number): number => Math.round(v * 1000) / 1000;

function encodeFlat(values: Flat): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}:${typeof v === 'number' ? round(v) : String(v)}`)
    .join(',');
}

function decodeFlat(text: string | null): Flat {
  const out: Flat = {};
  for (const pair of (text ?? '').split(',')) {
    const [key, raw] = pair.split(':');
    if (!key || raw === undefined) continue;
    const n = Number(raw);
    out[key] = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(n) ? n : raw;
  }
  return out;
}

// The URL search for a voyage; null strips everything (back at the main menu). Other flags in
// `current` (debug, quality, sim…) are kept.
export function setupSearch(setup: LinkableSetup | null, current = ''): string {
  const params = new URLSearchParams(scenarioSearch(setup, current));
  for (const key of SETUP_KEYS) params.delete(key);
  if (setup) {
    if (setup.mode && setup.mode !== 'free-sail') params.set('mode', setup.mode);
    const loading = setup.loading;
    if (loading && loading.cargo !== 'laden') params.set('cargo', loading.cargo);
    if (loading && loading.crabPots !== defaultSetup().loading.crabPots)
      params.set('pots', String(loading.crabPots));
    if (setup.weather === 'custom' && setup.customWeather)
      params.set('wx', encodeFlat({ ...setup.customWeather }));
    const sea = setup.sea;
    if (sea) {
      const { manual, ...auto } = sea;
      const flat: Flat = sea.mode === 'manual' ? { ...auto, ...manual } : { ...auto };
      const { manual: defaultManual, ...defaultAuto } = defaultSea();
      const defaults: Flat = { ...defaultAuto, ...defaultManual };
      for (const key of Object.keys(flat)) if (flat[key] === defaults[key]) delete flat[key];
      if (Object.keys(flat).length) params.set('sea', encodeFlat(flat));
    }
  }
  const search = params
    .toString()
    .replaceAll('%2C', ',')
    .replaceAll('%3A', ':')
    .replace(/=(?=&|$)/g, ''); // bare flags stay bare
  return search ? `?${search}` : '';
}

// The full setup a deep link describes, on top of `base` for anything the link leaves out.
export function setupFromSearch(search: string, base: ScenarioSetup = defaultSetup()): ScenarioSetup {
  const params = new URLSearchParams(search);
  const scenario = parseLaunchOptions(search, base).scenario;
  const sea = decodeFlat(params.get('sea'));
  const { mode: seaMode, fetchKm, fullyDeveloped, ...manual } = sea;
  // sanitizeSetup validates and clamps everything the link says, falling back to `base`.
  const linked = sanitizeSetup(
    {
      ...base,
      ...scenario,
      mode: params.get('mode') ?? base.mode,
      customWeather: { ...base.customWeather, ...decodeFlat(params.get('wx')) },
      sea: {
        ...base.sea,
        ...(seaMode !== undefined && { mode: seaMode }),
        ...(fetchKm !== undefined && { fetchKm }),
        ...(fullyDeveloped !== undefined && { fullyDeveloped }),
        manual: { ...base.sea.manual, ...manual },
      },
      loading: {
        cargo: params.get('cargo') ?? base.loading.cargo,
        crabPots: params.has('pots') ? Number(params.get('pots')) : base.loading.crabPots,
      },
    },
    base,
  );
  return buildScenarioSetup(linked);
}
