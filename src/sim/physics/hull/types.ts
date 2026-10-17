// Parameter types for the procedural canoe-body generator and the extra
// buoyant / non-buoyant volumes that sit on the deck.
//
// Body frame: x starboard, y up, z aft. The generated mesh's origin is on the
// centreline at the DESIGN WATERLINE: amidships between the waterline ends
// for displacement families, at mid-length for planing hulls.

interface HullCommon {
  stations?: number; // cross-sections along the length (incl. stem and transom)
  // Target displaced volume at the design draft, m³. When given, displacement
  // hulls solve their planform exponent to hit it at the given draft; planing
  // hulls keep their shape and solve the draft instead.
  targetVolume?: number;
}

// Round-bilge/displacement hulls: cargo and cruise ships, fishing vessels and
// the sailboat's canoe body. Lengths in m, angles in rad.
export interface DisplacementHullParams extends HullCommon {
  family: 'ship' | 'fishing' | 'sailing';
  lwl: number; // design waterline length (also Lpp for ships)
  beamWaterline: number; // maximum waterline breadth
  beamDeck: number; // maximum deck breadth (≥ waterline for flare)
  draft: number; // design draft amidships (canoe body for the sailboat)
  depth: number; // keel to deck edge amidships
  midshipCoefficient: number; // Cm → superellipse section exponent amidships
  endSectionExponent: number; // section exponent at the ends (1 = V, 2 = ellipse)
  parallelMidbodyForward: number; // fraction of the forward half-length that is parallel
  parallelMidbodyAft: number; // fraction of the aft half-length that is parallel
  entranceExponent: number; // waterline planform exponent forward (solved if targetVolume)
  runExponentRatio: number; // run (aft) exponent = entrance exponent × this
  deckFullness: number; // deck planform exponent multiplier (> 1 = fuller deck, flare)
  bowOverhang: number; // deck extends this far ahead of the forward waterline end
  sternOverhang: number; // deck/transom this far aft of the aft waterline end
  forefootLength: number; // fraction of LWL over which the keel rises to the stem
  runLength: number; // fraction of LWL over which the keel rises aft to the transom
  transomKeelHeight: number; // keel-line height at the transom above the baseline
  transomBeamRatio: number; // transom half-breadth / max half-breadth
  keelDrag: number; // keel deeper aft than forward by this much (fishing vessels)
  sheerBow: number; // deck rise at the stem above the midship depth
  sheerStern: number; // deck rise at the transom
  flareExponent: number; // topside shape from waterline to deck (1 = straight)
  bulbRadius?: number; // optional bulbous forefoot (widening low in the bow sections)
  girthBelow?: number; // section points from keel to the waterline
  girthAbove?: number; // section points from the waterline to the deck edge
}

// Hard-chine planing V-hull (center console, jet ski).
export interface PlaningHullParams extends HullCommon {
  family: 'planing';
  length: number; // stem top to transom along the sheer
  chineBeam: number; // maximum chine breadth
  beamDeck: number; // maximum sheer breadth
  draft: number; // keel depth below the waterline at the transom (solved if targetVolume)
  depth: number; // keel to sheer at the transom
  deadrise: number; // deadrise at the transom, rad
  deadriseBow: number; // deadrise at the forefoot, rad
  maxChineStation: number; // fraction of length from the transom where the chine is widest
  keelRiseStart: number; // fraction of length from the stem where the keel starts to rise
  transomChineRatio: number; // chine half-breadth at the transom / max
  transomDeckRatio: number; // sheer half-breadth at the transom / max
  entranceExponent: number; // chine planform exponent forward
  deckFullness: number;
  sheerBow: number; // sheer rise at the stem
  flareExponent: number;
  girthBottom?: number; // points keel → chine
  girthTopsides?: number; // points chine → sheer
}

// Three-point hydroplane (physics/hull/hydroplane.ts): two flat-bottomed sponsons forward at the
// beam's edges with the tunnel between them, a step at their aft ends, and the after-planing hull
// behind, narrowing to the transom. Heights are above the sponsons' running surface (the pad line).
export interface HydroplaneHullParams extends HullCommon {
  family: 'hydroplane';
  length: number; // sponson noses to the transom
  beam: number; // over the sponsons
  draft: number; // pad line below the waterline (solved if targetVolume)
  depth: number; // pad line to the deck
  sponsonWidth: number; // each sponson's running surface
  sponsonLength: number; // noses to the sponson step (the aft end of the pads)
  noseLength: number; // the pads curve up to the deck over this length at the noses
  noseBeamRatio: number; // half-breadth at the noses / half beam
  tunnelHeight: number; // tunnel roof above the pad line
  afterPlaneStep: number; // after-planing bottom above the pad line at the step
  afterPlaneTransom: number; // … and at the transom
  transomBeam: number; // after-planing hull's breadth at the transom
}

export type HullParams = DisplacementHullParams | PlaningHullParams | HydroplaneHullParams;

// Watertight volume above the deck (deckhouse, bridge, wheelhouse, cabin
// trunk, console). It sits on the deck at the given body z and is buoyant
// once immersed at large heel.
export interface SuperstructureSpec {
  name: string;
  z: number; // centre along the body z axis (aft positive)
  x?: number; // centre offset to starboard, default 0
  length: number;
  width: number;
  height: number;
  topLength?: number; // trapezoid prism / raked faces
  topWidth?: number;
  topShiftZ?: number;
  baseOffset?: number; // extra height above the deck at the base
}

// Open (non-buoyant) volumes: cockpits and deck wells that ship green water.
// Geometry for the deck-water reservoir model (DeckWater).
export interface OpenVolumeSpec {
  name: string;
  z: number;
  x?: number;
  length: number;
  width: number;
  depth: number; // coaming/bulwark height (or cockpit depth when recessed)
  recessed: boolean; // true = sunk into the hull (cockpit), false = above deck (bulwark well)
  drainArea: number; // freeing ports / scuppers, m²
  // Fraction of the drain area that lets the sea back in when it stands higher outside (default 1,
  // open scuppers). Freeing ports with non-return flaps hinged at the top admit only a little.
  drainBackflow?: number;
}
