// Menu lab (dev only): every menu screen over a painted ocean, driven by a real InputManager so
// keyboard navigation can be tried. ?screen=main|setup|pause|conditions|fleet|
// settings|help opens a screen; emitted events are logged bottom right.

import '../styles/base.css';
import { attachInputListeners } from '../input/dom';
import { InputManager } from '../input/InputManager';
import { SettingsStore } from '../settings/store';
import type { BoatKind } from '../sim/world/protocol';
import { MenuController, type FleetEntry, type ScreenId } from '../ui/menu/MenuController';
import { SCREEN_IDS } from '../ui/menu/screens/common';

const log = document.querySelector<HTMLElement>('.lab-log')!;
const playing = document.querySelector<HTMLElement>('.lab-playing')!;
const write = (line: string): void => {
  log.textContent = `${new Date().toLocaleTimeString()} ${line}\n${log.textContent ?? ''}`.slice(0, 6000);
};

const settings = new SettingsStore({ key: 'sea-state:menu-lab-settings' });
const menu = new MenuController(document.body, { settings, storage: localStorage });

let fleet: FleetEntry[] = [
  { id: 'b1', kind: 'powerboat', helm: true },
  { id: 'b2', kind: 'sail', helm: false },
  { id: 'b3', kind: 'cargo', helm: false },
];
let nextId = 4;
const pushFleet = (): void => menu.setFleet(fleet);
pushFleet();
menu.setSurvivalResults([
  {
    boat: 'powerboat',
    weather: 'gale',
    survivedS: 754,
    maxRollDeg: 48,
    slams: 31,
    greenWater: 4,
    date: '2026-10-01',
  },
  {
    boat: 'powerboat',
    weather: 'storm',
    survivedS: 212,
    maxRollDeg: 97,
    slams: 18,
    greenWater: 9,
    date: '2026-10-03',
  },
]);

const short = (value: unknown): string => {
  const text = JSON.stringify(value);
  return text === undefined ? '' : text.length > 220 ? `${text.slice(0, 220)}…` : text;
};

menu.on('start', (setup) => {
  write(`start ${short(setup)}`);
  menu.hide();
  playing.hidden = false;
});
menu.on('resume', () => {
  write('resume');
  menu.hide();
  playing.hidden = false;
});
menu.on('quit', () => {
  write('quit');
  playing.hidden = true;
  menu.showMain();
});
menu.on('conditions', (c) => write(`conditions ${short(c)}`));
menu.on('screen', (e) => write(`screen ${e.previous ?? '∅'} → ${e.screen ?? '∅'}`));
menu.on('fleetAdd', (kind: BoatKind) => {
  write(`fleetAdd ${kind}`);
  fleet = [...fleet, { id: `b${nextId++}`, kind, helm: false }];
  pushFleet();
});
menu.on('fleetRemove', (id) => {
  write(`fleetRemove ${id}`);
  fleet = fleet.filter((b) => b.id !== id);
  pushFleet();
});
menu.on('takeHelm', (id) => {
  write(`takeHelm ${id}`);
  fleet = fleet.map((b) => ({ ...b, helm: b.id === id }));
  pushFleet();
});
settings.subscribe((s, prev) => {
  const changed = (Object.keys(s) as (keyof typeof s)[]).filter(
    (k) => JSON.stringify(s[k]) !== JSON.stringify(prev[k]),
  );
  write(`settings ${changed.join(', ')} → ${short(Object.fromEntries(changed.map((k) => [k, s[k]])))}`);
});

const param = new URLSearchParams(location.search).get('screen');
const screen = (SCREEN_IDS as readonly string[]).includes(param ?? '') ? (param as ScreenId) : 'main';
const PAUSE_CHILDREN: readonly ScreenId[] = ['conditions', 'fleet'];
if (screen === 'pause' || PAUSE_CHILDREN.includes(screen)) menu.showPause();
else menu.showMain();
if (screen !== 'main' && screen !== 'pause') menu.open(screen);

const input = new InputManager();
attachInputListeners(input, { target: document.body });
let last = performance.now();
const frame = (now: number): void => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const f = input.poll(dt, menu.isOpen ? 'menu' : 'ship');
  if (menu.isOpen) menu.update(f.menu, dt);
  else if (f.triggered.has('pause')) {
    playing.hidden = true;
    menu.showPause();
  } else if (f.triggered.has('help')) {
    playing.hidden = true;
    menu.showPause();
    menu.open('help');
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
