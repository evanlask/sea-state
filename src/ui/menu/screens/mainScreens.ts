// Main menu and pause menu: short vertical button stacks over the live ocean.

import { boatCard } from '../boats';
import { button, h } from '../dom';
import { formatClock } from '../setup';
import { WEATHER_PRESETS } from '../weather';
import type { MenuHost, Screen } from './common';

export function createMainScreen(host: MenuHost): Screen {
  const cont = button('Continue', () => {
    if (host.state.lastSetup) host.emit('start', structuredClone(host.state.lastSetup));
  });
  const contDetail = h('span', { class: 'menu-main-detail' });
  const sail = button('Sail', () => host.open('setup'), 'menu-btn menu-btn-primary');
  const items = h('nav', { class: 'menu-main-items', attrs: { 'aria-label': 'Main menu' } }, [
    sail,
    h('div', { class: 'menu-main-continue' }, [cont, contDetail]),
    button('Settings', () => host.open('settings')),
    button('Help', () => host.open('help')),
  ]);
  const element = h('div', { class: 'menu-screen menu-screen-main', attrs: { 'data-screen': 'main' } }, [
    h('div', { class: 'menu-main' }, [
      h('h1', { class: 'menu-logo', text: 'Sea~State', attrs: { 'aria-label': 'Sea State' } }),
      h('p', {
        class: 'menu-tagline',
        text: 'Six real boats. Any weather, from glassy calm to a Category 5.',
      }),
      items,
    ]),
    h('p', { class: 'menu-version', text: `v${__APP_VERSION__}` }),
  ]);
  return {
    id: 'main',
    element,
    show() {
      const last = host.state.lastSetup;
      const continueRow = cont.parentElement!;
      continueRow.hidden = !last;
      contDetail.textContent = last
        ? `${boatCard(last.playerBoat).name} · ${WEATHER_PRESETS[last.weather].name} · ${formatClock(last.timeOfDay)}`
        : '';
      // A voyage to go back to comes first (and is the highlighted choice); otherwise Sail.
      if (last) items.prepend(continueRow);
      else items.prepend(sail);
      cont.classList.toggle('menu-btn-primary', !!last);
      sail.classList.toggle('menu-btn-primary', !last);
    },
    initialFocus: () => (host.state.lastSetup ? cont : sail),
  };
}

export function createPauseScreen(host: MenuHost): Screen {
  const resume = button('Resume', () => host.emit('resume', undefined), 'menu-btn menu-btn-primary');
  const recover = button('Recover boat', () => host.emit('recover', undefined), 'menu-btn', {
    title: 'Put your boat upright again (Backspace in play)',
  });
  const conditions = button('Conditions', () => host.open('conditions'));
  const fleet = button('Fleet', () => host.open('fleet'));
  const items = h('nav', { class: 'menu-main-items', attrs: { 'aria-label': 'Pause menu' } }, [
    resume,
    conditions,
    fleet,
    recover,
    button('Settings', () => host.open('settings')),
    button('Help', () => host.open('help')),
    button('Main menu', () =>
      host.confirm({
        title: 'Leave this voyage?',
        message: 'You will return to the main menu. The current scenario can be resumed with Continue.',
        confirmLabel: 'Main menu',
        onConfirm: () => host.emit('quit', undefined),
      }),
    ),
  ]);
  const element = h('div', { class: 'menu-screen menu-screen-pause', attrs: { 'data-screen': 'pause' } }, [
    h('div', { class: 'menu-pause' }, [
      h('div', { class: 'menu-kicker', text: 'Paused' }),
      h('h2', { class: 'menu-pause-title', text: 'Sea~State', attrs: { 'aria-label': 'Sea State' } }),
      items,
    ]),
  ]);
  return {
    id: 'pause',
    element,
    // Capsized or sunk: Recover moves up under Resume; otherwise it waits after Fleet.
    show() {
      if (host.state.helmDown) resume.after(recover);
      else fleet.after(recover);
    },
    initialFocus: () => (host.state.helmDown ? recover : resume),
  };
}
