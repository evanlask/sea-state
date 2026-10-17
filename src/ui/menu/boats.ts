// Boat card data for the scenario setup and fleet screens: fictional names, what each boat is
// modelled on, and its key real-world figures (formatted for display).

import { contextForBoat } from '../../input/contexts';
import type { BoatContext } from '../../input/contexts';
import { BOAT_KINDS, type BoatKind } from '../../sim/world/protocol';

interface BoatStats {
  lengthM: number; // overall
  massKg: number; // displacement, typical load
  powerKw?: number; // installed propulsion power
  sailAreaM2?: number;
  topSpeedKn: number;
}

export interface BoatCard {
  kind: BoatKind;
  name: string; // fictional, shown in the game
  className: string; // short type label
  modelledOn: string;
  description: string;
  stats: BoatStats;
  powerNote: string; // e.g. "2 × 300 hp outboards"
}

export const BOAT_CARDS: Readonly<Record<BoatKind, BoatCard>> = {
  cargo: {
    kind: 'cargo',
    name: 'MV Meridian Trader',
    className: 'Container ship',
    modelledOn: 'KCS 3,600 TEU Panamax benchmark',
    description: 'A 53,000-tonne box ship: slow to answer, impossible to hurry, unbothered by most seas.',
    stats: { lengthM: 243, massKg: 53_330_000, powerKw: 36_000, topSpeedKn: 24 },
    powerNote: 'Single 2-stroke diesel, 7.9 m propeller',
  },
  cruise: {
    kind: 'cruise',
    name: 'MS Celestine',
    className: 'Cruise ship',
    modelledOn: 'Celebrity Solstice class',
    description: 'A floating city on twin Azipods; surprisingly nimble at the dock, stately at sea.',
    stats: { lengthM: 317.2, massKg: 57_000_000, powerKw: 67_200, topSpeedKn: 24 },
    powerNote: 'Diesel-electric, 2 × 20.5 MW Azipods',
  },
  crab: {
    kind: 'crab',
    name: 'F/V Northern Reach',
    className: 'Crab boat',
    modelledOn: '125 ft Bering Sea crabber',
    description: 'A working boat built for the worst water on Earth. Heavy pots make her tender.',
    stats: { lengthM: 38.1, massKg: 700_000, powerKw: 1_200, topSpeedKn: 12.5 },
    powerNote: 'Single diesel, hydraulic bow thruster',
  },
  sail: {
    kind: 'sail',
    name: 'Kittiwake',
    className: 'Sailboat',
    modelledOn: 'C&C 115 performance cruiser',
    description: 'A 38-footer with a lead-bulb keel. No engine: read the wind, trim, and reef in time.',
    stats: { lengthM: 11.5, massKg: 5_572, sailAreaM2: 84.1, topSpeedKn: 8 },
    powerNote: 'Main 46 m² + genoa 38 m²',
  },
  powerboat: {
    kind: 'powerboat',
    name: 'Tidewater 33',
    className: 'Center console',
    modelledOn: '33 ft twin-outboard center console',
    description: 'Deep-vee, twin 300s, on the plane in seconds. Trim the bow to the sea.',
    stats: { lengthM: 10.1, massKg: 6_000, powerKw: 448, topSpeedKn: 47 },
    powerNote: '2 × 300 hp outboards',
  },
  pwc: {
    kind: 'pwc',
    name: 'Sea Dart RX',
    className: 'Jet ski',
    modelledOn: 'Sea-Doo RXP-X 325 class',
    description: 'Supercharged and twitchy. No thrust, no steering; flips easily, rights quickly.',
    stats: { lengthM: 3.3, massKg: 505, powerKw: 242, topSpeedKn: 58 },
    powerNote: '325 hp supercharged jet',
  },
  hydro: {
    kind: 'hydro',
    name: 'U-7 Sea Fury',
    className: 'Unlimited hydroplane',
    modelledOn: 'H1 Unlimited class',
    description:
      'A 3,000 hp helicopter turbine riding on three points at 200 mph. Flat water only: let the bow climb and it flies over backwards.',
    stats: { lengthM: 9.4, massKg: 3_062, powerKw: 2_240, topSpeedKn: 174 },
    powerNote: 'Lycoming T55 turbine, surface-piercing propeller, adjustable wing',
  },
};

export const boatCard = (kind: BoatKind): BoatCard => BOAT_CARDS[kind];
export const boatCards = (): BoatCard[] => BOAT_KINDS.map((kind) => BOAT_CARDS[kind]);

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];

// Display names for the boats on the water, in fleet order: a second boat of the same kind is
// "Kittiwake II", and so on.
export function fleetNames(boats: readonly { kind: BoatKind }[]): string[] {
  const seen = new Map<BoatKind, number>();
  return boats.map(({ kind }) => {
    const count = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, count);
    const name = BOAT_CARDS[kind].name;
    return count > 1 ? `${name} ${ROMAN[count] ?? count}` : name;
  });
}

const group = (n: number, digits = 0): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

export function formatMass(kg: number): string {
  return kg >= 10_000 ? `${group(kg / 1000)} t` : `${group(kg)} kg`;
}

export function formatPower(kw: number): string {
  return kw >= 10_000 ? `${group(kw / 1000, 1)} MW` : `${group(kw)} kW`;
}

function formatLength(m: number): string {
  return `${group(m, 1)} m`;
}

export interface StatRow {
  label: string;
  value: string;
}

export function statRows(card: BoatCard): StatRow[] {
  const { stats } = card;
  return [
    { label: 'Length', value: formatLength(stats.lengthM) },
    { label: 'Mass', value: formatMass(stats.massKg) },
    stats.sailAreaM2 !== undefined
      ? { label: 'Sail area', value: `${group(stats.sailAreaM2)} m²` }
      : { label: 'Power', value: formatPower(stats.powerKw ?? 0) },
    { label: 'Top speed', value: `${group(stats.topSpeedKn, 1)} kn` },
  ];
}

// ---------------------------------------------------------------------------------------------
// Help-screen helm classes: the cargo ship and crab boat share the 'ship' context.

export interface HelmClass {
  context: BoatContext;
  title: string;
  boats: BoatKind[];
}

export function helmClasses(): HelmClass[] {
  const titles: Record<BoatContext, string> = {
    ship: 'Crab boat & container ship',
    cruise: 'Cruise ship',
    powerboat: 'Center console',
    pwc: 'Jet ski',
    hydro: 'Hydroplane',
    sail: 'Sailboat',
  };
  // Smallest boats first, like the setup cards.
  const order: BoatContext[] = ['pwc', 'hydro', 'powerboat', 'sail', 'ship', 'cruise'];
  return order.map((context) => ({
    context,
    title: titles[context],
    boats: BOAT_KINDS.filter((kind) => contextForBoat(kind) === context),
  }));
}
