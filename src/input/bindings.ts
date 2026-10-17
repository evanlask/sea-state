// The bindings table: the single source of truth for what every key, button
// and stick does in each context. InputManager reads it to produce controls,
// the help screen renders it via describeBindings(), and a test checks it for
// conflicts.

import { type AxisSpec, axisSpec } from './axes';
import { activeContexts, type BoatContext, type InputContext, type PollContext } from './contexts';
import type { PadAxis, PadButton } from './gamepad';
import { parseChord } from './keyboard';

export type ControlAxisId =
  | 'telegraph'
  | 'throttle'
  | 'steer'
  | 'thruster'
  | 'trim'
  | 'mainSheet'
  | 'jibSheet';

type StickActionId = 'look' | 'menuNavigate' | 'photoMove';

// Camera axes (not boat controls): zoom, and photo mode's climb and aperture.
export type CameraAxisId = 'zoom' | 'photoRise' | 'photoAperture';

export const isCameraAxis = (id: string): id is CameraAxisId =>
  id === 'zoom' || id === 'photoRise' || id === 'photoAperture';

export type ButtonActionId =
  // Boat
  | 'allStop'
  | 'brake'
  | 'throttleOff'
  | 'midships'
  | 'reefIn'
  | 'reefOut'
  | 'furl'
  | 'autoTrim'
  | 'letFly'
  // Camera
  | 'cameraNext'
  | 'cameraPrev'
  | 'cameraReset'
  | 'photoMode'
  // Photo mode
  | 'photoSlowMo'
  // Global
  | 'horn'
  | 'navLights'
  | 'deckLights'
  | 'cabinLights'
  | 'signals'
  | 'extraLights'
  | 'nextBoat'
  | 'prevBoat'
  | 'recover'
  | 'hud'
  | 'help'
  | 'pause'
  | 'telemetry'
  | 'perf'
  | 'timeEarlier'
  | 'timeLater'
  | 'timeScale'
  // Menu
  | 'menuAccept'
  | 'menuBack'
  | 'menuTabPrev'
  | 'menuTabNext';

export type ActionId = ControlAxisId | StickActionId | CameraAxisId | ButtonActionId;

// 'press' fires on the down edge; 'tap' on release before the hold time;
// 'hold' once the button has been held for the hold time.
type PadMode = 'press' | 'tap' | 'hold';

export interface PadButtonBinding {
  button: PadButton;
  mode: PadMode;
}

interface BindingBase {
  contexts: readonly InputContext[];
  label: string;
  description: string;
  mouse?: string; // display only; mouse handling is fixed (look, orbit, wheel)
}

export interface ButtonBinding extends BindingBase {
  kind: 'button';
  id: ButtonActionId;
  keys: readonly string[];
  pad: readonly PadButtonBinding[];
}

export interface AxisBinding extends BindingBase {
  kind: 'axis';
  id: ControlAxisId | CameraAxisId;
  keysPos: readonly string[];
  keysNeg: readonly string[];
  padPos?: PadButton;
  padNeg?: PadButton;
  padAxis?: PadAxis;
  // A pad button that steps the quantity through presets (zoom: hold Y cycles near / normal / far).
  padStep?: PadButtonBinding;
  // Display order: "A / D" lists the negative key first, "W / S" the positive.
  negFirst?: boolean;
  // Feel per boat class; boat axes need a spec for every context they're in.
  specs?: Partial<Record<BoatContext, AxisSpec>>;
  // Realistic physics overrides (steering stays where it's left).
  realisticSpecs?: Partial<Record<BoatContext, AxisSpec>>;
}

export interface StickBinding extends BindingBase {
  kind: 'stick';
  id: StickActionId;
  keysLeft: readonly string[];
  keysRight: readonly string[];
  keysUp: readonly string[];
  keysDown: readonly string[];
  padStick: 'left' | 'right';
  padDpad?: boolean;
}

export type Binding = ButtonBinding | AxisBinding | StickBinding;

const press = (button: PadButton): PadButtonBinding => ({ button, mode: 'press' });
const tap = (button: PadButton): PadButtonBinding => ({ button, mode: 'tap' });
const hold = (button: PadButton): PadButtonBinding => ({ button, mode: 'hold' });

const SHIPS: readonly BoatContext[] = ['ship', 'cruise'];
const SMALL_POWERED: readonly BoatContext[] = ['powerboat', 'pwc'];

// Steering: in Arcade every helm springs back to centre when let go (ships at a stately rate); in
// Realistic it stays where it's left, as a real wheel, tiller or hydraulic helm does, and a stick
// turns it at a rate rather than holding it over. Midships (X) centres it.
const shipRudder = axisSpec('lever', { riseRate: 0.6, analogRate: 0.9 });
const shipSpring = axisSpec('spring', { riseRate: 0.8, returnRate: 1.2 });
const smallSteer = axisSpec('spring', { riseRate: 2.5, returnRate: 4 });
const smallHold = axisSpec('lever', { riseRate: 1.5, analogRate: 2 });
// The hydroplane's wheel comes on a little slower: full lock at 200 mph trips it over.
const hydroSteer = axisSpec('spring', { riseRate: 1.6, returnRate: 3 });
const thrusterFeel = axisSpec('spring', { riseRate: 1.5, returnRate: 2.5 });
const rateFeel = axisSpec('rate');

export const BINDINGS: readonly Binding[] = [
  // Boat controls
  {
    kind: 'axis',
    id: 'telegraph',
    contexts: SHIPS,
    label: 'Engine telegraph',
    description: 'One notch ahead / astern per press; triggers sweep the lever and it snaps to a notch',
    keysPos: ['KeyW'],
    keysNeg: ['KeyS'],
    padPos: 'RT',
    padNeg: 'LT',
    specs: { ship: axisSpec('notched', { riseRate: 0.8 }), cruise: axisSpec('notched', { riseRate: 1 }) },
  },
  {
    kind: 'axis',
    id: 'throttle',
    contexts: SMALL_POWERED,
    label: 'Throttle',
    description:
      'Center console: the lever stays where you set it. Jet ski: springs back when let go. S / LT goes astern',
    keysPos: ['KeyW'],
    keysNeg: ['KeyS'],
    padPos: 'RT',
    padNeg: 'LT',
    specs: {
      powerboat: axisSpec('lever', { riseRate: 0.5, analogRate: 0.8 }),
      pwc: axisSpec('spring', { riseRate: 2, returnRate: 4 }),
    },
  },
  {
    kind: 'axis',
    id: 'throttle',
    contexts: ['hydro'],
    label: 'Power lever',
    description:
      'The turbine’s power lever stays where you set it; the turbine takes about 3½ s to spool up to it. No reverse',
    keysPos: ['KeyW'],
    keysNeg: ['KeyS'],
    padPos: 'RT',
    padNeg: 'LT',
    specs: { hydro: axisSpec('lever', { riseRate: 0.8, analogRate: 1, min: 0 }) },
  },
  {
    kind: 'axis',
    id: 'mainSheet',
    contexts: ['sail'],
    label: 'Mainsheet',
    description: 'Pull the mainsail in (W / RT) or let it out (S / LT) while held; turns auto-trim off',
    keysPos: ['KeyW'],
    keysNeg: ['KeyS'],
    padPos: 'RT',
    padNeg: 'LT',
    specs: { sail: rateFeel },
  },
  {
    kind: 'axis',
    id: 'steer',
    contexts: ['ship', 'cruise', 'powerboat', 'pwc', 'hydro', 'sail'],
    label: 'Steer',
    description:
      'Rudder, pods, outboards or jet nozzle to port / starboard. Arcade: centres itself when let go. Realistic: stays put; X centres it',
    keysPos: ['KeyD'],
    keysNeg: ['KeyA'],
    padAxis: 'LX',
    negFirst: true,
    specs: {
      ship: shipSpring,
      cruise: shipSpring,
      powerboat: smallSteer,
      pwc: smallSteer,
      hydro: hydroSteer,
      sail: smallSteer,
    },
    realisticSpecs: {
      ship: shipRudder,
      cruise: shipRudder,
      powerboat: smallHold,
      pwc: smallHold,
      hydro: smallHold,
      sail: smallHold,
    },
  },
  {
    kind: 'axis',
    id: 'thruster',
    contexts: SHIPS,
    label: 'Bow thruster',
    description: 'Push the bow to port / starboard',
    keysPos: ['KeyE'],
    keysNeg: ['KeyQ'],
    padPos: 'RB',
    padNeg: 'LB',
    negFirst: true,
    specs: { ship: thrusterFeel, cruise: thrusterFeel },
  },
  {
    kind: 'axis',
    id: 'trim',
    contexts: ['powerboat'],
    label: 'Outboard trim',
    description: 'Trim the outboards down (bow down) / up (bow up)',
    keysPos: ['KeyE'],
    keysNeg: ['KeyQ'],
    padPos: 'RB',
    padNeg: 'LB',
    negFirst: true,
    specs: { powerboat: rateFeel },
  },
  {
    kind: 'axis',
    id: 'trim',
    contexts: ['hydro'],
    label: 'Wing trim',
    description:
      'Less wing (bow down) / more wing (bow up). Trim down in a chop or when the bow climbs; more wing holds the bow up off a wave',
    keysPos: ['KeyE'],
    keysNeg: ['KeyQ'],
    padPos: 'RB',
    padNeg: 'LB',
    negFirst: true,
    specs: { hydro: rateFeel },
  },
  {
    kind: 'axis',
    id: 'jibSheet',
    contexts: ['sail'],
    label: 'Jib sheet',
    description: 'Let the jib (front sail) out / pull it in while held; turns auto-trim off',
    keysPos: ['KeyE'],
    keysNeg: ['KeyQ'],
    padPos: 'RB',
    padNeg: 'LB',
    negFirst: true,
    specs: { sail: rateFeel },
  },
  {
    kind: 'button',
    id: 'allStop',
    contexts: SHIPS,
    label: 'All stop',
    description: 'Telegraph to Stop',
    keys: ['Space'],
    pad: [press('B')],
  },
  {
    kind: 'button',
    id: 'brake',
    contexts: SMALL_POWERED,
    label: 'Brake / reverse',
    description:
      'While held: the jet ski brakes with its reverse bucket, the center console drops to neutral',
    keys: ['Space'],
    pad: [press('B')],
  },
  {
    kind: 'button',
    id: 'throttleOff',
    contexts: ['hydro'],
    label: 'Throttle off',
    description:
      'Snap the power lever back to idle: the way out when the bow climbs or a wave is coming. The turbine still takes a couple of seconds to run down',
    keys: ['Space'],
    pad: [press('B')],
  },
  {
    kind: 'button',
    id: 'midships',
    contexts: ['ship', 'cruise', 'powerboat', 'pwc', 'hydro'],
    label: 'Midships',
    description:
      'Centre the helm (Realistic: it stays where you leave it). On a pad, X or click the steering stick',
    keys: ['KeyX'],
    pad: [press('X'), tap('L3')],
  },
  {
    // The sailboat's X button reefs; a click of the steering stick centres the wheel on every boat.
    kind: 'button',
    id: 'midships',
    contexts: ['sail'],
    label: 'Midships',
    description:
      'Centre the wheel (Realistic: it stays where you leave it). On a pad, click the steering stick',
    keys: ['KeyX'],
    pad: [tap('L3')],
  },
  {
    kind: 'button',
    id: 'reefIn',
    contexts: ['sail'],
    label: 'Reef',
    description: 'Make the mainsail smaller, one step at a time (three steps)',
    keys: ['KeyR'],
    pad: [tap('X')],
  },
  {
    kind: 'button',
    id: 'reefOut',
    contexts: ['sail'],
    label: 'Shake out reef',
    description: 'Make the mainsail one step bigger again',
    keys: ['Shift+KeyR'],
    pad: [hold('X')],
  },
  {
    kind: 'button',
    id: 'furl',
    contexts: ['sail'],
    label: 'Furl / unfurl jib',
    description: 'Roll the jib away a third per press; once it is fully rolled, the next press sets it again',
    keys: ['KeyF'],
    pad: [press('B')],
  },
  {
    kind: 'button',
    id: 'autoTrim',
    contexts: ['sail'],
    label: 'Auto-trim',
    description: 'Turn on or off: the crew trims the sails to the wind. On by default in Arcade',
    keys: ['KeyT'],
    pad: [hold('L3')],
  },
  {
    kind: 'button',
    id: 'letFly',
    contexts: ['sail'],
    label: 'Let fly',
    description:
      'While held, both sheets run right out and the sails spill the wind (a gust, a broach). Let go and auto-trim takes them back in; without it they stay out. Gamepad: ease with LT and LB',
    keys: ['Space'],
    pad: [],
  },

  // Camera
  {
    kind: 'button',
    id: 'cameraNext',
    contexts: ['camera'],
    label: 'Next camera',
    description: 'Cycle to the next camera',
    keys: ['KeyC'],
    pad: [tap('Y')],
  },
  {
    kind: 'button',
    id: 'cameraPrev',
    contexts: ['camera'],
    label: 'Previous camera',
    description: 'Cycle to the previous camera',
    keys: ['KeyV'],
    pad: [],
  },
  {
    kind: 'stick',
    id: 'look',
    contexts: ['camera'],
    label: 'Look / orbit',
    description:
      'Click the view to look around with the mouse (Esc lets go), or right-drag to orbit the boat',
    mouse: 'Mouse / right-drag',
    keysLeft: ['ArrowLeft'],
    keysRight: ['ArrowRight'],
    keysUp: ['ArrowUp'],
    keysDown: ['ArrowDown'],
    padStick: 'right',
  },
  {
    kind: 'axis',
    id: 'zoom',
    contexts: ['camera'],
    label: 'Zoom',
    description:
      'Zoom in / out (chase, orbit and drone cameras). Gamepad: hold Y to step near / normal / far',
    mouse: 'Wheel',
    keysPos: ['Minus'],
    keysNeg: ['Equal'],
    padStep: hold('Y'),
    negFirst: true,
  },
  {
    kind: 'button',
    id: 'cameraReset',
    contexts: ['camera'],
    label: 'Reset camera',
    description: 'Recentre the view (Cinematic: next shot)',
    keys: ['KeyZ'],
    pad: [tap('R3')],
  },
  {
    kind: 'button',
    id: 'photoMode',
    contexts: ['camera'],
    label: 'Photo mode',
    description: 'Free camera: fly anywhere, HUD hidden, depth of field; press again to leave',
    keys: ['KeyK'],
    pad: [hold('R3')],
  },

  // Photo mode (the boat sails on hands-off; look, zoom and the camera keys above still work)
  {
    kind: 'stick',
    id: 'photoMove',
    contexts: ['photo'],
    label: 'Fly',
    description: 'Fly forward / back along the view and strafe left / right',
    keysLeft: ['KeyA'],
    keysRight: ['KeyD'],
    keysUp: ['KeyW'],
    keysDown: ['KeyS'],
    padStick: 'left',
  },
  {
    kind: 'axis',
    id: 'photoRise',
    contexts: ['photo'],
    label: 'Down / up',
    description: 'Lower or raise the camera',
    keysPos: ['KeyE'],
    keysNeg: ['KeyQ'],
    padPos: 'RT',
    padNeg: 'LT',
    negFirst: true,
  },
  {
    kind: 'axis',
    id: 'photoAperture',
    contexts: ['photo'],
    label: 'Aperture',
    description:
      'Depth of field: wheel up, = or RB opens the aperture (shallower focus), wheel down, - or LB closes it; focus follows the boat',
    mouse: 'Wheel',
    keysPos: [],
    keysNeg: [],
    padPos: 'RB',
    padNeg: 'LB',
    negFirst: true,
  },
  {
    kind: 'button',
    id: 'photoSlowMo',
    contexts: ['photo'],
    label: 'Slow motion',
    description: 'Cycle the simulation speed: normal, quarter speed, frozen',
    keys: ['KeyT'],
    pad: [press('X')],
  },

  // Global
  // Lights, on the number keys (N and L also work). On the D-pad a tap switches the main
  // light of a pair and a hold the second one: ↑ navigation / signals, ↓ deck / cabin, ← or → extras.
  {
    kind: 'button',
    id: 'navLights',
    contexts: ['global'],
    label: 'Navigation lights',
    description: 'Switch the navigation lights (sidelights, masthead and stern lights) on or off',
    keys: ['Digit1', 'KeyN'],
    pad: [tap('DUp')],
  },
  {
    kind: 'button',
    id: 'deckLights',
    contexts: ['global'],
    label: 'Deck lights',
    description:
      'Switch the deck and work lights on or off: floods, spreader lights, the center console’s T-top lights',
    keys: ['Digit2', 'KeyL'],
    pad: [tap('DDown')],
  },
  {
    kind: 'button',
    id: 'cabinLights',
    contexts: ['global'],
    label: 'Cabin lights',
    description: 'Switch the cabin, wheelhouse and accommodation lights on or off',
    keys: ['Digit3'],
    pad: [hold('DDown')],
  },
  {
    kind: 'button',
    id: 'signals',
    contexts: ['global'],
    label: 'Signal lights',
    description:
      'Cycle the signal lights: automatic, at anchor, restricted in ability to manoeuvre (ships only)',
    keys: ['Digit4'],
    pad: [hold('DUp')],
  },
  {
    kind: 'button',
    id: 'extraLights',
    contexts: ['global'],
    label: 'Extra lights',
    description:
      'Switch the extras on or off: searchlights (ships and crab boat; the cruise ship also floodlights her funnels), underwater lights (center console), headlight (jet ski)',
    keys: ['Digit5'],
    pad: [hold('DLeft'), hold('DRight')],
  },
  {
    kind: 'button',
    id: 'nextBoat',
    contexts: ['global'],
    label: 'Next boat',
    description: 'Take the helm of the next boat in the fleet',
    keys: ['Tab'],
    pad: [tap('DRight')],
  },
  {
    kind: 'button',
    id: 'prevBoat',
    contexts: ['global'],
    label: 'Previous boat',
    description: 'Take the helm of the previous boat in the fleet',
    keys: ['Shift+Tab'],
    pad: [tap('DLeft')],
  },
  {
    kind: 'button',
    id: 'horn',
    contexts: ['global'],
    label: 'Horn',
    description: 'Sound the horn while held',
    keys: ['KeyB'],
    pad: [press('A')],
  },
  {
    kind: 'button',
    id: 'recover',
    contexts: ['global'],
    label: 'Recover boat',
    description: 'Right a capsized, sunk or stuck boat (also in the pause menu)',
    keys: ['Backspace'],
    pad: [hold('View')],
  },
  {
    kind: 'button',
    id: 'hud',
    contexts: ['global'],
    label: 'HUD mode',
    description: 'Cycle the HUD: Full, Minimal, Off',
    keys: ['KeyH'],
    pad: [tap('View')],
  },
  {
    kind: 'button',
    id: 'help',
    contexts: ['global'],
    label: 'Help',
    description: 'Open this help screen (gamepad: from the pause menu)',
    keys: ['Shift+Slash', 'F1'],
    pad: [],
  },
  {
    kind: 'button',
    id: 'pause',
    contexts: ['global'],
    label: 'Pause',
    description: 'Open the pause menu',
    keys: ['KeyP', 'Escape'],
    pad: [press('Start')],
  },
  {
    kind: 'button',
    id: 'telemetry',
    contexts: ['global'],
    label: 'Telemetry panel',
    description:
      'Show or hide the engineering readouts for your boat (off by default; also in Settings → HUD)',
    keys: ['KeyG'],
    pad: [],
  },
  {
    kind: 'button',
    id: 'perf',
    contexts: ['global'],
    label: 'Performance overlay',
    description: 'Frame rate, CPU and GPU time',
    keys: ['F3'],
    pad: [],
  },
  {
    kind: 'button',
    id: 'timeEarlier',
    contexts: ['global'],
    label: 'Time of day −',
    description: 'Jump the clock back half an hour',
    keys: ['BracketLeft'],
    pad: [],
  },
  {
    kind: 'button',
    id: 'timeLater',
    contexts: ['global'],
    label: 'Time of day +',
    description: 'Jump the clock forward half an hour',
    keys: ['BracketRight'],
    pad: [],
  },
  {
    kind: 'button',
    id: 'timeScale',
    contexts: ['global'],
    label: 'Time scale',
    description:
      'Fast-forward the clock (10 minutes a second, press again for an hour a second); a third press returns to the normal day length',
    keys: ['Backslash'],
    pad: [],
  },

  // Menus
  {
    kind: 'stick',
    id: 'menuNavigate',
    contexts: ['menu'],
    label: 'Move focus',
    description: 'Move between menu items',
    keysLeft: ['ArrowLeft'],
    keysRight: ['ArrowRight'],
    keysUp: ['ArrowUp'],
    keysDown: ['ArrowDown'],
    padStick: 'left',
    padDpad: true,
  },
  {
    kind: 'button',
    id: 'menuAccept',
    contexts: ['menu'],
    label: 'Select',
    description: 'Activate the focused item',
    keys: ['Enter'],
    pad: [press('A')],
  },
  {
    kind: 'button',
    id: 'menuBack',
    contexts: ['menu'],
    label: 'Back',
    description: 'Close this menu',
    keys: ['Escape'],
    pad: [press('B'), press('Start')],
  },
  {
    kind: 'button',
    id: 'menuTabPrev',
    contexts: ['menu'],
    label: 'Previous tab',
    description: 'Switch to the previous tab',
    keys: ['PageUp'],
    pad: [press('LB')],
  },
  {
    kind: 'button',
    id: 'menuTabNext',
    contexts: ['menu'],
    label: 'Next tab',
    description: 'Switch to the next tab',
    keys: ['PageDown'],
    pad: [press('RB')],
  },
];

export function bindingsFor(context: PollContext): Binding[] {
  const live = activeContexts(context);
  return BINDINGS.filter((binding) => binding.contexts.some((c) => live.includes(c)));
}

export function findBinding(id: ActionId): Binding | undefined {
  return BINDINGS.find((binding) => binding.id === id);
}

// ---------------------------------------------------------------------------
// Conflicts

function keysOf(binding: Binding): string[] {
  switch (binding.kind) {
    case 'button':
      return [...binding.keys];
    case 'axis':
      // Held keys ignore Shift, so they also occupy the Shift chord.
      return [...binding.keysPos, ...binding.keysNeg].flatMap((key) => [key, `Shift+${key}`]);
    case 'stick':
      return [...binding.keysLeft, ...binding.keysRight, ...binding.keysUp, ...binding.keysDown].flatMap(
        (key) => [key, `Shift+${key}`],
      );
  }
}

// Pad slots; 'press' claims all modes of its button, tap and hold may share.
function padSlotsOf(binding: Binding): { slot: string; exclusive: boolean }[] {
  switch (binding.kind) {
    case 'button':
      return binding.pad.map((p) => ({ slot: `${p.button}:${p.mode}`, exclusive: p.mode === 'press' }));
    case 'axis': {
      const slots = [binding.padPos, binding.padNeg]
        .filter((b): b is PadButton => !!b)
        .map((b) => ({ slot: `${b}:press`, exclusive: true }));
      if (binding.padAxis) slots.push({ slot: binding.padAxis, exclusive: true });
      if (binding.padStep)
        slots.push({
          slot: `${binding.padStep.button}:${binding.padStep.mode}`,
          exclusive: binding.padStep.mode === 'press',
        });
      return slots;
    }
    case 'stick': {
      const prefix = binding.padStick === 'left' ? 'L' : 'R';
      const slots = [`${prefix}X`, `${prefix}Y`].map((slot) => ({ slot, exclusive: true }));
      if (binding.padDpad) {
        for (const b of ['DUp', 'DDown', 'DLeft', 'DRight'])
          slots.push({ slot: `${b}:press`, exclusive: true });
      }
      return slots;
    }
  }
}

export interface Conflict {
  context: PollContext;
  input: string;
  actions: [ActionId, ActionId];
}

export function findConflicts(context: PollContext, bindings: readonly Binding[] = BINDINGS): Conflict[] {
  const live = activeContexts(context);
  const active = bindings.filter((binding) => binding.contexts.some((c) => live.includes(c)));
  const conflicts: Conflict[] = [];
  const keyOwner = new Map<string, ActionId>();
  const padOwners = new Map<string, { id: ActionId; slot: string; exclusive: boolean }[]>();
  for (const binding of active) {
    for (const key of new Set(keysOf(binding))) {
      const owner = keyOwner.get(key);
      if (owner && owner !== binding.id)
        conflicts.push({ context, input: key, actions: [owner, binding.id] });
      else keyOwner.set(key, binding.id);
    }
    for (const { slot, exclusive } of padSlotsOf(binding)) {
      const control = slot.split(':')[0];
      const owners = padOwners.get(control) ?? [];
      for (const other of owners) {
        if (other.id === binding.id) continue;
        if (other.exclusive || exclusive || other.slot === slot) {
          conflicts.push({ context, input: slot, actions: [other.id, binding.id] });
        }
      }
      owners.push({ id: binding.id, slot, exclusive });
      padOwners.set(control, owners);
    }
  }
  return conflicts;
}

// ---------------------------------------------------------------------------
// Display

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Enter',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Minus: '-',
  Equal: '=',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

const SHIFTED: Record<string, string> = { Slash: '?' };

export function keyName(chord: string): string {
  const { code, shift } = parseChord(chord);
  if (shift && SHIFTED[code]) return SHIFTED[code];
  let name = KEY_NAMES[code] ?? code;
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit\d$/.test(code)) name = code.slice(5);
  else if (code.startsWith('Numpad')) name = `Num ${code.slice(6)}`;
  return shift ? `Shift+${name}` : name;
}

const PAD_NAMES: Record<PadButton, string> = {
  A: 'A',
  B: 'B',
  X: 'X',
  Y: 'Y',
  LB: 'LB',
  RB: 'RB',
  LT: 'LT',
  RT: 'RT',
  View: 'View',
  Start: 'Start',
  L3: 'L3',
  R3: 'R3',
  DUp: 'D-pad ↑',
  DDown: 'D-pad ↓',
  DLeft: 'D-pad ←',
  DRight: 'D-pad →',
  Home: 'Home',
};

const AXIS_NAMES: Record<PadAxis, string> = {
  LX: 'Left stick X',
  LY: 'Left stick Y',
  RX: 'Right stick X',
  RY: 'Right stick Y',
};

export function padName(binding: PadButtonBinding): string {
  const name = PAD_NAMES[binding.button];
  return binding.mode === 'press' ? name : `${name} (${binding.mode})`;
}

function pair(pos: string, neg: string, negFirst: boolean | undefined): string {
  return negFirst ? `${neg} / ${pos}` : `${pos} / ${neg}`;
}

function keyboardText(binding: Binding): string {
  switch (binding.kind) {
    case 'button':
      return binding.keys.map(keyName).join(' / ');
    case 'axis': {
      const pos = binding.keysPos.map(keyName).join(', ');
      const neg = binding.keysNeg.map(keyName).join(', ');
      return pos || neg ? pair(pos, neg, binding.negFirst) : '';
    }
    case 'stick':
      return [binding.keysUp, binding.keysDown, binding.keysLeft, binding.keysRight]
        .flat()
        .map(keyName)
        .join(' ');
  }
}

function gamepadText(binding: Binding): string {
  switch (binding.kind) {
    case 'button':
      return binding.pad.map(padName).join(' / ');
    case 'axis': {
      if (binding.padAxis) return AXIS_NAMES[binding.padAxis];
      if (binding.padPos && binding.padNeg) {
        return pair(PAD_NAMES[binding.padPos], PAD_NAMES[binding.padNeg], binding.negFirst);
      }
      return binding.padStep ? padName(binding.padStep) : '';
    }
    case 'stick': {
      const stick = binding.padStick === 'left' ? 'Left stick' : 'Right stick';
      return binding.padDpad ? `D-pad / ${stick}` : stick;
    }
  }
}

export interface BindingRow {
  id: ActionId;
  group: InputContext;
  label: string;
  description: string;
  keyboard: string; // includes the mouse, e.g. "Mouse / right-drag · ← → ↑ ↓"
  gamepad: string; // '—' when there is none
}

// Rows for the help screen, boat controls first, then camera, then global.
export function describeBindings(context: PollContext): BindingRow[] {
  const order = [...activeContexts(context)].reverse();
  const rows: BindingRow[] = [];
  for (const group of order) {
    for (const binding of BINDINGS) {
      if (!binding.contexts.includes(group)) continue;
      const keys = keyboardText(binding);
      const keyboard = [binding.mouse, keys].filter(Boolean).join(' · ');
      rows.push({
        id: binding.id,
        group,
        label: binding.label,
        description: binding.description,
        keyboard: keyboard || '—',
        gamepad: gamepadText(binding) || '—',
      });
    }
  }
  return rows;
}
