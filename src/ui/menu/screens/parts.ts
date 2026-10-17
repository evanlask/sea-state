// Condition editors shared by scenario setup and the pause menu's Conditions screen: weather
// preset grid with the custom panel, sea-state auto/manual panel, and date / time sliders.
// Each edits a draft in place through a getter and calls onChange; refresh() re-reads it.

import { moonIllumination } from '../../../sim/astro/lunar';
import { REGIONS } from '../../../sim/astro/regions';
import { moonPhaseName } from '../../hud/format';
import { choice, type Control, field, h, section, slider, toggle } from '../dom';
import {
  dateFromDayOfYear,
  dayOfYear,
  daylight,
  daysInYear,
  describeDaylight,
  formatClock,
  formatDate,
  LIMITS,
  manualHs,
  nightTimeFor,
  regionSwellText,
  type ScenarioSetup,
  yearOf,
} from '../setup';
import {
  beaufort,
  beaufortName,
  CLOUD_TYPES,
  type CloudType,
  CUSTOM_LIMITS,
  DOUGLAS,
  describePreset,
  douglasCode,
  estimateSea,
  presetDetail,
  validateCustomWeather,
  WEATHER_PRESETS,
  type WeatherPresetId,
  weatherPresets,
} from '../weather';

type Draft = Pick<ScenarioSetup, 'weather' | 'customWeather' | 'sea' | 'timeOfDay' | 'date' | 'region'>;

const wide = (el: HTMLElement): HTMLElement => {
  el.classList.add('menu-field-wide');
  return el;
};

export interface Part {
  readonly element: HTMLElement;
  refresh(): void;
}

const fixed = (digits: number, unit: string) => (v: number) => `${v.toFixed(digits)} ${unit}`;
const deg = (v: number): string => `${String(Math.round(v)).padStart(3, '0')}°`;
const pct = (v: number): string => `${Math.round(v * 100)}%`;
const signedDeg = (v: number): string => (v === 0 ? '0°' : `${v > 0 ? '+' : '−'}${Math.abs(Math.round(v))}°`);

// Visibility spans 50 m to 50 km, so the slider is logarithmic.
const VIS_MIN = CUSTOM_LIMITS.visibilityKm.min;
const VIS_MAX = CUSTOM_LIMITS.visibilityKm.max;
const visToSlider = (km: number): number => (100 * Math.log(km / VIS_MIN)) / Math.log(VIS_MAX / VIS_MIN);
const sliderToVis = (p: number): number => {
  const km = VIS_MIN * Math.pow(VIS_MAX / VIS_MIN, p / 100);
  return km < 1 ? Math.round(km * 100) / 100 : Math.round(km * 10) / 10;
};
const fmtVis = (km: number): string =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;

const CLOUD_LABELS: Record<CloudType, string> = {
  clear: 'Clear',
  cirrus: 'Cirrus',
  cumulus: 'Cumulus',
  stratocumulus: 'Stratocumulus',
  stratus: 'Stratus',
  nimbostratus: 'Nimbostratus',
  cumulonimbus: 'Cumulonimbus',
};

// Mean wind for the current choice (preset or custom), for the sea-state estimate.
function windOf(draft: Pick<Draft, 'weather' | 'customWeather'>): number {
  return draft.weather === 'custom' ? draft.customWeather.windKn : WEATHER_PRESETS[draft.weather].windKn;
}

// ---------------------------------------------------------------------------------------------

export function weatherPart(
  get: () => Draft,
  onChange: () => void,
  allowed: (id: WeatherPresetId) => boolean = () => true,
  onPick: (id: WeatherPresetId) => void = () => {},
): Part {
  const grid = h('div', { class: 'menu-card-grid menu-weather-grid' });
  const cards = weatherPresets().map((preset) => {
    const card = h(
      'button',
      {
        class: `menu-card menu-weather-card${preset.storm ? ' is-storm' : ''}`,
        attrs: { type: 'button', 'aria-pressed': 'false', 'data-weather': preset.id },
        on: {
          click: () => {
            const draft = get();
            draft.weather = preset.id;
            // The night preset brings the night with it.
            if (preset.id === 'night-thunderstorm')
              draft.timeOfDay = nightTimeFor(daylight(draft.region, draft.date), draft.timeOfDay);
            onPick(preset.id);
            onChange();
          },
        },
      },
      [
        h('span', { class: 'menu-card-title', text: preset.name }),
        h('span', { class: 'menu-card-sub', text: describePreset(preset) }),
        preset.id === 'custom' ? null : h('span', { class: 'menu-card-detail', text: presetDetail(preset) }),
      ],
    );
    grid.append(card);
    return { id: preset.id, card };
  });

  const c = (): ScenarioSetup['customWeather'] => get().customWeather;
  const edit = (apply: () => void): void => {
    apply();
    onChange();
  };
  const controls: { refresh: () => void }[] = [];
  const bindSlider = (
    label: string,
    key: 'windKn' | 'windFromDeg' | 'gustKn' | 'cloudCover' | 'rain' | 'lightning',
    format: (v: number) => string,
    description?: string,
  ): HTMLElement => {
    const limits = CUSTOM_LIMITS[key];
    const s = slider(c()[key], { ...limits, label, format }, (v) =>
      edit(() => {
        c()[key] = v;
        if (key === 'windKn' && c().gustKn < v) c().gustKn = v;
        if (key === 'gustKn' && v < c().windKn) c().windKn = v;
      }),
    );
    controls.push({ refresh: () => s.set(c()[key]) });
    return field(label, s.element, description);
  };
  const vis = slider(
    visToSlider(c().visibilityKm),
    { min: 0, max: 100, step: 1, label: 'Visibility', format: (p) => fmtVis(sliderToVis(p)) },
    (p) => edit(() => (c().visibilityKm = sliderToVis(p))),
  );
  controls.push({ refresh: () => vis.set(visToSlider(c().visibilityKm)) });
  const cloudType = choice<CloudType>(
    CLOUD_TYPES.map((type) => ({ value: type, label: CLOUD_LABELS[type], title: type })),
    c().cloudType,
    (value) =>
      edit(() => {
        c().cloudType = value;
        if (value !== 'clear' && c().cloudCover === 0) c().cloudCover = 0.5;
        if (value !== 'cumulonimbus') c().lightning = 0;
      }),
    'Cloud type',
  );
  controls.push({ refresh: () => cloudType.set(c().cloudType) });
  const issues = h('p', { class: 'menu-note menu-note-warn', attrs: { 'aria-live': 'polite' } });
  const beaufortLine = h('p', { class: 'menu-note' });

  const custom = section(
    'Custom weather',
    [
      h('div', { class: 'menu-field-grid' }, [
        bindSlider('Wind speed', 'windKn', (v) => `${Math.round(v)} kn`),
        bindSlider('Wind from', 'windFromDeg', deg, 'Direction the wind blows from, true'),
        bindSlider('Gusts', 'gustKn', (v) => `${Math.round(v)} kn`, 'Peak gust speed'),
        bindSlider('Cloud cover', 'cloudCover', pct),
        wide(field('Cloud type', cloudType.element)),
        bindSlider('Rain', 'rain', (v) =>
          v === 0 ? 'None' : v < 0.25 ? 'Drizzle' : v < 0.6 ? 'Rain' : v < 0.85 ? 'Heavy' : 'Torrential',
        ),
        field('Visibility', vis.element),
        bindSlider(
          'Lightning',
          'lightning',
          (v) => (v === 0 ? 'None' : v < 0.4 ? 'Occasional' : v < 0.75 ? 'Frequent' : 'Continuous'),
          'Needs cumulonimbus',
        ),
      ]),
      beaufortLine,
      issues,
    ],
    'menu-custom-weather',
  );

  const element = h('div', { class: 'menu-part menu-weather' }, [grid, custom]);
  return {
    element,
    refresh() {
      const draft = get();
      for (const { id, card } of cards) {
        card.setAttribute('aria-pressed', String(draft.weather === id));
        const enabled = allowed(id);
        card.toggleAttribute('disabled', !enabled);
        card.classList.toggle('is-unavailable', !enabled);
      }
      custom.hidden = draft.weather !== 'custom';
      for (const control of controls) control.refresh();
      const force = beaufort(c().windKn);
      beaufortLine.textContent = `Force ${force} — ${beaufortName(force)}`;
      issues.textContent = validateCustomWeather(c()).issues.join(' · ');
    },
  };
}

// ---------------------------------------------------------------------------------------------

export function seaPart(get: () => Draft, onChange: () => void): Part {
  const sea = (): ScenarioSetup['sea'] => get().sea;
  const m = (): ScenarioSetup['sea']['manual'] => get().sea.manual;
  const edit = (apply: () => void): void => {
    apply();
    onChange();
  };
  const refreshers: (() => void)[] = [];

  const mode = choice(
    [
      { value: 'auto' as const, label: 'Auto' },
      { value: 'manual' as const, label: 'Manual' },
    ],
    sea().mode,
    (v) => edit(() => (sea().mode = v)),
    'Sea state mode',
  );
  refreshers.push(() => mode.set(sea().mode));

  const fetch = slider(
    sea().fetchKm,
    { ...LIMITS.fetchKm, label: 'Fetch', format: (v) => `${Math.round(v)} km` },
    (v) => edit(() => (sea().fetchKm = v)),
  );
  const developed = toggle(sea().fullyDeveloped, 'Fully developed', (v) =>
    edit(() => (sea().fullyDeveloped = v)),
  );
  refreshers.push(
    () => fetch.set(sea().fetchKm),
    () => developed.set(sea().fullyDeveloped),
  );
  const estimate = h('div', { class: 'menu-readout' });
  const auto = h('div', { class: 'menu-sea-auto' }, [
    h('div', { class: 'menu-field-grid' }, [
      field('Fetch', fetch.element, 'Open water the wind has blown over. Short fetch, smaller seas.'),
      field(
        'Fully developed',
        developed.element,
        'The wind has blown long enough for the sea to stop growing.',
      ),
    ]),
    estimate,
  ]);

  type ManualKey =
    | 'douglas'
    | 'hs'
    | 'tp'
    | 'choppiness'
    | 'directionOffsetDeg'
    | 'swellHeight'
    | 'swellPeriod'
    | 'swellFromDeg';
  const manualSlider = (
    label: string,
    key: ManualKey,
    format: (v: number) => string,
    description?: string,
  ): HTMLElement => {
    const s = slider(m()[key], { ...LIMITS[key], label, format }, (v) => edit(() => (m()[key] = v)));
    refreshers.push(() => s.set(m()[key]));
    return field(label, s.element, description);
  };
  const spec = choice(
    [
      { value: 'douglas' as const, label: 'Douglas code' },
      { value: 'hs' as const, label: 'Wave height' },
    ],
    m().spec,
    (v) => edit(() => (m().spec = v)),
    'Height from',
  );
  const crest: Control<'short' | 'long'> = choice(
    [
      { value: 'short' as const, label: 'Short-crested' },
      { value: 'long' as const, label: 'Long-crested' },
    ],
    m().crest,
    (v) => edit(() => (m().crest = v)),
    'Crest length',
  );
  refreshers.push(
    () => spec.set(m().spec),
    () => crest.set(m().crest),
  );
  const douglasField = manualSlider(
    'Douglas sea state',
    'douglas',
    (v) => `${v} · ${DOUGLAS[v]?.name ?? ''}`,
  );
  const hsField = manualSlider(
    'Significant height (Hs)',
    'hs',
    fixed(1, 'm'),
    'Mean of the highest third of waves',
  );
  const manual = h('div', { class: 'menu-sea-manual' }, [
    h('h4', { class: 'menu-subhead', text: 'Wind sea' }),
    h('div', { class: 'menu-field-grid' }, [
      field('Height from', spec.element),
      douglasField,
      hsField,
      manualSlider('Peak period (Tp)', 'tp', fixed(1, 's')),
      manualSlider('Choppiness', 'choppiness', pct, 'How sharp the crests are'),
      field('Crests', crest.element, 'Short: confused wind sea. Long: clean, regular lines.'),
      manualSlider('Direction offset', 'directionOffsetDeg', signedDeg, 'Waves relative to the wind'),
    ]),
    h('h4', { class: 'menu-subhead', text: 'Swell' }),
    h('div', { class: 'menu-field-grid' }, [
      manualSlider('Swell height', 'swellHeight', fixed(1, 'm')),
      manualSlider('Swell period', 'swellPeriod', fixed(1, 's')),
      manualSlider('Swell from', 'swellFromDeg', deg),
    ]),
  ]);
  const manualReadout = h('div', { class: 'menu-readout' });
  manual.append(manualReadout);

  const element = h('div', { class: 'menu-part menu-sea' }, [
    field('Sea state', mode.element, 'Auto derives the sea from the wind; Manual sets every parameter.'),
    auto,
    manual,
  ]);
  return {
    element,
    refresh() {
      for (const r of refreshers) r();
      const s = sea();
      auto.hidden = s.mode !== 'auto';
      manual.hidden = s.mode !== 'manual';
      douglasField.hidden = s.manual.spec !== 'douglas';
      hsField.hidden = s.manual.spec !== 'hs';
      const wind = windOf(get());
      const est = estimateSea(wind, s.fetchKm, s.fullyDeveloped);
      const preset = get().weather === 'custom' ? null : WEATHER_PRESETS[get().weather];
      // Presets without a swell of their own get the region's (scenarioConfig.seaStateFor).
      const swell = preset?.swell ?? regionSwellText(get().region);
      estimate.textContent =
        `From ${Math.round(wind)} kn of wind: Hs ≈ ${est.hs.toFixed(1)} m · Tp ≈ ${est.tp.toFixed(0)} s · ` +
        `Douglas ${est.douglas} ${DOUGLAS[est.douglas]!.name} · plus ${swell}`;
      const hs = manualHs(s.manual);
      const code = douglasCode(hs);
      manualReadout.textContent = `Hs ${hs.toFixed(1)} m · Douglas ${code} ${DOUGLAS[code]!.name}`;
    },
  };
}

// ---------------------------------------------------------------------------------------------

export function timePart(get: () => Draft, onChange: () => void): Part {
  const year = (): number => yearOf(get().date);
  const date = slider(
    dayOfYear(get().date),
    {
      min: 1,
      max: daysInYear(year()),
      step: 1,
      label: 'Date',
      format: (d) => formatDate(dateFromDayOfYear(year(), d)),
    },
    (d) => {
      get().date = dateFromDayOfYear(year(), d);
      onChange();
    },
  );
  const time = slider(
    get().timeOfDay,
    { ...LIMITS.timeOfDay, label: 'Time of day', format: formatClock },
    (v) => {
      get().timeOfDay = v;
      onChange();
    },
  );
  const light = h('p', { class: 'menu-note' });
  const element = h('div', { class: 'menu-part menu-time' }, [
    h('div', { class: 'menu-field-grid' }, [
      field('Date', date.element, 'Season, sun and moon. Moving region resets it to that region’s season.'),
      field('Time of day', time.element, 'Local solar time.'),
    ]),
    light,
  ]);
  return {
    element,
    refresh() {
      const draft = get();
      date.input.max = String(daysInYear(year()));
      date.set(dayOfYear(draft.date));
      time.set(draft.timeOfDay);
      const text = describeDaylight(daylight(draft.region, draft.date));
      // The moon that night (local midnight): a full moon lights the sea.
      const midnight =
        Date.parse(`${draft.date}T00:00:00Z`) + (24 - REGIONS[draft.region].longitudeDeg / 15) * 3.6e6;
      const moon = Number.isFinite(midnight) ? moonIllumination(new Date(midnight)) : null;
      const moonText = moon ? `${moonPhaseName(moon.phase)} (${Math.round(moon.fraction * 100)}%)` : '';
      light.textContent = [text ? `${REGIONS[draft.region].name}: ${text}` : '', moonText]
        .filter(Boolean)
        .join(' · ');
    },
  };
}
