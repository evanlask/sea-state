// Pause-menu screens that act on the running scenario: Conditions (weather, time and sea without
// restarting) and Fleet (add / remove boats, take the helm).

import { BOAT_KINDS, type BoatKind } from '../../../sim/world/protocol';
import { boatArt } from '../boatArt';
import { boatCard } from '../boats';
import { button, h, section, tabs } from '../dom';
import { type Conditions, MAX_FLEET, type ScenarioSetup } from '../setup';
import { type FleetAutopilot, frame, type MenuHost, type Screen } from './common';
import { seaPart, timePart, weatherPart } from './parts';

type ConditionsDraft = Conditions & Pick<ScenarioSetup, 'region'>;

export function createConditionsScreen(host: MenuHost): Screen {
  let draft: ConditionsDraft = { ...structuredClone(host.state.conditions), region: host.state.setup.region };
  const get = (): ConditionsDraft => draft;
  let pending = false;
  // Coalesce a burst of slider events into one emission per task.
  const changed = (): void => {
    refresh();
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      const { region: _region, ...conditions } = draft;
      host.state.conditions = structuredClone(conditions);
      host.emit('conditions', structuredClone(conditions));
    });
  };
  const f = frame({
    id: 'conditions',
    title: 'Conditions',
    kicker: 'Changes apply live',
    onBack: () => host.back(),
  });
  const weather = weatherPart(get, changed);
  const time = timePart(get, changed);
  const sea = seaPart(get, changed);
  const tabStrip = tabs([
    { label: 'Weather', panel: h('div', {}, [section('Weather', [weather.element])]) },
    { label: 'Time', panel: h('div', {}, [section('Date and time', [time.element])]) },
    { label: 'Sea state', panel: h('div', {}, [section('Sea state', [sea.element])]) },
  ]);
  f.header.append(tabStrip.element);
  f.body.append(tabStrip.panels);
  f.footer.append(
    h('p', {
      class: 'menu-note menu-footer-middle',
      text: 'Weather blends in smoothly; in Realistic mode the sea takes time to build.',
    }),
  );
  function refresh(): void {
    weather.refresh();
    time.refresh();
    sea.refresh();
  }
  return {
    id: 'conditions',
    element: f.root,
    tabs: tabStrip,
    show() {
      const region = host.state.lastSetup?.region ?? host.state.setup.region;
      draft = { ...structuredClone(host.state.conditions), region };
      refresh();
    },
    initialFocus: () => f.root.querySelector<HTMLElement>('[aria-pressed="true"]'),
  };
}

// Autopilot choices for a boat nobody is helming; a sailboat holds a wind angle instead of a course.
export function autopilotModes(kind: BoatKind): [FleetAutopilot, string][] {
  return [
    ['follow', 'Follow'],
    kind === 'sail' ? ['windAngle', 'Hold wind angle'] : ['hold', 'Hold course'],
    ['circle', 'Circle'],
    ['drift', kind === 'sail' ? 'Drift' : 'Stop'],
  ];
}

export function createFleetScreen(host: MenuHost): Screen {
  const f = frame({
    id: 'fleet',
    title: 'Fleet',
    kicker: 'Boats in this sea',
    size: 'narrow',
    onBack: () => host.back(),
  });
  const list = h('ul', { class: 'menu-fleet-list' });
  const addButtons = BOAT_KINDS.map((kind) =>
    button(
      [h('span', { class: 'menu-plus', attrs: { 'aria-hidden': 'true' }, text: '+' }), boatCard(kind).name],
      () => host.emit('fleetAdd', kind),
      'menu-chip',
      { title: `Add a ${boatCard(kind).className.toLowerCase()}` },
    ),
  );
  const addNote = h('p', { class: 'menu-note' });
  f.body.append(
    section('In company', [list]),
    section('Add a boat', [addNote, h('div', { class: 'menu-chip-row' }, addButtons)]),
  );

  function render(): void {
    const fleet = host.state.fleet;
    list.replaceChildren(
      ...fleet.map((entry) => {
        const card = boatCard(entry.kind);
        const helm = button(
          entry.helm ? 'At the helm' : 'Take helm',
          () => host.emit('takeHelm', entry.id),
          'menu-btn menu-btn-small',
          {
            disabled: entry.helm,
          },
        );
        const remove = button(
          'Remove',
          () => host.emit('fleetRemove', entry.id),
          'menu-btn menu-btn-small menu-btn-ghost',
          {
            disabled: entry.helm || fleet.length <= 1,
            'aria-label': `Remove ${entry.name ?? card.name}`,
          },
        );
        const modes = autopilotModes(entry.kind);
        const pilot = entry.helm
          ? null
          : h(
              'div',
              {
                class: 'menu-chip-row menu-fleet-pilot',
                attrs: { role: 'group', 'aria-label': 'Autopilot' },
              },
              modes.map(([mode, label]) =>
                button(label, () => host.emit('fleetAutopilot', { id: entry.id, mode }), 'menu-chip', {
                  'aria-pressed': String((entry.autopilot ?? 'follow') === mode),
                }),
              ),
            );
        return h('li', { class: `menu-fleet-item${entry.helm ? ' is-helm' : ''}` }, [
          boatArt(entry.kind, true),
          h('div', { class: 'menu-fleet-text' }, [
            h('div', { class: 'menu-card-title', text: entry.name ?? card.name }),
            h('div', { class: 'menu-card-sub', text: card.className }),
          ]),
          helm,
          remove,
          ...(pilot ? [pilot] : []),
        ]);
      }),
    );
    if (fleet.length === 0) list.append(h('li', { class: 'menu-empty', text: 'No boats yet.' }));
    const full = fleet.length >= MAX_FLEET + 1;
    for (const b of addButtons) b.toggleAttribute('disabled', full);
    addNote.textContent = full
      ? `The fleet is full (${MAX_FLEET + 1} boats).`
      : 'New boats join in formation, spaced by size, on autopilot.';
  }

  return {
    id: 'fleet',
    element: f.root,
    show: render,
    initialFocus: () => f.body.querySelector<HTMLElement>('button:not([disabled])'),
  };
}
