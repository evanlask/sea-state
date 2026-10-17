// Scenario setup: mode, boat and fleet, where and when, weather, sea state and physics, with a
// summary footer and "Set sail". Edits host.state.setup in place; emits 'start' with the built
// ScenarioSetup.

import { REGION_IDS, REGIONS } from '../../../sim/astro/regions';
import { BOAT_KINDS } from '../../../sim/world/protocol';
import { boatArt } from '../boatArt';
import { boatCard, boatCards, statRows } from '../boats';
import { button, choice, field, h, section, slider, tabs } from '../dom';
import {
  buildScenarioSetup,
  describeRegionClimate,
  formatClock,
  formatDate,
  formatDuration,
  isStormPreset,
  LIMITS,
  loadingRelevance,
  MAX_FLEET,
  type ScenarioSetup,
  validateSetup,
  withRegion,
} from '../setup';
import { WEATHER_PRESETS } from '../weather';
import { frame, type MenuHost, type Screen } from './common';
import { seaPart, timePart, weatherPart } from './parts';

const MODE_CARDS = [
  {
    value: 'free-sail' as const,
    title: 'Free Sail',
    text: 'Any boat, any weather, no goals. Explore, compare boats, watch the sky turn.',
  },
  {
    value: 'storm-survival' as const,
    title: 'Storm Survival',
    text: 'Pick a storm and stay upright. Time, max roll, slams and green water are kept as local bests.',
  },
];

const PHYSICS_CARDS = [
  {
    value: 'arcade' as const,
    title: 'Arcade',
    text: 'Real top speeds and real seas, but the helm answers in seconds. Ships stop and turn quickly; sails trim themselves.',
  },
  {
    value: 'realistic' as const,
    title: 'Realistic',
    text: 'Real masses, rates and stopping distances — for the nerds. Crash stops take minutes; trim your own sails.',
  },
];

export function createSetupScreen(host: MenuHost): Screen {
  const s = (): ScenarioSetup => host.state.setup;
  const changed = (): void => refresh();
  // Whether the player has picked a weather this setup session: switching region then keeps it
  // rather than moving to the region's typical weather.
  let weatherPicked = false;

  const f = frame({ id: 'setup', title: 'Scenario', kicker: 'Set sail', onBack: () => host.back() });

  // --- Mode ---------------------------------------------------------------------------------
  const modeCards = MODE_CARDS.map((card) => {
    const el = button(
      [
        h('span', { class: 'menu-card-title', text: card.title }),
        h('span', { class: 'menu-card-sub', text: card.text }),
      ],
      () => {
        s().mode = card.value;
        if (card.value === 'storm-survival' && !isStormPreset(s().weather)) s().weather = 'gale';
        changed();
      },
      'menu-card menu-card-large',
      { 'aria-pressed': 'false' },
    );
    return { value: card.value, el };
  });
  const physicsCards = PHYSICS_CARDS.map((card) => {
    const el = button(
      [
        h('span', { class: 'menu-card-title', text: card.title }),
        h('span', { class: 'menu-card-sub', text: card.text }),
      ],
      () => {
        s().physicsMode = card.value;
        changed();
      },
      'menu-card menu-card-large',
      { 'aria-pressed': 'false' },
    );
    return { value: card.value, el };
  });
  const bests = h('div', { class: 'menu-bests' });
  const modePanel = h('div', {}, [
    section('Game mode', [
      h(
        'div',
        { class: 'menu-card-row' },
        modeCards.map((c) => c.el),
      ),
    ]),
    bests,
    section('Physics', [
      h(
        'div',
        { class: 'menu-card-row' },
        physicsCards.map((c) => c.el),
      ),
    ]),
  ]);

  // --- Boat ---------------------------------------------------------------------------------
  const boatButtons = boatCards().map((card) => {
    const el = button(
      [
        boatArt(card.kind),
        h('span', { class: 'menu-card-kicker', text: card.className }),
        h('span', { class: 'menu-card-title', text: card.name }),
        h('span', { class: 'menu-card-sub', text: card.description }),
        h(
          'dl',
          { class: 'menu-stats' },
          statRows(card).flatMap((row) => [h('dt', { text: row.label }), h('dd', { text: row.value })]),
        ),
        h('span', { class: 'menu-card-detail', text: `Modelled on the ${card.modelledOn}` }),
      ],
      () => {
        s().playerBoat = card.kind;
        changed();
      },
      'menu-card menu-boat-card',
      { 'aria-pressed': 'false', 'data-kind': card.kind },
    );
    return { kind: card.kind, el };
  });
  const fleetButtons = BOAT_KINDS.map((kind) => {
    const el = button(
      [h('span', { class: 'menu-check', attrs: { 'aria-hidden': 'true' } }), boatCard(kind).name],
      () => {
        const fleet = s().fleet;
        const i = fleet.indexOf(kind);
        if (i >= 0) fleet.splice(i, 1);
        else if (fleet.length < MAX_FLEET) fleet.push(kind);
        changed();
      },
      'menu-chip',
      { 'aria-pressed': 'false', title: boatCard(kind).className },
    );
    return { kind, el };
  });
  const cargo = choice(
    [
      { value: 'laden' as const, label: 'Laden' },
      { value: 'ballast' as const, label: 'In ballast' },
    ],
    s().loading.cargo,
    (v) => {
      s().loading.cargo = v;
      changed();
    },
    'Container ship load',
  );
  const pots = slider(
    s().loading.crabPots,
    { ...LIMITS.crabPots, label: 'Crab pots', format: (v) => `${v} pots · ${Math.round(v * 0.34)} t` },
    (v) => {
      s().loading.crabPots = v;
      changed();
    },
  );
  const cargoField = field(
    'Container ship',
    cargo.element,
    'Laden sits deep and stiff; in ballast she rides high, rolls quicker and catches more wind.',
  );
  const potsField = field(
    'Crab pots on deck',
    pots.element,
    'Each pot is ~340 kg high on deck: more pots, less stability.',
  );
  const loadingSection = section('Loading condition', [cargoField, potsField]);
  const boatPanel = h('div', {}, [
    section('Your boat', [
      h(
        'div',
        { class: 'menu-card-grid menu-boat-grid' },
        boatButtons.map((b) => b.el),
      ),
    ]),
    section('Fleet companions', [
      h('p', {
        class: 'menu-note',
        text: 'Optional. They sail alongside on autopilot; switch helm any time with Tab or the D-pad.',
      }),
      h(
        'div',
        { class: 'menu-chip-row' },
        fleetButtons.map((b) => b.el),
      ),
    ]),
    loadingSection,
  ]);

  // --- Where & when -------------------------------------------------------------------------
  const regionButtons = REGION_IDS.map((id) => {
    const region = REGIONS[id];
    const el = button(
      [
        h('span', { class: 'menu-card-title', text: region.name }),
        h('span', { class: 'menu-card-sub', text: region.description }),
        h('span', { class: 'menu-card-detail', text: describeRegionClimate(id) }),
        h('span', {
          class: 'menu-card-detail',
          text: `${Math.abs(region.latitudeDeg)}°${region.latitudeDeg >= 0 ? 'N' : 'S'} ${Math.abs(region.longitudeDeg)}°${region.longitudeDeg >= 0 ? 'E' : 'W'}`,
        }),
      ],
      () => {
        // The region's typical weather comes along unless the player has already chosen one.
        Object.assign(s(), withRegion(s(), id, { keepWeather: weatherPicked }));
        changed();
      },
      'menu-card',
      { 'aria-pressed': 'false' },
    );
    return { id, el };
  });
  const time = timePart(s, changed);
  const wherePanel = h('div', {}, [
    section('Region', [
      h(
        'div',
        { class: 'menu-card-grid menu-region-grid' },
        regionButtons.map((r) => r.el),
      ),
    ]),
    section('Date and time', [time.element]),
  ]);

  // --- Weather / sea ------------------------------------------------------------------------
  const weather = weatherPart(
    s,
    changed,
    (id) => s().mode !== 'storm-survival' || isStormPreset(id),
    () => (weatherPicked = true),
  );
  const survivalNote = h('p', {
    class: 'menu-note',
    text: 'Storm Survival: only storm presets are available.',
  });
  const weatherPanel = h('div', {}, [section('Weather', [survivalNote, weather.element])]);
  const sea = seaPart(s, changed);
  const seaPanel = h('div', {}, [section('Sea state', [sea.element])]);

  const tabStrip = tabs([
    { label: 'Mode', panel: modePanel },
    { label: 'Boat', panel: boatPanel },
    { label: 'Where & when', panel: wherePanel },
    { label: 'Weather', panel: weatherPanel },
    { label: 'Sea state', panel: seaPanel },
  ]);
  f.header.append(tabStrip.element);
  f.body.append(tabStrip.panels);

  // --- Footer -------------------------------------------------------------------------------
  const summary = h('div', { class: 'menu-summary', attrs: { 'aria-live': 'polite' } });
  const issues = h('div', { class: 'menu-note menu-note-warn' });
  const sail = button(
    [h('span', { class: 'menu-glyph menu-glyph-accept', attrs: { 'aria-hidden': 'true' } }), 'Set sail'],
    () => {
      if (validateSetup(s()).length > 0) return;
      weatherPicked = false; // the next setup session starts fresh
      host.emit('start', buildScenarioSetup(s()));
    },
    'menu-btn menu-btn-primary',
  );
  f.footer.append(h('div', { class: 'menu-footer-middle' }, [summary, issues]), sail);

  function renderBests(): void {
    bests.replaceChildren();
    bests.hidden = s().mode !== 'storm-survival';
    if (bests.hidden) return;
    const results = host.state.survival.filter((r) => r.boat === s().playerBoat);
    const rows = results.length
      ? results.map((r) =>
          h('tr', {}, [
            h('td', { text: WEATHER_PRESETS[r.weather].name }),
            h('td', { text: formatDuration(r.survivedS) }),
            h('td', { text: `${Math.round(r.maxRollDeg)}°` }),
            h('td', { text: String(r.slams) }),
            h('td', { text: String(r.greenWater) }),
          ]),
        )
      : [
          h('tr', {}, [
            h('td', {
              attrs: { colspan: 5 },
              class: 'menu-empty',
              text: 'No results yet for this boat. Survive a storm to set one.',
            }),
          ]),
        ];
    bests.append(
      section(`Local bests · ${boatCard(s().playerBoat).name}`, [
        h('table', { class: 'menu-table menu-bests-table' }, [
          h('thead', {}, [
            h(
              'tr',
              {},
              ['Storm', 'Survived', 'Max roll', 'Slams', 'Green water'].map((t) => h('th', { text: t })),
            ),
          ]),
          h('tbody', {}, rows),
        ]),
      ]),
    );
  }

  function refresh(): void {
    const setup = s();
    for (const c of modeCards) c.el.setAttribute('aria-pressed', String(setup.mode === c.value));
    for (const c of physicsCards) c.el.setAttribute('aria-pressed', String(setup.physicsMode === c.value));
    for (const b of boatButtons) b.el.setAttribute('aria-pressed', String(setup.playerBoat === b.kind));
    const full = setup.fleet.length >= MAX_FLEET;
    for (const b of fleetButtons) {
      const on = setup.fleet.includes(b.kind);
      b.el.setAttribute('aria-pressed', String(on));
      b.el.toggleAttribute('disabled', !on && full);
    }
    const relevant = loadingRelevance([setup.playerBoat, ...setup.fleet]);
    cargoField.hidden = !relevant.cargo;
    potsField.hidden = !relevant.crabPots;
    loadingSection.hidden = !relevant.cargo && !relevant.crabPots;
    cargo.set(setup.loading.cargo);
    pots.set(setup.loading.crabPots);
    for (const r of regionButtons) r.el.setAttribute('aria-pressed', String(setup.region === r.id));
    survivalNote.hidden = setup.mode !== 'storm-survival';
    time.refresh();
    weather.refresh();
    sea.refresh();
    renderBests();

    const fleet = setup.fleet.length
      ? ` + ${setup.fleet.length} companion${setup.fleet.length > 1 ? 's' : ''}`
      : '';
    const parts = [
      setup.mode === 'storm-survival' ? 'Storm Survival' : 'Free Sail',
      `${boatCard(setup.playerBoat).name}${fleet}`,
      REGIONS[setup.region].name,
      `${formatDate(setup.date)} ${formatClock(setup.timeOfDay)}`,
      WEATHER_PRESETS[setup.weather].name,
      setup.sea.mode === 'auto' ? 'Auto sea' : 'Manual sea',
      setup.physicsMode === 'arcade' ? 'Arcade' : 'Realistic',
    ];
    summary.replaceChildren(...parts.map((p) => h('span', { class: 'menu-summary-item', text: p })));
    const problems = validateSetup(setup);
    issues.textContent = problems.map((p) => p.message).join(' ');
    sail.toggleAttribute('disabled', problems.length > 0);
  }

  return {
    id: 'setup',
    element: f.root,
    tabs: tabStrip,
    show: refresh,
    initialFocus: () => sail,
  };
}
