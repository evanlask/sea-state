// Where each boat carries its lights, in the body frame (x starboard, y up from the design
// waterline, z aft; bow −Z): navigation lanterns placed from the real dimensions under the Annex I
// height rules, and the work / courtesy lights. Models can replace any of these with named markers
// (see mountsFromObject in BoatLights.ts); mergeMounts combines the two. Pure TS.

import type { BoatKind } from '../../../sim/world/protocol';
import {
  chromaticityToLinear,
  type LightColour,
  type LightKind,
  type LightSector,
  type NavRole,
  type Rgb,
  ROLE_LIGHT,
  srgbHexToLinear,
} from './colregs';

const DEG = Math.PI / 180;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface LightMount {
  name: string; // unique per boat; a model marker with the same name replaces this mount
  roles: readonly NavRole[]; // lit when any of these is required
  position: Vec3Like; // body frame, m
  kind?: LightKind; // default from the first role
  colour?: LightColour; // default from the first role
  sector?: LightSector; // arc override (e.g. a screened lantern)
  rangeNm?: number; // overrides the Rule 22 range for the vessel's length
  intensity?: number; // cd, overrides the range
  lensRadius?: number; // m, the glowing lens
}

export type DeckLightType =
  | 'flood'
  | 'spreader'
  | 'courtesy'
  | 'underwater'
  | 'headlight'
  | 'funnel'
  | 'searchlight';

// The switch a fitting is on: 'deck' is the deck and work lighting (floods, spreaders, courtesy
// lights), 'extra' the special fittings only some boats carry (searchlights, underwater lights, the
// jet ski's headlight, the cruise ship's funnel floodlight).
export type DeckGroup = 'deck' | 'extra';

const GROUP_OF: Readonly<Record<DeckLightType, DeckGroup>> = {
  flood: 'deck',
  spreader: 'deck',
  courtesy: 'deck',
  underwater: 'extra',
  headlight: 'extra',
  funnel: 'extra',
  searchlight: 'extra',
};

export const deckGroupOf = (type: DeckLightType): DeckGroup => GROUP_OF[type];

export interface DeckMount {
  name: string;
  type: DeckLightType;
  position: Vec3Like; // body frame
  target: Vec3Like; // body-frame point the beam is aimed at (point lights ignore it)
  colour: Rgb; // linear, unit luminance
  intensity: number; // cd on the beam axis
  angle: number; // rad, beam half-angle (spot lights)
  penumbra: number; // 0..1
  range: number; // m, light cut-off distance
  light: 'spot' | 'point' | 'none'; // 'none': only the lamp glows (beyond the light budget anyway)
  priority: number; // lower gets a scene light (and a shadow) first
  shadow: boolean; // may cast shadows when the budget allows
  lamp: boolean; // draw the lens and glow (false for underwater LEDs)
  lensRadius: number; // m
}

// Height of the hull (uppermost continuous deck / gunwale) above the waterline near the lights:
// Annex I measures light heights from here.
export const HULL_HEIGHT: Readonly<Record<BoatKind, number>> = {
  cargo: 8.2, // depth 19.0 − draft 10.8
  cruise: 5.7, // depth 14.0 − draft 8.3
  crab: 1.0, // 1.0 m freeboard amidships
  sail: 1.05, // sheer at the mast
  powerboat: 1.0, // gunwale aft of the console
  pwc: 0.3,
  hydro: 0.58, // the deck at rest
};

const v = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });

// Work-light colours.
const SODIUM: Rgb = chromaticityToLinear(0.53, 0.415); // high-pressure sodium, ~2100 K
const LED_COOL: Rgb = chromaticityToLinear(0.3451, 0.3516); // 5000 K
export const LED_WARM: Rgb = chromaticityToLinear(0.4369, 0.4041); // 3000 K
const UNDERWATER_TEAL: Rgb = srgbHexToLinear(0x00d8c8);
const COURTESY_BLUE: Rgb = srgbHexToLinear(0xbfd4ff);

// Lens radii by size class.
const LENS_SHIP = 0.15;
const LENS_CRAB = 0.08;
const LENS_SMALL = 0.035;

function shipMounts(p: {
  masthead: Vec3Like;
  mastheadAft: Vec3Like;
  sidelight: Vec3Like; // starboard wing; port mirrors
  stern: Vec3Like;
  anchorForward: Vec3Like;
  anchorAft: Vec3Like;
  signals: Vec3Like; // top of the red-white-red stack, 2 m spacing
}): LightMount[] {
  const s = p.signals;
  const lensRadius = LENS_SHIP;
  return [
    { name: 'masthead', roles: ['masthead'], position: p.masthead, lensRadius },
    { name: 'masthead-aft', roles: ['mastheadAft'], position: p.mastheadAft, lensRadius },
    { name: 'port', roles: ['port'], position: v(-p.sidelight.x, p.sidelight.y, p.sidelight.z), lensRadius },
    { name: 'starboard', roles: ['starboard'], position: p.sidelight, lensRadius },
    { name: 'stern', roles: ['stern'], position: p.stern, lensRadius },
    { name: 'anchor-forward', roles: ['anchorForward'], position: p.anchorForward, lensRadius },
    { name: 'anchor-aft', roles: ['anchorAft'], position: p.anchorAft, lensRadius },
    { name: 'signal-red-upper', roles: ['signalRedUpper'], position: s, lensRadius },
    { name: 'signal-white', roles: ['signalWhite'], position: v(s.x, s.y - 2, s.z), lensRadius },
    { name: 'signal-red-lower', roles: ['signalRedLower'], position: v(s.x, s.y - 4, s.z), lensRadius },
  ];
}

const NAV_MOUNTS: Readonly<Record<BoatKind, readonly LightMount[]>> = {
  // KCS: stem z ≈ −121, stern z ≈ +122, accommodation and bridge aft (z ≈ 60–78, eye 35 m).
  // Forward masthead on the foremast above the container stacks; after masthead on the radar mast,
  // 8.5 m higher and 166 m aft (so it shows above the forward one from 1000 m ahead); sidelights on
  // the bridge wings at ≤ ¾ of the forward masthead height.
  cargo: shipMounts({
    masthead: v(0, 43, -100),
    mastheadAft: v(0, 51.5, 66),
    sidelight: v(16, 33.5, 62),
    stern: v(0, 11, 121.5),
    anchorForward: v(0, 18, -115),
    anchorAft: v(0, 13, 119),
    signals: v(0, 49, 67.5),
  }),
  // Solstice: stem z ≈ −158.5, bridge forward (eye 33 m, 28 m aft of the stem), funnel aft.
  cruise: shipMounts({
    masthead: v(0, 47, -135),
    mastheadAft: v(0, 56, -20),
    sidelight: v(18.2, 31.5, -130),
    stern: v(0, 12, 158),
    anchorForward: v(0, 15, -150),
    anchorAft: v(0, 10, 157),
    signals: v(0, 53, -21),
  }),
  // 38 m crabber: stem z ≈ −20, wheelhouse forward (eye 7.5 m), mast on the wheelhouse top. The
  // fishing red-over-white sit on the mast below the masthead light, the white ≥ 4 m above the
  // sidelights (twice the 2 m spacing, Annex I 4(a)).
  crab: [
    { name: 'masthead', roles: ['masthead'], position: v(0, 14, -11.5), lensRadius: LENS_CRAB },
    { name: 'port', roles: ['port'], position: v(-3.3, 6, -10), lensRadius: LENS_CRAB },
    { name: 'starboard', roles: ['starboard'], position: v(3.3, 6, -10), lensRadius: LENS_CRAB },
    { name: 'stern', roles: ['stern'], position: v(0, 2.6, 17.8), lensRadius: LENS_CRAB },
    { name: 'anchor-forward', roles: ['anchorForward'], position: v(0, 14.6, -11.5), lensRadius: LENS_CRAB },
    {
      name: 'signal-red-upper',
      roles: ['signalRedUpper'],
      position: v(0, 12.2, -11.3),
      lensRadius: LENS_CRAB,
    },
    { name: 'signal-white', roles: ['signalWhite'], position: v(0, 10.2, -11.3), lensRadius: LENS_CRAB },
    {
      name: 'signal-red-lower',
      roles: ['signalRedLower'],
      position: v(0, 8.2, -11.3),
      lensRadius: LENS_CRAB,
    },
  ],
  // C&C 115: masthead at 16.65 m (mast z = −1.1). Tricolour and anchor light on the masthead, or
  // sidelights on the bow pulpit and the sternlight on the pushpit.
  sail: [
    { name: 'port', roles: ['port'], position: v(-0.3, 1.75, -5.5), lensRadius: LENS_SMALL },
    { name: 'starboard', roles: ['starboard'], position: v(0.3, 1.75, -5.5), lensRadius: LENS_SMALL },
    { name: 'stern', roles: ['stern'], position: v(0, 1.7, 5.45), lensRadius: LENS_SMALL },
    { name: 'tricolour-port', roles: ['tricolourPort'], position: v(0, 16.75, -1.1), lensRadius: LENS_SMALL },
    {
      name: 'tricolour-starboard',
      roles: ['tricolourStarboard'],
      position: v(0, 16.75, -1.1),
      lensRadius: LENS_SMALL,
    },
    {
      name: 'tricolour-stern',
      roles: ['tricolourStern'],
      position: v(0, 16.75, -1.1),
      lensRadius: LENS_SMALL,
    },
    { name: 'anchor', roles: ['anchorForward'], position: v(0, 16.95, -1.1), lensRadius: LENS_SMALL },
  ],
  // 33 ft centre console: bow combination lantern on the foredeck, all-round white on a stern pole
  // ≥ 1 m above it (Annex I 2(i)); the pole light doubles as the anchor light.
  powerboat: [
    { name: 'port', roles: ['port'], position: v(-0.06, 1.5, -4.75), lensRadius: 0.03 },
    { name: 'starboard', roles: ['starboard'], position: v(0.06, 1.5, -4.75), lensRadius: 0.03 },
    {
      name: 'stern-pole',
      roles: ['allRoundWhite', 'anchorForward'],
      position: v(0, 2.75, 4.4),
      lensRadius: 0.03,
    },
  ],
  // PWC: an optional accessory all-round white on a short pole behind the seat.
  pwc: [{ name: 'accessory', roles: ['allRoundWhite'], position: v(0, 1.25, 1.45), lensRadius: 0.025 }],
  // Race boats carry no lights; this one has what a power-driven vessel under 12 m needs to be out at
  // night (Rule 23(d)(i)): LED sidelights in low pods on the sponson noses and an all-round white on a
  // stalk on top of the wing, 1 m above them, which doubles as the anchor light (models/hydro.ts).
  hydro: [
    { name: 'port', roles: ['port'], position: v(-1.7, 0.623, -4.25), lensRadius: 0.02 },
    { name: 'starboard', roles: ['starboard'], position: v(1.7, 0.623, -4.25), lensRadius: 0.02 },
    {
      name: 'wing',
      roles: ['allRoundWhite', 'anchorForward'],
      position: v(0, 1.635, 4.42),
      lensRadius: 0.02,
    },
  ],
};

const spot = (
  name: string,
  type: DeckLightType,
  position: Vec3Like,
  target: Vec3Like,
  o: Partial<DeckMount> & { intensity: number; priority: number },
): DeckMount => ({
  name,
  type,
  position,
  target,
  colour: LED_COOL,
  angle: 35 * DEG,
  penumbra: 0.5,
  range: 40,
  light: 'spot',
  shadow: false,
  lamp: true,
  lensRadius: 0.12,
  ...o,
});

// Mirrors a starboard mount to port.
const pair = (m: DeckMount, suffix = ['port', 'starboard']): DeckMount[] => [
  {
    ...m,
    name: `${m.name}-${suffix[0]}`,
    position: v(-m.position.x, m.position.y, m.position.z),
    target: v(-m.target.x, m.target.y, m.target.z),
  },
  { ...m, name: `${m.name}-${suffix[1]}`, priority: m.priority + 0.5 },
];

// Searchlights: a 1–2 kW xenon or LED searchlight throws a pencil beam (3–5° half-angle) of a few
// hundred kcd to ~1 Mcd. Fixed here, aimed ahead and a little outboard onto the water (clear of the
// bow and the deck cargo); no shadows (a beam reaching hundreds of metres).
const searchlight = (
  position: Vec3Like,
  target: Vec3Like,
  o: Partial<DeckMount> & { intensity: number; priority: number },
): DeckMount =>
  spot('searchlight', 'searchlight', position, target, {
    angle: 4 * DEG,
    penumbra: 0.3,
    range: 300,
    ...o,
  });

// Floods: a 400 W LED (~50 klm in a 40° half-angle beam) is ~30 kcd on axis; 1 kW sodium ~40 kcd.
const DECK_MOUNTS: Readonly<Record<BoatKind, readonly DeckMount[]>> = {
  cargo: [
    ...pair(
      spot('deckhouse-flood', 'flood', v(10, 31, 59), v(6, 24, 0), {
        intensity: 30_000,
        priority: 0,
        range: 160,
        shadow: true,
        lensRadius: 0.2,
      }),
    ),
    spot('forecastle-flood', 'flood', v(0, 18, -108), v(0, 11, -118), {
      intensity: 15_000,
      priority: 2,
      range: 40,
      lensRadius: 0.2,
    }),
    spot('poop-flood', 'flood', v(0, 16, 100), v(0, 9.5, 116), {
      intensity: 15_000,
      priority: 3,
      range: 40,
      lensRadius: 0.2,
    }),
    // On the bridge wings, inboard of the sidelights (the model's searchlight markers place them).
    ...pair(
      searchlight(v(14.6, 35.17, 65.93), v(80, 0, -450), {
        intensity: 600_000,
        priority: 1,
        range: 900,
        angle: 3.5 * DEG,
        lensRadius: 0.2,
      }),
    ),
  ],
  cruise: [
    // Floodlights the twin funnels (an extra: decoration, not deck lighting).
    spot('funnel-uplight', 'funnel', v(0, 45, 35), v(0, 58, 48), {
      intensity: 20_000,
      priority: 1,
      range: 40,
      colour: LED_WARM,
      angle: 30 * DEG,
      lensRadius: 0.2,
    }),
    spot('pool-deck', 'flood', v(0, 50, 10), v(0, 44, 25), {
      intensity: 12_000,
      priority: 0,
      range: 60,
      colour: LED_WARM,
      angle: 50 * DEG,
      shadow: true,
      lensRadius: 0.2,
    }),
    spot('bow-flood', 'flood', v(0, 22, -148), v(0, 8, -156), {
      intensity: 10_000,
      priority: 2,
      range: 30,
      lensRadius: 0.2,
    }),
    ...pair(
      spot('promenade', 'courtesy', v(17.5, 14, 0), v(17.5, 10, 0), {
        intensity: 800,
        priority: 3,
        range: 40,
        colour: LED_WARM,
        light: 'point',
        lensRadius: 0.1,
      }),
    ),
    // On the bridge-wing roofs.
    ...pair(
      searchlight(v(18.6, 35.65, -132.43), v(45, 0, -460), {
        intensity: 600_000,
        priority: 1.2,
        range: 900,
        angle: 3.5 * DEG,
        lensRadius: 0.2,
      }),
    ),
  ],
  // Bering Sea crabbers blaze with 12–16 floods; the first few by priority get scene lights. Sized for
  // a working deck of a few hundred lux (16 kcd sodium, 10 kcd LED).
  crab: [
    ...pair(
      spot('mast-flood', 'flood', v(0.6, 11.5, -11), v(2, 1.2, 4), {
        intensity: 16_000,
        priority: 0,
        colour: SODIUM,
        angle: 32 * DEG,
        shadow: true,
      }),
    ),
    ...pair(
      spot('mast-flood-low', 'flood', v(1.2, 10.8, -10.8), v(2.5, 1.2, 11), {
        intensity: 16_000,
        priority: 4,
        colour: SODIUM,
        angle: 30 * DEG,
      }),
    ),
    ...pair(
      spot('wheelhouse-flood', 'flood', v(3.4, 7.2, -6.5), v(1.5, 1.2, 6), {
        intensity: 10_000,
        priority: 2,
        angle: 32 * DEG,
      }),
    ),
    ...pair(
      spot('gantry-flood', 'flood', v(3, 5.5, 16.5), v(2, 1.2, 8), {
        intensity: 10_000,
        priority: 6,
        angle: 30 * DEG,
      }),
    ),
    ...pair(
      spot('rail-flood', 'flood', v(3.6, 4.5, 2), v(4.6, 0.5, 6), {
        intensity: 10_000,
        priority: 8,
        angle: 30 * DEG,
        light: 'none',
      }),
    ),
    ...pair(
      spot('whaleback-flood', 'flood', v(2.5, 4.4, -14), v(0, 2.8, -19), {
        intensity: 10_000,
        priority: 10,
        angle: 30 * DEG,
        light: 'none',
      }),
    ),
    // Twin searchlights on the wheelhouse roof, for picking up buoys and pots in the dark.
    ...pair(
      searchlight(v(1.6, 9.24, -11.1), v(4, 0, -90), {
        intensity: 250_000,
        priority: 1,
        lensRadius: 0.13,
      }),
    ),
  ],
  // Spreader lights: ~2 klm LED in a 50° half-angle beam ≈ 900 cd, down onto the deck.
  sail: pair(
    spot('spreader', 'spreader', v(0.75, 9.5, -1.05), v(0.4, 1.1, -1.8), {
      intensity: 900,
      priority: 0,
      range: 18,
      angle: 50 * DEG,
      shadow: true,
      lensRadius: 0.04,
    }),
  ),
  powerboat: [
    // LED downlights under the T-top (the model's lenses, three a side, stand for these): ~500 lm
    // a side, down onto the console and the cockpit.
    ...pair(
      spot('ttop-spreader', 'spreader', v(0.4, 2.33, -0.43), v(0.4, 0.3, -0.43), {
        intensity: 180,
        priority: 0,
        range: 6,
        angle: 60 * DEG,
        penumbra: 0.6,
        shadow: true,
        lamp: false,
        lensRadius: 0.04,
      }),
    ),
    ...pair(
      spot('courtesy', 'courtesy', v(1.2, 0.85, 2.2), v(0.6, 0.4, 2.2), {
        intensity: 4,
        priority: 1,
        range: 4,
        colour: COURTESY_BLUE,
        light: 'point',
        lensRadius: 0.02,
      }),
    ),
    // Transom LEDs below the surface. No scene light: the ocean shades as if lit from above, so a
    // point light under it paints a blown-out disk on the sea and floodlights the hull from below.
    // DeckLights draws their glow in the water instead (UnderwaterGlow).
    ...pair(
      spot('underwater', 'underwater', v(0.6, -0.15, 5.1), v(0.6, -2, 7), {
        intensity: 600, // ~3 klm each
        priority: 2,
        range: 9,
        colour: UNDERWATER_TEAL,
        light: 'none',
        lamp: false,
        lensRadius: 0.03,
      }),
    ),
  ],
  // ~1 klm LED headlight in a 12° half-angle beam.
  pwc: [
    spot('headlight', 'headlight', v(0, 0.5, -1.55), v(0, 0, -35), {
      intensity: 7000,
      priority: 0,
      range: 60,
      angle: 12 * DEG,
      penumbra: 0.6,
      lensRadius: 0.03,
    }),
  ],
  hydro: [],
};

const cloneMount = (m: LightMount): LightMount => ({
  ...m,
  roles: [...m.roles],
  position: { ...m.position },
});

export const defaultMounts = (kind: BoatKind): LightMount[] => NAV_MOUNTS[kind].map(cloneMount);

export const defaultDeckMounts = (kind: BoatKind): DeckMount[] =>
  DECK_MOUNTS[kind].map((m) => ({ ...m, position: { ...m.position }, target: { ...m.target } }));

// Overrides replace same-named defaults; new names are added.
export function mergeMounts<T extends { name: string }>(
  defaults: readonly T[],
  overrides: readonly T[],
): T[] {
  const byName = new Map(defaults.map((m) => [m.name, m]));
  for (const m of overrides) byName.set(m.name, m);
  return [...byName.values()];
}

// Kind and colour a mount resolves to.
export function mountLight(mount: LightMount): { kind: LightKind; colour: LightColour } {
  const role = mount.roles[0];
  const base = role ? ROLE_LIGHT[role] : { kind: 'allRound' as const, colour: 'white' as const };
  return { kind: mount.kind ?? base.kind, colour: mount.colour ?? base.colour };
}

export const mountsForRole = (mounts: readonly LightMount[], role: NavRole): LightMount[] =>
  mounts.filter((m) => m.roles.includes(role));
