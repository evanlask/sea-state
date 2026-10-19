// Help: controls per helm class generated from the bindings table, sailing, hydroplane and lights
// primers, and tips.

import type { PollContext } from '../../../input/contexts';
import { boatCard, helmClasses } from '../boats';
import { GAMEPLAY_TIPS, HYDRO_PRIMER, LIGHTS_PRIMER, SAILING_PRIMER, type Article } from '../content';
import { choice, h, section, tabs } from '../dom';
import { buildHelpTables, keyTokens } from '../helpTables';
import { frame, type MenuHost, type Screen } from './common';

function keys(text: string): HTMLElement {
  return h(
    'span',
    { class: 'menu-keys' },
    keyTokens(text).map((t) =>
      t.cap ? h('kbd', { text: t.text }) : h('span', { class: 'menu-keys-sep', text: t.text }),
    ),
  );
}

function controlsTable(context: PollContext): HTMLElement {
  return h(
    'div',
    { class: 'menu-help-tables' },
    buildHelpTables(context).map((table) =>
      section(table.title, [
        h('table', { class: 'menu-table menu-help-table' }, [
          h('thead', {}, [h('tr', {}, [h('th', { text: 'Action' }), h('th', { text: 'Keyboard' })])]),
          h(
            'tbody',
            {},
            table.rows.map((row) =>
              h('tr', { class: 'menu-readable', attrs: { tabindex: 0 } }, [
                h('td', {}, [
                  h('div', { class: 'menu-help-action', text: row.label }),
                  h('div', { class: 'menu-help-desc', text: row.description }),
                ]),
                h('td', {}, [keys(row.keyboard)]),
              ]),
            ),
          ),
        ]),
      ]),
    ),
  );
}

// Text blocks are focusable so the arrow keys can step (and scroll) through them.
const focusable = <T extends HTMLElement>(el: T): T => {
  el.tabIndex = 0;
  el.classList.add('menu-readable');
  return el;
};

function article(a: Article): HTMLElement {
  return focusable(
    section(a.title, [
      ...a.paragraphs.map((p) => h('p', { class: 'menu-prose', text: p })),
      a.points
        ? h(
            'dl',
            { class: 'menu-points' },
            a.points.flatMap((pt) => [
              h('dt', { text: pt.term, attrs: { 'data-tone': pt.tone } }),
              h('dd', { text: pt.text }),
            ]),
          )
        : null,
    ]),
  );
}

// Top-down sketch of the light arcs (bow up), so the primer has a picture.
function lightsDiagram(): HTMLElement {
  const at = (r: number, deg: number): string => {
    const a = (deg * Math.PI) / 180;
    return `${(r * Math.sin(a)).toFixed(1)} ${(-r * Math.cos(a)).toFixed(1)}`;
  };
  const R = 92;
  const M = 104;
  const wrap = h('figure', { class: 'menu-lights-diagram' });
  wrap.innerHTML = `
    <svg viewBox="-120 -120 240 240" aria-hidden="true">
      <path class="arc arc-port" d="M0 0 L${at(R, 0)} A${R} ${R} 0 0 0 ${at(R, -112.5)} Z"/>
      <path class="arc arc-stbd" d="M0 0 L${at(R, 0)} A${R} ${R} 0 0 1 ${at(R, 112.5)} Z"/>
      <path class="arc arc-stern" d="M0 0 L${at(R, 112.5)} A${R} ${R} 0 0 1 ${at(R, 247.5)} Z"/>
      <path class="arc-mast" d="M${at(M, -112.5)} A${M} ${M} 0 1 1 ${at(M, 112.5)}"/>
      <path class="hull" d="M0 -30 C9 -18 11 6 8 26 L-8 26 C-11 6 -9 -18 0 -30 Z"/>
      <text x="-58" y="-28">PORT</text><text x="30" y="-28">STBD</text>
      <text x="-17" y="62">STERN</text><text x="-30" y="-108">MASTHEAD</text>
    </svg>
    <figcaption>Sidelights 112.5° each · masthead 225° · sternlight 135°</figcaption>`;
  return wrap;
}

export function createHelpScreen(host: MenuHost): Screen {
  const f = frame({
    id: 'help',
    title: 'Help',
    kicker: 'Controls and seamanship',
    onBack: () => host.back(),
  });

  const classes = helmClasses();
  const tableHolder = h('div', { class: 'menu-help-holder' });
  const showContext = (context: PollContext): void => tableHolder.replaceChildren(controlsTable(context));
  const options = [
    ...classes.map((c) => ({
      value: c.context as PollContext,
      label: c.title,
      title: c.boats.map((kind) => boatCard(kind).name).join(', '),
    })),
    { value: 'photo' as PollContext, label: 'Photo mode', title: 'Free camera (K / hold R3)' },
    { value: 'menu' as PollContext, label: 'Menus' },
  ];
  const picker = choice(
    options,
    'ship',
    (v) => {
      picker.set(v);
      showContext(v);
    },
    'Show controls for',
  );
  showContext('ship');

  const controls = h('div', {}, [
    h('div', { class: 'menu-help-picker' }, [
      h('span', { class: 'menu-field-label', text: 'Show controls for' }),
      picker.element,
    ]),
    tableHolder,
  ]);
  const sailing = h('div', { class: 'menu-articles' }, SAILING_PRIMER.map(article));
  const hydro = h('div', { class: 'menu-articles' }, HYDRO_PRIMER.map(article));
  const lights = h('div', { class: 'menu-articles menu-lights' }, [
    lightsDiagram(),
    ...LIGHTS_PRIMER.map(article),
  ]);
  const tips = h('div', {}, [
    section('Tips', [
      h(
        'ul',
        { class: 'menu-tips' },
        GAMEPLAY_TIPS.map((t) => focusable(h('li', { text: t }))),
      ),
    ]),
  ]);
  const tabStrip = tabs([
    { label: 'Controls', panel: controls },
    { label: 'Sailing primer', panel: sailing },
    { label: 'Hydroplane', panel: hydro },
    { label: 'Navigation lights', panel: lights },
    { label: 'Tips', panel: tips },
  ]);
  f.header.append(tabStrip.element);
  f.body.append(tabStrip.panels);
  return {
    id: 'help',
    element: f.root,
    tabs: tabStrip,
    initialFocus: () => f.header.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
  };
}
